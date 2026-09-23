import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';
import ErrorMessage from './ErrorMessage';
import type { CreateAssessmentRequest } from '../../../shared/types/assessment';

type AssessmentType = 'proctored-exam' | 'formative-practice' | 'custom';

// Presets only set the behaviour flags; answerMode is chosen independently.
const PRESETS: Record<
  Exclude<AssessmentType, 'custom'>,
  Pick<CreateAssessmentRequest, 'proctored' | 'allowReview' | 'feedbackRelease' | 'autoEvaluate'>
> = {
  // Both auto-evaluate; the exam still needs a manual results release.
  'proctored-exam': { proctored: true, allowReview: false, feedbackRelease: 'manual', autoEvaluate: true },
  'formative-practice': { proctored: false, allowReview: true, feedbackRelease: 'immediate', autoEvaluate: true },
};

const INPUT_CLASS =
  'w-full px-4 py-2 bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none';
const NUMBER_INPUT_CLASS = `${INPUT_CLASS} tabular-nums`;
const RADIO_CLASS = 'text-accent focus:ring-accent';
const HELP_CLASS = 'mt-1 text-sm text-slate';
const ERROR_CLASS = 'mt-1 text-sm text-danger';
const LABEL_CLASS = 'block text-sm font-medium text-ink mb-2';
const LEGEND_CLASS = 'block text-sm font-medium text-ink mb-2';

export default function CreateAssessmentForm() {
  const navigate = useNavigate();
  const { addAssessment, setSelectedAssessment, setLoading, setError, error } = useAssessmentStore();

  const [formData, setFormData] = useState<CreateAssessmentRequest>({
    title: '',
    description: '',
    course: '',
    dueDate: '',
    totalQuestions: 8,
    timeLimit: undefined,
    accessMode: 'open',
    scheduledWindowStart: undefined,
    scheduledWindowEnd: undefined,
    answerMode: 'oral',
    preparationTime: 60,
    // Behaviour flags default to the "Proctored exam" preset.
    proctored: true,
    allowReview: false,
    feedbackRelease: 'manual',
    autoEvaluate: true,
    autoReport: true,
    autoReportThreshold: 10,
  });

  const [errors, setErrors] = useState<Partial<Record<keyof CreateAssessmentRequest | string, string>>>({});
  const [assessmentType, setAssessmentType] = useState<AssessmentType>('proctored-exam');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const initialFormData = useRef(formData);
  const hasSubmitted = useRef(false);

  // `error` is app-wide store state; clear any left over from the previous page.
  useEffect(() => {
    setError(null);
  }, [setError]);

  const applyPreset = (type: AssessmentType) => {
    setAssessmentType(type);
    if (type !== 'custom') {
      setFormData((prev) => ({ ...prev, ...PRESETS[type] }));
    }
  };

  // Editing an individual flag means the config no longer matches a named preset.
  const setFlag = (patch: Partial<CreateAssessmentRequest>) => {
    setFormData((prev) => ({ ...prev, ...patch }));
    setAssessmentType('custom');
  };

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasSubmitted.current) return;
      const isDirty = JSON.stringify(formData) !== JSON.stringify(initialFormData.current);
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [formData]);

  const validateForm = (): boolean => {
    const newErrors: Partial<Record<keyof CreateAssessmentRequest, string>> = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    }

    if (!formData.course.trim()) {
      newErrors.course = 'Course is required';
    }

    if (!formData.dueDate) {
      newErrors.dueDate = 'Due date is required';
    } else {
      const dueDate = new Date(formData.dueDate);
      const today = new Date();
      // Date-only comparison so choosing today is valid.
      const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (dueDateOnly < todayOnly) {
        newErrors.dueDate = 'Due date must be today or in the future';
      }
    }

    if (formData.totalQuestions < 1 || formData.totalQuestions > 20) {
      newErrors.totalQuestions = 'Total questions must be between 1 and 20';
    }

    if (formData.timeLimit && (formData.timeLimit < 1 || formData.timeLimit > 30)) {
      newErrors.timeLimit = 'Time limit must be between 1 and 30 minutes';
    }

    if (formData.answerMode === 'oral' && formData.preparationTime != null && (formData.preparationTime < 0 || formData.preparationTime > 300)) {
      (newErrors as Record<string, string>).preparationTime = 'Preparation time must be between 0 and 300 seconds';
    }

    if (formData.accessMode === 'scheduled') {
      if (!formData.scheduledWindowStart) {
        newErrors.scheduledWindowStart = 'Window start is required for scheduled access';
      }
      if (!formData.scheduledWindowEnd) {
        newErrors.scheduledWindowEnd = 'Window end is required for scheduled access';
      }
      if (formData.scheduledWindowStart && formData.scheduledWindowEnd) {
        if (new Date(formData.scheduledWindowEnd) <= new Date(formData.scheduledWindowStart)) {
          newErrors.scheduledWindowEnd = 'Window end must be after window start';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // datetime-local values carry no timezone, and the server reads a bare time as
      // UTC — an instructor in Sydney got a window 10-11 hours late. new Date() reads
      // them as the browser's local time, so toISOString() sends the instant they meant.
      const toUtc = (v?: string | null) => (v ? new Date(v).toISOString() : v);
      const assessment = await apiService.createAssessment({
        ...formData,
        dueDate: toUtc(formData.dueDate) ?? '',
        scheduledWindowStart: toUtc(formData.scheduledWindowStart),
        scheduledWindowEnd: toUtc(formData.scheduledWindowEnd),
      });
      addAssessment(assessment);
      setSelectedAssessment(assessment);

      hasSubmitted.current = true;
      navigate(`/assessments/${assessment.id}/upload`, { state: { created: assessment.title } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create assessment');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: name === 'totalQuestions'
        ? Number(value)
        : name === 'timeLimit' || name === 'preparationTime'
        ? (value === '' ? undefined : Number(value))
        : value,
    }));

    if (errors[name as keyof CreateAssessmentRequest]) {
      setErrors((prev) => ({ ...prev, [name]: undefined }));
    }
  };

  const handleAccessModeChange = (mode: 'open' | 'scheduled') => {
    setFormData(prev => ({
      ...prev,
      accessMode: mode,
      scheduledWindowStart: mode === 'open' ? undefined : prev.scheduledWindowStart,
      scheduledWindowEnd: mode === 'open' ? undefined : prev.scheduledWindowEnd,
    }));
  };

  // Custom config forces the panel open; aria-expanded must reflect that.
  const advancedOpen = showAdvanced || assessmentType === 'custom';

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}

      <div>
        <label htmlFor="title" className={LABEL_CLASS}>
          Assessment Title *
        </label>
        <input
          type="text"
          id="title"
          name="title"
          value={formData.title}
          onChange={handleChange}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? 'title-error' : undefined}
          className={INPUT_CLASS}
          placeholder="e.g., Midterm Oral Assessment"
        />
        {errors.title && (
          <p id="title-error" role="alert" className={ERROR_CLASS}>
            {errors.title}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="description" className={LABEL_CLASS}>
          Description
        </label>
        <textarea
          id="description"
          name="description"
          value={formData.description}
          onChange={handleChange}
          rows={3}
          className={`${INPUT_CLASS} resize-none`}
          placeholder="Describe the assessment objectives..."
        />
      </div>

      <div>
        <label htmlFor="course" className={LABEL_CLASS}>
          Course *
        </label>
        <input
          type="text"
          id="course"
          name="course"
          value={formData.course}
          onChange={handleChange}
          aria-invalid={errors.course ? true : undefined}
          aria-describedby={errors.course ? 'course-error' : undefined}
          className={INPUT_CLASS}
          placeholder="e.g., CS 101 - Introduction to Programming"
        />
        {errors.course && (
          <p id="course-error" role="alert" className={ERROR_CLASS}>
            {errors.course}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="dueDate" className={LABEL_CLASS}>
          Display Deadline *
        </label>
        <input
          type="datetime-local"
          id="dueDate"
          name="dueDate"
          value={formData.dueDate}
          onChange={handleChange}
          aria-invalid={errors.dueDate ? true : undefined}
          aria-describedby={errors.dueDate ? 'dueDate-help dueDate-error' : 'dueDate-help'}
          className={INPUT_CLASS}
        />
        <p id="dueDate-help" className={HELP_CLASS}>
          Shown to students as a reminder — does not enforce access. Use "Scheduled Window" below to restrict when students can open the assessment.
        </p>
        {errors.dueDate && (
          <p id="dueDate-error" role="alert" className={ERROR_CLASS}>
            {errors.dueDate}
          </p>
        )}
      </div>

      <fieldset aria-describedby="accessMode-help">
        <legend className={LEGEND_CLASS}>Student Access</legend>
        <div className="flex space-x-4">
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="radio"
              name="accessMode"
              checked={formData.accessMode === 'open'}
              onChange={() => handleAccessModeChange('open')}
              className={RADIO_CLASS}
            />
            <span className="text-ink text-sm font-medium">Open access</span>
          </label>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="radio"
              name="accessMode"
              checked={formData.accessMode === 'scheduled'}
              onChange={() => handleAccessModeChange('scheduled')}
              className={RADIO_CLASS}
            />
            <span className="text-ink text-sm font-medium">Scheduled window</span>
          </label>
        </div>
        <p id="accessMode-help" className={HELP_CLASS}>
          {formData.accessMode === 'open'
            ? 'Students can open their link at any time until the display deadline.'
            : 'Students can only access the assessment during the specified window.'}
        </p>
      </fieldset>

      {formData.accessMode === 'scheduled' && (
        <div className="bg-ink/5 border border-hairline rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-semibold text-ink">Scheduled Access Window</h3>
          <div>
            <label htmlFor="scheduledWindowStart" className="block text-sm font-medium text-slate mb-2">
              Window opens *
            </label>
            <input
              type="datetime-local"
              id="scheduledWindowStart"
              name="scheduledWindowStart"
              value={formData.scheduledWindowStart ?? ''}
              onChange={handleChange}
              aria-invalid={errors.scheduledWindowStart ? true : undefined}
              aria-describedby={errors.scheduledWindowStart ? 'scheduledWindowStart-error' : undefined}
              className={INPUT_CLASS}
            />
            {errors.scheduledWindowStart && (
              <p id="scheduledWindowStart-error" role="alert" className={ERROR_CLASS}>
                {errors.scheduledWindowStart}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="scheduledWindowEnd" className="block text-sm font-medium text-slate mb-2">
              Window closes *
            </label>
            <input
              type="datetime-local"
              id="scheduledWindowEnd"
              name="scheduledWindowEnd"
              value={formData.scheduledWindowEnd ?? ''}
              onChange={handleChange}
              aria-invalid={errors.scheduledWindowEnd ? true : undefined}
              aria-describedby={errors.scheduledWindowEnd ? 'scheduledWindowEnd-error' : undefined}
              className={INPUT_CLASS}
            />
            {errors.scheduledWindowEnd && (
              <p id="scheduledWindowEnd-error" role="alert" className={ERROR_CLASS}>
                {errors.scheduledWindowEnd}
              </p>
            )}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="totalQuestions" className={LABEL_CLASS}>
          Number of Questions *
        </label>
        <input
          type="number"
          id="totalQuestions"
          name="totalQuestions"
          value={formData.totalQuestions}
          onChange={handleChange}
          min={1}
          max={20}
          aria-invalid={errors.totalQuestions ? true : undefined}
          aria-describedby={
            errors.totalQuestions ? 'totalQuestions-help totalQuestions-error' : 'totalQuestions-help'
          }
          className={NUMBER_INPUT_CLASS}
        />
        <p id="totalQuestions-help" className={HELP_CLASS}>
          Recommended: 8 questions (1-20)
        </p>
        {errors.totalQuestions && (
          <p id="totalQuestions-error" role="alert" className={ERROR_CLASS}>
            {errors.totalQuestions}
          </p>
        )}
      </div>

      <fieldset aria-describedby="answerMode-help">
        <legend className={LEGEND_CLASS}>Answer Mode *</legend>
        <div className="flex space-x-4">
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="radio"
              name="answerMode"
              checked={formData.answerMode === 'oral'}
              onChange={() => setFormData(prev => ({ ...prev, answerMode: 'oral', preparationTime: 60 }))}
              className={RADIO_CLASS}
            />
            <span className="text-ink text-sm font-medium">Oral (voice recording)</span>
          </label>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="radio"
              name="answerMode"
              checked={formData.answerMode === 'written'}
              onChange={() => setFormData(prev => ({ ...prev, answerMode: 'written', preparationTime: undefined }))}
              className={RADIO_CLASS}
            />
            <span className="text-ink text-sm font-medium">Written (typed text)</span>
          </label>
        </div>
        <p id="answerMode-help" className={HELP_CLASS}>
          {formData.answerMode === 'oral'
            ? 'Students record an audio answer. A preparation countdown is shown before recording starts.'
            : 'Students type their answer. The answer timer starts immediately when the question is shown.'}
        </p>
      </fieldset>

      {formData.answerMode === 'oral' && (
        <div>
          <label htmlFor="preparationTime" className={LABEL_CLASS}>
            Preparation Time (seconds)
          </label>
          <input
            type="number"
            id="preparationTime"
            name="preparationTime"
            value={formData.preparationTime ?? ''}
            onChange={handleChange}
            min={0}
            max={300}
            placeholder="60"
            aria-invalid={errors.preparationTime ? true : undefined}
            aria-describedby={
              errors.preparationTime ? 'preparationTime-help preparationTime-error' : 'preparationTime-help'
            }
            className={NUMBER_INPUT_CLASS}
          />
          <p id="preparationTime-help" className={HELP_CLASS}>
            0-300 seconds (0-5 minutes). Time students have to read the question before recording begins. Set to 0 to start recording immediately.
          </p>
          {errors.preparationTime && (
            <p id="preparationTime-error" role="alert" className={ERROR_CLASS}>
              {errors.preparationTime}
            </p>
          )}
        </div>
      )}

      <div>
        <label htmlFor="timeLimit" className={LABEL_CLASS}>
          Time Limit per Question (minutes)
        </label>
        <input
          type="number"
          id="timeLimit"
          name="timeLimit"
          value={formData.timeLimit ?? ''}
          onChange={handleChange}
          min={1}
          max={30}
          placeholder="No limit"
          aria-invalid={errors.timeLimit ? true : undefined}
          aria-describedby={errors.timeLimit ? 'timeLimit-help timeLimit-error' : 'timeLimit-help'}
          className={NUMBER_INPUT_CLASS}
        />
        <p id="timeLimit-help" className={HELP_CLASS}>
          Optional: 1-30 minutes per question. Leave blank for no time limit.
        </p>
        {errors.timeLimit && (
          <p id="timeLimit-error" role="alert" className={ERROR_CLASS}>
            {errors.timeLimit}
          </p>
        )}
      </div>

      <fieldset>
        <legend className={LEGEND_CLASS}>Assessment Type</legend>
        <div className="flex flex-col gap-2">
          <label className="flex items-start space-x-2 cursor-pointer">
            <input
              type="radio"
              name="assessmentType"
              checked={assessmentType === 'proctored-exam'}
              onChange={() => applyPreset('proctored-exam')}
              className={`mt-1 ${RADIO_CLASS}`}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Proctored exam</span>
              <span className="block text-slate">Webcam proctoring on, answers locked once submitted, auto-scored on submit, results released manually.</span>
            </span>
          </label>
          <label className="flex items-start space-x-2 cursor-pointer">
            <input
              type="radio"
              name="assessmentType"
              checked={assessmentType === 'formative-practice'}
              onChange={() => applyPreset('formative-practice')}
              className={`mt-1 ${RADIO_CLASS}`}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Formative practice</span>
              <span className="block text-slate">No camera, students can revise their answers, auto-scored with feedback shown immediately.</span>
            </span>
          </label>
          <label className="flex items-start space-x-2 cursor-pointer">
            <input
              type="radio"
              name="assessmentType"
              checked={assessmentType === 'custom'}
              onChange={() => setAssessmentType('custom')}
              className={`mt-1 ${RADIO_CLASS}`}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Custom</span>
              <span className="block text-slate">Configure proctoring, review and feedback individually.</span>
            </span>
          </label>
        </div>
      </fieldset>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          aria-expanded={advancedOpen}
          aria-controls="advanced-settings"
          className="text-sm font-medium text-accent hover:text-accent-hover"
        >
          <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span> Advanced settings
        </button>
        {advancedOpen && (
          <div id="advanced-settings" className="mt-3 bg-ink/5 border border-hairline rounded-xl p-4 space-y-4">
            <fieldset>
              <legend className="block text-sm font-medium text-ink mb-1">Webcam proctoring</legend>
              <div className="flex space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="proctored" checked={formData.proctored === true} onChange={() => setFlag({ proctored: true })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">On</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="proctored" checked={formData.proctored === false} onChange={() => setFlag({ proctored: false })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Off</span>
                </label>
              </div>
            </fieldset>
            <fieldset aria-describedby="allowReview-help">
              <legend className="block text-sm font-medium text-ink mb-1">Answer review</legend>
              <div className="flex space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="allowReview" checked={formData.allowReview === false} onChange={() => setFlag({ allowReview: false })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Locked (one-shot, in order)</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="allowReview" checked={formData.allowReview === true} onChange={() => setFlag({ allowReview: true })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Allow revisiting &amp; editing</span>
                </label>
              </div>
              <p id="allowReview-help" className="mt-1 text-xs text-slate">Applies to written assessments.</p>
            </fieldset>
            <fieldset>
              <legend className="block text-sm font-medium text-ink mb-1">Feedback release</legend>
              <div className="flex space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="feedbackRelease" checked={formData.feedbackRelease === 'manual'} onChange={() => setFlag({ feedbackRelease: 'manual' })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Manual (you release results)</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="feedbackRelease" checked={formData.feedbackRelease === 'immediate'} onChange={() => setFlag({ feedbackRelease: 'immediate' })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Immediate (as soon as graded)</span>
                </label>
              </div>
            </fieldset>
            <fieldset aria-describedby="autoEvaluate-help">
              <legend className="block text-sm font-medium text-ink mb-1">Automatic AI evaluation</legend>
              <div className="flex space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="autoEvaluate" checked={formData.autoEvaluate === true} onChange={() => setFlag({ autoEvaluate: true })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">On (score each student as they submit)</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="autoEvaluate" checked={formData.autoEvaluate === false} onChange={() => setFlag({ autoEvaluate: false })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Off (evaluate manually later)</span>
                </label>
              </div>
              <p id="autoEvaluate-help" className="mt-1 text-xs text-slate">When on, a student's answers are AI-evaluated as soon as they submit — no need to wait for the whole class or click Evaluate.</p>
            </fieldset>
            <fieldset aria-describedby="autoReport-help">
              <legend className="block text-sm font-medium text-ink mb-1">Automatic cohort report</legend>
              <div className="flex space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="autoReport" checked={formData.autoReport !== false} onChange={() => setFlag({ autoReport: true })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">On</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="radio" name="autoReport" checked={formData.autoReport === false} onChange={() => setFlag({ autoReport: false })} className={RADIO_CLASS} />
                  <span className="text-ink text-sm">Off</span>
                </label>
              </div>
              {formData.autoReport !== false && (
                <label className="mt-2 flex items-center gap-2 text-sm text-ink">
                  <span>Generate after</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={formData.autoReportThreshold ?? 10}
                    onChange={(e) => setFlag({ autoReportThreshold: Number(e.target.value) || 10 })}
                    className={`${NUMBER_INPUT_CLASS} w-24`}
                  />
                  <span>submissions</span>
                </label>
              )}
              <p id="autoReport-help" className="mt-1 text-xs text-slate">
                A class summary (averages, grade spread, score distribution) is generated automatically once this many students have submitted, then refreshed at each further multiple. It doesn't wait for the whole cohort.
              </p>
            </fieldset>
            {formData.feedbackRelease === 'immediate' && !formData.autoEvaluate && (
              <p role="status" aria-live="polite" className="text-xs text-caution">
                Heads up: "immediate" feedback release has no effect unless automatic AI evaluation is on — with auto-evaluation off, there's nothing to show until you evaluate manually.
              </p>
            )}
            {formData.allowReview && formData.timeLimit != null && (
              <p role="status" aria-live="polite" className="text-xs text-caution">
                Heads up: per-question time limits and answer revisiting don't combine well — with review on, the timer is shown but won't auto-submit.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 pt-4">
        <button
          type="submit"
          className="bg-accent text-white px-6 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create Assessment
        </button>
        <button
          type="button"
          onClick={() => navigate('/assessments')}
          className="bg-ink/5 text-ink px-6 py-2.5 rounded-xl font-medium hover:bg-ink/10 transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
