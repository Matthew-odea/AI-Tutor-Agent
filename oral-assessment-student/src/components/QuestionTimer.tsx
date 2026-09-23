import { useEffect, useState, useRef, useCallback } from 'react';
import { formatDuration } from '../utils/helpers';

interface QuestionTimerProps {
  /** Seconds. Falsy hides the timer. */
  timeLimitSeconds?: number | null;
  onExpire?: () => void; // fires once
  resetKey?: string;
  /** Freezes the countdown so it tracks recording-elapsed time and never force-submits early after a pause. */
  paused?: boolean;
  /** ms since epoch. Overrides any local anchor. */
  serverStartedAtMs?: number | null;
  /**
   * sessionStorage key for the start anchor so the countdown survives refresh. Omitted,
   * it re-anchors on every mount, which the oral timer relies on.
   */
  persistKey?: string;
}

const ANNOUNCE_THRESHOLDS = new Set([30, 10, 0]);

function readPersistedAnchor(key?: string): number | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // storage disabled: degrade to live clock
  }
}

function writePersistedAnchor(key: string, ms: number): void {
  try {
    sessionStorage.setItem(key, String(ms));
  } catch {
    /* storage disabled: works, just not across refresh */
  }
}

// Server anchor beats the persisted one. Null on first sighting.
function existingAnchorMs(serverStartedAtMs?: number | null, persistKey?: string): number | null {
  if (typeof serverStartedAtMs === 'number' && Number.isFinite(serverStartedAtMs)) {
    return serverStartedAtMs;
  }
  return readPersistedAnchor(persistKey);
}

// Seeds the first paint from any anchor so a refresh doesn't flash the full limit.
function computeInitialRemaining(
  timeLimitSeconds: number | null | undefined,
  serverStartedAtMs?: number | null,
  persistKey?: string,
): number {
  if (!timeLimitSeconds) return 0;
  const anchor = existingAnchorMs(serverStartedAtMs, persistKey);
  if (anchor === null) return timeLimitSeconds;
  return Math.max(0, Math.round((anchor + timeLimitSeconds * 1000 - Date.now()) / 1000));
}

export default function QuestionTimer({
  timeLimitSeconds,
  onExpire,
  resetKey,
  paused = false,
  serverStartedAtMs,
  persistKey,
}: QuestionTimerProps) {
  const [remaining, setRemaining] = useState<number>(() =>
    computeInitialRemaining(timeLimitSeconds, serverStartedAtMs, persistKey),
  );
  const expiredRef = useRef(false);
  const endTimeRef = useRef<number>(0);
  const pausedRef = useRef(paused);
  const pausedAtRef = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // On resume, push the end time forward by the paused duration.
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      pausedAtRef.current = Date.now();
    } else if (pausedAtRef.current !== null) {
      endTimeRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
  }, [paused]);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  // Render-time reset on resetKey change (avoids setState-in-effect).
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setRemaining(computeInitialRemaining(timeLimitSeconds, serverStartedAtMs, persistKey));
    setAnnouncement('');
  }

  const handleExpire = useCallback(() => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    onExpireRef.current?.();
  }, []);

  useEffect(() => {
    expiredRef.current = false;
    pausedAtRef.current = null;
    if (!timeLimitSeconds) return; // never write an anchor for a null/0 limit

    // Anchor: server > persisted > now. Persist a first sighting so a refresh continues it.
    let startMs = existingAnchorMs(serverStartedAtMs, persistKey);
    if (startMs === null) {
      startMs = Date.now();
      if (persistKey) writePersistedAnchor(persistKey, startMs);
    }
    endTimeRef.current = startMs + timeLimitSeconds * 1000;

    const tick = (): boolean => {
      if (pausedRef.current) return false;

      const secsLeft = Math.max(0, Math.round((endTimeRef.current - Date.now()) / 1000));
      setRemaining(secsLeft);

      if (ANNOUNCE_THRESHOLDS.has(secsLeft)) {
        setAnnouncement(secsLeft === 0 ? "Time's up!" : `${secsLeft} seconds remaining`);
      }

      if (secsLeft <= 0) {
        handleExpire();
        return true; // stop ticking
      }
      return false;
    };

    // Tick once synchronously so a refresh after the deadline expires immediately.
    if (tick()) return;

    const interval = setInterval(() => {
      if (tick()) clearInterval(interval);
    }, 250);

    return () => clearInterval(interval);
  }, [timeLimitSeconds, resetKey, handleExpire, serverStartedAtMs, persistKey]);

  if (!timeLimitSeconds) return null;

  const isWarning = remaining <= 60 && remaining > 30;
  const isDanger  = remaining <= 30;
  const isCritical = remaining <= 10;
  const isExpired = remaining === 0;

  const colorClass = isExpired
    ? 'text-record border-record/50 bg-record/10 animate-pulse motion-reduce:animate-none'
    : isCritical
    ? 'text-record border-record/30 bg-record/5 animate-[pulse_0.5s_ease-in-out_infinite] motion-reduce:animate-none'
    : isDanger
    ? 'text-record border-record/30 bg-record/5'
    : isWarning
    ? 'text-caution border-caution/30 bg-caution/5'
    : 'text-ink border-hairline bg-paper';

  return (
    <>
      <div
        role="timer"
        className={`inline-flex items-center space-x-2 px-3 py-1.5 rounded-full border text-sm font-serif font-semibold tabular-nums tracking-tight ${colorClass}`}
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{formatDuration(remaining)}</span>
        {isExpired && (
          <span className="text-xs font-normal font-sans">Time&apos;s up!</span>
        )}
        {isCritical && !isExpired && (
          <span className="text-xs font-normal font-sans">Time almost up!</span>
        )}
      </div>
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}
