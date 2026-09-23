import { Link, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import { apiService } from '../services/api';
import AppShell from '../components/AppShell';
import SetupStepIndicator from '../components/SetupStepIndicator';
import StudentProgressTable from '../components/StudentProgressTable';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';

export default function MonitorProgress() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const { selectedAssessment, error, setSelectedAssessment, setLoading, setError } = useAssessmentStore();

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

  // Full-page error state — AppShell is only mounted once there is an assessment
  // to title it with, so the retry lives on its own centred card.
  if (error && !selectedAssessment) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-4">
          <ErrorMessage error={error} />
          <button
            onClick={() => assessmentId && loadAssessment(assessmentId)}
            className="w-full bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!selectedAssessment || !assessmentId) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <LoadingSpinner size="lg" message="Loading assessment…" />
      </div>
    );
  }

  return (
    <AppShell
      breadcrumbs={[
        { label: 'Assessments', to: '/assessments' },
        { label: selectedAssessment.title, to: `/assessments/${assessmentId}/results` },
        { label: 'Monitor Progress' },
      ]}
      title={`Monitor Progress: ${selectedAssessment.title}`}
      subtitle={selectedAssessment.course}
      actions={
        // Ghost, not filled: View Results is lateral navigation to a sibling screen
        // of the same assessment, not this page's primary forward action. Its
        // mirror image on ViewResults ("Monitor Progress") carries the same weight.
        <Link
          to={`/assessments/${assessmentId}/results`}
          className="inline-flex items-center rounded-xl border border-hairline bg-paper px-4 py-2 text-sm font-medium text-ink hover:bg-ink/5 transition-colors"
        >
          View Results
        </Link>
      }
      // Step 4 of the setup flow. Without this banner step 4 was never reachable as
      // "current" anywhere in the app. maxWidth matches this shell's own (default)
      // column so the trail lines up with the title above it.
      banner={
        <SetupStepIndicator currentStep={4} assessmentId={assessmentId} maxWidth="default" />
      }
    >
      <StudentProgressTable assessmentId={assessmentId} />
    </AppShell>
  );
}
