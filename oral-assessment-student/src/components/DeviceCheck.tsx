/**
 * Pre-flight mic gate between the overview and Q1, using its own AudioRecorder. Start stays
 * disabled until isMicConfirmed. The test stream is fully released before onReady so Q1's
 * recorder doesn't hit a concurrent mic grab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AudioRecorder, { isMicConfirmed } from '../services/audio';
import { checkBrowserSupport } from '../utils/helpers';
import { useAssessmentStore } from '../store/assessmentStore';
import ErrorMessage from './ErrorMessage';

interface DeviceCheckProps {
  answerMode: 'oral' | 'written';
  requireCamera: boolean;
  onReady: () => void;
}

type PermissionState = 'prompting' | 'granted' | 'denied' | 'error';

const MIC_DENIED_MESSAGE =
  'Microphone access denied. Please allow microphone access in your browser settings and reload.';
const SAMPLE_CAP_SECONDS = 5;
// Peak level (0..1) that counts as the mic hearing something.
const SIGNAL_THRESHOLD = 0.08;

function resolveAudioContextCtor(): typeof AudioContext | null {
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

export default function DeviceCheck({ answerMode, requireCamera, onReady }: DeviceCheckProps) {
  // Camera status is informational only; it never blocks Start.
  const proctorStream = useAssessmentStore((s) => s.proctorStream);
  const proctoringWarning = useAssessmentStore((s) => s.proctoringWarning);
  const cameraConnected =
    requireCamera &&
    !!proctorStream &&
    proctorStream.getVideoTracks().some((t) => t.readyState === 'live');

  const [permissionState, setPermissionState] = useState<PermissionState>('prompting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [hasDetectedSound, setHasDetectedSound] = useState(false);
  const [meterLevel, setMeterLevel] = useState(0);
  const [deviceFallbackNote, setDeviceFallbackNote] = useState<string | null>(null);

  const [isSampleRecording, setIsSampleRecording] = useState(false);
  const [recordedSampleUrl, setRecordedSampleUrl] = useState<string | null>(null);

  // Refs so the rAF loop and teardown never read stale closures.
  const recorderRef = useRef<AudioRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const sampleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleUrlRef = useRef<string | null>(null);
  const selectedDeviceIdRef = useRef<string>('');

  const supported = checkBrowserSupport().supported;

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  const teardownRecorder = useCallback(() => {
    stopMeter();
    if (recorderRef.current) {
      recorderRef.current.cleanup();
      recorderRef.current = null;
    }
  }, [stopMeter]);

  const clearSampleUrl = useCallback(() => {
    if (sampleUrlRef.current) {
      URL.revokeObjectURL(sampleUrlRef.current);
      sampleUrlRef.current = null;
    }
    setRecordedSampleUrl(null);
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    stopMeter();
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return;
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    audioContextRef.current = ctx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      const node = analyserRef.current;
      if (!node) return;
      node.getByteTimeDomainData(data);
      // Peak (not RMS) deviation from the 128 midpoint.
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      setMeterLevel(peak);
      if (peak >= SIGNAL_THRESHOLD) {
        setHasDetectedSound((prev) => (prev ? prev : true));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopMeter]);

  // A vanished chosen device falls back to the default once, via a loop rather than
  // recursion so the callback never references itself.
  const acquireMic = useCallback(
    async (deviceId?: string) => {
      teardownRecorder();
      setPermissionState('prompting');
      setErrorMessage(null);
      setHasDetectedSound(false);
      setMeterLevel(0);

      let targetDeviceId = deviceId;
      let recorder: AudioRecorder | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidate = new AudioRecorder();
        try {
          await candidate.initialize(targetDeviceId);
          recorder = candidate;
          break;
        } catch (err) {
          candidate.cleanup();
          const name = err instanceof Error ? err.name : '';
          if (targetDeviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
            setDeviceFallbackNote(
              'The selected microphone is no longer available — falling back to the default device.',
            );
            setSelectedDeviceId('');
            selectedDeviceIdRef.current = '';
            targetDeviceId = undefined;
            continue;
          }
          const msg = err instanceof Error ? err.message : 'Failed to access microphone';
          const denied = /denied|NotAllowed|permission/i.test(msg) || name === 'NotAllowedError';
          setPermissionState(denied ? 'denied' : 'error');
          setErrorMessage(denied ? MIC_DENIED_MESSAGE : msg);
          return;
        }
      }
      if (!recorder) {
        setPermissionState('error');
        setErrorMessage('Could not access any microphone. Please check your device and try again.');
        return;
      }

      recorderRef.current = recorder;
      setPermissionState('granted');

      // Enumerate AFTER the grant so device labels are populated.
      try {
        const inputs = await AudioRecorder.listInputDevices();
        setDevices(inputs);
        if (!targetDeviceId && inputs.length > 0) {
          setSelectedDeviceId((prev) => (prev && inputs.some((d) => d.deviceId === prev) ? prev : ''));
        } else if (targetDeviceId) {
          setSelectedDeviceId(targetDeviceId);
          selectedDeviceIdRef.current = targetDeviceId;
        }
      } catch {
        // Best-effort; the meter and gating work without a list.
      }

      const stream = recorder.getStream();
      if (stream) startMeter(stream);
    },
    [teardownRecorder, startMeter],
  );

  useEffect(() => {
    if (answerMode !== 'oral') return;
    if (!supported) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPermissionState('error');
      setErrorMessage('Your browser does not support audio recording. Please use a recent Chrome, Edge, or Firefox.');
      return;
    }
    void acquireMic(undefined);
    return () => {
      if (sampleTimeoutRef.current) {
        clearTimeout(sampleTimeoutRef.current);
        sampleTimeoutRef.current = null;
      }
      if (sampleUrlRef.current) {
        URL.revokeObjectURL(sampleUrlRef.current);
        sampleUrlRef.current = null;
      }
      teardownRecorder();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerMode]);

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setDeviceFallbackNote(null);
    clearSampleUrl();
    setSelectedDeviceId(id);
    selectedDeviceIdRef.current = id;
    void acquireMic(id || undefined);
  };

  const handleRetry = () => {
    setDeviceFallbackNote(null);
    void acquireMic(selectedDeviceIdRef.current || undefined);
  };

  const handleRecordSample = async () => {
    const recorder = recorderRef.current;
    if (!recorder || isSampleRecording) return;
    clearSampleUrl();
    try {
      recorder.start();
      setIsSampleRecording(true);
      sampleTimeoutRef.current = setTimeout(() => {
        void finishSample();
      }, SAMPLE_CAP_SECONDS * 1000);
    } catch {
      setIsSampleRecording(false);
    }
  };

  const finishSample = useCallback(async () => {
    if (sampleTimeoutRef.current) {
      clearTimeout(sampleTimeoutRef.current);
      sampleTimeoutRef.current = null;
    }
    const recorder = recorderRef.current;
    if (!recorder) {
      setIsSampleRecording(false);
      return;
    }
    try {
      const blob = await recorder.stop();
      const url = recorder.createAudioUrl(blob);
      if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
      sampleUrlRef.current = url;
      setRecordedSampleUrl(url);
    } catch {
      // No usable sample; gating falls back to the live meter.
    } finally {
      setIsSampleRecording(false);
    }
  }, []);

  const handleStopSample = () => {
    void finishSample();
  };

  const micConfirmed = isMicConfirmed({
    permissionState,
    hasDetectedSound,
    hasSample: recordedSampleUrl !== null,
  });

  const handleStart = () => {
    // Release before the exam mounts, or Q1's recorder can hit NotReadableError.
    if (sampleTimeoutRef.current) {
      clearTimeout(sampleTimeoutRef.current);
      sampleTimeoutRef.current = null;
    }
    clearSampleUrl();
    teardownRecorder();
    onReady();
  };

  if (answerMode === 'written') {
    return (
      <div className="fixed inset-0 bg-paper flex items-center justify-center p-4 z-40">
        <div className="bg-paper rounded-xl border border-hairline shadow-overlay max-w-lg w-full p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success/10">
            <svg className="h-7 w-7 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold font-serif text-ink mb-2">You&apos;re all set</h2>
          <p className="text-sm text-slate mb-8">
            This is a written assessment — no microphone is needed. Click below to begin.
          </p>
          <button
            onClick={handleStart}
            className="w-full bg-accent text-white py-3 rounded-xl font-semibold hover:bg-accent-hover transition-colors text-lg"
          >
            I&apos;m ready, start
          </button>
        </div>
      </div>
    );
  }

  const meterPct = Math.min(100, Math.round(meterLevel * 100));

  return (
    <div className="fixed inset-0 bg-paper flex items-center justify-center p-4 z-40 overflow-y-auto">
      <div className="bg-paper rounded-xl border border-hairline shadow-overlay max-w-lg w-full p-8 my-8">
        <h2 className="text-2xl font-bold font-serif text-ink mb-1">Microphone check</h2>
        <p className="text-sm text-slate mb-6">
          Make sure your microphone works before the timed assessment begins.
        </p>

        {permissionState === 'prompting' && (
          <div className="mb-4 p-4 rounded-xl bg-caution/10 border border-caution/20">
            <p className="text-sm text-caution">
              Requesting microphone access… Please allow it when prompted.
            </p>
          </div>
        )}

        {(permissionState === 'denied' || permissionState === 'error') && errorMessage && (
          <div className="mb-4">
            <ErrorMessage error={errorMessage} />
            <button
              onClick={handleRetry}
              className="mt-3 w-full bg-ink text-paper py-2.5 rounded-xl font-medium hover:bg-ink/90 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {permissionState === 'granted' && (
          <>
            <div className="mb-4">
              <label htmlFor="mic-device" className="block text-sm font-medium text-ink mb-1">
                Input device
              </label>
              <select
                id="mic-device"
                value={selectedDeviceId}
                onChange={handleDeviceChange}
                className="w-full border border-hairline bg-paper text-ink rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Default microphone</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId || `device-${i}`} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </select>
              {deviceFallbackNote && (
                <p className="mt-1 text-xs text-caution">{deviceFallbackNote}</p>
              )}
            </div>

            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-ink">Input level</span>
                {hasDetectedSound ? (
                  <span className="text-xs text-success font-medium">Sound detected ✓</span>
                ) : (
                  <span className="text-xs text-slate">Speak to test…</span>
                )}
              </div>
              <div className="h-3 w-full bg-ink/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width] duration-75 ${
                    meterLevel >= SIGNAL_THRESHOLD ? 'bg-success' : 'bg-accent/40'
                  }`}
                  style={{ width: `${meterPct}%` }}
                />
              </div>
            </div>

            <div className="mb-4">
              <p className="text-sm font-medium text-ink mb-2">
                Optional: record a short test clip (up to {SAMPLE_CAP_SECONDS}s)
              </p>
              <div className="flex items-center gap-3">
                {!isSampleRecording ? (
                  <button
                    onClick={handleRecordSample}
                    className="bg-record text-white px-4 py-2 rounded-full text-sm font-medium hover:opacity-90 transition-opacity"
                  >
                    Record test clip
                  </button>
                ) : (
                  <button
                    onClick={handleStopSample}
                    className="bg-ink text-paper px-4 py-2 rounded-full text-sm font-medium hover:bg-ink/90 transition-colors"
                  >
                    Stop
                  </button>
                )}
                {recordedSampleUrl && (
                  <audio controls src={recordedSampleUrl} className="flex-1 max-w-xs" preload="metadata">
                    Your browser does not support audio playback.
                  </audio>
                )}
              </div>
            </div>
          </>
        )}

        {requireCamera && (
          <div className="mb-6 text-sm">
            {cameraConnected ? (
              <span className="text-success">Camera connected</span>
            ) : (
              <span className="text-caution">
                {proctoringWarning ||
                  'Camera not detected — the assessment will continue without proctoring.'}
              </span>
            )}
          </div>
        )}

        <button
          onClick={handleStart}
          disabled={!micConfirmed}
          className="w-full bg-accent text-white py-3 rounded-xl font-semibold hover:bg-accent-hover disabled:bg-ink/20 disabled:cursor-not-allowed transition-colors text-lg"
        >
          {micConfirmed ? "I'm ready, start" : 'Confirm your microphone to start'}
        </button>
      </div>
    </div>
  );
}
