import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import { useToastStore } from '../store/toastStore';
import { getResultsPdf } from '../services/api';
import ResultsCard from '../components/ResultsCard';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import {
  getBandGradeColor,
  formatTimestamp,
} from '../utils/helpers';
import { isResultsNotReleasedError } from '../utils/resultHelpers';

// ~2 minutes of background polling before falling back to a manual "Check again".
const POLL_INTERVAL_MS = 8000;
const MAX_RESULT_POLLS = 15;

const PDF_BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2 text-sm font-medium hover:bg-accent-hover transition-colors duration-200 ease-out';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Counts up once on mount; snaps to the final value under reduced motion.
function ScoreDial({
  total,
  max,
  percentage,
}: {
  total: number;
  max: number;
  percentage: number;
}) {
  const target = Math.max(0, Math.min(100, percentage));
  const [progress, setProgress] = useState(() => (prefersReducedMotion() ? target : 0));
  const [shownTotal, setShownTotal] = useState(() => (prefersReducedMotion() ? total : 0));

  useEffect(() => {
    let raf = 0;
    if (prefersReducedMotion()) {
      // Snap inside a rAF, not the effect body, to avoid the set-state-in-effect lint.
      raf = requestAnimationFrame(() => {
        setProgress(target);
        setShownTotal(total);
      });
      return () => cancelAnimationFrame(raf);
    }
    const DURATION = 750; // ms
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(target * eased);
      setShownTotal(Math.round(total * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, total]);

  const R = 84;
  const STROKE = 6;
  const SIZE = (R + STROKE) * 2;
  const CENTER = SIZE / 2;
  const circumference = 2 * Math.PI * R;
  const offset = circumference * (1 - progress / 100);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: SIZE, height: SIZE }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R}
          fill="none"
          stroke="var(--color-hairline)"
          strokeWidth={STROKE}
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R}
          fill="none"
          stroke="var(--color-accent-solid)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="relative flex flex-col items-center leading-none">
        <span className="font-serif text-6xl font-semibold text-ink tabular-nums tracking-tight">
          {shownTotal}
        </span>
        <span className="mt-1 font-serif text-lg text-slate tabular-nums tracking-tight">/ {max}</span>
        <span className="mt-2 text-sm text-slate tabular-nums tracking-tight">{Math.round(progress)}%</span>
      </div>
    </div>
  );
}

export default function ViewResults() {
  const navigate = useNavigate();
  const { studentId: urlStudentId, assessmentId: urlAssessmentId } = useParams<{
    studentId: string;
    assessmentId: string;
  }>();

  const {
    studentId,
    assessmentId,
    assessment,
    progress,
    results,
    isResultsReady,
    isResultsPending,
    resultsPollExhausted,
    isLoading,
    error,
    setStudentInfo,
    loadQuestions,
    loadResults,
    loadProgress,
    clearError,
    resetResultsPolling,
    setResultsPollExhausted,
  } = useAssessmentStore();

  const addToast = useToastStore((state) => state.addToast);

  useEffect(() => {
    if (urlStudentId && urlAssessmentId) {
      setStudentInfo(urlStudentId, urlAssessmentId);
    }
  }, [urlStudentId, urlAssessmentId, setStudentInfo]);

  // Progress gates the results fetch on submission status.
  useEffect(() => {
    if (studentId && assessmentId && !progress) {
      loadProgress();
    }
  }, [studentId, assessmentId, progress, loadProgress]);

  // Foreground fetch exactly once; background polling takes over so the spinner shows only on first load.
  const initialLoadDoneRef = useRef(false);
  useEffect(() => {
    if (initialLoadDoneRef.current) return;
    if (studentId && assessmentId && !isResultsReady) {
      if (!progress || progress.status === 'submitted') {
        initialLoadDoneRef.current = true;
        loadResults();
      }
    }
  }, [studentId, assessmentId, isResultsReady, progress, loadResults]);

  // Only for title/course metadata; best-effort.
  useEffect(() => {
    if (studentId && assessmentId && !assessment) {
      loadQuestions().catch(() => {
        // ignore
      });
    }
  }, [studentId, assessmentId, assessment, loadQuestions]);

  // Background polls don't touch isLoading, so the pending panel doesn't flicker.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (isResultsReady || resultsPollExhausted) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (!studentId || !assessmentId) return;
    if (progress && progress.status !== 'submitted') return;

    pollRef.current = setInterval(() => {
      if (useAssessmentStore.getState().resultsPollCount >= MAX_RESULT_POLLS) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setResultsPollExhausted(true);
        return;
      }
      loadResults({ background: true });
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isResultsReady, resultsPollExhausted, studentId, assessmentId, progress, loadResults, setResultsPollExhausted]);

  const handleCheckAgain = () => {
    initialLoadDoneRef.current = true;
    resetResultsPolling();
    loadResults();
  };

  const assessmentHeader = assessment ? (
    <div className="text-center mb-6">
      <h1 className="font-serif text-2xl font-semibold text-ink">{assessment.title}</h1>
      {assessment.course && (
        <p className="text-slate mt-1">{assessment.course}</p>
      )}
    </div>
  ) : null;

  if (progress && progress.status !== 'submitted') {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          {assessmentHeader}
          <svg className="mx-auto h-12 w-12 text-caution mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <h2 className="font-serif text-lg font-semibold text-ink mb-2">Assessment Not Submitted</h2>
          <p className="text-sm text-slate mb-4">You need to complete and submit the assessment before viewing results.</p>
          <button
            onClick={() => navigate(`/${studentId}/${assessmentId}`)}
            className="rounded-xl bg-accent text-white px-6 py-2 hover:bg-accent-hover transition-colors duration-200 ease-out"
          >
            Return to Assessment
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          {assessmentHeader}
          <div className="flex justify-center">
            <LoadingSpinner size="lg" message="Loading results..." />
          </div>
        </div>
      </div>
    );
  }

  if (resultsPollExhausted && !isResultsReady && !results) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          {assessmentHeader}
          <div className="p-6 bg-caution/10 border border-caution/20 rounded-xl text-center">
            <svg className="mx-auto h-12 w-12 text-caution mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 className="font-serif text-lg font-semibold text-ink mb-2">This is taking longer than expected</h2>
            <p className="text-sm text-slate mb-4">
              Your assessment is still being evaluated. You can safely close this page and come back
              later, or check again now.
            </p>
            <button
              onClick={handleCheckAgain}
              className="rounded-xl bg-accent text-white px-6 py-2 hover:bg-accent-hover transition-colors duration-200 ease-out"
            >
              Check again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // isResultsPending can be set with no error (a 2xx "still evaluating" body), so it gates
  // this block too. The error only picks which pending panel to show.
  if (error || isResultsPending) {
    const isNotReleased = isResultsNotReleasedError(error);
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          {assessmentHeader}
          {isNotReleased ? (
            <div className="p-6 bg-accent/[0.06] border border-accent/20 rounded-xl text-center">
              <svg className="mx-auto h-12 w-12 text-accent mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <h2 className="font-serif text-lg font-semibold text-ink mb-2">Results Pending Release</h2>
              <p className="text-sm text-slate">Your results are ready but have not yet been released by your instructor.</p>
              <p className="text-xs text-slate mt-2">This page will update automatically.</p>
            </div>
          ) : isResultsPending ? (
            <div className="p-6 bg-accent/[0.06] border border-accent/20 rounded-xl text-center">
              {/* Reduced motion freezes this via index.css. */}
              <div className="mx-auto h-12 w-12 mb-3 flex items-center justify-center">
                <span className="h-3 w-3 rounded-full bg-accent animate-pulse" aria-hidden="true"></span>
              </div>
              <h2 className="font-serif text-lg font-semibold text-ink mb-2">Evaluating Your Assessment</h2>
              <p className="text-sm text-slate">Your assessment is being evaluated.</p>
              <p className="text-sm text-slate mt-1">This usually takes 2–5 minutes depending on the number of questions.</p>
              <p className="text-xs text-slate mt-2">This page will update automatically.</p>
            </div>
          ) : error ? (
            <>
              <ErrorMessage error={error} onDismiss={clearError} />
              <button onClick={() => loadResults()} className="mt-4 w-full rounded-xl bg-accent text-white px-4 py-2 hover:bg-accent-hover transition-colors duration-200 ease-out">
                Retry
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  if (!results) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          {assessmentHeader}
          <h2 className="font-serif text-xl font-semibold text-ink mb-2">
            No Results Available
          </h2>
          <p className="text-slate mb-4">
            Results for this assessment are not available yet.
          </p>
          <button
            onClick={handleCheckAgain}
            className="rounded-xl bg-accent text-white px-6 py-2 hover:bg-accent-hover transition-colors duration-200 ease-out"
          >
            Check Again
          </button>
        </div>
      </div>
    );
  }

  const grade = results.grade;
  const gradeColorClass = getBandGradeColor(grade);

  const handleDownloadPdf = async () => {
    if (!studentId || !assessmentId) return;
    try {
      const blob = await getResultsPdf(studentId, assessmentId);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `results-${assessmentId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch {
      addToast('Failed to download PDF. Please try again.', 'error');
    }
  };

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-paper border-b border-hairline">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <h1 className="font-serif text-2xl font-semibold text-ink">Assessment Results</h1>
            <button onClick={handleDownloadPdf} className={PDF_BUTTON_CLASS}>
              Download PDF
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-hairline bg-ink/[0.02] p-3 text-sm text-slate">
          <svg className="h-5 w-5 flex-shrink-0 text-slate mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>
            Scores and feedback are AI-generated. If you believe a result is incorrect, contact your
            instructor.
          </p>
        </div>

        <div className="bg-paper rounded-xl border border-hairline p-8 mb-8">
          <div className="flex flex-col items-center">
            <ScoreDial
              total={results.totalScore}
              max={results.maxScore}
              percentage={results.percentage}
            />

            <div className="mt-6 flex items-center gap-3 rounded-xl border border-hairline px-4 py-2">
              <span className="text-sm text-slate">Grade</span>
              <span className={`rounded-xl px-3 py-0.5 font-serif font-semibold ${gradeColorClass}`}>
                {grade}
              </span>
            </div>

            <div className="mt-8 w-full max-w-md grid grid-cols-2 gap-6 pt-6 border-t border-hairline text-center">
              <div>
                <div className="font-serif text-2xl font-semibold text-ink tabular-nums tracking-tight">
                  {results.questions.length}
                </div>
                <div className="text-sm text-slate">Questions</div>
              </div>
              <div>
                {results.submittedAt && (
                  <>
                    <div className="text-sm font-medium text-ink tabular-nums tracking-tight">{formatTimestamp(results.submittedAt)}</div>
                    <div className="text-sm text-slate">Submitted</div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div>
          <h2 className="font-serif text-xl font-semibold text-ink mb-4">
            Question Details
          </h2>
          <div className="space-y-4">
            {results.questions.map((questionResult) => (
              <ResultsCard
                key={questionResult.questionId}
                result={questionResult}
              />
            ))}
          </div>

          <div className="mt-8 flex justify-center">
            <button onClick={handleDownloadPdf} className={PDF_BUTTON_CLASS}>
              Download PDF
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
