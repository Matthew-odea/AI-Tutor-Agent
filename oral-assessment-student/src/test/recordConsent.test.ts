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
  recordConsent: vi.fn(),
  CONSENT_VERSION: '2026-06-10',
}));

vi.mock('../services/s3', () => ({
  uploadAudio: vi.fn().mockResolvedValue('https://s3.example/audio.webm'),
  validateAudioBlob: vi.fn().mockReturnValue(true),
}));

import * as api from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';
import { useToastStore } from '../store/toastStore';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.setItem('studentToken', 'token');
  useAssessmentStore.getState().reset();
  useToastStore.getState().clearAllToasts();
  useAssessmentStore.setState({ studentId: 'z1', assessmentId: 'a1' });
});

describe('recordConsentDecision', () => {
  it('sets consentGiven + persists sessionStorage + calls recordConsent with granted=true', async () => {
    vi.mocked(api.recordConsent).mockResolvedValue(undefined);

    await useAssessmentStore.getState().recordConsentDecision(true);

    expect(useAssessmentStore.getState().consentGiven).toBe(true);
    expect(sessionStorage.getItem('consent_a1')).toBe('true');
    expect(api.recordConsent).toHaveBeenCalledWith('z1', 'a1', expect.objectContaining({
      granted: true,
      consentVersion: '2026-06-10',
      timestamp: expect.any(String),
    }));
  });

  it('records granted=false for a decline', async () => {
    vi.mocked(api.recordConsent).mockResolvedValue(undefined);

    await useAssessmentStore.getState().recordConsentDecision(false);

    expect(api.recordConsent).toHaveBeenCalledWith('z1', 'a1', expect.objectContaining({ granted: false }));
  });

  it('degrades gracefully on a failed server write: still consents locally, shows a non-blocking toast, never throws', async () => {
    vi.mocked(api.recordConsent).mockRejectedValue({ message: 'no endpoint', status: 404 });

    await expect(useAssessmentStore.getState().recordConsentDecision(true)).resolves.toBeUndefined();

    // Local consent stands despite the server failure — student is NOT blocked.
    expect(useAssessmentStore.getState().consentGiven).toBe(true);
    expect(sessionStorage.getItem('consent_a1')).toBe('true');
    // A non-blocking toast was surfaced.
    expect(useToastStore.getState().toasts.some((t) => t.type === 'warning')).toBe(true);
  });
});

describe('ensureProctoring (idempotent re-arm)', () => {
  it('no-ops when a live proctoring video track already exists', async () => {
    const liveVideo = { readyState: 'live', kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = { getVideoTracks: () => [liveVideo], getTracks: () => [liveVideo] } as unknown as MediaStream;
    useAssessmentStore.setState({ proctorStream: stream, isProctoringActive: true });

    const getUserMedia = vi.fn();
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia }, onLine: true };

    await useAssessmentStore.getState().ensureProctoring();

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
