import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { apiService } from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';
import { useToastStore } from '../store/toastStore';
import LoadingSpinner from './LoadingSpinner';
import ErrorMessage from './ErrorMessage';
import { gradeToken } from '../utils/statusTokens';
import type { Schemas } from '../../../shared/types/assessment';

interface ResultsDashboardProps {
  assessmentId: string;
  evalJobId?: string;
}

// completedAt is null for enrolled-but-unsubmitted students; `new Date(null)` is
// epoch 1970 ("56 years ago"), so guard before formatting and show a dash instead.
function isValidDate(value: unknown): value is string | number | Date {
  if (value === null || value === undefined || value === '') return false;
  return !Number.isNaN(new Date(value as string | number | Date).getTime());
}

export default function ResultsDashboard({ assessmentId, evalJobId }: ResultsDashboardProps) {
  const navigate = useNavigate();
  const { results, setResults, progress, setProgress, isLoading, setLoading, error, setError } = useAssessmentStore();
  const addToast = useToastStore((s) => s.addToast);

  const [isReleasing, setIsReleasing] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);
  const [resultsReleased, setResultsReleased] = useState<boolean | null>(null);
  const [flagged, setFlagged] = useState<Pick<Schemas['FlaggedEvaluationsResponse'], 'flaggedCount' | 'items'> | null>(null);
  const [agreement, setAgreement] = useState<Schemas['ScoreAgreementResponse'] | null>(null);
  const [showFlagged, setShowFlagged] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  const loadFlagged = async () => {
    try {
      const { flaggedCount, items } = await apiService.getFlaggedEvaluations(assessmentId);
      setFlagged({ flaggedCount, items });
    } catch { /* non-critical */ }
  };

  const loadAgreement = async () => {
    try {
      setAgreement(await apiService.getScoreAgreement(assessmentId));
    } catch { /* non-critical */ }
  };

  const loadReleasedState = async () => {
    try {
      const assessment = await apiService.getAssessment(assessmentId);
      setResultsReleased(assessment.resultsReleased ?? false);
    } catch { /* non-critical */ }
  };

  const loadProgress = async () => {
    try {
      const students = await apiService.getAssessmentProgress(assessmentId);
      setProgress(students);
    } catch { /* non-critical */ }
  };

  const loadResults = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiService.getAssessmentResults(assessmentId);
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load results');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Intentional reset-on-key-change: clear stale results/release state when
    // switching assessments before the async loaders below refetch them.
    setResults([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResultsReleased(null);
    loadResults();
    loadReleasedState();
    loadProgress();
    loadFlagged();
    loadAgreement();
  }, [assessmentId]);

  useEffect(() => {
    if (!evalJobId) return;
    const es = apiService.openEvaluationStatusStream(assessmentId, evalJobId);
    sseRef.current = es;
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status === 'completed') {
          loadResults();
          es.close();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [evalJobId]);

  const handleReleaseResults = async () => {
    try {
      setIsReleasing(true);
      await apiService.releaseResults(assessmentId);
      setResultsReleased(true);
      addToast('Results released to students.', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to release results', 'error');
    } finally {
      setIsReleasing(false);
    }
  };

  const resultsArray = Array.isArray(results) ? results : [];

  const submittedCount = progress.filter(
    (s) => s.status === 'completed' || s.status === 'submitted'
  ).length;
  const evaluatedCount = resultsArray.length;
  const hasUnevaluated = submittedCount > 0 && evaluatedCount < submittedCount;

  const gradeCounts = resultsArray.reduce((acc, r) => {
    acc[r.grade] = (acc[r.grade] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const gradeSummary = Object.entries(gradeCounts).map(([g, c]) => `${c} ${g}`).join(', ');

  if (isLoading && results.length === 0) {
    return (
      <div className="py-8">
        <LoadingSpinner size="lg" message="Loading results…" />
      </div>
    );
  }

  if (!isLoading && results.length === 0) {
    return (
      <div className="space-y-6">
        {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}
        <div className="bg-paper border border-hairline rounded-xl p-12 text-center">
          <h3 className="font-serif text-lg font-semibold text-ink mb-2">No Results Available</h3>
          <p className="text-slate">Results will appear here once students complete the assessment and evaluations are processed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}

      {/* Release Results */}
      <div className="bg-paper border border-hairline rounded-xl p-4">
        {resultsReleased ? (
          <div className="flex items-center justify-between gap-4" role="status" aria-live="polite">
            <div>
              <p className="text-sm font-medium text-success">Results Released</p>
              <p className="text-xs text-slate">Students can view their scores and feedback.</p>
            </div>
            <span className="flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium bg-success/10 text-success">Released</span>
          </div>
        ) : showReleaseConfirm ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">Confirm release?</p>
            <p className="text-xs text-slate">This will make scores and feedback visible to all students immediately.</p>
            {hasUnevaluated && (
              <div className="bg-caution/10 border border-caution/30 rounded-xl px-3 py-2" role="alert">
                <p className="text-sm text-caution font-medium tabular-nums">
                  Only {evaluatedCount} of {submittedCount} submitted students have been evaluated.
                </p>
                <p className="text-xs text-caution mt-0.5">
                  Students without evaluations will see no results.
                </p>
              </div>
            )}
            <div className="flex items-center gap-3">
              {/* Releasing cannot be undone from here, so the commit step carries
                  danger weight rather than a reassuring "go" colour. */}
              <button
                onClick={async () => { await handleReleaseResults(); setShowReleaseConfirm(false); }}
                disabled={isReleasing}
                className="bg-danger text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-danger/90 transition-colors disabled:opacity-50"
              >
                {isReleasing ? 'Releasing…' : 'Confirm Release'}
              </button>
              <button onClick={() => setShowReleaseConfirm(false)} className="text-slate hover:text-ink text-sm transition-colors">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">Release Results to Students</p>
            <button
              onClick={() => setShowReleaseConfirm(true)}
              className="bg-accent text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              Release Results
            </button>
          </div>
        )}
      </div>

      {/* Summary */}
      {gradeSummary && (
        <p className="text-sm text-slate tabular-nums">{resultsArray.length} students evaluated — {gradeSummary}</p>
      )}

      {/* Review & validity (Tasks 3 & 5) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">Flagged for review</p>
            <span className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium tabular-nums ${flagged && flagged.flaggedCount > 0 ? 'bg-caution/10 text-caution' : 'bg-ink/5 text-slate'}`}>
              {flagged ? flagged.flaggedCount : '—'}
            </span>
          </div>
          <p className="text-xs text-slate mt-1">
            Evaluations needing a human glance before release (low confidence, AI fallback, or divergent scores).
          </p>
          {flagged && flagged.flaggedCount > 0 && (
            <button
              onClick={() => setShowFlagged(v => !v)}
              aria-expanded={showFlagged}
              aria-controls="flagged-evaluation-list"
              className="mt-2 text-xs text-accent hover:text-accent-hover hover:underline transition-colors"
            >
              {showFlagged ? 'Hide flagged items' : 'View flagged items'}
            </button>
          )}
          {showFlagged && flagged && (
            <ul id="flagged-evaluation-list" className="mt-2 max-h-44 overflow-y-auto text-xs text-slate space-y-1">
              {flagged.items.map((it, idx) => (
                <li key={`${it.studentId}-${it.questionId}-${idx}`} className="flex items-center justify-between gap-2">
                  <button
                    className="text-accent hover:text-accent-hover hover:underline truncate transition-colors"
                    onClick={() => navigate(`/assessments/${assessmentId}/student/${it.studentId}/results`)}
                  >
                    {it.studentId}
                  </button>
                  <span className="text-slate truncate">{it.reasons.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <p className="text-sm font-medium text-ink">AI vs human agreement</p>
          {agreement && agreement.dualScoredCount > 0 ? (
            <div className="mt-1 text-xs text-slate space-y-0.5">
              <p>Dual-scored items: <span className="font-medium text-ink tabular-nums">{agreement.dualScoredCount}</span></p>
              <p>Exact match: <span className="font-medium text-ink tabular-nums">{agreement.exactMatchRate != null ? `${(agreement.exactMatchRate * 100).toFixed(0)}%` : '—'}</span></p>
              <p>Within 1 mark: <span className="font-medium text-ink tabular-nums">{agreement.within1Rate != null ? `${(agreement.within1Rate * 100).toFixed(0)}%` : '—'}</span></p>
              <p>Mean abs. difference: <span className="font-medium text-ink tabular-nums">{agreement.meanAbsoluteDifference != null ? agreement.meanAbsoluteDifference.toFixed(2) : '—'}</span></p>
            </div>
          ) : (
            <p className="text-xs text-slate mt-1">
              No human reference scores recorded yet. Enter human scores on a student's detail page to measure agreement.
            </p>
          )}
        </div>
      </div>

      {/* Results Table */}
      <div className="bg-paper border border-hairline rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink/5">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">Student</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">Score</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">Grade</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">Completed</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {resultsArray.map((result) => (
                // The whole row stays clickable as a convenience, but the "View"
                // cell below is a real <Link> so the row is reachable (and
                // announced) by keyboard and screen readers too.
                <tr key={result.studentId} className="hover:bg-ink/5 transition-colors" onClick={() => navigate(`/assessments/${assessmentId}/student/${result.studentId}/results`)}>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-ink">{result.name ?? result.studentId}</div>
                    <div className="text-xs text-slate">{result.email ?? ''}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-ink tabular-nums">
                    {result.totalScore}/{result.maxScore} ({result.percentage}%)
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${gradeToken(result.grade).className}`}>
                      {gradeToken(result.grade).label}
                    </span>
                  </td>
                  <td
                    className="px-4 py-3 text-sm text-slate"
                    title={isValidDate(result.completedAt) ? new Date(result.completedAt).toLocaleString() : undefined}
                  >
                    {isValidDate(result.completedAt)
                      ? formatDistanceToNow(new Date(result.completedAt), { addSuffix: true })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/assessments/${assessmentId}/student/${result.studentId}/results`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-accent hover:text-accent-hover text-sm transition-colors"
                    >
                      View<span className="sr-only"> results for {result.name ?? result.studentId}</span> →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
