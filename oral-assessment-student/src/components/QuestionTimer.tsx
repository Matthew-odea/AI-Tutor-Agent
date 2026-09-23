/**
 * QuestionTimer - Countdown timer for per-question time limits.
 * Turns orange at ≤60 s remaining, red at ≤30 s remaining.
 * Flashes at ≤10 s, pulses at 0 s.
 * Calls onExpire when the countdown reaches zero.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { formatDuration } from '../utils/helpers';

interface QuestionTimerProps {
  /** Time limit in seconds. If undefined/null the timer is not shown. */
  timeLimitSeconds?: number | null;
  /** Called once when the countdown reaches zero. */
  onExpire?: () => void;
  /** Key that resets the timer when it changes (e.g. question ID). */
  resetKey?: string;
  /**
   * When true, the countdown freezes (e.g. oral recording is paused). This keeps
   * the header clock anchored to RECORDING-elapsed time — matching the recorder's
   * recordingDuration, which also excludes paused time — so the two never diverge
   * and the timer doesn't force-submit early after a pause.
   */
  paused?: boolean;
  /**
   * Optional server-stamped start time for this question (ms since epoch). When
   * a finite number it anchors the countdown and OVERRIDES any local anchor.
   * The questions API does not send one today, so TakeAssessment never passes it.
   */
  serverStartedAtMs?: number | null;
  /**
   * Optional namespaced sessionStorage key under which to persist/read the
   * per-question start anchor so the countdown SURVIVES REFRESH (P4). When
   * omitted, the timer anchors to the live wall clock on each mount and persists
   * nothing — the ORAL recording-elapsed timer relies on this unchanged
   * behaviour (a refresh ends the recording, so its clock must restart).
   */
  persistKey?: string;
}

const ANNOUNCE_THRESHOLDS = new Set([30, 10, 0]);

/**
 * Refresh-fairness anchoring (P4). A WRITTEN timer that re-anchored to
 * `Date.now()` on every mount handed the student a fresh full clock on every
 * page refresh, defeating timed questions. Callers opt into persistence by
 * passing `persistKey` (a collision-free, per-assessment+question key — see
 * TakeAssessment, which uses `qtimer_start_<assessmentId>_<questionId>`, NOT the
 * `draft_*` namespace owned by the durable-drafts task). A server-stamped start
 * (`serverStartedAtMs`) always wins over the local anchor.
 */

/** Read a persisted start anchor (ms since epoch) for `key`, or null. */
function readPersistedAnchor(key?: string): number | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // storage disabled (e.g. private mode) — degrade to live clock
  }
}

/** Persist a start anchor (ms since epoch) for `key`; no-op if storage throws. */
function writePersistedAnchor(key: string, ms: number): void {
  try {
    sessionStorage.setItem(key, String(ms));
  } catch {
    /* storage disabled — the timer still works, just not across refresh */
  }
}

/**
 * The existing start anchor for this mount, in priority order:
 * server-stamped start > persisted local anchor. Returns null when neither
 * exists yet (i.e. this is the first time the timed phase has been shown).
 */
function existingAnchorMs(serverStartedAtMs?: number | null, persistKey?: string): number | null {
  if (typeof serverStartedAtMs === 'number' && Number.isFinite(serverStartedAtMs)) {
    return serverStartedAtMs;
  }
  return readPersistedAnchor(persistKey);
}

/**
 * Initial remaining seconds for the first paint, derived from any existing
 * anchor so a refresh of an in-progress (or already-elapsed) timed question
 * renders the REDUCED time immediately rather than flashing the full limit.
 * A brand-new question (no anchor yet) falls back to the full limit, unchanged.
 */
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

  // Track pause transitions: while paused, the tick freezes; on resume we push the
  // end time forward by the paused duration so no recording time is silently burned.
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      pausedAtRef.current = Date.now();
    } else if (pausedAtRef.current !== null) {
      endTimeRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
  }, [paused]);
  // Stable ref so the interval always calls the latest onExpire without re-creating
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  // Reset state when question changes (render-time pattern, avoids setState-in-effect)
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    // Re-seed from any existing anchor (refresh-fairness) — a brand-new question
    // has no anchor yet, so this falls back to the full limit exactly as before.
    setRemaining(computeInitialRemaining(timeLimitSeconds, serverStartedAtMs, persistKey));
    setAnnouncement('');
  }

  const handleExpire = useCallback(() => {
    if (expiredRef.current) return; // prevent double-fire
    expiredRef.current = true;
    onExpireRef.current?.();
  }, []);

  // Tick down using a start anchor (server > persisted > now) for accuracy and
  // refresh-fairness. The anchor is resolved once per (timeLimit, resetKey) here.
  useEffect(() => {
    expiredRef.current = false;
    pausedAtRef.current = null;
    if (!timeLimitSeconds) return; // criterion (e): no anchor written for null/0 limits

    // Resolve the start anchor: server-stamped > persisted local > first sighting
    // (now). On the first sighting, persist it (only when a persistKey is given)
    // so a later refresh continues this SAME countdown instead of restarting it.
    let startMs = existingAnchorMs(serverStartedAtMs, persistKey);
    if (startMs === null) {
      startMs = Date.now();
      if (persistKey) writePersistedAnchor(persistKey, startMs);
    }
    endTimeRef.current = startMs + timeLimitSeconds * 1000;

    const tick = (): boolean => {
      // Freeze while paused — endTimeRef is pushed forward on resume so the
      // remaining time is preserved exactly (recording-elapsed, not wall-clock).
      if (pausedRef.current) return false;

      const secsLeft = Math.max(0, Math.round((endTimeRef.current - Date.now()) / 1000));
      setRemaining(secsLeft);

      if (ANNOUNCE_THRESHOLDS.has(secsLeft)) {
        setAnnouncement(secsLeft === 0 ? "Time's up!" : `${secsLeft} seconds remaining`);
      }

      if (secsLeft <= 0) {
        handleExpire();
        return true; // expired — caller should stop ticking
      }
      return false;
    };

    // Evaluate once synchronously so an anchor whose deadline has ALREADY passed
    // (e.g. refreshed after expiry) reads 0 and fires onExpire immediately,
    // without waiting for the first interval tick.
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

  // Threshold ramp on the token palette: calm = slate/ink hairline, warning =
  // caution amber, danger/critical/expired = record vermillion (NOT raw red-*).
  // The existing pulse cadence is preserved but disabled under reduced motion via
  // the `motion-reduce:animate-none` variant.
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
        {/* Clock icon */}
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
      {/* Screen-reader announcements only at thresholds */}
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}
