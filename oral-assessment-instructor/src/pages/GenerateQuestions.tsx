import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import { useToastStore } from '../store/toastStore';
import { apiService } from '../services/api';
import AppShell from '../components/AppShell';
import ErrorMessage from '../components/ErrorMessage';
import LoadingSpinner from '../components/LoadingSpinner';
import SetupStepIndicator from '../components/SetupStepIndicator';
import QuestionGenerationProgress from '../components/QuestionGenerationProgress';

const BRIEF_MIN_LENGTH = 50;

export default function GenerateQuestions() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const { selectedAssessment, error, setSelectedAssessment, setLoading, setError } = useAssessmentStore();
  const addToast = useToastStore((s) => s.addToast);
  const [brief, setBrief] = useState('');
  const [isSavingBrief, setIsSavingBrief] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  const loadAssessment = async (id: string) => {
    try {
      setLoading(true);
      setError(null);
      const assessment = await apiService.getAssessment(id);
      setSelectedAssessment(assessment);
      if (assessment.assignmentBrief) setBrief(assessment.assignmentBrief);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessment');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (assessmentId && assessmentId !== selectedAssessment?.id) {
      // Intentional: fetch the assessment when the route id changes and it is
      // not already the selected one. loadAssessment toggles loading/error and
      // seeds the brief — an effect-driven fetch, not a render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadAssessment(assessmentId);
    } else if (selectedAssessment?.assignmentBrief) {
      // Seed the local editable brief from the already-loaded assessment in the
      // external store; runs only when the store id matches (no fetch needed).
      setBrief(selectedAssessment.assignmentBrief);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on which assessment is open; re-seeding on every brief change would overwrite the instructor's unsaved edits
  }, [assessmentId, selectedAssessment?.id]);

  const handleSaveBrief = async () => {
    if (!assessmentId) return;
    if ((brief ?? '').trim().length < BRIEF_MIN_LENGTH) {
      setBriefError(`Brief must be at least ${BRIEF_MIN_LENGTH} characters.`);
      return;
    }
    setIsSavingBrief(true);
    setBriefError(null);
    try {
      await apiService.updateBrief(assessmentId, (brief ?? '').trim());
      addToast('Assignment brief saved.', 'success');
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : 'Failed to save brief');
    } finally {
      setIsSavingBrief(false);
    }
  };

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

  const briefLength = (brief ?? '').trim().length;
  const isBriefTooShort = briefLength < BRIEF_MIN_LENGTH;

  return (
    <AppShell
      breadcrumbs={[
        { label: 'Assessments', to: '/assessments' },
        { label: selectedAssessment.title, to: `/assessments/${assessmentId}/results` },
        { label: 'Generate Questions' },
      ]}
      title={`Generate Questions: ${selectedAssessment.title}`}
      subtitle={selectedAssessment.course}
      banner={
        <SetupStepIndicator currentStep={3} assessmentId={assessmentId} maxWidth="narrow" />
      }
      maxWidth="narrow"
      contentClassName="space-y-6"
    >
      {/* Assignment Brief Editor */}
      <div className="bg-paper rounded-xl border border-hairline p-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 className="font-serif text-base font-semibold text-ink">Assignment Brief</h2>
            <p className="text-sm text-slate mt-0.5">
              Describe the assignment so the AI can generate relevant questions. Minimum{' '}
              <span className="tabular-nums">{BRIEF_MIN_LENGTH}</span> characters.
            </p>
          </div>
          {!(brief ?? '').trim() && (
            <span className="flex-shrink-0 px-2.5 py-1 text-xs font-medium text-caution bg-caution/10 border border-caution/30 rounded-full">
              No brief set
            </span>
          )}
        </div>
        <label htmlFor="assignment-brief" className="sr-only">
          Assignment brief
        </label>
        <textarea
          id="assignment-brief"
          value={brief}
          onChange={(e) => { setBrief(e.target.value); setBriefError(null); }}
          rows={5}
          placeholder="Describe the assignment, its objectives, the programming concepts it covers, and what students were expected to implement..."
          aria-invalid={briefError ? true : undefined}
          aria-describedby={`assignment-brief-count${briefError ? ' assignment-brief-error' : ''}`}
          className="w-full px-4 py-3 bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none resize-y text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
          <span
            id="assignment-brief-count"
            className={`text-xs tabular-nums ${isBriefTooShort ? 'text-slate' : 'text-success'}`}
          >
            {briefLength} / {BRIEF_MIN_LENGTH} characters minimum
          </span>
          <div className="flex items-center gap-3">
            {briefError && (
              <span id="assignment-brief-error" role="alert" className="text-xs text-danger">
                {briefError}
              </span>
            )}
            <button
              onClick={handleSaveBrief}
              disabled={isSavingBrief || isBriefTooShort}
              className="bg-accent text-white px-4 py-1.5 rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSavingBrief ? 'Saving…' : 'Save Brief'}
            </button>
          </div>
        </div>
      </div>

      <QuestionGenerationProgress assessmentId={assessmentId} />
    </AppShell>
  );
}
