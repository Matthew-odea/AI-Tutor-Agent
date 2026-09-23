import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/api', () => ({
  getUploadUrl: vi.fn(),
  uploadAudioToS3: vi.fn(),
  submitProctorChunk: vi.fn(),
}));

import * as api from '../services/api';
import ProctoringRecorder from '../services/proctoring';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(api.getUploadUrl).mockResolvedValue({
    uploadUrl: 'https://s3.example/put',
    fileUrl: 'https://s3.example/file.webm',
  } as Awaited<ReturnType<typeof api.getUploadUrl>>);
  vi.mocked(api.uploadAudioToS3).mockResolvedValue(undefined);
  vi.mocked(api.submitProctorChunk).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeRecorder(overrides: Partial<ConstructorParameters<typeof ProctoringRecorder>[0]> = {}) {
  const onChunkUploaded = vi.fn();
  const onError = vi.fn();
  const rec = new ProctoringRecorder({
    studentId: 'z1',
    assessmentId: 'a1',
    onChunkUploaded,
    onError,
    ...overrides,
  });
  return { rec, onChunkUploaded, onError };
}

// uploadChunk is private; cast to reach the path ondataavailable feeds.
type UploadChunk = (blob: Blob, index: number) => Promise<void>;
const callUpload = (rec: ProctoringRecorder, blob: Blob, index: number): Promise<void> =>
  (rec as unknown as { uploadChunk: UploadChunk }).uploadChunk(blob, index);

const blob = () => new Blob(['x'], { type: 'video/webm' });

describe('ProctoringRecorder upload resilience', () => {
  it('retries a transient failure and reports success without onError', async () => {
    const { rec, onChunkUploaded, onError } = makeRecorder();
    // Fail the first getUploadUrl, succeed the second.
    vi.mocked(api.getUploadUrl)
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue({ uploadUrl: 'u', fileUrl: 'f' } as Awaited<ReturnType<typeof api.getUploadUrl>>);

    const p = callUpload(rec, blob(), 0);
    await vi.runAllTimersAsync();
    await p;

    expect(onChunkUploaded).toHaveBeenCalledWith(0);
    expect(onError).not.toHaveBeenCalled();
    expect(api.submitProctorChunk).toHaveBeenCalledWith('z1', 'a1', 'f', 0);
  });

  it('fires onError only after retries are exhausted, and buffers the chunk', async () => {
    const { rec, onChunkUploaded, onError } = makeRecorder();
    vi.mocked(api.getUploadUrl).mockRejectedValue(new Error('down'));

    const p = callUpload(rec, blob(), 5);
    await vi.runAllTimersAsync();
    await p;

    expect(onChunkUploaded).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    // 3 bounded attempts.
    expect(vi.mocked(api.getUploadUrl).mock.calls.length).toBe(3);
  });

  it('flushes a previously-failed chunk on the next successful upload, preserving index', async () => {
    const { rec, onChunkUploaded } = makeRecorder();
    // First chunk (index 0) fails all retries → buffered.
    vi.mocked(api.getUploadUrl).mockRejectedValue(new Error('down'));
    const p1 = callUpload(rec, blob(), 0);
    await vi.runAllTimersAsync();
    await p1;
    expect(onChunkUploaded).not.toHaveBeenCalled();

    // Recover: next chunk (index 1) succeeds and triggers a flush of index 0.
    vi.mocked(api.getUploadUrl).mockResolvedValue({ uploadUrl: 'u', fileUrl: 'f' } as Awaited<ReturnType<typeof api.getUploadUrl>>);
    const p2 = callUpload(rec, blob(), 1);
    await vi.runAllTimersAsync();
    await p2;

    const uploadedIndexes = onChunkUploaded.mock.calls.map((c) => c[0]).sort();
    expect(uploadedIndexes).toEqual([0, 1]);
  });

  it('drops the oldest and fires onError when the failed buffer overflows the cap', async () => {
    const { rec, onError } = makeRecorder();
    vi.mocked(api.getUploadUrl).mockRejectedValue(new Error('down'));

    // Push 11 failures; cap is 10 → one overflow drop + an extra onError for it.
    for (let i = 0; i < 11; i++) {
      const p = callUpload(rec, blob(), i);
      await vi.runAllTimersAsync();
      await p;
    }
    // 11 post-retry failures + 1 overflow-drop error.
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(12);
  });
});

// Regression: with MediaRecorder.start(timeslice) only the first blob carries the
// WebM header, so every later S3 chunk was unplayable on its own, and a new
// recorder after a refresh restarted at index 0 and overwrote the first footage.
describe('ProctoringRecorder chunk files', () => {
  it('records each chunk as its own file, keeps numbering across a restart, and uploads the final chunk', async () => {
    localStorage.clear();
    const startArgs: unknown[][] = [];
    class FakeRecorder extends EventTarget {
      static isTypeSupported = () => true;
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      start(...args: unknown[]) {
        startArgs.push(args);
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['x']) });
        this.dispatchEvent(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const stream = { active: true, getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;

    // First page load: two 30s rotations finish chunks 0 and 1; chunk 2 is still
    // recording when the student refreshes, so it is lost.
    const first = makeRecorder();
    first.rec.start(stream);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.clearAllTimers();

    // After the refresh a new recorder runs until submit.
    const second = makeRecorder();
    second.rec.start(stream);
    second.rec.stop();
    await second.rec.drain();
    vi.unstubAllGlobals();

    // No timeslice: each recorder emits one complete, standalone file.
    expect(startArgs.length).toBe(4);
    expect(startArgs.every((args) => args.length === 0)).toBe(true);
    // No index reused (so no S3 key overwritten); the final chunk is uploaded.
    const indexes = vi.mocked(api.submitProctorChunk).mock.calls.map((c) => c[3]);
    expect(indexes).toEqual([0, 1, 3]);
  });
});
