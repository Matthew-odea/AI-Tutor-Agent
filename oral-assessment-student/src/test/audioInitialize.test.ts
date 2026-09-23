import { describe, it, expect, vi, beforeEach } from 'vitest';
import AudioRecorder from '../services/audio';

function fakeTrack(readyState: MediaStreamTrackState = 'live'): MediaStreamTrack {
  return {
    readyState,
    kind: 'audio',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

beforeEach(() => {
  vi.restoreAllMocks();
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    state = 'inactive';
    mimeType = 'audio/webm';
    stream: MediaStream;
    constructor(stream: MediaStream) {
      this.stream = stream;
    }
    start() {}
    stop() {}
  }
  // @ts-expect-error test stub
  globalThis.MediaRecorder = FakeMediaRecorder;
  // @ts-expect-error test stub — wrap whatever tracks are passed.
  globalThis.MediaStream = class {
    private tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
  };
});

describe('AudioRecorder.initialize', () => {
  it('reuses a passed live audio track without calling getUserMedia, and does not stop it on cleanup', async () => {
    const getUserMedia = vi.fn();
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const track = fakeTrack('live');
    const rec = new AudioRecorder();
    await rec.initialize(track);

    expect(getUserMedia).not.toHaveBeenCalled();

    rec.cleanup();
    // The reused (proctoring-owned) track must NOT be stopped by the recorder.
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('falls back to getUserMedia when no track is passed, and owns/stops that stream', async () => {
    const ownTrack = fakeTrack('live');
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [ownTrack],
    });
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await rec.initialize();

    expect(getUserMedia).toHaveBeenCalledTimes(1);

    rec.cleanup();
    // The recorder owns this stream → it must stop the track.
    expect(ownTrack.stop).toHaveBeenCalled();
  });

  it('falls back to getUserMedia when the passed track is not live (ended)', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [fakeTrack('live')] });
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await rec.initialize(fakeTrack('ended'));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('maps NotReadableError to the explicit "microphone already in use" message', async () => {
    const err = new Error('busy');
    err.name = 'NotReadableError';
    const getUserMedia = vi.fn().mockRejectedValue(err);
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await expect(rec.initialize()).rejects.toThrow(/already in use by the proctoring camera/i);
  });

  it('maps AbortError to the same explicit message', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const getUserMedia = vi.fn().mockRejectedValue(err);
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await expect(rec.initialize()).rejects.toThrow(/already in use by the proctoring camera/i);
  });
});
