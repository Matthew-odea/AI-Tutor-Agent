import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTimerExpiry, type TimerExpiryDeps } from '../utils/timerExpiry';
import type { Question } from '../types';

// ── Mock the network + upload layers so the store never touches a real backend ──
vi.mock('../services/api', () => ({
  getStudentToken: vi.fn().mockResolvedValue('token'),
  getQuestions: vi.fn().mockResolvedValue({
    questions: [{ id: 'q1', assessmentId: 'a1', studentId: 'z1', createdAt: '', timeLimit: 120 }],
    currentQuestionIndex: 1,
    answerMode: 'oral',
  }),
  getProgress: vi.fn().mockResolvedValue({
    studentId: 'z1',
    assessmentId: 'a1',
    totalQuestions: 1,
    answeredQuestions: 1,
    percentage: 100,
    status: 'in-progress',
  }),
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
import type AudioRecorder from '../services/audio';

const audioBlob = () => new Blob(['fake-audio'], { type: 'audio/webm' });

const baseQuestion: Question = {
  id: 'q1',
  assessmentId: 'a1',
  studentId: 'z1',
  createdAt: '',
  timeLimit: 120,
};

// ────────────────────────────────────────────────────────────────────────────
// runTimerExpiry — the pure decision logic extracted from handleTimerExpire.
// ────────────────────────────────────────────────────────────────────────────
function makeDeps(overrides: Partial<TimerExpiryDeps> = {}): TimerExpiryDeps {
  return {
    inFlight: false,
    answerMode: 'oral',
    getIsRecording: () => false,
    getRecordedBlob: () => null,
    getTextAnswer: () => '',
    stopRecording: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    submitAudio: vi.fn().mockResolvedValue(undefined),
    submitText: vi.fn().mockResolvedValue(undefined),
    skip: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runTimerExpiry', () => {
  it('oral + existing recorded blob → submits AUDIO, never a text placeholder', async () => {
    const deps = makeDeps({ answerMode: 'oral', getRecordedBlob: () => audioBlob() });
    await runTimerExpiry(deps);
    expect(deps.submitAudio).toHaveBeenCalledTimes(1);
    expect(deps.submitText).not.toHaveBeenCalled();
    expect(deps.skip).not.toHaveBeenCalled();
  });

  it('oral + actively recording at expiry → stops first, then submits the just-captured blob', async () => {
    // The blob only exists AFTER stopRecording resolves — this is the "mid-sentence
    // when time expires" case that the old snapshot-gated code dropped to a skip.
    let stopped = false;
    const deps = makeDeps({
      answerMode: 'oral',
      getIsRecording: () => !stopped,
      getRecordedBlob: () => (stopped ? audioBlob() : null),
      stopRecording: vi.fn().mockImplementation(async () => {
        stopped = true;
      }),
    });
    await runTimerExpiry(deps);
    expect(deps.stopRecording).toHaveBeenCalledTimes(1);
    expect(deps.submitAudio).toHaveBeenCalledTimes(1);
    expect(deps.skip).not.toHaveBeenCalled();
    expect(deps.submitText).not.toHaveBeenCalled();
  });

  it('oral + no audio ever recorded → skip(oral), NOT a text answer', async () => {
    const deps = makeDeps({ answerMode: 'oral', getIsRecording: () => false, getRecordedBlob: () => null });
    await runTimerExpiry(deps);
    expect(deps.skip).toHaveBeenCalledTimes(1);
    expect(deps.skip).toHaveBeenCalledWith('oral');
    expect(deps.submitText).not.toHaveBeenCalled();
    expect(deps.submitAudio).not.toHaveBeenCalled();
  });

  it('written + 3-char non-empty answer → submits that text (no >= 20 threshold)', async () => {
    const deps = makeDeps({ answerMode: 'written', getTextAnswer: () => 'n+1' });
    await runTimerExpiry(deps);
    expect(deps.submitText).toHaveBeenCalledTimes(1);
    expect(deps.skip).not.toHaveBeenCalled();
  });

  it('written + whitespace-only answer → skip(written)', async () => {
    const deps = makeDeps({ answerMode: 'written', getTextAnswer: () => '   \n\t ' });
    await runTimerExpiry(deps);
    expect(deps.skip).toHaveBeenCalledTimes(1);
    expect(deps.skip).toHaveBeenCalledWith('written');
    expect(deps.submitText).not.toHaveBeenCalled();
  });

  it('re-entrancy: inFlight → no-op (no stop, no submit, no skip) even with a blob present', async () => {
    const deps = makeDeps({ inFlight: true, answerMode: 'oral', getIsRecording: () => true, getRecordedBlob: () => audioBlob() });
    await runTimerExpiry(deps);
    expect(deps.stopRecording).not.toHaveBeenCalled();
    expect(deps.submitAudio).not.toHaveBeenCalled();
    expect(deps.submitText).not.toHaveBeenCalled();
    expect(deps.skip).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Store skip/submit paths — proves the actual POST shapes, not just the decision.
// ────────────────────────────────────────────────────────────────────────────
describe('assessmentStore expiry paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.clear();
    localStorage.setItem('studentToken', 'token');
    useAssessmentStore.setState({
      studentId: 'z1',
      assessmentId: 'a1',
      questions: [baseQuestion],
      currentQuestionIndex: 0,
      answeredQuestionIds: new Set<string>(),
      answerMode: 'oral',
      textAnswer: '',
      recordedBlob: null,
      recordingDuration: 0,
      recordingStartTime: 1000,
      isUploading: false,
      isRecording: false,
      error: null,
    });
  });

  it('skipCurrentQuestion("oral") records an explicit skip, never "(time expired)" text', async () => {
    await useAssessmentStore.getState().skipCurrentQuestion('oral');
    expect(api.submitSkip).toHaveBeenCalledWith('z1', 'q1', 'a1', 'oral');
    expect(api.submitTextAnswer).not.toHaveBeenCalled();
  });

  it('skipCurrentQuestion("oral") falls back to [NO_ORAL_ANSWER] when backend 422s the skip', async () => {
    vi.mocked(api.submitSkip).mockRejectedValueOnce({ status: 422, message: 'Unprocessable Entity' });
    await useAssessmentStore.getState().skipCurrentQuestion('oral');
    expect(api.submitTextAnswer).toHaveBeenCalledWith('z1', 'q1', 'a1', '[NO_ORAL_ANSWER]');
    // The oral fallback must NOT be the written placeholder.
    expect(api.submitTextAnswer).not.toHaveBeenCalledWith('z1', 'q1', 'a1', '(time expired)');
  });

  it('skipCurrentQuestion("written") falls back to "(time expired)" when backend 400s the skip', async () => {
    vi.mocked(api.submitSkip).mockRejectedValueOnce({ status: 400, message: 'Bad Request' });
    await useAssessmentStore.getState().skipCurrentQuestion('written');
    expect(api.submitTextAnswer).toHaveBeenCalledWith('z1', 'q1', 'a1', '(time expired)');
  });

  it('skipCurrentQuestion surfaces a non-4xx failure instead of papering it over with a fake answer', async () => {
    vi.mocked(api.submitSkip).mockRejectedValueOnce({ status: 0, message: 'Could not reach the server' });
    await useAssessmentStore.getState().skipCurrentQuestion('oral');
    expect(api.submitTextAnswer).not.toHaveBeenCalled();
    expect(useAssessmentStore.getState().error?.message).toMatch(/server/i);
  });

  it('submitCurrentAnswer posts AUDIO (not text) and clears recordingStartTime', async () => {
    useAssessmentStore.setState({ recordedBlob: audioBlob(), recordingDuration: 7 });
    await useAssessmentStore.getState().submitCurrentAnswer();
    expect(api.submitAnswer).toHaveBeenCalledTimes(1);
    expect(api.submitTextAnswer).not.toHaveBeenCalled();
    expect(useAssessmentStore.getState().recordingStartTime).toBeNull();
  });

  it('submitCurrentTextAnswer submits a short answer verbatim', async () => {
    useAssessmentStore.setState({ answerMode: 'written', textAnswer: '42' });
    await useAssessmentStore.getState().submitCurrentTextAnswer();
    expect(api.submitTextAnswer).toHaveBeenCalledWith('z1', 'q1', 'a1', '42');
  });

  it('stopRecording dedupes concurrent calls (manual Stop racing timer expiry) — stop() runs once, blob kept', async () => {
    let resolveStop!: (b: Blob) => void;
    const pending = new Promise<Blob>((res) => { resolveStop = res; });
    const fakeRecorder = {
      stop: vi.fn().mockReturnValue(pending),
      getDuration: vi.fn().mockReturnValue(5),
    };
    useAssessmentStore.setState({
      audioRecorder: fakeRecorder as unknown as AudioRecorder,
      isRecording: true,
      isStopping: false,
      recordedBlob: null,
    });

    // Two near-simultaneous stops: the timer-expiry handler and the manual Stop button.
    const p1 = useAssessmentStore.getState().stopRecording();
    const p2 = useAssessmentStore.getState().stopRecording();
    resolveStop(audioBlob());
    await Promise.all([p1, p2]);

    expect(fakeRecorder.stop).toHaveBeenCalledTimes(1); // never stopped twice (no rejection, no lost blob)
    expect(useAssessmentStore.getState().recordedBlob).not.toBeNull();
    expect(useAssessmentStore.getState().isRecording).toBe(false);
    expect(useAssessmentStore.getState().isStopping).toBe(false);
  });
});

// The recorder's remaining-time display is `timeLimit - recordingDuration`. If the
// clock keeps advancing while paused it diverges from the (frozen) header timer.
describe('recordingDuration freezes while paused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useAssessmentStore.setState({
      isRecording: false,
      isStopping: false,
      isPaused: false,
      recordingDuration: 0,
      recordingStartTime: null,
      recordedBlob: null,
      error: null,
    });
  });
  afterEach(() => {
    // tear the recording interval down, then restore real timers
    useAssessmentStore.setState({ isRecording: false });
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
  });

  it('does not advance the clock during a pause, and resumes correctly', () => {
    let dur = 0;
    const fakeRecorder = {
      start: vi.fn(),
      getDuration: vi.fn().mockImplementation(() => dur),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    useAssessmentStore.setState({ audioRecorder: fakeRecorder as unknown as AudioRecorder });

    useAssessmentStore.getState().startRecording(); // isRecording=true, starts the 1s interval
    dur = 1; vi.advanceTimersByTime(1000);
    dur = 2; vi.advanceTimersByTime(1000);
    dur = 3; vi.advanceTimersByTime(1000);
    expect(useAssessmentStore.getState().recordingDuration).toBe(3);

    // Pause: getDuration() would keep growing on wall-clock, but the clock must freeze.
    useAssessmentStore.getState().pauseRecording();
    dur = 4; vi.advanceTimersByTime(1000);
    dur = 5; vi.advanceTimersByTime(1000);
    expect(useAssessmentStore.getState().recordingDuration).toBe(3); // frozen, matches header

    // Resume: audio.ts shifts startTime so getDuration() continues from where it froze.
    useAssessmentStore.getState().resumeRecording();
    dur = 4; vi.advanceTimersByTime(1000);
    expect(useAssessmentStore.getState().recordingDuration).toBe(4);
  });
});
