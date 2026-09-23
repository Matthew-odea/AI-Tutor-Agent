import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import { apiService } from '../services/api';
import AppShell from '../components/AppShell';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import { assessmentStatusToken } from '../utils/statusTokens';

export default function AssessmentList() {
  const { assessments, setAssessments, isLoading, setLoading, error, setError } = useAssessmentStore();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [statsCache, setStatsCache] = useState<Record<string, { enrolled: number; completed: number }>>({});

  const loadAssessments = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiService.listAssessments();
      const list = Array.isArray(data) ? data : [];
      setAssessments(list);
      setLoading(false);

      // Load stats in background — don't block the page render.
      // Sequential to avoid overwhelming the single-worker backend.
      for (const a of list) {
        try {
          const progData = await apiService.getAssessmentProgress(a.id);
          const prog = Array.isArray(progData) ? progData : [];
          const enrolled = prog.length;
          const completed = prog.filter(s => s.status === 'submitted' || s.status === 'completed').length;
          setStatsCache(prev => ({ ...prev, [a.id]: { enrolled, completed } }));
        } catch {
          // skip — card just won't show stats
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessments');
      setLoading(false);
    }
  };

  useEffect(() => {
    // Intentional: load assessments once on mount. loadAssessments toggles
    // loading/error/data state as it fetches — effect-driven initial fetch,
    // not a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAssessments();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch; loadAssessments only touches stable store setters and apiService
  }, []);

  // Auto-refresh stats when page regains focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadAssessments();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a mount-time loadAssessments is safe to reuse: it only touches stable store setters and apiService
  }, []);

  const handleDelete = async (assessmentId: string) => {
    setIsDeleting(true);
    try {
      await apiService.deleteAssessment(assessmentId);
      const current = Array.isArray(assessments) ? assessments : [];
      setAssessments(current.filter(a => a.id !== assessmentId));
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete assessment');
    } finally {
      setIsDeleting(false);
    }
  };

  // Display assessments (real data when available)
  const displayAssessments = Array.isArray(assessments) ? assessments : [];

  return (
    <AppShell
      title="Oral Assessments"
      actions={
        <>
          <Link
            to="/assessments/create"
            className="inline-flex items-center rounded-xl bg-accent hover:bg-accent-hover text-white px-4 py-2 text-sm font-medium transition-colors"
          >
            + Create Assessment
          </Link>
          <button
            onClick={() => loadAssessments()}
            disabled={isLoading}
            aria-busy={isLoading}
            className="inline-flex items-center rounded-xl border border-hairline bg-paper px-3 py-2 text-sm font-medium text-ink hover:bg-ink/5 transition-colors disabled:opacity-50"
            title="Refresh assessments"
          >
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </>
      }
    >
      {error && (
        <div className="mb-6">
          <ErrorMessage error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner size="lg" message="Loading assessments…" />
      ) : (
        <div className="grid gap-6">
          {displayAssessments.map((assessment) => {
          // Chip tint AND label both come from the shared status tokens, so the
          // status reads as Title Case here exactly as it does on every other
          // screen instead of the raw lowercase backend value.
          const status = assessmentStatusToken(assessment.status);
          return (
          <div
            key={assessment.id}
            className="bg-paper rounded-xl border border-hairline p-5 hover:border-accent/40 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-3">
                  <Link to={`/assessments/${assessment.id}/results`} className="text-lg font-semibold text-ink hover:text-accent transition-colors truncate">
                    {assessment.title}
                  </Link>
                  <span className={`${status.className} text-xs px-2 py-0.5 rounded-full flex-shrink-0`}>
                    {status.label}
                  </span>
                </div>
                <p className="text-sm text-slate mt-1">
                  {assessment.course}
                  {statsCache[assessment.id] && (
                    <span className="ml-3 tabular-nums">{statsCache[assessment.id].enrolled} students, {statsCache[assessment.id].completed} completed</span>
                  )}
                </p>
              </div>
              <div className="flex items-center space-x-2 ml-4">
                <Link
                  to={`/assessments/${assessment.id}/results`}
                  className="inline-flex items-center rounded-xl bg-accent hover:bg-accent-hover text-white px-4 py-2 text-sm font-medium transition-colors"
                >
                  Open
                </Link>
                {/* Two-step inline confirm — no modal for a destructive-but-recoverable
                    action, and the confirm names the assessment for screen readers. */}
                {confirmDeleteId === assessment.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(assessment.id)}
                      disabled={isDeleting}
                      aria-label={`Confirm deletion of ${assessment.title}`}
                      className="rounded-xl bg-danger text-white px-3 py-2 text-sm font-medium hover:bg-danger/90 transition-colors disabled:opacity-50"
                    >
                      {isDeleting ? 'Deleting…' : 'Confirm'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      aria-label={`Cancel deleting ${assessment.title}`}
                      className="text-slate hover:text-ink text-sm transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(assessment.id)}
                    aria-label={`Delete ${assessment.title}`}
                    className="text-slate hover:text-danger text-sm transition-colors"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
          );
          })}
        </div>
      )}

      {!isLoading && !error && displayAssessments.length === 0 && (
        <div className="bg-paper border border-hairline rounded-xl p-12 text-center">
          <h2 className="font-serif text-lg font-semibold text-ink">No assessments yet</h2>
          <p className="mt-2 text-sm text-slate">
            Create your first assessment to start generating questions and inviting students.
          </p>
          <Link
            to="/assessments/create"
            className="mt-6 inline-flex items-center rounded-xl bg-accent hover:bg-accent-hover text-white px-6 py-3 text-sm font-medium transition-colors"
          >
            Create Your First Assessment
          </Link>
        </div>
      )}
    </AppShell>
  );
}
