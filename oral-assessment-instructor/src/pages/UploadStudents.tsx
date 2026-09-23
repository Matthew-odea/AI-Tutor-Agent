import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import { apiService } from '../services/api';
import type { Schemas } from '../../../shared/types/assessment';
import AppShell from '../components/AppShell';
import BulkUploadCSV from '../components/BulkUploadCSV';
import ErrorMessage from '../components/ErrorMessage';
import LoadingSpinner from '../components/LoadingSpinner';
import SetupStepIndicator from '../components/SetupStepIndicator';
import { useToastStore } from '../store/toastStore';

export default function UploadStudents() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedAssessment, error, setSelectedAssessment, setLoading, setError } = useAssessmentStore();
  const addToast = useToastStore((s) => s.addToast);

  const [edToken, setEdToken] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ count: number; students: Schemas['ImportedStudentSummary'][] } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

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

  useEffect(() => {
    const state = location.state as { created?: string } | null;
    if (state?.created) {
      addToast(`Assessment "${state.created}" created successfully.`, 'success');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one toast on arrival from the create form, not on later navigation state changes
  }, []);

  const handleEdImport = async () => {
    if (!assessmentId || !edToken.trim() || !challengeId.trim()) return;
    setIsImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await apiService.importFromEd(assessmentId, edToken.trim(), Number(challengeId.trim()));
      setImportResult({ count: result.studentsImported, students: result.students });
      addToast(`Imported ${result.studentsImported} students from Ed.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import from Ed';
      setImportError(msg);
    } finally {
      setIsImporting(false);
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

  if (!selectedAssessment) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <LoadingSpinner size="lg" message="Loading assessment…" />
      </div>
    );
  }

  // Shared so the two Ed credentials fields can't drift apart visually.
  const inputClass =
    'w-full px-3 py-2 border border-hairline rounded-xl bg-paper text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none';

  return (
    <AppShell
      breadcrumbs={[
        { label: 'Assessments', to: '/assessments' },
        { label: selectedAssessment.title, to: `/assessments/${selectedAssessment.id}/results` },
        { label: 'Upload Students' },
      ]}
      title={`Upload Students: ${selectedAssessment.title}`}
      subtitle={selectedAssessment.course}
      banner={
        <SetupStepIndicator
          currentStep={2}
          assessmentId={selectedAssessment.id}
          maxWidth="narrow"
        />
      }
      maxWidth="narrow"
      contentClassName="space-y-8"
    >
      {/* Import from Ed */}
      <div className="bg-paper rounded-xl border border-hairline p-6">
        <h2 className="font-serif text-lg font-semibold text-ink mb-1">Import from Ed</h2>
        <p className="text-sm text-slate mb-4">
          Pull students and their code submissions directly from an Ed challenge.
        </p>

        {/* A failed import is a rejection of what was typed into these two fields, so
            both are marked invalid and point at the error region while it's showing. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label htmlFor="challengeId" className="block text-sm font-medium text-ink mb-1">
              Challenge ID
            </label>
            <input
              id="challengeId"
              type="number"
              value={challengeId}
              onChange={(e) => setChallengeId(e.target.value)}
              placeholder="e.g. 238511"
              aria-invalid={importError ? true : undefined}
              aria-describedby={importError ? 'challengeId-hint ed-import-error' : 'challengeId-hint'}
              className={`${inputClass} tabular-nums`}
            />
            <p id="challengeId-hint" className="mt-1 text-xs text-slate">
              From the Ed URL: edstem.org/.../challenges/<strong>ID</strong>
            </p>
          </div>
          <div>
            <label htmlFor="edToken" className="block text-sm font-medium text-ink mb-1">
              Ed API Token
            </label>
            <input
              id="edToken"
              type="password"
              value={edToken}
              onChange={(e) => setEdToken(e.target.value)}
              placeholder="Your Ed API token"
              aria-invalid={importError ? true : undefined}
              aria-describedby={importError ? 'edToken-hint ed-import-error' : 'edToken-hint'}
              className={inputClass}
            />
            <p id="edToken-hint" className="mt-1 text-xs text-slate">
              From edstem.org → Settings → API Tokens
            </p>
          </div>
        </div>

        {importError && (
          <div id="ed-import-error" className="mb-4">
            <ErrorMessage error={importError} onDismiss={() => setImportError(null)} />
          </div>
        )}

        {importResult && (
          <div
            className="mb-4 p-3 bg-success/10 border border-success/30 rounded-xl"
            role="status"
            aria-live="polite"
          >
            <p className="text-sm text-success font-medium mb-1">
              Imported <span className="tabular-nums">{importResult.count}</span> students
            </p>
            <ul className="text-xs text-success space-y-0.5">
              {importResult.students.slice(0, 5).map((s) => (
                <li key={s.studentId}>{s.name} ({s.studentId}) {s.hasCode ? '— code loaded' : '— no submission'}</li>
              ))}
              {importResult.students.length > 5 && (
                <li>...and <span className="tabular-nums">{importResult.students.length - 5}</span> more</li>
              )}
            </ul>
            <button
              type="button"
              onClick={() => navigate(`/assessments/${assessmentId}/generate`)}
              className="mt-3 bg-accent text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper"
            >
              Continue to Generate Questions
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={handleEdImport}
          disabled={isImporting || !edToken.trim() || !challengeId.trim()}
          aria-busy={isImporting}
          className="bg-accent text-white px-6 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isImporting ? 'Importing...' : 'Import from Ed'}
        </button>
        {isImporting && (
          <p role="status" aria-live="polite" className="mt-2 text-sm text-slate">
            Importing students from Ed…
          </p>
        )}
      </div>

      {/* CSV fallback */}
      <div className="bg-paper rounded-xl border border-hairline p-6">
        <h2 className="font-serif text-lg font-semibold text-ink mb-1">Or upload CSV</h2>
        <p className="text-sm text-slate mb-4">
          Upload a CSV file with student information and code submissions manually.
        </p>
        <BulkUploadCSV
          assessmentId={selectedAssessment.id}
          onUploadSuccess={() => addToast('Students uploaded successfully.', 'success')}
        />
      </div>
    </AppShell>
  );
}
