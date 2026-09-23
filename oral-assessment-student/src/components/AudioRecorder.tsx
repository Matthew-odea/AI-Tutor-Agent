import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../utils/helpers';
import { useAssessmentStore } from '../store/assessmentStore';

interface AudioRecorderProps {
  onSubmit?: () => void;
  timeLimit?: number; // seconds
  disabled?: boolean;
}

// Breathing ring: radius eases between REST_R and MAX_R with live mic amplitude.
const RING_BOX = 112; // px
const RING_CENTER = RING_BOX / 2;
const REST_R = 40;
const MAX_R = 52;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function AudioRecorder({
  onSubmit,
  timeLimit = 300,
  disabled = false,
}: AudioRecorderProps) {
  const {
    isRecording,
    isPaused,
    recordingDuration,
    recordedBlob,
    isUploading,
    uploadProgress,
    error,
    initializeRecorder,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    cancelRecording,
    clearError,
  } = useAssessmentStore();

  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Display only. The header QuestionTimer is the single clock that stops+submits on expiry;
  // this component deliberately has no auto-stop (two clocks racing caused double submits).
  const remainingSeconds = Math.max(0, timeLimit - recordingDuration);

  // The rAF loop sets the circle's `r` directly and reads amplitude via getState(), so there
  // is no per-frame re-render or store set().
  const ringRef = useRef<SVGCircleElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const smoothedRef = useRef(REST_R);

  useEffect(() => {
    const reduced = prefersReducedMotion();

    if (!isRecording || isPaused || reduced) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      smoothedRef.current = REST_R;
      if (ringRef.current) ringRef.current.setAttribute('r', String(REST_R));
      return;
    }

    const loop = () => {
      const recorder = useAssessmentStore.getState().audioRecorder;
      const amp = recorder ? recorder.getAmplitude() : 0;
      // Ease toward the target so the ring doesn't jitter frame to frame.
      const target = REST_R + (MAX_R - REST_R) * Math.min(1, amp * 3.5);
      smoothedRef.current += (target - smoothedRef.current) * 0.18;
      if (ringRef.current) ringRef.current.setAttribute('r', smoothedRef.current.toFixed(2));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isRecording, isPaused]);

  // Same thresholds as QuestionTimer (60s / 30s).
  const topHairlineClass = !isRecording
    ? 'bg-hairline'
    : remainingSeconds <= 30
    ? 'bg-record'
    : remainingSeconds <= 60
    ? 'bg-caution'
    : 'bg-accent';

  useEffect(() => {
    const init = async () => {
      try {
        setInitError(null);
        await initializeRecorder();
        setIsInitialized(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to access microphone';
        setInitError(msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Microphone access denied. Please allow microphone access in your browser settings and reload.'
          : `Microphone error: ${msg}`);
        console.error('Failed to initialize recorder:', err);
      }
    };

    if (!isInitialized && !disabled) {
      init();
    }
  }, [initializeRecorder, isInitialized, disabled]);

  useEffect(() => {
    if (recordedBlob) {
      const url = URL.createObjectURL(recordedBlob);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      return () => URL.revokeObjectURL(url);
    }
  }, [recordedBlob]);

  const handleStartRecording = () => {
    if (error) clearError();
    startRecording();
  };

  const handleStopRecording = async () => {
    await stopRecording();
  };

  const handleRerecord = () => {
    cancelRecording();
    setAudioUrl(null);
  };

  const handleSubmit = () => {
    if (recordedBlob && onSubmit) {
      onSubmit();
    }
  };

  const isIdle = !isRecording && !recordedBlob;
  const isRecordingState = isRecording && !isPaused;
  const isRecordedState = !isRecording && recordedBlob;
  const canSubmit = recordedBlob && !isUploading;

  return (
    <div className="relative overflow-hidden bg-paper rounded-card border border-hairline p-6">
      <div
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-0.5 transition-colors duration-200 ease-out ${topHairlineClass}`}
      />

      <h3 className="text-lg font-serif font-semibold text-ink mb-4">
        Record Your Answer
      </h3>

      {!isInitialized && !disabled && (
        <div className={`mb-4 p-4 rounded-card border ${initError ? 'border-danger/30 bg-danger/5' : 'border-caution/30 bg-caution/5'}`}>
          <p className={`text-sm ${initError ? 'text-danger' : 'text-caution'}`}>
            {initError || 'Initializing microphone... Please allow microphone access when prompted.'}
          </p>
        </div>
      )}

      <div className="mb-6 text-center">
        <div className="inline-flex items-center justify-center">
          {isRecordingState && (
            <div className="w-3 h-3 bg-record rounded-full animate-pulse mr-3" />
          )}

          <div className="text-4xl font-serif font-semibold tabular-nums tracking-tight text-ink">
            {formatDuration(remainingSeconds)}
          </div>

        </div>

        {isRecordingState && (
          <p className="mt-2 text-sm text-slate">Recording in progress — {formatDuration(remainingSeconds)} remaining</p>
        )}
        {isPaused && (
          <p className="mt-2 text-sm text-caution">Recording paused</p>
        )}
      </div>

      <div className="flex flex-col items-center space-y-3 mb-6">
        {isIdle && (
          <div className="relative inline-flex items-center justify-center" style={{ width: RING_BOX, height: RING_BOX }}>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              width={RING_BOX}
              height={RING_BOX}
              viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
            >
              <circle
                ref={ringRef}
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={REST_R}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-record/40"
              />
            </svg>
            <button
              onClick={handleStartRecording}
              disabled={!isInitialized || disabled}
              className="relative flex items-center justify-center space-x-2 bg-record text-white px-8 py-3 rounded-full hover:bg-record/90 disabled:bg-slate/40 disabled:cursor-not-allowed transition-colors duration-200 ease-out"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="font-medium">Start Recording</span>
            </button>
          </div>
        )}

        {isRecording && (
          <div className="relative inline-flex items-center justify-center" style={{ minHeight: RING_BOX }}>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              width={RING_BOX}
              height={RING_BOX}
              viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
            >
              <circle
                ref={ringRef}
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={REST_R}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-record/40"
              />
            </svg>
            <div className="relative flex space-x-3">
              <button
                onClick={isPaused ? resumeRecording : pauseRecording}
                className="flex items-center space-x-2 bg-accent text-white px-6 py-3 rounded-full hover:bg-accent-hover transition-colors duration-200 ease-out"
              >
                {isPaused ? (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span>Resume</span>
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span>Pause</span>
                  </>
                )}
              </button>

              <button
                onClick={handleStopRecording}
                className="flex items-center space-x-2 bg-ink text-paper px-6 py-3 rounded-full hover:bg-ink/90 transition-colors duration-200 ease-out"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>Stop</span>
              </button>
            </div>
          </div>
        )}

        {isRecordedState && (
          <div className="w-full space-y-3">
            {audioUrl && (
              <div className="flex items-center justify-center p-4 bg-ink/5 rounded-card">
                <audio
                  controls
                  src={audioUrl}
                  className="w-full max-w-md"
                  preload="metadata"
                >
                  Your browser does not support audio playback.
                </audio>
              </div>
            )}

            <div className="flex justify-center space-x-3">
              <button
                onClick={handleRerecord}
                disabled={isUploading}
                className="flex items-center space-x-2 bg-paper text-ink border border-hairline px-6 py-3 rounded-full hover:bg-ink/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 ease-out"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>Re-record</span>
              </button>

              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex items-center space-x-2 bg-success text-white px-8 py-3 rounded-full hover:bg-success/90 disabled:bg-slate/40 disabled:cursor-not-allowed transition-colors duration-200 ease-out font-medium"
              >
                {isUploading ? (
                  <>
                    <svg className="w-5 h-5 -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
                      <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3" className="text-white/30" />
                      <circle
                        cx="18"
                        cy="18"
                        r="15"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        className="text-white transition-[stroke-dashoffset] duration-200 ease-out"
                        strokeDasharray={2 * Math.PI * 15}
                        strokeDashoffset={2 * Math.PI * 15 * (1 - Math.min(100, Math.max(0, uploadProgress)) / 100)}
                      />
                    </svg>
                    <span className="tabular-nums">Uploading... {uploadProgress}%</span>
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span>Submit Answer</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 bg-danger/5 border border-danger/30 rounded-card flex items-center justify-between">
          <p className="text-sm text-danger">{error.message}</p>
          {recordedBlob && !isUploading && (
            <button
              onClick={handleSubmit}
              className="ml-3 flex-shrink-0 bg-record text-white px-4 py-1.5 rounded-full text-sm font-medium hover:bg-record/90 transition-colors duration-200 ease-out"
            >
              Retry Upload
            </button>
          )}
        </div>
      )}

    </div>
  );
}
