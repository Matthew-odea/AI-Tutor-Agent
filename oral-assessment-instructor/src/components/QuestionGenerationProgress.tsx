import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';
import ErrorMessage from './ErrorMessage';
import type { Student } from '../../../shared/types/assessment';

interface QuestionGenerationProgressProps {
  assessmentId: string;
}

export default function QuestionGenerationProgress({ assessmentId }: QuestionGenerationProgressProps) {
  const navigate = useNavigate();
  const { generationJob, setGenerationJob, setLoading, setError } = useAssessmentStore();
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [jobStartTime, setJobStartTime] = useState<number | null>(null);
  const [elapsedDisplay, setElapsedDisplay] = useState('');
  const pollDelayRef = useRef(3000);
  const JOB_KEY = `genJob:${assessmentId}`;

  // On opening an assessment, drop any job the global store holds for a different
  // assessment (it used to be shown here as this one's), then restore this
  // assessment's in-flight job from localStorage (survives page refresh).
  useEffect(() => {
    if (useAssessmentStore.getState().generationJob?.assessmentId === assessmentId) return;
    let restored = null;
    try {
      const stored = localStorage.getItem(JOB_KEY);
      const parsed = stored ? JSON.parse(stored) : null;
      if (parsed?.status === 'pending' || parsed?.status === 'running') restored = parsed;
    } catch { /* ignore parse errors */ }
    setGenerationJob(restored);
  }, [assessmentId, JOB_KEY, setGenerationJob]);

  // Persist this assessment's job to localStorage whenever it changes
  useEffect(() => {
    if (generationJob?.assessmentId === assessmentId) {
      localStorage.setItem(JOB_KEY, JSON.stringify(generationJob));
    }
  }, [generationJob, assessmentId, JOB_KEY]);

  // Holds the latest scheduleNextPoll so the recursive re-schedule inside the
  // setTimeout callback can call it without referencing the const before it is
  // assigned (the ref is populated synchronously below, on every render).
  const scheduleNextPollRef = useRef<() => void>(() => {});

  const jobId = generationJob?.jobId;
  const scheduleNextPoll = useCallback(() => {
    if (!jobId) return;

    const timeout = setTimeout(async () => {
      try {
        const updatedJob = await apiService.getQuestionGenerationStatus(assessmentId, jobId);
        setGenerationJob(updatedJob);

        // Stop polling if job is complete or failed
        if (updatedJob.status === 'completed' || updatedJob.status === 'failed') {
          setPollingInterval(null);
          pollDelayRef.current = 3000;
          return;
        }
      } catch (err) {
        console.error('Error polling job status:', err);
      }

      // Exponential backoff: 3s -> 5s -> 10s -> 20s -> 30s (max)
      pollDelayRef.current = Math.min(pollDelayRef.current * 1.5, 30000);
      scheduleNextPollRef.current();
    }, pollDelayRef.current);

    setPollingInterval(timeout);
  }, [assessmentId, jobId, setGenerationJob]);

  // Keep the ref pointing at the latest scheduleNextPoll so the recursive
  // re-schedule inside the setTimeout callback always invokes the current one.
  useEffect(() => {
    scheduleNextPollRef.current = scheduleNextPoll;
  }, [scheduleNextPoll]);

  const startPolling = useCallback(() => {
    if (pollingInterval) return; // Already polling
    pollDelayRef.current = 3000; // reset on fresh start
    scheduleNextPoll();
  }, [pollingInterval, scheduleNextPoll]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearTimeout(pollingInterval);
      }
    };
  }, [pollingInterval]);

  // Track elapsed time while job is running
  useEffect(() => {
    if (generationJob?.status === 'pending' || generationJob?.status === 'running') {
      // Intentional: lazily stamp the job start time on the first running tick;
      // guarded by !jobStartTime so it fires once per job, not a render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!jobStartTime) setJobStartTime(Date.now());
      const timer = setInterval(() => {
        if (jobStartTime) {
          const seconds = Math.floor((Date.now() - jobStartTime) / 1000);
          const mins = Math.floor(seconds / 60);
          const secs = seconds % 60;
          setElapsedDisplay(mins > 0 ? `${mins}m ${secs}s` : `${secs}s`);
        }
      }, 1000);
      return () => clearInterval(timer);
    } else {
      if (generationJob?.status === 'completed' || generationJob?.status === 'failed') {
        // Keep final elapsed display, reset start time
        setJobStartTime(null);
      }
    }
  }, [generationJob?.status, jobStartTime]);

  // Start polling when job is in progress
  useEffect(() => {
    if (generationJob && (generationJob.status === 'pending' || generationJob.status === 'running')) {
      startPolling();
    } else if (pollingInterval) {
      clearTimeout(pollingInterval);
      // Intentional: tear down the polling handle when the job leaves an
      // in-progress state. Mirrors an external timer; not a render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPollingInterval(null);
      pollDelayRef.current = 3000; // reset backoff
    }
    // Keyed on status alone on purpose: startPolling and pollingInterval change on
    // every scheduled poll, and re-running this then would only hit the
    // "already polling" guard. The closure is fresh each time status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationJob?.status]);

  // Load students when job completes so we can show per-student question links
  useEffect(() => {
    if (generationJob?.status === 'completed' && students.length === 0) {
      apiService.getAssessmentStudents(assessmentId)
        .then(s => setStudents(Array.isArray(s) ? s : []))
        .catch(() => { /* non-critical */ });
    }
  }, [generationJob?.status, assessmentId, students.length]);

  const handleStartGeneration = async () => {
    // Prevent duplicate generation if a job is already in progress
    if (generationJob && (generationJob.status === 'pending' || generationJob.status === 'running')) {
      return;
    }
    try {
      setIsGenerating(true);
      setLoading(true);
      setError(null);

      const job = await apiService.generateQuestions(assessmentId);
      setGenerationJob(job);

      // Start polling for status updates
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start question generation');
    } finally {
      setIsGenerating(false);
      setLoading(false);
    }
  };

  const handleCancel = () => {
    // No server-side cancel endpoint exists; reset client-side state
    if (pollingInterval) {
      clearTimeout(pollingInterval);
      setPollingInterval(null);
    }
    pollDelayRef.current = 3000;
    setJobStartTime(null);
    setElapsedDisplay('');
    localStorage.removeItem(JOB_KEY);
    setGenerationJob(null);
    setIsGenerating(false);
  };

  const handleContinue = () => {
    navigate(`/assessments/${assessmentId}/monitor`);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'text-success';
      case 'running':
        return 'text-accent';
      case 'pending':
        return 'text-caution';
      case 'failed':
        return 'text-danger';
      default:
        return 'text-slate';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <svg className="h-6 w-6 text-success" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'running':
        return (
          <div
            aria-hidden="true"
            className="h-6 w-6 animate-spin motion-reduce:animate-none rounded-full border-2 border-ink/10 border-t-accent"
          />
        );
      case 'pending':
        return (
          <svg className="h-6 w-6 text-caution" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'failed':
        return (
          <svg className="h-6 w-6 text-danger" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      default:
        return null;
    }
  };

  const progressPercentage = generationJob
    ? generationJob.totalStudents > 0
      ? Math.round((generationJob.processedCount / generationJob.totalStudents) * 100)
      : 0
    : 0;

  return (
    <div className="space-y-6">

      {/* Generation Status */}
      {!generationJob ? (
        <div className="bg-paper border border-hairline rounded-xl p-6 text-center">
          <p className="text-slate mb-6">
            Generate personalised questions for each student based on their submitted code.
          </p>
          <button
            onClick={handleStartGeneration}
            disabled={isGenerating}
            className="bg-accent text-white px-8 py-3 rounded-xl font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating ? 'Starting...' : 'Generate Questions'}
          </button>
        </div>
      ) : (
        <div className="bg-paper border border-hairline rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center space-x-3">
              {getStatusIcon(generationJob.status)}
              <div>
                <h3 className="font-serif text-lg font-semibold text-ink">
                  Question Generation
                </h3>
                {/* The one live region for the job: a stable node whose text changes as
                    the poll advances, so AT hears "Completed" without the 1s elapsed
                    ticker below spamming announcements. */}
                <p
                  role="status"
                  aria-live="polite"
                  className={`text-sm ${getStatusColor(generationJob.status)}`}
                >
                  Status: {generationJob.status.charAt(0).toUpperCase() + generationJob.status.slice(1)}
                </p>
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex justify-between text-sm text-slate mb-2">
              <span>Progress</span>
              <span className="tabular-nums">
                {generationJob.processedCount} / {generationJob.totalStudents} students
              </span>
            </div>
            <div className="w-full bg-ink/10 rounded-full h-3">
              <div
                className={`h-3 rounded-full transition-all duration-500 ${
                  generationJob.status === 'completed'
                    ? 'bg-success'
                    : generationJob.status === 'failed'
                    ? 'bg-danger'
                    : 'bg-accent'
                }`}
                style={{ width: `${progressPercentage}%` }}
                role="progressbar"
                aria-label="Question generation progress"
                aria-valuenow={progressPercentage}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <div className="flex justify-center items-center gap-4 mt-2">
              <span className="font-serif text-2xl font-semibold text-ink tabular-nums tracking-tight">
                {generationJob.totalStudents === 0 ? 'No students' : `${progressPercentage}%`}
              </span>
              {elapsedDisplay && (
                <span className="text-sm text-slate tabular-nums">Elapsed: {elapsedDisplay}</span>
              )}
            </div>
          </div>

          {/* Stats Grid */}
          <div className={`grid ${generationJob.failedCount > 0 ? 'grid-cols-3' : 'grid-cols-2'} gap-4 mb-6`}>
            <div className="bg-ink/5 rounded-xl p-4">
              <div className="text-sm text-slate mb-1">Total Students</div>
              <div className="font-serif text-2xl font-semibold text-ink tabular-nums tracking-tight">
                {generationJob.totalStudents}
              </div>
            </div>
            <div className="bg-ink/5 rounded-xl p-4">
              <div className="text-sm text-slate mb-1">Processed</div>
              <div className="font-serif text-2xl font-semibold text-ink tabular-nums tracking-tight">
                {generationJob.processedCount}
              </div>
            </div>
            {generationJob.failedCount > 0 && (
              <div className="bg-ink/5 rounded-xl p-4">
                <div className="text-sm text-danger mb-1">Failed</div>
                <div className="font-serif text-2xl font-semibold text-danger tabular-nums tracking-tight">
                  {generationJob.failedCount}
                </div>
              </div>
            )}
          </div>

          {/* Partial failure warning */}
          {generationJob.status === 'completed' && generationJob.failedCount > 0 && (
            <div className="bg-caution/10 border border-caution/30 rounded-xl p-4 mb-6" role="status">
              <div className="flex items-start">
                <svg className="h-5 w-5 text-caution mr-3 mt-0.5 flex-shrink-0" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <div>
                  <h4 className="text-sm font-medium text-caution mb-1">Partial Failure</h4>
                  <p className="text-sm text-caution">
                    {generationJob.failedCount} student(s) failed question generation. You can retry generation for those students.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {generationJob.status === 'failed' && 'error' in generationJob && generationJob.error && (
            <div className="mb-6" role="alert">
              <ErrorMessage error={generationJob.error} />
            </div>
          )}

          {/* Status Message */}
          <div className="text-center">
            {generationJob.status === 'pending' && (
              <div className="space-y-3">
                <p className="text-slate text-sm">
                  Waiting to start... Your job is in the queue.
                </p>
                <button
                  onClick={handleCancel}
                  className="bg-ink/5 text-ink px-4 py-2 rounded-xl text-sm font-medium hover:bg-ink/10 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            )}
            {generationJob.status === 'running' && (
              <div className="space-y-3">
                <p className="text-slate text-sm">
                  Generating questions... This may take a few minutes.
                </p>
                <button
                  onClick={handleCancel}
                  className="bg-ink/5 text-ink px-4 py-2 rounded-xl text-sm font-medium hover:bg-ink/10 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            )}
            {generationJob.status === 'completed' && (
              <div className="space-y-4">
                <p className="text-success text-sm font-medium">
                  ✓ Question generation completed successfully!
                </p>
                {students.length > 0 && (
                  <div className="text-left mt-4">
                    <h4 className="text-sm font-medium text-slate mb-2">
                      Questions generated for <span className="tabular-nums">{students.length}</span> student{students.length !== 1 ? 's' : ''}
                    </h4>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {students.map(s => (
                        <Link
                          key={s.studentId}
                          to={`/assessments/${assessmentId}/questions/${s.studentId}`}
                          className="flex items-center justify-between px-3 py-2 rounded-xl bg-ink/5 hover:bg-ink/10 transition-colors text-sm"
                        >
                          <span className="text-ink">{s.name || s.studentId}</span>
                          <span className="text-accent text-xs font-medium">Edit Questions →</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={handleContinue}
                  className="bg-accent text-white px-6 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper"
                >
                  Continue to Monitor Progress
                </button>
              </div>
            )}
            {/* Retry is a RECOVERY action, not a destructive one, so it is accent
                like the Retry on MonitorProgress and StudentResultDetail. Danger
                is reserved for actions that destroy data. */}
            {generationJob.status === 'failed' && (
              <button
                onClick={handleStartGeneration}
                disabled={isGenerating}
                className="bg-accent text-white px-6 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper disabled:opacity-50"
              >
                Retry Generation
              </button>
            )}
          </div>
        </div>
      )}

      {/* Additional Info */}
      <div className="bg-accent/[0.08] border border-accent/20 rounded-xl p-4">
        <div className="flex items-start">
          <svg
            className="h-5 w-5 text-accent mr-3 mt-0.5 flex-shrink-0"
            aria-hidden="true"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <h4 className="text-sm font-medium text-accent mb-1">Note</h4>
            <p className="text-sm text-accent">
              You can safely navigate away from this page. The generation process will continue
              in the background, and you can check the status anytime.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
