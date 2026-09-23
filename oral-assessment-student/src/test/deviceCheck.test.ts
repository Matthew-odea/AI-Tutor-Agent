import { describe, it, expect, vi, beforeEach } from 'vitest';
import AudioRecorder, { isMicConfirmed } from '../services/audio';

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

function fakeTrack(readyState: MediaStreamTrackState = 'live'): MediaStreamTrack {
  return { readyState, kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack;
}

describe('AudioRecorder.listInputDevices', () => {
  it('returns only audioinput devices', async () => {
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'audioinput', deviceId: 'a', label: 'Mic A' },
      { kind: 'videoinput', deviceId: 'b', label: 'Cam B' },
      { kind: 'audiooutput', deviceId: 'c', label: 'Speaker C' },
      { kind: 'audioinput', deviceId: 'd', label: 'Mic D' },
    ]);
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { enumerateDevices } };

    const inputs = await AudioRecorder.listInputDevices();
    expect(inputs.map((d) => d.deviceId)).toEqual(['a', 'd']);
    expect(inputs.every((d) => d.kind === 'audioinput')).toBe(true);
  });

  it('returns [] when enumerateDevices is unavailable', async () => {
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: {} };
    await expect(AudioRecorder.listInputDevices()).resolves.toEqual([]);
  });
});

describe('AudioRecorder.initialize with a deviceId', () => {
  it('passes deviceId: { exact } into the audio constraints and preserves defaults', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [fakeTrack('live')] });
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await rec.initialize('mic-123');

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const arg = getUserMedia.mock.calls[0][0];
    expect(arg).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100,
        deviceId: { exact: 'mic-123' },
      },
    });
  });

  it('omits deviceId when no id is given (default device, unchanged behavior)', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [fakeTrack('live')] });
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await rec.initialize();

    const arg = getUserMedia.mock.calls[0][0];
    expect(arg).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
    });
    expect(arg.audio.deviceId).toBeUndefined();
  });

  it('still maps NotAllowedError to the permission-denied message on the deviceId path', async () => {
    const err = new Error('denied');
    err.name = 'NotAllowedError';
    const getUserMedia = vi.fn().mockRejectedValue(err);
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await expect(rec.initialize('mic-123')).rejects.toThrow(/allow microphone access/i);
  });

  it('still maps NotFoundError to the no-microphone message', async () => {
    const err = new Error('none');
    err.name = 'NotFoundError';
    const getUserMedia = vi.fn().mockRejectedValue(err);
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await expect(rec.initialize('mic-123')).rejects.toThrow(/No microphone found/i);
  });

  it('does not break the existing live-track reuse path (a track is not a deviceId)', async () => {
    const getUserMedia = vi.fn();
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const track = fakeTrack('live');
    const rec = new AudioRecorder();
    await rec.initialize(track);

    expect(getUserMedia).not.toHaveBeenCalled();
    rec.cleanup();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('getStream() exposes the live stream and null after cleanup', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [fakeTrack('live')] });
    // @ts-expect-error test stub
    globalThis.navigator = { mediaDevices: { getUserMedia } };

    const rec = new AudioRecorder();
    await rec.initialize('mic-123');
    expect(rec.getStream()).not.toBeNull();
    rec.cleanup();
    expect(rec.getStream()).toBeNull();
  });
});

describe('isMicConfirmed gating predicate', () => {
  it('is false while prompting, regardless of signal/sample', () => {
    expect(isMicConfirmed({ permissionState: 'prompting', hasDetectedSound: true, hasSample: true })).toBe(false);
  });

  it('is false when denied or errored, even with a stale signal/sample', () => {
    expect(isMicConfirmed({ permissionState: 'denied', hasDetectedSound: true, hasSample: true })).toBe(false);
    expect(isMicConfirmed({ permissionState: 'error', hasDetectedSound: true, hasSample: true })).toBe(false);
  });

  it('is false when granted but no signal and no sample (a muted mic stays disabled)', () => {
    expect(isMicConfirmed({ permissionState: 'granted', hasDetectedSound: false, hasSample: false })).toBe(false);
  });

  it('is true when granted and a signal was observed', () => {
    expect(isMicConfirmed({ permissionState: 'granted', hasDetectedSound: true, hasSample: false })).toBe(true);
  });

  it('is true when granted and a sample was recorded/played back', () => {
    expect(isMicConfirmed({ permissionState: 'granted', hasDetectedSound: false, hasSample: true })).toBe(true);
  });
});
