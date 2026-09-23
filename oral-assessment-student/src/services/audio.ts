export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  duration: number;
  blob: Blob | null;
}

/** Safari prefixes it as webkitAudioContext. Null when unsupported. */
export function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

/** RMS of getByteTimeDomainData bytes (128 = silence), normalised to 0..1. */
export function rmsFromTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return rms > 1 ? 1 : rms;
}

export const STATIC_AMPLITUDE = 0;

/** DeviceCheck gate: permission granted plus evidence of sound (meter crossed threshold, or a sample was recorded). */
export interface MicConfirmation {
  permissionState: 'prompting' | 'granted' | 'denied' | 'error';
  hasDetectedSound: boolean;
  hasSample: boolean;
}

export function isMicConfirmed({
  permissionState,
  hasDetectedSound,
  hasSample,
}: MicConfirmation): boolean {
  if (permissionState !== 'granted') return false;
  return hasDetectedSound || hasSample;
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startTime: number = 0;
  private pausedTime: number = 0;
  // False when wrapping the proctoring track: cleanup() must not stop it.
  private ownsStream = true;
  // Amplitude metering for the breathing ring; null when unsupported or attach failed.
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  // Concrete ArrayBuffer (not ArrayBufferLike) to satisfy getByteTimeDomainData's TS DOM signature.
  private timeDomainData: Uint8Array<ArrayBuffer> | null = null;

  /**
   * - Live MediaStreamTrack (proctoring audio): wrapped without getUserMedia, since a second
   *   capture throws NotReadableError on Safari/iOS. Not owned; cleanup() leaves it running.
   * - deviceId string (DeviceCheck): own stream pinned to that input.
   * - Omitted, or a dead track: own stream on the default device.
   */
  async initialize(arg?: MediaStreamTrack | string): Promise<void> {
    const deviceId = typeof arg === 'string' ? arg : undefined;
    const existingAudioTrack = typeof arg === 'string' ? undefined : arg;
    try {
      if (existingAudioTrack && existingAudioTrack.readyState === 'live') {
        this.ownsStream = false;
        this.stream = new MediaStream([existingAudioTrack]);
      } else {
        this.ownsStream = true;
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        };
        if (deviceId) {
          audioConstraints.deviceId = { exact: deviceId };
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      }

      const mimeType = this.getSupportedMimeType();

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.attachAmplitudeAnalyser();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          throw new Error('Microphone permission denied. Please allow microphone access to record your answer.');
        } else if (error.name === 'NotFoundError') {
          throw new Error('No microphone found. Please connect a microphone and try again.');
        } else if (error.name === 'NotReadableError' || error.name === 'AbortError') {
          // Mic already held by another capture (proctoring camera on Safari/iOS).
          throw new Error('Your microphone is already in use by the proctoring camera. Please reload the page and grant access again.');
        } else {
          throw new Error(`Failed to initialize audio recorder: ${error.message}`);
        }
      }
      throw error;
    }
  }

  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return ''; // browser default
  }

  start(): void {
    if (!this.mediaRecorder) {
      throw new Error('Audio recorder not initialized');
    }

    if (this.mediaRecorder.state === 'recording') {
      return;
    }

    this.audioChunks = [];
    this.startTime = Date.now();
    this.mediaRecorder.start(100); // timeslice ms
  }

  async stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('Audio recorder not initialized'));
        return;
      }

      if (this.mediaRecorder.state === 'inactive') {
        reject(new Error('Recorder is not active'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, { 
          type: this.mediaRecorder?.mimeType || 'audio/webm' 
        });
        
        if (blob.size === 0) {
          reject(new Error('Recording failed - no audio data captured'));
          return;
        }

        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  pause(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
      return;
    }

    this.mediaRecorder.pause();
    this.pausedTime = Date.now();
  }

  resume(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'paused') {
      return;
    }

    this.mediaRecorder.resume();
    this.startTime += Date.now() - this.pausedTime;
  }

  /** Seconds. Keeps growing while paused; startTime is only corrected on resume. */
  getDuration(): number {
    if (!this.startTime) return 0;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  getState(): 'inactive' | 'recording' | 'paused' {
    return this.mediaRecorder?.state || 'inactive';
  }

  // DeviceCheck attaches its own AnalyserNode to this for the input-level meter.
  getStream(): MediaStream | null {
    return this.stream;
  }

  // Best-effort and idempotent: metering is decorative and must never break recording.
  private attachAmplitudeAnalyser(): void {
    if (!this.stream) return;
    if (this.analyser) return;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(this.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.audioContext = ctx;
      this.analyser = analyser;
      this.timeDomainData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      this.audioContext = null;
      this.analyser = null;
      this.timeDomainData = null;
    }
  }

  /** 0..1, or STATIC_AMPLITUDE with no analyser. Cheap enough to call every animation frame. */
  getAmplitude(): number {
    if (!this.analyser || !this.timeDomainData) return STATIC_AMPLITUDE;
    this.analyser.getByteTimeDomainData(this.timeDomainData);
    return rmsFromTimeDomain(this.timeDomainData);
  }

  createAudioUrl(blob: Blob): string {
    return URL.createObjectURL(blob);
  }

  releaseAudioUrl(url: string): void {
    URL.revokeObjectURL(url);
  }

  cleanup(): void {
    // Closing the context never stops the underlying track. close() can reject if already closed.
    if (this.audioContext) {
      const ctx = this.audioContext;
      if (ctx.state !== 'closed' && typeof ctx.close === 'function') {
        void Promise.resolve(ctx.close()).catch(() => {});
      }
    }
    this.audioContext = null;
    this.analyser = null;
    this.timeDomainData = null;

    if (this.stream) {
      // A reused proctoring track is stopped by stopProctoring(), not here.
      if (this.ownsStream) {
        this.stream.getTracks().forEach(track => track.stop());
      }
      this.stream = null;
    }

    this.mediaRecorder = null;
    this.audioChunks = [];
    this.startTime = 0;
    this.pausedTime = 0;
  }

  // Labels are blank until mic permission is granted, so call after initialize() resolves.
  static async listInputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  static isSupported(): boolean {
    return !!(
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      window.MediaRecorder
    );
  }

  getFileExtension(): string {
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4')) return 'mp4';
    
    return 'webm';
  }
}

export default AudioRecorder;
