/**
 * Proctoring Service - Continuous background camera recording in 30s chunks
 *
 * Flow:
 *  1. startProctoring(stream) — attach the live camera stream, begin chunked recording
 *  2. Every 30 seconds a fresh MediaRecorder takes over and the previous one is
 *     stopped; its single blob → uploadChunk()
 *  3. uploadChunk uploads to S3 (presigned URL) then POSTs manifest to backend
 *  4. stopProctoring() stops the recorder and uploads the final partial chunk
 *  5. onPermissionRevoked callback fires if any track ends unexpectedly
 *
 * Why one recorder per chunk, not MediaRecorder.start(timeslice): with a timeslice
 * only the first blob carries the WebM header, so chunks 1..n cannot be played on
 * their own and a lost or overwritten chunk 0 makes the whole session unplayable.
 * A recorder per chunk makes every S3 object a complete, standalone video file.
 *
 * Chunk indexes are persisted per student+assessment in localStorage so a new
 * recorder after a refresh or camera re-grant continues numbering instead of
 * restarting at 0 and overwriting the earlier footage's S3 keys.
 */

import { getUploadUrl, uploadAudioToS3, submitProctorChunk } from './api';

export interface ProctoringOptions {
  studentId: string;
  assessmentId: string;
  onPermissionRevoked?: () => void;
  onChunkUploaded?: (chunkIndex: number) => void;
  onError?: (error: Error) => void;
}

const CHUNK_INTERVAL_MS = 30_000; // 30 seconds

// Upload resilience tuning.
const UPLOAD_MAX_ATTEMPTS = 3; // initial try + up to 2 retries
const UPLOAD_RETRY_BASE_MS = 500; // short backoff between attempts
// Cap on the in-memory buffer of chunks that failed all retries. Bounded so a
// long network outage can't grow memory unboundedly; oldest is dropped on overflow.
const FAILED_BUFFER_CAP = 10;
// Delay before a track `onended` is confirmed as a real revocation (vs a blip).
const REVOCATION_CONFIRM_MS = 1_500;

// A chunk awaiting (re)upload: its blob plus the index assigned at capture time.
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
  // Chunks that exhausted their retries, kept (bounded) so a later success can
  // flush them and we never silently lose footage on a transient outage.
  private failedBuffer: PendingChunk[] = [];

  constructor(options: ProctoringOptions) {
    this.options = options;
  }

  /**
   * Begin chunked proctoring. Pass the existing camera stream (from VideoRecorder
   * or a dedicated getUserMedia call). The stream is not owned by this class and
   * will NOT be stopped when stopProctoring() is called.
   */
  start(stream: MediaStream): void {
    if (this.mediaRecorder) return; // already started

    const mimeType = this.getSupportedMimeType();

    // Watch for tracks ending (permission revoked by OS/browser).
    // Debounce before declaring revocation: a track can momentarily fire
    // `onended` during a device blip / tab backgrounding and then return to
    // 'live'. We wait a short delay and only treat it as a genuine revocation if
    // NO video track is live anymore — that's what actually kills proctoring.
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (this.stopped) return;
        setTimeout(() => {
          if (this.stopped) return;
          // If any video track is still live, this was a transient glitch — ignore.
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
      // Ended stream (camera revoked): the current recorder stops itself and its
      // chunk still uploads; a new MediaRecorder would throw on an inactive stream.
      if (!stream.active) return;
      const previous = this.mediaRecorder;
      this.mediaRecorder = this.recordChunk(stream, mimeType);
      this.stopRecorder(previous);
    }, CHUNK_INTERVAL_MS);
  }

  /** Record one chunk with its own MediaRecorder (no timeslice → one complete file). */
  private recordChunk(stream: MediaStream, mimeType: string): MediaRecorder {
    const index = this.claimChunkIndex();
    const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined });
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const blob = new Blob([event.data], { type: mimeType || 'video/webm' });
      // Queue uploads sequentially so chunks reach S3 in capture order.
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
   * Next chunk index, persisted so a later recorder for the same student+assessment
   * (refresh, camera re-grant) never reuses an index and overwrites an S3 key.
   * ponytail: per-browser counter; a second device on the same attempt can still
   * collide — move index assignment server-side if that ever happens.
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

  /**
   * Upload one chunk with a bounded retry. On genuine success fires
   * onChunkUploaded and flushes any previously-buffered failures. On exhausted
   * retries the chunk is parked in the bounded failedBuffer and onError fires so
   * the store can show the degraded indicator.
   */
  private async uploadChunk(blob: Blob, index: number): Promise<void> {
    try {
      await this.attemptUpload(blob, index);
      this.options.onChunkUploaded?.(index);
      // A genuine success — try to flush anything that failed earlier.
      await this.flushFailedBuffer();
    } catch (error) {
      this.bufferFailed({ blob, index });
      this.options.onError?.(
        error instanceof Error ? error : new Error('Chunk upload failed')
      );
    }
  }

  /** Single chunk upload pipeline with bounded retry + short backoff. */
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
        return; // success
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

  /** Park a chunk that exhausted retries; drop oldest + onError on overflow. */
  private bufferFailed(chunk: PendingChunk): void {
    this.failedBuffer.push(chunk);
    if (this.failedBuffer.length > FAILED_BUFFER_CAP) {
      this.failedBuffer.shift(); // drop oldest
      this.options.onError?.(
        new Error('Proctoring upload buffer full — oldest chunk dropped')
      );
    }
  }

  /**
   * Try to re-upload buffered chunks in capture order. Stops at the first chunk
   * that still fails (re-buffering it) so ordering is preserved and we don't spin
   * on a persistent outage — the next success retries the rest.
   */
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
        // Re-buffer this and the remaining (still-ordered) chunks; bail out.
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
