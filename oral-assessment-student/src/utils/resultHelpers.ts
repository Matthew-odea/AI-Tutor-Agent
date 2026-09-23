/**
 * Pure helpers for rendering assessment results.
 *
 * These are extracted from the result components so the tricky bits — per-question
 * status derivation, sub-score denominators, and pending-error classification —
 * can be unit tested without mounting React or the network layer.
 */

import type { ApiError, QuestionResult } from '../types';

/**
 * Effective per-question status used to drive result rendering. The server does
 * not send a per-question status, so {@link deriveResultStatus} derives it.
 */
export type EffectiveStatus = 'graded' | 'skipped' | 'not-attempted' | 'grading-failed';

/**
 * Literal sentinel written by `skipCurrentQuestion` (assessmentStore) when a
 * question's timer expires. It is a control marker, never a real transcript.
 */
export const TIME_EXPIRED_SENTINEL = '(time expired)';

/** Default points-possible for a question when the server omits `maxScore`. */
export const DEFAULT_QUESTION_MAX = 10;

/**
 * Resolve the effective status for a question result:
 *   - transcript is the time-expired sentinel  -> 'skipped'
 *   - no total score was recorded (null/undef) -> 'grading-failed'
 *   - otherwise                                -> 'graded'
 */
export function deriveResultStatus(
  result: Pick<QuestionResult, 'transcript' | 'totalScore'>
): EffectiveStatus {
  if (result.transcript?.trim() === TIME_EXPIRED_SENTINEL) return 'skipped';
  if (result.totalScore == null) return 'grading-failed';
  return 'graded';
}

/** Points-possible for the whole question (total). */
export function totalMaxFor(result: Pick<QuestionResult, 'maxScore'>): number {
  return result.maxScore ?? DEFAULT_QUESTION_MAX;
}

/**
 * Points-possible for each sub-score. The grader scores correctness and
 * understanding on equal scales that sum to the total (0-5 + 0-5 = 0-10 today),
 * so each component max is half of the question total.
 */
export function componentMaxFor(result: Pick<QuestionResult, 'maxScore'>): number {
  return totalMaxFor(result) / 2;
}

/** Whole-number percentage of value/max, guarding divide-by-zero. */
export function scorePercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((value / max) * 100);
}

/**
 * Tailwind classes for a graded score badge, by percentage band. Mapped onto the
 * "quiet room" status tokens — success / caution / neutral-slate / danger — so the
 * badge never reverts to the old bright green/blue/yellow/red ramp.
 */
export function scoreColorClass(percentage: number): string {
  if (percentage >= 90) return 'text-success bg-success/10';
  if (percentage >= 70) return 'text-caution bg-caution/10';
  if (percentage >= 50) return 'text-slate bg-ink/5';
  return 'text-danger bg-danger/10';
}

export interface StatusBadge {
  label: string;
  className: string;
}

/**
 * Badge label + classes for a question, given its effective status. For graded
 * questions the percentage drives the colour band; non-graded statuses use a
 * neutral (skipped/not-attempted) or amber (grading-failed) treatment — never a
 * misleading red 0%.
 */
export function statusBadgeFor(status: EffectiveStatus, percentage: number | null): StatusBadge {
  switch (status) {
    case 'graded':
      return {
        label: `${percentage ?? 0}%`,
        className: scoreColorClass(percentage ?? 0),
      };
    case 'skipped':
      return { label: 'Skipped', className: 'text-slate bg-ink/5' };
    case 'not-attempted':
      return { label: 'Not attempted', className: 'text-slate bg-ink/5' };
    case 'grading-failed':
      return { label: 'Grading unavailable', className: 'text-caution bg-caution/10' };
  }
}

/**
 * Collect every text fragment an error might carry, lower-cased for matching.
 *
 * `handleApiError` rewrites the top-level `message` to a friendly fallback for
 * some 404s, but the backend's real domain message ("Results not available yet
 * ...") survives in `details` under the `{ ok, error: { message } }` envelope
 * (older endpoints used `{ detail }`). We match against all of them.
 */
function errorText(error: ApiError): string {
  const details = error.details as
    | { error?: { message?: string }; detail?: string }
    | null
    | undefined;
  return [error.message, details?.error?.message, details?.detail]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * True when an error means "results aren't released by the instructor yet".
 * Matches both the explicit 403 status and the backend's message (which today
 * arrives as a 404 with "Results not released yet ...").
 */
export function isResultsNotReleasedError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  const text = errorText(error);
  return error.status === 403 || text.includes('not released') || text.includes('pending release');
}

/**
 * True when an error means "results are still being evaluated / not ready yet".
 * Matches the 202 status and the backend's pending messages.
 */
export function isResultsPendingError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  const text = errorText(error);
  return (
    error.status === 202 ||
    text.includes('not ready') ||
    text.includes('not available') ||
    text.includes('being evaluated') ||
    text.includes('pending')
  );
}

/** Either flavour of "still pending" (not released OR not yet evaluated). */
export function isResultsStillPending(error: ApiError | null | undefined): boolean {
  return isResultsNotReleasedError(error) || isResultsPendingError(error);
}
