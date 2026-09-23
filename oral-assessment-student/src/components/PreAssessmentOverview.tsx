import type { Assessment } from '../types';
import { estimateTotalMinutes } from '../utils/timeEstimate';

interface PreAssessmentOverviewProps {
  assessment: Assessment;
  questionCount: number;
  onStart: () => void;
  /** Oral passes "Continue" since the next step is the device check, not the exam. */
  startLabel?: string;
  /** Seconds. Preferred over questionCount x assessment.timeLimit for the estimate. */
  perQuestionSeconds?: Array<number | null | undefined>;
}

export default function PreAssessmentOverview({
  assessment,
  questionCount,
  onStart,
  startLabel = 'Start Assessment',
  perQuestionSeconds,
}: PreAssessmentOverviewProps) {
  const timeLimitMinutes = assessment.timeLimit ? Math.round(assessment.timeLimit / 60) : null;
  const estimatedTotalMinutes = estimateTotalMinutes({
    questionCount,
    perQuestionSeconds,
    fallbackPerQuestionSeconds: assessment.timeLimit ?? null,
  });

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-40 backdrop-blur-[2px]"
      style={{ backgroundColor: 'var(--scrim)' }}
    >
      <div className="bg-paper rounded-card shadow-overlay border border-ink/10 max-w-lg w-full p-8">
        <h2 className="font-serif text-2xl font-semibold text-ink mb-1">{assessment.title}</h2>
        <p className="text-sm text-slate mb-6">{assessment.course}</p>

        <div className="flex items-stretch border-y border-ink/10 mb-6">
          <div className="flex-1 py-4 px-2">
            <div className="text-xs uppercase tracking-wide text-slate">Questions</div>
            <div className="mt-1 text-2xl font-serif text-ink tabular-nums tracking-tight">
              {questionCount}
            </div>
          </div>
          <div className="w-px bg-ink/10" aria-hidden="true" />
          <div className="flex-1 py-4 px-2">
            <div className="text-xs uppercase tracking-wide text-slate">Time</div>
            {timeLimitMinutes ? (
              <div className="mt-1 text-2xl font-serif text-ink tabular-nums tracking-tight">
                {timeLimitMinutes}
                <span className="ml-1 text-sm font-sans text-slate tracking-normal">min / question</span>
              </div>
            ) : (
              <div className="mt-1 text-2xl font-serif text-ink tracking-tight">No limit</div>
            )}
          </div>
        </div>

        {estimatedTotalMinutes !== null && (
          <div className="flex items-center justify-center gap-2 text-sm text-slate mb-6 -mt-2">
            <svg className="w-4 h-4 text-slate flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Estimated total:{' '}
              <span className="font-semibold text-ink tabular-nums tracking-tight">
                ~{estimatedTotalMinutes} min
              </span>
            </span>
          </div>
        )}

        {assessment.description && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-ink mb-2">Instructions</h3>
            <p className="text-sm text-slate leading-relaxed">{assessment.description}</p>
          </div>
        )}

        <ul className="text-sm text-slate space-y-1 mb-8">
          <li>• Answer each question using {assessment.answerMode === 'written' ? 'text' : 'audio'}</li>
          {assessment.allowReview ? (
            <li>• You can move between questions and revise your answers before you submit</li>
          ) : (
            <>
              <li>• Questions are presented one at a time in order</li>
              <li>• Submit each answer before moving to the next question</li>
            </>
          )}
          {assessment.proctored && (
            <li>• Your webcam and microphone will be recorded throughout</li>
          )}
        </ul>

        <button
          onClick={onStart}
          className="w-full bg-accent text-paper py-3 rounded-card font-semibold hover:bg-accent-hover transition-colors duration-200 ease-out text-lg"
        >
          {startLabel}
        </button>
      </div>
    </div>
  );
}
