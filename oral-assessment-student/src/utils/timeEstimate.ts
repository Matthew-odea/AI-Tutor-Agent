/**
 * Coarse time estimates rolled up from per-question limits (seconds in, minutes out).
 * Sums per-question limits when given, else count x fallback; null means no time limit.
 * Missing, non-finite or non-positive values count as "no limit".
 */

function positiveOrNull(n: number | null | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function estimateTotalMinutes(opts: {
  questionCount?: number;
  perQuestionSeconds?: Array<number | null | undefined>;
  fallbackPerQuestionSeconds?: number | null;
}): number | null {
  const { perQuestionSeconds, fallbackPerQuestionSeconds } = opts;
  const questionCount = positiveOrNull(opts.questionCount) ?? 0;

  if (perQuestionSeconds && perQuestionSeconds.length > 0) {
    const totalSeconds = perQuestionSeconds.reduce<number>(
      (sum, s) => sum + (positiveOrNull(s) ?? 0),
      0
    );
    if (totalSeconds <= 0) return null;
    return Math.max(1, Math.round(totalSeconds / 60));
  }

  const fallback = positiveOrNull(fallbackPerQuestionSeconds);
  if (fallback === null || questionCount <= 0) return null;
  return Math.max(1, Math.round((fallback * questionCount) / 60));
}

// Includes the current question (sums from currentIndex onward).
export function estimateRemainingMinutes(opts: {
  questionCount?: number;
  currentIndex?: number;
  perQuestionSeconds?: Array<number | null | undefined>;
  fallbackPerQuestionSeconds?: number | null;
}): number | null {
  const { perQuestionSeconds, fallbackPerQuestionSeconds } = opts;
  const questionCount = positiveOrNull(opts.questionCount) ?? 0;
  const rawIndex = typeof opts.currentIndex === 'number' && Number.isFinite(opts.currentIndex)
    ? opts.currentIndex
    : 0;
  const currentIndex = Math.min(Math.max(0, Math.trunc(rawIndex)), questionCount);

  if (perQuestionSeconds && perQuestionSeconds.length > 0) {
    const remainingSeconds = perQuestionSeconds
      .slice(currentIndex)
      .reduce<number>((sum, s) => sum + (positiveOrNull(s) ?? 0), 0);
    if (remainingSeconds <= 0) return null;
    return Math.max(0, Math.round(remainingSeconds / 60));
  }

  const fallback = positiveOrNull(fallbackPerQuestionSeconds);
  if (fallback === null) return null;
  const remainingQuestions = Math.max(0, questionCount - currentIndex);
  if (remainingQuestions <= 0) return 0;
  return Math.max(1, Math.round((fallback * remainingQuestions) / 60));
}
