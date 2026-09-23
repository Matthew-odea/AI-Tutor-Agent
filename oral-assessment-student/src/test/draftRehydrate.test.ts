import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Progress, Question } from '../types';

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

// Asserts store wiring around drafts, not real IndexedDB.
vi.mock('../services/draftStore', () => ({
  saveAudioDraft: vi.fn().mockResolvedValue(undefined),
  loadAudioDraft: vi.fn().mockResolvedValue(null),
  clearAudioDraft: vi.fn().mockResolvedValue(undefined),
  saveTextDraft: vi.fn(),
  loadTextDraft: vi.fn().mockReturnValue(null),
  clearTextDraft: vi.fn(),
}));

import * as api from '../services/api';
import * as draftStore from '../services/draftStore';
import { useAssessmentStore } from '../store/assessmentStore';

const q = (id: string): Question => ({
  id,
  assessmentId: 'a1',
  studentId: 'z1',
  createdAt: '',
});

const baseProgress: Progress = {
  studentId: 'z1',
  studentName: 'Test Student',
  studentEmail: 'student@example.test',
  assessmentId: 'a1',
  assessmentTitle: 'Test Assessment',
  totalQuestions: 2,
  answeredQuestions: 0,
  percentage: 0,
  status: 'in-progress',
};

const baseQuestionsResponse = {
  ok: true,
  studentId: 'z1',
  assessmentId: 'a1',
  totalQuestions: 2,
  allowReview: false,
};

const audioBlob = () => new Blob(['audio'], { type: 'audio/webm' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.setItem('studentToken', 'token');
  useAssessmentStore.getState().reset();
  useAssessmentStore.setState({
    studentId: 'z1',
    assessmentId: 'a1',
    questions: [q('q1'), q('q2')],
    currentQuestionIndex: 0,
  });
});

// Persist-on-capture
describe('persist on capture', () => {
  it('setTextAnswer persists a NON-empty draft for the current question', () => {
    useAssessmentStore.getState().setTextAnswer('partial answer');
    expect(draftStore.saveTextDraft).toHaveBeenCalledWith('a1', 'q1', 'partial answer');
  });

  it('setTextAnswer does NOT persist an empty/whitespace value (so the reset-effect clear cannot clobber a draft)', () => {
    useAssessmentStore.getState().setTextAnswer('');
    useAssessmentStore.getState().setTextAnswer('   ');
    expect(draftStore.saveTextDraft).not.toHaveBeenCalled();
  });

  it('stopRecording persists the captured blob + duration keyed to the current question id', async () => {
    const blob = audioBlob();
    const fakeRecorder = {
      stop: vi.fn().mockResolvedValue(blob),
      getDuration: vi.fn().mockReturnValue(7),
      getState: vi.fn().mockReturnValue('recording'),
      cleanup: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useAssessmentStore.setState({ audioRecorder: fakeRecorder as any, isRecording: true });

    await useAssessmentStore.getState().stopRecording();

    expect(draftStore.saveAudioDraft).toHaveBeenCalledWith({
      assessmentId: 'a1',
      questionId: 'q1',
      blob,
      durationSeconds: 7,
    });
  });
});

// rehydrateDraft — audio
describe('rehydrateDraft (audio)', () => {
  it('restores recordedBlob + duration when the draft matches the current question and none is in memory', async () => {
    const blob = audioBlob();
    vi.mocked(draftStore.loadAudioDraft).mockResolvedValueOnce({ questionId: 'q1', blob, durationSeconds: 33 });

    const recovered = await useAssessmentStore.getState().rehydrateDraft();

    const state = useAssessmentStore.getState();
    expect(recovered).toBe(true);
    expect(state.recordedBlob).toBe(blob);
    expect(state.recordingDuration).toBe(33);
  });

  it('does NOT overwrite a fresh in-memory recording even if a matching draft exists', async () => {
    const fresh = audioBlob();
    const stale = audioBlob();
    useAssessmentStore.setState({ recordedBlob: fresh });
    vi.mocked(draftStore.loadAudioDraft).mockResolvedValueOnce({ questionId: 'q1', blob: stale, durationSeconds: 99 });

    await useAssessmentStore.getState().rehydrateDraft();

    expect(useAssessmentStore.getState().recordedBlob).toBe(fresh);
  });

  it('discards a STALE audio draft (questionId != current) and never sets recordedBlob', async () => {
    vi.mocked(draftStore.loadAudioDraft).mockResolvedValueOnce({
      questionId: 'q-old',
      blob: audioBlob(),
      durationSeconds: 10,
    });

    const recovered = await useAssessmentStore.getState().rehydrateDraft();

    expect(recovered).toBe(false);
    expect(useAssessmentStore.getState().recordedBlob).toBeNull();
    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });

  it('matches the LIVE question after the async load (no stale leak if the index advances mid-read)', async () => {
    const blob = audioBlob();
    // The IndexedDB read resolves only AFTER the store has advanced q1 -> q2.
    // The draft is for q1, but by the time it loads we are on q2, so it must be
    // discarded rather than leaked onto q2.
    vi.mocked(draftStore.loadAudioDraft).mockImplementationOnce(async () => {
      useAssessmentStore.setState({ currentQuestionIndex: 1 });
      return { questionId: 'q1', blob, durationSeconds: 12 };
    });

    const recovered = await useAssessmentStore.getState().rehydrateDraft();

    expect(recovered).toBe(false);
    expect(useAssessmentStore.getState().recordedBlob).toBeNull();
    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });
});

// rehydrateDraft — text
describe('rehydrateDraft (text)', () => {
  it('restores textAnswer when empty and the draft matches the current question', async () => {
    vi.mocked(draftStore.loadTextDraft).mockReturnValueOnce({ questionId: 'q1', text: 'recovered text' });

    const recovered = await useAssessmentStore.getState().rehydrateDraft();

    expect(recovered).toBe(true);
    expect(useAssessmentStore.getState().textAnswer).toBe('recovered text');
  });

  it('does NOT overwrite a non-empty textAnswer the student already has', async () => {
    useAssessmentStore.setState({ textAnswer: 'live typing' });
    vi.mocked(draftStore.loadTextDraft).mockReturnValueOnce({ questionId: 'q1', text: 'old draft' });

    await useAssessmentStore.getState().rehydrateDraft();

    expect(useAssessmentStore.getState().textAnswer).toBe('live typing');
  });

  it('discards a STALE text draft (questionId != current)', async () => {
    vi.mocked(draftStore.loadTextDraft).mockReturnValueOnce({ questionId: 'q-old', text: 'leftover' });

    const recovered = await useAssessmentStore.getState().rehydrateDraft();

    expect(recovered).toBe(false);
    expect(useAssessmentStore.getState().textAnswer).toBe('');
    expect(draftStore.clearTextDraft).toHaveBeenCalledWith('a1');
  });

  it('returns false (no-op) when there is no assessment or current question', async () => {
    useAssessmentStore.setState({ assessmentId: null });
    expect(await useAssessmentStore.getState().rehydrateDraft()).toBe(false);
  });
});

// Draft clearing on every terminal path
describe('drafts cleared on success / skip / cancel / reset', () => {
  it('clears the audio draft after a SUCCESSFUL audio submit', async () => {
    vi.mocked(api.getQuestions).mockResolvedValue({
      ...baseQuestionsResponse,
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 1,
      answerMode: 'oral',
    });
    vi.mocked(api.getProgress).mockResolvedValue({ ...baseProgress, answeredQuestions: 1 });
    useAssessmentStore.setState({ recordedBlob: audioBlob(), recordingDuration: 5 });

    await useAssessmentStore.getState().submitCurrentAnswer();

    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });

  it('clears the text draft after a SUCCESSFUL text submit', async () => {
    vi.mocked(api.getQuestions).mockResolvedValue({
      ...baseQuestionsResponse,
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 1,
      answerMode: 'written',
    });
    vi.mocked(api.getProgress).mockResolvedValue({ ...baseProgress, answeredQuestions: 1 });
    useAssessmentStore.setState({ answerMode: 'written', textAnswer: 'final answer' });

    await useAssessmentStore.getState().submitCurrentTextAnswer();

    expect(draftStore.clearTextDraft).toHaveBeenCalledWith('a1');
  });

  it('clears BOTH drafts on skip', async () => {
    vi.mocked(api.getQuestions).mockResolvedValue({
      ...baseQuestionsResponse,
      questions: [q('q1'), q('q2')],
      currentQuestionIndex: 1,
      answerMode: 'written',
    });
    vi.mocked(api.getProgress).mockResolvedValue({ ...baseProgress, answeredQuestions: 0 });

    await useAssessmentStore.getState().skipCurrentQuestion('written');

    expect(draftStore.clearTextDraft).toHaveBeenCalledWith('a1');
    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });

  it('clears the audio draft when a recording is cancelled / re-recorded', () => {
    const fakeRecorder = {
      stop: vi.fn(),
      getState: vi.fn().mockReturnValue('recording'),
      cleanup: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useAssessmentStore.setState({ audioRecorder: fakeRecorder as any, recordedBlob: audioBlob() });

    useAssessmentStore.getState().cancelRecording();

    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });

  it('clears the audio draft on cancel even when audioRecorder is null (post-rehydrate / mic-denied re-record)', () => {
    // Refresh-recovery state: recordedBlob was restored from IndexedDB but the
    // recorder has not (or cannot) re-initialise. Discarding must still work.
    useAssessmentStore.setState({ audioRecorder: null, recordedBlob: audioBlob() });

    useAssessmentStore.getState().cancelRecording();

    const state = useAssessmentStore.getState();
    expect(state.recordedBlob).toBeNull();
    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });

  it('clears BOTH drafts on full reset', () => {
    useAssessmentStore.getState().reset();
    expect(draftStore.clearTextDraft).toHaveBeenCalledWith('a1');
    expect(draftStore.clearAudioDraft).toHaveBeenCalledWith('a1');
  });
});
