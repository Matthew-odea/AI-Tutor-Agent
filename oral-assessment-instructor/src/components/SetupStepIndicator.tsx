import { Link } from 'react-router-dom';
import type { AppShellMaxWidth } from './AppShell';

interface SetupStepIndicatorProps {
  currentStep: 1 | 2 | 3 | 4;
  /** Empty on step 1 (no assessment yet); safe because only earlier steps are linked. */
  assessmentId: string;
  /** Must match the page's AppShell `maxWidth` or the trail misaligns with the title. */
  maxWidth?: AppShellMaxWidth;
}

/** Mirrors AppShell's MAX_WIDTH_CLASS so the banner shares the shell's column. */
const MAX_WIDTH_CLASS: Record<AppShellMaxWidth, string> = {
  default: 'max-w-7xl',
  medium: 'max-w-5xl',
  narrow: 'max-w-4xl',
};

const STEPS = [
  { label: 'Create', path: () => `/assessments` },
  { label: 'Upload Students', path: (id: string) => `/assessments/${id}/upload` },
  { label: 'Generate Questions', path: (id: string) => `/assessments/${id}/generate` },
  { label: 'Monitor', path: (id: string) => `/assessments/${id}/monitor` },
];

/** Wayfinding for the 4-step assessment setup flow, mounted as AppShell's `banner`. */
export default function SetupStepIndicator({
  currentStep,
  assessmentId,
  maxWidth = 'narrow',
}: SetupStepIndicatorProps) {
  return (
    <nav aria-label="Setup progress" className="bg-paper border-b border-hairline">
      {/* Rebuilds AppShell's column (padding inside the max-width) so the trail aligns. */}
      <ol
        className={`${MAX_WIDTH_CLASS[maxWidth]} mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center gap-y-1 text-sm`}
      >
        {STEPS.map((step, i) => {
          const stepNum = (i + 1) as 1 | 2 | 3 | 4;
          const isCompleted = stepNum < currentStep;
          const isCurrent = stepNum === currentStep;

          const label = (
            <span
              className={`inline-flex items-center gap-1.5 ${
                isCurrent
                  ? 'font-semibold text-accent'
                  : isCompleted
                  ? 'font-medium text-success'
                  : 'font-medium text-slate'
              }`}
            >
              {isCompleted && (
                <svg
                  aria-hidden="true"
                  className="w-4 h-4 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              {isCurrent && (
                <span aria-hidden="true" className="w-2 h-2 flex-shrink-0 rounded-full bg-accent" />
              )}
              {/* Icons are decorative; aria-current covers only the current step. */}
              {isCompleted && <span className="sr-only">Completed: </span>}
              {step.label}
            </span>
          );

          return (
            <li
              key={stepNum}
              className="flex items-center"
              aria-current={isCurrent ? 'step' : undefined}
            >
              {isCompleted ? (
                <Link to={step.path(assessmentId)} className="rounded hover:underline">
                  {label}
                </Link>
              ) : (
                label
              )}
              {i < STEPS.length - 1 && (
                <svg
                  aria-hidden="true"
                  className="w-4 h-4 mx-2 flex-shrink-0 text-slate/50"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
