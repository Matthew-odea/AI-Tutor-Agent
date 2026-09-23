import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  uploadAudio: vi.fn().mockResolvedValue('https://s3/a.webm'),
  validateAudioBlob: vi.fn().mockReturnValue(true),
}));

import { useAssessmentStore } from '../store/assessmentStore';

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

beforeEach(() => {
  setOnLine(true);
  useAssessmentStore.getState().reset();
});

describe('isOnline + initNetworkListeners', () => {
  it('initializes isOnline from navigator.onLine', () => {
    expect(typeof useAssessmentStore.getState().isOnline).toBe('boolean');
  });

  it('updates isOnline on offline/online window events while listeners are active', () => {
    const cleanup = useAssessmentStore.getState().initNetworkListeners();

    setOnLine(false);
    window.dispatchEvent(new Event('offline'));
    expect(useAssessmentStore.getState().isOnline).toBe(false);

    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    expect(useAssessmentStore.getState().isOnline).toBe(true);

    cleanup();
  });

  it('cleanup removes the listeners (no further updates)', () => {
    const cleanup = useAssessmentStore.getState().initNetworkListeners();
    cleanup();

    setOnLine(false);
    window.dispatchEvent(new Event('offline'));
    // Still whatever it was before; the removed listener must not update it.
    expect(useAssessmentStore.getState().isOnline).toBe(true);
  });

  it('reset() keeps isOnline reflecting navigator.onLine (not forced true)', () => {
    setOnLine(false);
    useAssessmentStore.getState().reset();
    expect(useAssessmentStore.getState().isOnline).toBe(false);
  });
});
