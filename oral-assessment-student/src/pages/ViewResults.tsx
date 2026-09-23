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

// Auto-poll cadence and cap. ~15 background polls × 8s ≈ 2 minutes before we
// stop and hand control back to the student with a manual "Check again".
const POLL_INTERVAL_MS = 8000;
const MAX_RESULT_POLLS = 15;

// Single accent style shared by both "Download PDF" buttons.
const PDF_BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2 text-sm font-medium hover:bg-accent-hover transition-colors duration-200 ease-out';

/** True when the user has asked the OS to reduce motion. SSR/no-matchMedia safe. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Signature #2 — oversized serif numeral over a thin teal arc dial whose sweep
 * equals `percentage`. Both the numeral and the stroke count up ONCE on mount
 * over ~750ms ease-out; under prefers-reduced-motion they snap to the final
 * value instantly. Pure presentation — no behavior or copy depends on it.
 */
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
      // Snap to final values asynchronously (in a rAF callback, not
      // synchronously in the effect body) so prop changes still settle
      // without triggering a cascading-render lint error.
      raf = requestAnimationFrame(() => {
        setProgress(target);
        setShownTotal(total);
      });
      return () => cancelAnimationFrame(raf);
    }
    const DURATION = 750; // ms, within the 600–900ms spec window
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(target * eased);
      setShownTotal(Math.round(total * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, total]);

  // Geometry: a near-full sweep with a small gap at the bottom reads as a dial.
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
        {/* Track */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R}
          fill="none"
          stroke="var(--color-hairline)"
          strokeWidth={STROKE}
        />
        {/* Teal sweep */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R}
          fill="none"
          stroke="var(--color-accent)"
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

  // Initialize and load results
  useEffect(() => {
    if (urlStudentId && urlAssessmentId) {
      setStudentInfo(urlStudentId, urlAssessmentId);
    }
  }, [urlStudentId, urlAssessmentId, setStudentInfo]);

  // Load progress first to check submission status
  useEffect(() => {
    if (studentId && assessmentId && !progress) {
      loadProgress();
    }
  }, [studentId, assessmentId, progress, loadProgress]);

  // First (foreground) results fetch — exactly once. Background polling (below)
  // takes over afterwards so the full-screen spinner only ever shows on first load.
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

  // Load assessment metadata (title, course) if not already in store
  useEffect(() => {
    if (studentId && assessmentId && !assessment) {
      loadQuestions().catch(() => {
        // Silently ignore — metadata is best-effort for display
      });
    }
  }, [studentId, assessmentId, assessment, loadQuestions]);

  // Auto-poll while results are pending. Polls run in the BACKGROUND (no global
  // isLoading), so the "Evaluating Your Assessment" panel stays put with no
  // spinner flicker. Stops when results arrive OR the attempt cap is reached.
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
    initialLoadDoneRef.current = true; // initial load already happened; this is a manual retry
    resetResultsPolling();
    loadResults();
  };

  // Shared assessment header for pending/error states
  const assessmentHeader = assessment ? (
    <div className="text-center mb-6">
      <h1 className="font-serif text-2xl font-semibold text-ink">{assessment.title}</h1>
      {assessment.course && (
        <p className="text-slate mt-1">{assessment.course}</p>
      )}
    </div>
  ) : null;

  // Guard: if progress loaded and assessment not submitted, redirect to assessment
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

  // Loading state — first foreground fetch only (background polls never set isLoading)
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

  // Polling exhausted — grading is taking longer than expected. Offer a manual retry.
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

  // Error / pending states. `isResultsPending` can be set without an error when
  // the server answered 2xx with a "still evaluating" body rather than results,
  // so it gates this block too — otherwise that case would fall through to the
  // "No Results Available" panel.
  if (error || isResultsPending) {
    // `isResultsPending` (store) is the single source of truth for "still pending";
    // the error message only refines WHICH pending panel (not-released vs evaluating).
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
              {/* Calm breathing dot instead of a spinner — the 8s poll updates
                  this panel in place; reduced-motion freezes it via index.css. */}
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

  // No results state
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
      {/* Header */}
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
        {/* AI-grading disclosure */}
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-hairline bg-ink/[0.02] p-3 text-sm text-slate">
          <svg className="h-5 w-5 flex-shrink-0 text-slate mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>
            Scores and feedback are AI-generated. If you believe a result is incorrect, contact your
            instructor.
          </p>
        </div>

        {/* Overall Score Card — signature #2: serif numeral + teal arc dial */}
        <div className="bg-paper rounded-xl border border-hairline p-8 mb-8">
          <div className="flex flex-col items-center">
            <ScoreDial
              total={results.totalScore}
              max={results.maxScore}
              percentage={results.percentage}
            />

            {/* Grade as a restrained hairline row, not a rounded-full pill */}
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

        {/* Question Results */}
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

          {/* Bottom Download PDF — unified accent style, same as header */}
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
