import { calculatePercentage } from '../utils/helpers';

interface ProgressTrackerProps {
  currentIndex: number;
  totalQuestions: number;
  answeredCount: number;
  questionIds?: string[];
  answeredQuestionIds?: Set<string>;
  skippedQuestionIds?: Set<string>;
  // Review mode only: indicators become navigation buttons.
  onNavigate?: (index: number) => void;
}

export default function ProgressTracker({
  currentIndex,
  totalQuestions,
  answeredCount,
  questionIds,
  answeredQuestionIds,
  skippedQuestionIds,
  onNavigate,
}: ProgressTrackerProps) {
  const percentage = calculatePercentage(answeredCount, totalQuestions);

  return (
    <div className="bg-paper rounded-xl border border-hairline p-4">
      <div className="flex justify-between text-sm text-slate mb-2">
        <span>Progress</span>
        <span className="font-medium tabular-nums">
          {answeredCount} / {totalQuestions} answered
        </span>
      </div>
      <div className="w-full bg-ink/10 rounded-full h-2 mb-3">
        <div
          className="bg-accent h-2 rounded-full transition-all duration-300"
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: totalQuestions }, (_, i) => {
          const qId = questionIds?.[i] ?? '';
          const isCurrent = i === currentIndex;
          // Skipped beats answered: the server's answered list includes skips, and a skip
          // must never wear the green check.
          const isSkipped = !!skippedQuestionIds && skippedQuestionIds.has(qId);
          const isAnswered = answeredQuestionIds && questionIds
            ? answeredQuestionIds.has(qId)
            : i < answeredCount;

          const state = isCurrent
            ? 'current'
            : isSkipped
            ? 'skipped'
            : isAnswered
            ? 'answered'
            : 'unanswered';

          const indicatorClass = `
                w-8 h-8 rounded-xl font-medium text-xs tabular-nums flex items-center justify-center
                ${isCurrent
                  ? 'bg-accent text-white ring-2 ring-accent/40'
                  : isSkipped
                  ? 'bg-caution/10 text-caution'
                  : isAnswered
                  ? 'bg-success/10 text-success'
                  : 'bg-ink/5 text-slate'
                }
                ${onNavigate ? 'cursor-pointer hover:ring-2 hover:ring-accent/40 focus:outline-none focus:ring-2 focus:ring-accent' : ''}
              `;

          const indicatorContent = !isCurrent && isSkipped ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 20 20" stroke="currentColor">
              <path strokeLinecap="round" strokeWidth={2} d="M5 10h10" />
            </svg>
          ) : !isCurrent && isAnswered ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            i + 1
          );

          return onNavigate ? (
            <button
              key={i}
              type="button"
              onClick={() => onNavigate(i)}
              className={indicatorClass}
              aria-label={`Go to question ${i + 1}, ${state}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {indicatorContent}
            </button>
          ) : (
            <div
              key={i}
              className={indicatorClass}
              aria-label={`Question ${i + 1}, ${state}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {indicatorContent}
            </div>
          );
        })}
      </div>
    </div>
  );
}
