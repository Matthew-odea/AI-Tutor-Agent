import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { apiService } from '../services/api';
import { useToastStore } from '../store/toastStore';
import AppShell from '../components/AppShell';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';

type AxiosLike = { response?: { data?: { detail?: string } }; message?: string };
const errMsg = (e: unknown, fallback: string) =>
  ((e as AxiosLike)?.response?.data?.detail) || ((e as AxiosLike)?.message) || fallback;

interface StudentQuestion {
  id: string;
  text: string;
  questionNumber: number;
  questionType: string;
  difficulty: string;
  topic: string;
  timeLimit?: number | null;
  createdAt: string;
}

interface EditState {
  text: string;
  timeLimit: string;
}

const CHIP_BASE = 'px-2 py-0.5 text-xs border rounded-full';

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-success/10 text-success border-success/30',
  medium: 'bg-caution/10 text-caution border-caution/30',
  hard: 'bg-danger/10 text-danger border-danger/30',
};

const TYPE_COLORS: Record<string, string> = {
  manual: 'bg-accent/10 text-accent border-accent/20',
  specific: 'bg-accent/10 text-accent border-accent/20',
  general: 'bg-ink/5 text-slate border-hairline',
};

const INPUT_CLASS =
  'bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate text-sm focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none';

const PRIMARY_BUTTON_CLASS =
  'bg-accent text-white rounded-xl font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
  'bg-ink/5 text-ink rounded-xl font-medium hover:bg-ink/10 transition-colors';

/** Also enforced server-side. */
const MIN_QUESTION_LENGTH = 10;

export default function QuestionEditor() {
  const { assessmentId, studentId } = useParams<{ assessmentId: string; studentId: string }>();
  const addToast = useToastStore((s) => s.addToast);

  const [questions, setQuestions] = useState<StudentQuestion[]>([]);
  const [assessment, setAssessment] = useState<{ status: string; title?: string } | null>(null);
  const [studentName, setStudentName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ text: '', timeLimit: '' });
  // Field-level; the page-level error banner is reserved for API failures.
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Id of the question whose delete is armed but not yet confirmed.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({
    text: '',
    questionType: 'manual',
    difficulty: 'medium',
    topic: 'general',
    timeLimit: '',
  });
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const isLocked = assessment != null && ['active', 'completed'].includes(assessment.status);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [asmtResp, qResp, studentsResp] = await Promise.all([
        apiService.getAssessment(assessmentId!),
        apiService.listStudentQuestions(assessmentId!, studentId!),
        apiService.getAssessmentStudents(assessmentId!),
      ]);
      setAssessment(asmtResp);
      setQuestions(qResp.questions || []);
      const student = (studentsResp || []).find((s) => s.studentId === studentId);
      setStudentName(student?.name || studentId || '');
    } catch (e: unknown) {
      setError(errMsg(e, 'Failed to load questions'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (assessmentId && studentId) {
      // Effect-driven fetch, not a render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadData is recreated each render but only reads assessmentId/studentId, which are the deps
  }, [assessmentId, studentId]);

  const startEdit = (q: StudentQuestion) => {
    setEditingId(q.id);
    // Editing hides the action row, so an armed delete must not survive it.
    setConfirmDeleteId(null);
    setEditState({ text: q.text, timeLimit: q.timeLimit != null ? String(q.timeLimit) : '' });
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditState({ text: '', timeLimit: '' });
    setEditError(null);
  };

  const saveEdit = async (questionId: string) => {
    if (!editState.text.trim() || editState.text.trim().length < MIN_QUESTION_LENGTH) {
      setEditError(`Question text must be at least ${MIN_QUESTION_LENGTH} characters`);
      return;
    }
    setSaving(true);
    setError(null);
    setEditError(null);
    try {
      const parsed = editState.timeLimit.trim() !== '' ? parseInt(editState.timeLimit, 10) : NaN;
      const currentQ = questions.find(q => q.id === questionId);
      const tl = !isNaN(parsed) ? parsed : (currentQ?.timeLimit ?? null);
      const resp = await apiService.updateStudentQuestion(
        assessmentId!,
        studentId!,
        questionId,
        editState.text.trim(),
        tl
      );
      setQuestions((prev) =>
        prev.map((q) => (q.id === questionId ? resp.question : q))
      );
      setEditingId(null);
      addToast('Question saved.', 'success');
    } catch (e: unknown) {
      setError(errMsg(e, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  // Unguarded: the inline Confirm button is the confirmation step.
  const deleteQuestion = async (questionId: string) => {
    setDeletingId(questionId);
    setError(null);
    try {
      await apiService.deleteStudentQuestion(assessmentId!, studentId!, questionId);
      setQuestions((prev) => prev.filter((q) => q.id !== questionId));
      setConfirmDeleteId(null);
      addToast('Question deleted.', 'success');
    } catch (e: unknown) {
      setError(errMsg(e, 'Failed to delete'));
    } finally {
      setDeletingId(null);
    }
  };

  const addQuestion = async () => {
    if (!addForm.text.trim() || addForm.text.trim().length < MIN_QUESTION_LENGTH) {
      setAddError(`Question text must be at least ${MIN_QUESTION_LENGTH} characters`);
      return;
    }
    setAdding(true);
    setError(null);
    setAddError(null);
    try {
      const tl = addForm.timeLimit ? parseInt(addForm.timeLimit, 10) : null;
      const resp = await apiService.addStudentQuestion(assessmentId!, studentId!, {
        text: addForm.text.trim(),
        questionType: addForm.questionType,
        difficulty: addForm.difficulty,
        topic: addForm.topic,
        timeLimit: tl,
      });
      setQuestions((prev) => [...prev, resp.question]);
      setAddForm({ text: '', questionType: 'manual', difficulty: 'medium', topic: 'general', timeLimit: '' });
      setShowAddForm(false);
      addToast('Question added.', 'success');
    } catch (e: unknown) {
      setError(errMsg(e, 'Failed to add question'));
    } finally {
      setAdding(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <LoadingSpinner size="lg" message="Loading questions…" />
      </div>
    );
  }

  return (
    <AppShell
      breadcrumbs={[
        { label: 'Assessments', to: '/assessments' },
        { label: assessment?.title || 'Assessment', to: `/assessments/${assessmentId}/results` },
        { label: `Questions: ${studentId ?? ''}` },
      ]}
      title="Question Editor"
      subtitle={assessment?.title ? `${assessment.title} · ${studentName}` : studentName}
      actions={
        isLocked ? (
          <span className="px-3 py-1 bg-caution/10 border border-caution/30 text-caution text-xs rounded-full">
            Locked — assessment is {assessment?.status}
          </span>
        ) : undefined
      }
      maxWidth="narrow"
      contentClassName="space-y-4"
    >
      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}

      {questions.length === 0 && (
        <div className="bg-paper border border-hairline rounded-xl p-12 text-center">
          <h2 className="font-serif text-lg font-semibold text-ink">No questions yet</h2>
          <p className="mt-1 text-sm text-slate">
            No questions generated yet for this student.
          </p>
        </div>
      )}

      {questions.map((q) => (
        <div
          key={q.id}
          className="bg-paper border border-hairline rounded-xl p-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 flex-1">
              <span className="text-slate font-mono text-sm tabular-nums mt-0.5 min-w-[2rem]">
                Q{q.questionNumber}
              </span>
              <div className="flex-1">
                {editingId === q.id ? (
                  <div className="space-y-3">
                    <label htmlFor={`question-text-${q.id}`} className="sr-only">
                      Question {q.questionNumber} text
                    </label>
                    <textarea
                      id={`question-text-${q.id}`}
                      value={editState.text}
                      onChange={(e) => { setEditState((s) => ({ ...s, text: e.target.value })); setEditError(null); }}
                      rows={4}
                      aria-invalid={editError ? true : undefined}
                      aria-describedby={`question-hint-${q.id}${editError ? ` question-error-${q.id}` : ''}`}
                      className={`w-full px-3 py-2 resize-y ${INPUT_CLASS}`}
                    />
                    <p id={`question-hint-${q.id}`} className="text-xs text-slate">
                      Minimum <span className="tabular-nums">{MIN_QUESTION_LENGTH}</span> characters to ensure questions are descriptive enough for students.
                    </p>
                    {editError && (
                      <p id={`question-error-${q.id}`} role="alert" className="text-xs text-danger">
                        {editError}
                      </p>
                    )}
                    <div className="flex items-center gap-3">
                      <label htmlFor={`question-time-${q.id}`} className="text-xs text-slate">
                        Time limit (min)
                      </label>
                      <input
                        id={`question-time-${q.id}`}
                        type="number"
                        min={1}
                        max={30}
                        value={editState.timeLimit}
                        onChange={(e) => setEditState((s) => ({ ...s, timeLimit: e.target.value }))}
                        placeholder="inherit"
                        className={`w-24 px-2 py-1 tabular-nums ${INPUT_CLASS}`}
                      />
                      <div className="flex gap-2 ml-auto">
                        <button
                          type="button"
                          onClick={() => saveEdit(q.id)}
                          disabled={saving}
                          className={`px-3 py-1.5 text-xs ${PRIMARY_BUTTON_CLASS}`}
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className={`px-3 py-1.5 text-xs ${SECONDARY_BUTTON_CLASS}`}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-ink leading-relaxed">{q.text}</p>
                )}

                {editingId !== q.id && (
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className={`${CHIP_BASE} ${TYPE_COLORS[q.questionType] || TYPE_COLORS['general']}`}>
                      {q.questionType}
                    </span>
                    <span className={`${CHIP_BASE} ${DIFFICULTY_COLORS[q.difficulty] || DIFFICULTY_COLORS['medium']}`}>
                      {q.difficulty}
                    </span>
                    {q.topic && q.topic !== 'general' && (
                      <span className={`${CHIP_BASE} bg-ink/5 text-slate border-hairline`}>
                        {q.topic}
                      </span>
                    )}
                    {q.timeLimit != null && (
                      <span className="px-2 py-0.5 text-xs text-slate">
                        <span aria-hidden="true">⏱</span>
                        <span className="sr-only">Time limit: </span>{' '}
                        <span className="tabular-nums">{q.timeLimit}</span>m
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {!isLocked && editingId !== q.id && (
              /* Two-step inline confirm, same pattern as AssessmentList. */
              confirmDeleteId === q.id ? (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => deleteQuestion(q.id)}
                    disabled={deletingId === q.id}
                    aria-busy={deletingId === q.id}
                    aria-label={`Confirm deletion of question ${q.questionNumber}`}
                    className="rounded-xl bg-danger text-white px-3 py-1.5 text-xs font-medium hover:bg-danger/90 transition-colors disabled:opacity-50"
                  >
                    {deletingId === q.id ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    aria-label={`Cancel deleting question ${q.questionNumber}`}
                    className="text-slate hover:text-ink text-xs transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(q)}
                    className="p-1.5 text-slate hover:text-accent hover:bg-ink/5 rounded-xl transition-colors"
                    aria-label={`Edit question ${q.questionNumber}`}
                    title="Edit question"
                  >
                    <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(q.id)}
                    disabled={questions.length <= 1}
                    aria-label={`Delete question ${q.questionNumber}`}
                    className="p-1.5 text-slate hover:text-danger hover:bg-ink/5 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={questions.length <= 1 ? 'Cannot delete last question' : 'Delete question'}
                  >
                    <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      ))}

      {!isLocked && (
        showAddForm ? (
          <div className="bg-paper border border-hairline rounded-xl p-5 space-y-4">
            <h2 className="font-serif text-base font-semibold text-ink">Add Question</h2>
            <div>
              <label htmlFor="add-question-text" className="sr-only">
                Question text
              </label>
              <textarea
                id="add-question-text"
                value={addForm.text}
                onChange={(e) => { setAddForm((s) => ({ ...s, text: e.target.value })); setAddError(null); }}
                rows={4}
                placeholder={`Enter question text (min ${MIN_QUESTION_LENGTH} characters)…`}
                aria-invalid={addError ? true : undefined}
                aria-describedby={`add-question-hint${addError ? ' add-question-error' : ''}`}
                className={`w-full px-3 py-2 resize-y ${INPUT_CLASS}`}
              />
              <p id="add-question-hint" className="mt-2 text-xs text-slate">
                Minimum <span className="tabular-nums">{MIN_QUESTION_LENGTH}</span> characters to ensure questions are descriptive enough for students.
              </p>
              {addError && (
                <p id="add-question-error" role="alert" className="mt-1 text-xs text-danger">
                  {addError}
                </p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="add-question-type" className="block text-xs text-slate mb-1">Type</label>
                <select
                  id="add-question-type"
                  value={addForm.questionType}
                  onChange={(e) => setAddForm((s) => ({ ...s, questionType: e.target.value }))}
                  className={`w-full px-2 py-1.5 ${INPUT_CLASS}`}
                >
                  <option value="manual">manual</option>
                  <option value="specific">specific</option>
                  <option value="general">general</option>
                </select>
              </div>
              <div>
                <label htmlFor="add-question-difficulty" className="block text-xs text-slate mb-1">Difficulty</label>
                <select
                  id="add-question-difficulty"
                  value={addForm.difficulty}
                  onChange={(e) => setAddForm((s) => ({ ...s, difficulty: e.target.value }))}
                  className={`w-full px-2 py-1.5 ${INPUT_CLASS}`}
                >
                  <option value="easy">easy</option>
                  <option value="medium">medium</option>
                  <option value="hard">hard</option>
                </select>
              </div>
              <div>
                <label htmlFor="add-question-time" className="block text-xs text-slate mb-1">Time limit (min)</label>
                <input
                  id="add-question-time"
                  type="number"
                  min={1}
                  max={30}
                  value={addForm.timeLimit}
                  onChange={(e) => setAddForm((s) => ({ ...s, timeLimit: e.target.value }))}
                  placeholder="inherit"
                  className={`w-full px-2 py-1.5 tabular-nums ${INPUT_CLASS}`}
                />
              </div>
            </div>
            <div>
              <label htmlFor="add-question-topic" className="block text-xs text-slate mb-1">Topic</label>
              <input
                id="add-question-topic"
                type="text"
                value={addForm.topic}
                onChange={(e) => setAddForm((s) => ({ ...s, topic: e.target.value }))}
                placeholder="e.g. data structures, algorithms…"
                className={`w-full px-3 py-1.5 ${INPUT_CLASS}`}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setShowAddForm(false); setAddError(null); setAddForm({ text: '', questionType: 'manual', difficulty: 'medium', topic: 'general', timeLimit: '' }); }}
                className={`px-4 py-2 text-sm ${SECONDARY_BUTTON_CLASS}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={addQuestion}
                disabled={adding}
                className={`px-4 py-2 text-sm ${PRIMARY_BUTTON_CLASS}`}
              >
                {adding ? 'Adding…' : 'Add Question'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="w-full py-3 border-2 border-dashed border-hairline text-slate hover:border-accent hover:text-accent rounded-xl text-sm font-medium transition-colors"
          >
            + Add Question for This Student
          </button>
        )
      )}
    </AppShell>
  );
}
