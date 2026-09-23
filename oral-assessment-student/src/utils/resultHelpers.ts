import type { ApiError, QuestionResult } from '../types';

/**
 * The backend does not send per-question `status`, so deriveResultStatus reconstructs it.
 * 'grading-failed' = answer exists but evaluation errored.
 */
export type EffectiveStatus = 'graded' | 'skipped' | 'not-attempted' | 'grading-failed';

// Text markers skipCurrentQuestion submits when the backend rejects answer_type 'skipped'.
// Only the frontend writes them; the backend stores them as an ordinary transcript.
export const TIME_EXPIRED_SENTINEL = '(time expired)'; // written mode
export const NO_ORAL_ANSWER_SENTINEL = '[NO_ORAL_ANSWER]'; // oral mode

export function isSkipSentinel(transcript: string | null | undefined): boolean {
  const t = transcript?.trim();
  return t === TIME_EXPIRED_SENTINEL || t === NO_ORAL_ANSWER_SENTINEL;
}

// Used when the server omits maxScore.
export const DEFAULT_QUESTION_MAX = 10;

export function deriveResultStatus(
  result: Pick<QuestionResult, 'transcript' | 'totalScore'>
): EffectiveStatus {
  if (isSkipSentinel(result.transcript)) return 'skipped';
  if (result.totalScore == null) return 'grading-failed';
  return 'graded';
}

export function totalMaxFor(result: Pick<QuestionResult, 'maxScore'>): number {
  return result.maxScore ?? DEFAULT_QUESTION_MAX;
}

// Correctness and understanding are equal halves of the total (0-5 + 0-5 = 0-10).
export function componentMaxFor(result: Pick<QuestionResult, 'maxScore'>): number {
  return totalMaxFor(result) / 2;
}

export function scorePercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((value / max) * 100);
}

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

// handleApiError can replace `message` with friendly copy; the backend's real message
// survives in details.error.message (or details.detail on older endpoints).
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

// The backend currently sends this as a 404 "Results not released yet", not a 403.
export function isResultsNotReleasedError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  const text = errorText(error);
  return error.status === 403 || text.includes('not released') || text.includes('pending release');
}

// The 202 arm never fires via axios (2xx resolves); loadResults handles that case.
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

export function isResultsStillPending(error: ApiError | null | undefined): boolean {
  return isResultsNotReleasedError(error) || isResultsPendingError(error);
}
