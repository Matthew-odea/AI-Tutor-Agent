import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Question } from '../types';

// ── Mock the network + upload layers so the store never touches a real backend ──
// getQuestions/getProgress are left bare so each test sets the exact response it
// needs; the rest get harmless default resolutions (mirrors timerExpiry.test.ts).
vi.mock('../services/api', () => ({
  getStudentToken: vi.fn().mockResolvedValue('token'),
  getQuestions: vi.fn(),
  getProgress: vi.fn(),
  submitAnswer: vi.fn().mockResolvedValue(undefined),
  submitTextAnswer: vi.fn().mockResolvedValue(undefined),
  submitSkip: vi.fn().mockResolvedValue(undefined),
  submitAssessment: vi.fn().mockResolvedValue(undefined),
  getResults: vi.fn().mockResolvedValue({}),
}));

vi.mock('../services/s3', () => ({
  uploadAudio: vi.fn().mockResolvedValue('https://s3.example/audio.webm'),
  validateAudioBlob: vi.fn().mockReturnValue(true),
}));

import * as api from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';

const q = (id: string): Question => ({
  id,
  assessmentId: 'a1',
  studentId: 'z1',
  createdAt: '',
});

const baseProgress = {
  studentId: 'z1',
  assessmentId: 'a1',
  totalQuestions: 3,
  answeredQuestions: 0,
  percentage: 0,
  status: 'in-progress' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.setItem('studentToken', 'token');
  useAssessmentStore.getState().reset();
  useAssessmentStore.setState({ studentId: 'z1', assessmentId: 'a1' });
});

// ────────────────────────────────────────────────────────────────────────────
// loadProgress — authoritative server IDs preferred over the index heuristic.
// ────────────────────────────────────────────────────────────────────────────
describe('loadProgress', () => {
  it('prefers the server answeredQuestionIds list over the index heuristic, unioned with session-tracked ids', async () => {
    useAssessmentStore.setState({
      questions: [q('q1'), q('q2'), q('q3')],
      // An id answered THIS session that a stale progress read may not reflect yet.
      answeredQuestionIds: new Set<string>(['q2']),
    });
    // Server says only q3 is answered (out of array order); answeredQuestions=1
    // would make the heuristic mark q1 (slice(0,1)). The server list must win.
    vi.mocked(api.getProgress).mockResolvedValueOnce({
      ...baseProgress,
      answeredQuestions: 1,
      answeredQuestionIds: ['q3'],
    });

    await useAssessmentStore.getState().loadProgress();

    const ids = useAssessmentStore.getState().answeredQuestionIds;
    expect(ids.has('q3')).toBe(true); // from the authoritative server list
    expect(ids.has('q2')).toBe(true); // unioned from this session's tracking
    expect(ids.has('q1')).toBe(false); // heuristic (slice 0..1) NOT applied
  });

  it('unions the server list with ids added DURING the in-flight fetch (re-reads store, no stale pre-await snapshot)', async () => {
    useAssessmentStore.setState({
      questions: [q('q1'), q('q2')],
      answeredQuestionIds: new Set<string>(['q1']),
    });
    // Simulate a concurrent answer landing while getProgress is in flight: the
    // store gains 'q2' before the progress response resolves. A pre-await
    // snapshot of answeredQuestionIds would drop it; the union must re-read.
    vi.mocked(api.getProgress).mockImplementationOnce(async () => {
      useAssessmentStore.setState({
        answeredQuestionIds: new Set<string>([
          ...useAssessmentStore.getState().answeredQuestionIds,
          'q2',
        ]),
      });
      return {
        ...baseProgress,
        totalQuestions: 2,
        answeredQuestions: 1,
        answeredQuestionIds: ['q1'],
      };
    });

    await useAssessmentStore.getState().loadProgress();

    const ids = useAssessmentStore.getState().answeredQuestionIds;
    expect(ids.has('q1')).toBe(true); // from the server list
    expect(ids.has('q2')).toBe(true); // added mid-flight — must NOT be dropped
  });

  it('falls back to the first-N-by-index heuristic when the server omits the field, replacing (not unioning) prior ids', async () => {
    useAssessmentStore.setState({
      questions: [q('q1'), q('q2'), q('q3')],
      // A stale id the legacy heuristic branch must NOT preserve — proves the
      // fallback path keeps today's behavior (replace, not union).
      answeredQuestionIds: new Set<string>(['qX']),
    });
    vi.mocked(api.getProgress).mockResolvedValueOnce({
      ...baseProgress,
      answeredQuestions: 2,
      // no answeredQuestionIds field present
    });

    await useAssessmentStore.getState().loadProgress();

    const ids = useAssessmentStore.getState().answeredQuestionIds;
    expect(ids.has('q1')).toBe(true);
    expect(ids.has('q2')).toBe(true);
    expect(ids.has('q3')).toBe(false);
    expect(ids.has('qX')).toBe(false); // replaced, current behavior unchanged
    expect(ids.size).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// skipCurrentQuestion — a skip is tracked distinctly and clears any draft.
// ────────────────────────────────────────────────────────────────────────────
describe('skipCurrentQuestion', () => {
  it('records the question in skippedQuestionIds (NOT answeredQuestionIds) and clears the written draft', async () => {
    useAssessmentStore.setState({
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 0,
      answerMode: 'written',
      textAnswer: 'half-written draft',
      answeredQuestionIds: new Set<string>(),
      skippedQuestionIds: new Set<string>(),
    });
    // advance() re-fetches questions + progress. Return an EMPTY authoritative
    // answered list so the follow-up loadProgress can't re-add q1 to answered —
    // isolating skip's local bookkeeping from server reconciliation.
    vi.mocked(api.getQuestions).mockResolvedValue({
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 1,
      answerMode: 'written',
    });
    vi.mocked(api.getProgress).mockResolvedValue({
      ...baseProgress,
      totalQuestions: 2,
      answeredQuestions: 1,
      answeredQuestionIds: [],
    });

    await useAssessmentStore.getState().skipCurrentQuestion('written');

    const state = useAssessmentStore.getState();
    expect(state.skippedQuestionIds.has('q1')).toBe(true);
    expect(state.answeredQuestionIds.has('q1')).toBe(false);
    expect(state.textAnswer).toBe('');
    expect(api.submitSkip).toHaveBeenCalledWith('z1', 'q1', 'a1', 'written');
    expect(api.submitTextAnswer).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// goToQuestion — client-side navigation, only in review mode (allowReview).
// ────────────────────────────────────────────────────────────────────────────
describe('goToQuestion', () => {
  it('jumps to the index and pre-fills that question\'s prior answer when allowReview is true', () => {
    useAssessmentStore.setState({
      allowReview: true,
      questions: [
        { ...q('q1'), priorAnswer: 'answer one' },
        { ...q('q2') },
        { ...q('q3'), priorAnswer: 'answer three' },
      ],
      currentQuestionIndex: 0,
      textAnswer: 'currently typing q1',
    });

    useAssessmentStore.getState().goToQuestion(2);
    let s = useAssessmentStore.getState();
    expect(s.currentQuestionIndex).toBe(2);
    expect(s.textAnswer).toBe('answer three');

    useAssessmentStore.getState().goToQuestion(1); // no prior answer → empty editor
    s = useAssessmentStore.getState();
    expect(s.currentQuestionIndex).toBe(1);
    expect(s.textAnswer).toBe('');
  });

  it('is a no-op when allowReview is false (strict sequential flow unchanged)', () => {
    useAssessmentStore.setState({
      allowReview: false,
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 0,
      textAnswer: 'keep me',
    });

    useAssessmentStore.getState().goToQuestion(1);
    const s = useAssessmentStore.getState();
    expect(s.currentQuestionIndex).toBe(0);
    expect(s.textAnswer).toBe('keep me');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// submitCurrentTextAnswer — review mode saves without advancing or re-fetching.
// ────────────────────────────────────────────────────────────────────────────
describe('submitCurrentTextAnswer (review mode)', () => {
  it('saves, reflects the answer locally, clears any skip, and does NOT advance or re-fetch questions', async () => {
    useAssessmentStore.setState({
      allowReview: true,
      answerMode: 'written',
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 1,
      textAnswer: 'my answer to q2',
      answeredQuestionIds: new Set<string>(),
      skippedQuestionIds: new Set<string>(['q2']),
    });
    vi.mocked(api.getProgress).mockResolvedValue({
      ...baseProgress,
      totalQuestions: 2,
      answeredQuestions: 1,
      answeredQuestionIds: ['q2'],
    });

    await useAssessmentStore.getState().submitCurrentTextAnswer();

    const s = useAssessmentStore.getState();
    expect(api.submitTextAnswer).toHaveBeenCalledWith('z1', 'q2', 'a1', 'my answer to q2');
    expect(api.getQuestions).not.toHaveBeenCalled(); // no re-fetch / no index reset
    expect(s.currentQuestionIndex).toBe(1); // stayed on the question
    expect(s.answeredQuestionIds.has('q2')).toBe(true);
    expect(s.skippedQuestionIds.has('q2')).toBe(false); // skip marker cleared
    expect(s.questions[1].priorAnswer).toBe('my answer to q2'); // reflected locally for re-nav
  });
});
