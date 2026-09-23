import { Link, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import { apiService } from '../services/api';
import AppShell from '../components/AppShell';
import ResultsDashboard from '../components/ResultsDashboard';
import CohortReport from '../components/CohortReport';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';

export default function ViewResults() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const { selectedAssessment, setSelectedAssessment, setLoading, error, setError } = useAssessmentStore();

  const loadAssessment = async (id: string) => {
    try {
      setLoading(true);
      setError(null);
      const assessment = await apiService.getAssessment(id);
      setSelectedAssessment(assessment);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessment');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (assessmentId && assessmentId !== selectedAssessment?.id) {
      loadAssessment(assessmentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch only when the route id changes; loadAssessment is recreated each render and uses only stable setters
  }, [assessmentId]);

  // Full-page loading / error state — AppShell is only mounted once there is an
  // assessment to title it with.
  if (!selectedAssessment || !assessmentId) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        {error ? (
          <div className="w-full max-w-md">
            <ErrorMessage error={error} />
          </div>
        ) : (
          <LoadingSpinner size="lg" message="Loading assessment…" />
        )}
      </div>
    );
  }

  return (
    <AppShell
      // ViewResults is the assessment's canonical landing page, so the assessment
      // title IS the leaf here — unlinked, and stamped aria-current="page" by
      // AppShell. This is the one screen whose trail stops at the title.
      breadcrumbs={[
        { label: 'Assessments', to: '/assessments' },
        { label: selectedAssessment.title },
      ]}
      title={`Results: ${selectedAssessment.title}`}
      subtitle={selectedAssessment.course}
      actions={
        <Link
          to={`/assessments/${assessmentId}/monitor`}
          className="inline-flex items-center rounded-xl border border-hairline bg-paper px-4 py-2 text-sm font-medium text-ink hover:bg-ink/5 transition-colors"
        >
          Monitor Progress
        </Link>
      }
    >
      <div className="space-y-4">
        <CohortReport assessmentId={assessmentId} />
        <ResultsDashboard assessmentId={assessmentId} />
      </div>
    </AppShell>
  );
}
