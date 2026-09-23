/**
 * Background camera recording in 30s chunks. Each chunk goes to S3 via a presigned URL,
 * then a manifest entry is POSTed. Failed chunks are buffered (bounded) and re-flushed.
 *
 * One MediaRecorder per chunk, not start(timeslice): with a timeslice only the first blob
 * carries the WebM header, so later chunks can't play on their own. Chunk indexes are
 * persisted per student+assessment so a refresh or camera re-grant never reuses an S3 key.
 */

import { getUploadUrl, uploadAudioToS3, submitProctorChunk } from './api';

export interface ProctoringOptions {
  studentId: string;
  assessmentId: string;
  onPermissionRevoked?: () => void;
  onChunkUploaded?: (chunkIndex: number) => void;
  onError?: (error: Error) => void;
}

const CHUNK_INTERVAL_MS = 30_000;

const UPLOAD_MAX_ATTEMPTS = 3; // includes the initial attempt
const UPLOAD_RETRY_BASE_MS = 500;
// Bounds memory during a long outage; oldest chunk is dropped on overflow.
const FAILED_BUFFER_CAP = 10;
// Debounce before treating a track `onended` as a real revocation rather than a blip.
const REVOCATION_CONFIRM_MS = 1_500;

// index is assigned at capture time.
interface PendingChunk {
  blob: Blob;
  index: number;
}

export class ProctoringRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private rotateTimer: ReturnType<typeof setInterval> | null = null;
  private lastStop: Promise<void> = Promise.resolve();
  private memoryIndex = 0;
  private options: ProctoringOptions;
  private uploadQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  // Chunks that exhausted retries; flushed on the next success.
  private failedBuffer: PendingChunk[] = [];

  constructor(options: ProctoringOptions) {
    this.options = options;
  }

  /** The stream is not owned: stop() does not stop its tracks. */
  start(stream: MediaStream): void {
    if (this.mediaRecorder) return;

    const mimeType = this.getSupportedMimeType();

    // onended can fire on a device blip or tab backgrounding. Only report revocation if,
    // after a debounce, no video track is live.
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (this.stopped) return;
        setTimeout(() => {
          if (this.stopped) return;
          const stillProctoring = stream.getVideoTracks().some(
            (t) => t.readyState === 'live'
          );
          if (!stillProctoring) {
            this.options.onPermissionRevoked?.();
          }
        }, REVOCATION_CONFIRM_MS);
      };
    });

    this.mediaRecorder = this.recordChunk(stream, mimeType);
    // Start the next recorder before stopping the previous one, so there is no gap.
    this.rotateTimer = setInterval(() => {
      // Ended stream (camera revoked): the current recorder stops itself and its chunk
      // still uploads; a new MediaRecorder would throw on an inactive stream.
      if (!stream.active) return;
      const previous = this.mediaRecorder;
      this.mediaRecorder = this.recordChunk(stream, mimeType);
      this.stopRecorder(previous);
    }, CHUNK_INTERVAL_MS);
  }

  /** One MediaRecorder per chunk (no timeslice), so each chunk is a complete file. */
  private recordChunk(stream: MediaStream, mimeType: string): MediaRecorder {
    const index = this.claimChunkIndex();
    const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined });
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const blob = new Blob([event.data], { type: mimeType || 'video/webm' });
      // Sequential queue keeps chunk_index uploads ordered.
      this.uploadQueue = this.uploadQueue.then(() => this.uploadChunk(blob, index));
    };
    recorder.start();
    return recorder;
  }

  private stopRecorder(recorder: MediaRecorder | null): void {
    if (!recorder || recorder.state === 'inactive') return;
    // dataavailable fires before stop, so once this resolves the chunk is queued.
    this.lastStop = new Promise((resolve) =>
      recorder.addEventListener('stop', () => resolve(), { once: true })
    );
    recorder.stop();
  }

  /**
   * Next chunk index, persisted so a later recorder for the same student+assessment never
   * reuses an index and overwrites an S3 key.
   * ponytail: per-browser counter; a second device on the same attempt can still
   * collide. Move index assignment server-side if that ever happens.
   */
  private claimChunkIndex(): number {
    const key = `proctor_next_chunk_${this.options.studentId}_${this.options.assessmentId}`;
    let index = this.memoryIndex;
    try {
      index = Math.max(index, Number(localStorage.getItem(key)) || 0);
      localStorage.setItem(key, String(index + 1));
    } catch {
      // Storage unavailable: in-memory numbering still holds for this instance.
    }
    this.memoryIndex = index + 1;
    return index;
  }

  stop(): void {
    this.stopped = true;
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    this.stopRecorder(this.mediaRecorder);
  }

  /** Wait for the final chunk and all in-flight uploads, then attempt one buffer flush. */
  async drain(): Promise<void> {
    await this.lastStop;
    await this.uploadQueue;
    await this.flushFailedBuffer();
  }

  // onError drives the store's non-blocking degraded banner.
  private async uploadChunk(blob: Blob, index: number): Promise<void> {
    try {
      await this.attemptUpload(blob, index);
      this.options.onChunkUploaded?.(index);
      await this.flushFailedBuffer();
    } catch (error) {
      this.bufferFailed({ blob, index });
      this.options.onError?.(
        error instanceof Error ? error : new Error('Chunk upload failed')
      );
    }
  }

  private async attemptUpload(blob: Blob, index: number): Promise<void> {
    const { studentId, assessmentId } = this.options;
    // Key (proctoring/<assessment>/<student>/chunk_<index>.<ext>) is built
    // server-side; the student id comes from the auth token, not from here.
    const target = { kind: 'proctoring' as const, assessmentId, chunkIndex: index };

    let lastError: unknown;
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const { uploadUrl, fileUrl } = await getUploadUrl(target, blob.type);
        await uploadAudioToS3(uploadUrl, blob);
        await submitProctorChunk(studentId, assessmentId, fileUrl, index);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < UPLOAD_MAX_ATTEMPTS) {
          const backoff = UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Chunk upload failed');
  }

  private bufferFailed(chunk: PendingChunk): void {
    this.failedBuffer.push(chunk);
    if (this.failedBuffer.length > FAILED_BUFFER_CAP) {
      this.failedBuffer.shift();
      this.options.onError?.(
        new Error('Proctoring upload buffer full — oldest chunk dropped')
      );
    }
  }

  // Stops at the first failure to preserve order and avoid spinning on a persistent outage.
  private async flushFailedBuffer(): Promise<void> {
    if (this.failedBuffer.length === 0) return;
    const pending = this.failedBuffer;
    this.failedBuffer = [];
    for (let i = 0; i < pending.length; i++) {
      const chunk = pending[i];
      try {
        await this.attemptUpload(chunk.blob, chunk.index);
        this.options.onChunkUploaded?.(chunk.index);
      } catch {
        for (let j = i; j < pending.length; j++) this.bufferFailed(pending[j]);
        return;
      }
    }
  }

  private getSupportedMimeType(): string {
    const types = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }
}

export default ProctoringRecorder;
