import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { apiService } from '../services/api';
import AppShell from '../components/AppShell';
import ErrorMessage from '../components/ErrorMessage';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToastStore } from '../store/toastStore';
import { gradeToken } from '../utils/statusTokens';
import type { Schemas } from '../../../shared/types/assessment';

type StudentDetail = Schemas['InstructorStudentDetailResponse'];
type QuestionDetail = StudentDetail['questions'][number];

const REVIEW_REASON_LABELS: Record<string, string> = {
  empty_transcript: 'No speech detected',
  transcript_too_short: 'Transcript too short',
  low_confidence_transcript: 'Low transcription confidence',
  structured_output_fallback: 'AI fell back to text parsing',
  evaluation_error: 'Automatic evaluation failed',
  score_divergence: 'Correctness/understanding diverge',
  needs_review: 'Flagged for review',
};

const reviewReasonLabel = (reason: string): string =>
  REVIEW_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');

const toText = (value?: string | unknown[] | null): string => {
  if (Array.isArray(value)) return value.join('; ');
  return value ?? '';
};

/**
 * Score-band tint, mirroring the student app's ResultsCard header badge, so an
 * instructor and a student looking at the same question see the same visual
 * language. Ungraded questions get the neutral chip rather than a red 0%.
 */
const scoreToneClass = (score?: number | null, maxScore?: number): string => {
  if (score === null || score === undefined || !maxScore) return 'text-slate bg-ink/5';
  const percent = (score / maxScore) * 100;
  if (percent >= 80) return 'text-success bg-success/10';
  if (percent >= 50) return 'text-caution bg-caution/10';
  return 'text-danger bg-danger/10';
};

export default function StudentResultDetail() {
  const { assessmentId, studentId } = useParams<{ assessmentId: string; studentId: string }>();
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideStates, setOverrideStates] = useState<Record<string, { score: string; comment: string; saving: boolean; scoreError?: string }>>({});
  const [humanScoreStates, setHumanScoreStates] = useState<Record<string, { correctness: string; understanding: string; saving: boolean; error?: string }>>({});
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  // The breadcrumb carries the assessment-title level, like every other deep
  // page, but the student-detail payload does not include the title — so it is
  // fetched separately. Kept out of loadDetail because loadDetail re-runs after
  // every override save, and a failure here must degrade the crumb to a generic
  // label rather than take down the page.
  const [assessmentTitle, setAssessmentTitle] = useState<string | null>(null);
  const addToast = useToastStore(s => s.addToast);

  useEffect(() => {
    if (assessmentId && studentId) loadDetail();
  }, [assessmentId, studentId]);

  useEffect(() => {
    if (!assessmentId) return;
    let cancelled = false;
    (async () => {
      try {
        const assessment = await apiService.getAssessment(assessmentId);
        if (!cancelled) setAssessmentTitle(assessment?.title ?? null);
      } catch {
        // Non-fatal: the crumb falls back to "Assessment".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assessmentId]);

  const loadDetail = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiService.getStudentDetail(assessmentId!, studentId!);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load student detail');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOverride = async (questionId: string, maxScore: number) => {
    const state = overrideStates[questionId];
    if (!state) return;
    const trimmed = state.score.trim();
    if (trimmed === '' || !/^\d+$/.test(trimmed)) {
      setOverrideStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], scoreError: 'Score must be a number' } }));
      return;
    }
    const score = parseInt(trimmed, 10);
    if (score < 0 || score > maxScore) {
      setOverrideStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], scoreError: `Score must be between 0 and ${maxScore}` } }));
      return;
    }

    setOverrideStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], saving: true } }));
    try {
      await apiService.overrideScore(assessmentId!, studentId!, questionId, score, state.comment || undefined);
      await loadDetail();
      setOverrideStates(prev => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
      addToast('Score override saved.', 'success');
    } catch (err) {
      // A failed save is transient — toast it instead of replacing the whole
      // page with the full-page error state.
      addToast(err instanceof Error ? err.message : 'Failed to save override', 'error');
    } finally {
      setOverrideStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], saving: false } }));
    }
  };

  const initOverride = (q: QuestionDetail) => {
    setOverrideStates(prev => ({
      ...prev,
      [q.questionId]: {
        score: String(q.instructorScore ?? q.aiScore ?? ''),
        comment: q.instructorComment ?? '',
        saving: false,
      },
    }));
  };

  const initHumanScore = (q: QuestionDetail) => {
    setHumanScoreStates(prev => ({
      ...prev,
      [q.questionId]: {
        correctness: q.humanCorrectnessScore != null ? String(q.humanCorrectnessScore) : '',
        understanding: q.humanUnderstandingScore != null ? String(q.humanUnderstandingScore) : '',
        saving: false,
      },
    }));
  };

  const handleHumanScore = async (questionId: string) => {
    const state = humanScoreStates[questionId];
    if (!state) return;
    const c = state.correctness.trim();
    const u = state.understanding.trim();
    if (!/^\d+$/.test(c) || !/^\d+$/.test(u)) {
      setHumanScoreStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], error: 'Both scores must be numbers' } }));
      return;
    }
    const correctness = parseInt(c, 10);
    const understanding = parseInt(u, 10);
    if (correctness < 0 || correctness > 5 || understanding < 0 || understanding > 5) {
      setHumanScoreStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], error: 'Each score must be between 0 and 5' } }));
      return;
    }
    setHumanScoreStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], saving: true, error: undefined } }));
    try {
      await apiService.recordHumanScore(assessmentId!, studentId!, questionId, correctness, understanding);
      await loadDetail();
      setHumanScoreStates(prev => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
      addToast('Human reference score saved.', 'success');
    } catch (err) {
      setHumanScoreStates(prev => ({ ...prev, [questionId]: { ...prev[questionId], saving: false, error: err instanceof Error ? err.message : 'Failed to save human score' } }));
    }
  };

  if (isLoading) return (
    <div className="min-h-screen bg-paper flex items-center justify-center">
      <LoadingSpinner size="lg" message="Loading student result…" />
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-paper flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-3" role="alert">
        <ErrorMessage error={error} />
        <button
          onClick={loadDetail}
          className="px-4 py-2 bg-accent text-white text-sm rounded-xl hover:bg-accent-hover transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );

  if (!detail) return null;

  return (
    <AppShell
      breadcrumbs={[
        { label: 'Assessments', to: '/assessments' },
        { label: assessmentTitle || 'Assessment', to: `/assessments/${assessmentId}/results` },
        { label: detail.studentName },
      ]}
      title={detail.studentName}
      subtitle={`${detail.studentEmail} · ${detail.studentId}`}
      maxWidth="medium"
      contentClassName="space-y-6"
    >
      {/* Score Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-xs text-slate mb-1">Score</div>
          <div className="font-serif text-2xl font-semibold text-ink tabular-nums tracking-tight">
            {detail.totalScore}
            <span className="text-sm font-normal text-slate"> / {detail.maxScore}</span>
          </div>
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-xs text-slate mb-1">Percentage</div>
          <div className="font-serif text-2xl font-semibold text-ink tabular-nums tracking-tight">{detail.percentage}%</div>
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-xs text-slate mb-1">Grade</div>
          {/* Grade chip classes + label come from the shared status tokens, so an
              unrecognised grade (e.g. "Not Evaluated") still renders readably. */}
          <span className={`inline-block px-2.5 py-1 rounded-full text-sm font-medium ${gradeToken(detail.grade).className}`}>
            {gradeToken(detail.grade).label}
          </span>
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-xs text-slate mb-1">Submitted</div>
          <div className="text-sm text-slate tabular-nums">{detail.submittedAt ? new Date(detail.submittedAt).toLocaleString() : '—'}</div>
        </div>
      </div>

      {/* Questions */}
      <div className="space-y-3">
        <h2 className="font-serif text-lg font-semibold text-ink">Question Results</h2>
        {detail.questions.map((q, i) => {
          const override = overrideStates[q.questionId];
          const humanState = humanScoreStates[q.questionId];
          const isExpanded = expandedQuestion === q.questionId;
          const panelId = `question-panel-${q.questionId}`;
          const overrideErrorId = `override-error-${q.questionId}`;
          const humanErrorId = `human-score-error-${q.questionId}`;
          return (
            <div key={q.questionId} className="bg-paper border border-hairline rounded-xl overflow-hidden">
              <button
                className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-ink/[0.03] transition-colors"
                onClick={() => setExpandedQuestion(isExpanded ? null : q.questionId)}
                aria-expanded={isExpanded}
                aria-controls={panelId}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-slate font-medium tabular-nums">Q{i + 1}</span>
                  {q.answerType && <span className="px-2 py-0.5 text-xs text-slate bg-ink/5 rounded-full">{q.answerType}</span>}
                  <p className="text-sm text-ink line-clamp-1">{q.questionText}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {q.needsReview && (
                    <span
                      className="px-2 py-0.5 text-xs text-caution bg-caution/10 rounded-full"
                      title={(q.reviewReasons ?? []).map(reviewReasonLabel).join(', ')}
                    >
                      ⚠ review
                    </span>
                  )}
                  {q.humanTotalScore !== null && q.humanTotalScore !== undefined && (
                    <span className="text-xs text-accent" title="Human reference score recorded">human ✓</span>
                  )}
                  {q.instructorScore !== null && q.instructorScore !== undefined && (
                    <span className="text-xs text-caution">override</span>
                  )}
                  <span className={`px-2.5 py-1 rounded-full font-serif text-sm font-semibold tabular-nums tracking-tight whitespace-nowrap ${scoreToneClass(q.effectiveScore, q.maxScore)}`}>
                    {q.effectiveScore ?? '—'} / {q.maxScore}
                  </span>
                  <svg
                    className={`w-4 h-4 text-slate transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                  >
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </div>
              </button>

              {isExpanded && (
                <div id={panelId} className="border-t border-hairline p-4 space-y-4">
                  {/* Review flag banner (Tasks 4 & 5) */}
                  {q.needsReview && (
                    <div className="bg-caution/10 border border-caution/30 rounded-xl p-3">
                      <p className="text-sm font-medium text-caution">⚠ Flagged for instructor review</p>
                      {(q.reviewReasons ?? []).length > 0 && (
                        <ul className="mt-1 text-xs text-caution list-disc list-inside">
                          {(q.reviewReasons ?? []).map(r => (
                            <li key={r}>{reviewReasonLabel(r)}</li>
                          ))}
                        </ul>
                      )}
                      {q.transcriptConfidence !== null && q.transcriptConfidence !== undefined && (
                        <p className="mt-1 text-xs text-caution tabular-nums">
                          Transcription confidence: {(q.transcriptConfidence * 100).toFixed(0)}%
                        </p>
                      )}
                    </div>
                  )}

                  {/* Question text */}
                  <div>
                    <p className="text-xs text-slate mb-1">Question</p>
                    <p className="text-sm text-ink">{q.questionText}</p>
                  </div>

                  {/* Transcript */}
                  {q.transcript && (
                    <div>
                      <p className="text-xs text-slate mb-1">Transcript
                        {q.transcriptStatus && <span className="ml-2 text-slate">({q.transcriptStatus})</span>}
                      </p>
                      <p className="text-sm text-ink italic bg-ink/5 rounded-xl p-3">{q.transcript}</p>
                    </div>
                  )}

                  {/* Text answer */}
                  {q.textContent && !q.transcript && (
                    <div>
                      <p className="text-xs text-slate mb-1">Written Answer</p>
                      <p className="text-sm text-ink bg-ink/5 rounded-xl p-3">{q.textContent}</p>
                    </div>
                  )}

                  {/* Audio playback */}
                  {q.audioUrl && (
                    <div>
                      <p className="text-xs text-slate mb-1">Audio Recording</p>
                      <audio controls src={q.audioUrl} className="w-full" aria-label={`Audio recording for question ${i + 1}`} />
                    </div>
                  )}

                  {/* Video playback */}
                  {q.videoUrl && (
                    <div>
                      <p className="text-xs text-slate mb-1">Video Recording</p>
                      <video controls src={q.videoUrl} className="w-full max-h-48 rounded-xl" aria-label={`Video recording for question ${i + 1}`} />
                    </div>
                  )}

                  {/* Scores — hairline-divided figure rows, echoing the student
                      app's ResultsCard breakdown so both sides read the same. */}
                  <div className="rounded-xl border border-hairline divide-y divide-hairline overflow-hidden">
                    <div className="flex items-baseline justify-between px-4 py-3">
                      <span className="text-sm text-slate">AI Score</span>
                      <span className="font-serif text-lg text-ink tabular-nums tracking-tight">{q.aiScore ?? '—'}</span>
                    </div>
                    <div className="flex items-baseline justify-between px-4 py-3">
                      <span className="text-sm text-slate">Override</span>
                      <span className="font-serif text-lg text-ink tabular-nums tracking-tight">
                        {q.instructorScore ?? '—'}
                        {q.instructorScore !== null && q.instructorScore !== undefined && (
                          <span className="text-sm font-normal text-slate"> / {q.maxScore}</span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between px-4 py-3 bg-ink/[0.02]">
                      <span className="text-sm font-medium text-ink">Effective</span>
                      <span className="font-serif text-lg font-semibold text-ink tabular-nums tracking-tight">
                        {q.effectiveScore ?? '—'}
                        <span className="text-sm font-normal text-slate"> / {q.maxScore}</span>
                      </span>
                    </div>
                  </div>

                  {/* AI dimension breakdown */}
                  {(q.correctnessScore != null || q.understandingScore != null) && (
                    <p className="text-xs text-slate tabular-nums">
                      AI breakdown — correctness {q.correctnessScore ?? '—'}/5 · understanding {q.understandingScore ?? '—'}/5
                      {q.evaluationMethod ? ` · method: ${q.evaluationMethod}` : ''}
                    </p>
                  )}

                  {/* AI feedback */}
                  {q.feedback && (
                    <div>
                      <p className="text-xs text-slate mb-1">AI Feedback</p>
                      <p className="text-sm text-ink">{q.feedback}</p>
                    </div>
                  )}
                  {toText(q.strengths) && (
                    <div>
                      <p className="text-xs text-slate mb-1">Strengths</p>
                      <p className="text-sm text-ink">{toText(q.strengths)}</p>
                    </div>
                  )}
                  {toText(q.weaknesses) && (
                    <div>
                      <p className="text-xs text-slate mb-1">Weaknesses</p>
                      <p className="text-sm text-ink">{toText(q.weaknesses)}</p>
                    </div>
                  )}
                  {(toText(q.suggestedImprovements) || toText(q.improvements)) && (
                    <div>
                      <p className="text-xs text-slate mb-1">Improvements</p>
                      <p className="text-sm text-ink">{toText(q.suggestedImprovements) || toText(q.improvements)}</p>
                    </div>
                  )}

                  {/* Dual-scoring: human reference score (AI validity check) */}
                  <div className="border-t border-hairline pt-3">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-xs font-medium text-slate">Human reference score</p>
                      {q.humanTotalScore !== null && q.humanTotalScore !== undefined && (
                        <span className="text-xs text-accent tabular-nums">
                          Human {q.humanTotalScore} / 10{q.aiScore !== null && q.aiScore !== undefined ? ` · AI ${q.aiScore} / 10` : ''}
                        </span>
                      )}
                    </div>
                    {humanState ? (
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <label className="text-xs text-slate" htmlFor={`human-correctness-${q.questionId}`}>
                            Correctness
                          </label>
                          <input
                            id={`human-correctness-${q.questionId}`}
                            type="number" min={0} max={5}
                            value={humanState.correctness}
                            onChange={e => setHumanScoreStates(prev => ({ ...prev, [q.questionId]: { ...prev[q.questionId], correctness: e.target.value, error: undefined } }))}
                            aria-invalid={humanState.error ? true : undefined}
                            aria-describedby={humanState.error ? humanErrorId : undefined}
                            className={`w-16 px-2 py-1 bg-ink/5 border rounded-xl text-ink text-sm tabular-nums ${humanState.error ? 'border-danger' : 'border-hairline'}`}
                            placeholder="0-5"
                          />
                          <label className="text-xs text-slate" htmlFor={`human-understanding-${q.questionId}`}>
                            Understanding
                          </label>
                          <input
                            id={`human-understanding-${q.questionId}`}
                            type="number" min={0} max={5}
                            value={humanState.understanding}
                            onChange={e => setHumanScoreStates(prev => ({ ...prev, [q.questionId]: { ...prev[q.questionId], understanding: e.target.value, error: undefined } }))}
                            aria-invalid={humanState.error ? true : undefined}
                            aria-describedby={humanState.error ? humanErrorId : undefined}
                            className={`w-16 px-2 py-1 bg-ink/5 border rounded-xl text-ink text-sm tabular-nums ${humanState.error ? 'border-danger' : 'border-hairline'}`}
                            placeholder="0-5"
                          />
                          <button
                            onClick={() => handleHumanScore(q.questionId)}
                            disabled={humanState.saving}
                            className="px-3 py-1 bg-accent text-white text-sm rounded-xl hover:bg-accent-hover transition-colors disabled:opacity-50"
                          >
                            {humanState.saving ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            onClick={() => setHumanScoreStates(prev => { const n = { ...prev }; delete n[q.questionId]; return n; })}
                            className="px-3 py-1 bg-ink/5 text-slate text-sm rounded-xl hover:bg-ink/10 hover:text-ink transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                        {humanState.error && (
                          <p id={humanErrorId} role="alert" className="mt-1 text-xs text-danger">{humanState.error}</p>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => initHumanScore(q)}
                        className="px-3 py-1 bg-ink/5 text-slate text-sm rounded-xl hover:bg-ink/10 hover:text-ink transition-colors"
                      >
                        {q.humanTotalScore !== null && q.humanTotalScore !== undefined ? 'Edit Human Score' : 'Enter Human Score'}
                      </button>
                    )}
                    <p className="mt-1 text-[11px] text-slate">
                      Recorded for AI-vs-human agreement analysis. Does not change the student's grade.
                    </p>
                  </div>

                  {/* Score override form */}
                  <div className="border-t border-hairline pt-3">
                    <p className="text-xs font-medium text-slate mb-2">Override Score</p>
                    {override ? (
                      <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="sr-only" htmlFor={`override-score-${q.questionId}`}>
                          Override score (0-{q.maxScore})
                        </label>
                        <input
                          id={`override-score-${q.questionId}`}
                          type="number"
                          min={0}
                          max={q.maxScore}
                          value={override.score}
                          onChange={e => setOverrideStates(prev => ({ ...prev, [q.questionId]: { ...prev[q.questionId], score: e.target.value, scoreError: undefined } }))}
                          aria-invalid={override.scoreError ? true : undefined}
                          aria-describedby={override.scoreError ? overrideErrorId : undefined}
                          className={`w-20 px-2 py-1 bg-ink/5 border rounded-xl text-ink text-sm tabular-nums ${override.scoreError ? 'border-danger' : 'border-hairline'}`}
                          placeholder={`0-${q.maxScore}`}
                        />
                        <label className="sr-only" htmlFor={`override-comment-${q.questionId}`}>
                          Override comment (optional)
                        </label>
                        <input
                          id={`override-comment-${q.questionId}`}
                          type="text"
                          value={override.comment}
                          onChange={e => setOverrideStates(prev => ({ ...prev, [q.questionId]: { ...prev[q.questionId], comment: e.target.value } }))}
                          className="flex-1 min-w-[8rem] px-2 py-1 bg-ink/5 border border-hairline rounded-xl text-ink text-sm"
                          placeholder="Optional comment..."
                        />
                        <button
                          onClick={() => handleOverride(q.questionId, q.maxScore)}
                          disabled={override.saving}
                          className="px-3 py-1 bg-accent text-white text-sm rounded-xl hover:bg-accent-hover transition-colors disabled:opacity-50"
                        >
                          {override.saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setOverrideStates(prev => { const n = { ...prev }; delete n[q.questionId]; return n; })}
                          className="px-3 py-1 bg-ink/5 text-slate text-sm rounded-xl hover:bg-ink/10 hover:text-ink transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      {override.scoreError && (
                        <p id={overrideErrorId} role="alert" className="mt-1 text-xs text-danger">{override.scoreError}</p>
                      )}
                      </div>
                    ) : (
                      <button
                        onClick={() => initOverride(q)}
                        className="px-3 py-1 bg-ink/5 text-slate text-sm rounded-xl hover:bg-ink/10 hover:text-ink transition-colors"
                      >
                        {q.instructorScore !== null && q.instructorScore !== undefined ? 'Edit Override' : 'Set Override'}
                      </button>
                    )}
                    {q.instructorComment && !override && (
                      <p className="mt-1 text-xs text-slate">Comment: {q.instructorComment}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Proctoring chunk health */}
      <div className="bg-paper border border-hairline rounded-xl p-4">
        <h2 className="font-serif text-base font-semibold text-ink mb-3">Proctoring Footage</h2>
        <div className="flex items-center gap-6 mb-3">
          <div>
            <span className="text-xs text-slate">Chunks uploaded</span>
            <div className="font-serif text-lg font-semibold text-ink tabular-nums tracking-tight">{detail.proctoring.totalChunks}</div>
          </div>
          <div>
            <span className="text-xs text-slate">Missing chunks</span>
            <div className={`font-serif text-lg font-semibold tabular-nums tracking-tight ${detail.proctoring.missingIndexes.length > 0 ? 'text-danger' : 'text-success'}`}>
              {detail.proctoring.missingIndexes.length}
            </div>
          </div>
        </div>
        {detail.proctoring.missingIndexes.length > 0 && (
          <p className="text-xs text-danger tabular-nums">Missing chunk indexes: {detail.proctoring.missingIndexes.join(', ')}</p>
        )}
        {detail.proctoring.totalChunks === 0 && (
          <p className="text-xs text-slate">No proctoring chunks uploaded for this student.</p>
        )}
        {detail.proctoring.chunks.length > 0 && (
          <div className="mt-3 max-h-40 overflow-y-auto">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate">
                    <th scope="col" className="text-left py-1 font-medium">Chunk #</th>
                    <th scope="col" className="text-left py-1 font-medium">Recorded At</th>
                    <th scope="col" className="text-left py-1 font-medium">URL</th>
                  </tr>
                </thead>
                <tbody className="text-slate">
                  {detail.proctoring.chunks.map(c => (
                    <tr key={c.chunkIndex}>
                      <td className="py-0.5 tabular-nums">{c.chunkIndex}</td>
                      <td className="py-0.5 tabular-nums">{c.recordedAt ? new Date(c.recordedAt).toLocaleTimeString() : '—'}</td>
                      <td className="py-0.5 truncate max-w-xs">
                        <a
                          href={c.chunkUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`View proctoring chunk ${c.chunkIndex}`}
                          className="text-accent hover:text-accent-hover hover:underline"
                        >
                          view
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
