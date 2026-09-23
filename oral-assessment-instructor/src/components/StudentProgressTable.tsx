import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';
import { useToastStore } from '../store/toastStore';
import type { StudentProgress, Student } from '../../../shared/types/assessment';
import { assessmentPhaseToken, studentStatusToken } from '../utils/statusTokens';
import type { AssessmentPhase } from '../utils/statusTokens';

interface EvalProgress {
  questionsEvaluated: number;
  totalQuestions: number;
  percentage: number;
  status: string; // 'evaluating' | 'completed' | 'failed' | 'not_started'
}

interface StudentProgressTableProps {
  assessmentId: string;
}

type StudentProgressWithInfo = StudentProgress & {
  student: Pick<Student, 'studentId' | 'name' | 'email'>;
};

/**
 * Row actions are a single family of small ghost buttons — before this they were
 * bare text links colour-coded yellow/blue/green/primary, so colour was the only
 * differentiator and there was no button affordance at all. Exactly ONE action per
 * row is promoted (accent); everything else stays neutral.
 */
const rowActionClass = (promoted: boolean) =>
  `text-xs font-medium px-2 py-1 rounded-xl border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    promoted
      ? 'border-accent/30 text-accent hover:text-accent-hover hover:bg-accent/10'
      : 'border-hairline text-slate hover:text-ink hover:bg-ink/5'
  }`;

export default function StudentProgressTable({ assessmentId }: StudentProgressTableProps) {
  const { progress, setProgress, students, setStudents, setLoading, setError } = useAssessmentStore();
  const addToast = useToastStore((s) => s.addToast);

  const [filteredProgress, setFilteredProgress] = useState<StudentProgressWithInfo[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluatingSingle, setEvaluatingSingle] = useState<Record<string, boolean>>({});
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);
  const [reminderSent, setReminderSent] = useState<string | null>(null);
  const [resendingInvite, setResendingInvite] = useState<string | null>(null);
  const [inviteResentId, setInviteResentId] = useState<string | null>(null);
  const [copiedStudentId, setCopiedStudentId] = useState<string | null>(null);
  const [isSendingInvites, setIsSendingInvites] = useState(false);
  const [invitesSent, setInvitesSent] = useState(() => {
    try { return localStorage.getItem(`invitesSent:${assessmentId}`) === 'true'; } catch { return false; }
  });
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteSubject, setInviteSubject] = useState('');
  const [inviteMessage, setInviteMessage] = useState('');
  const STUDENT_APP_URL = (() => {
    const envUrl = import.meta.env.VITE_STUDENT_APP_URL;
    if (!envUrl) {
      console.warn('VITE_STUDENT_APP_URL is not set — falling back to window.location.origin for student links');
    }
    return envUrl || window.location.origin;
  })();
  const EVAL_DONE_KEY = `evalDone:${assessmentId}`;
  const [evalProgress, setEvalProgress] = useState<Record<string, EvalProgress>>(() => {
    // Restore completed evaluations from localStorage
    try {
      const stored = localStorage.getItem(EVAL_DONE_KEY);
      const doneIds: string[] = stored ? JSON.parse(stored) : [];
      return Object.fromEntries(
        doneIds.map(id => [id, { questionsEvaluated: 1, totalQuestions: 1, percentage: 100, status: 'completed' }])
      );
    } catch {
      return {};
    }
  });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState(0);
  // Current time, refreshed by the 1s ticker below. Read during render to drive
  // the "Inactive 30m+" badge without calling the impure Date.now() in render.
  const [now, setNow] = useState(() => Date.now());
  const evalStreams = useRef<Record<string, EventSource>>({});
  const INACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

  // Invite modal focus management: the dialog traps Tab, closes on Escape, and
  // returns focus to whatever opened it (the banner button).
  const inviteDialogRef = useRef<HTMLDivElement>(null);
  const inviteSubjectRef = useRef<HTMLInputElement>(null);
  const inviteReturnFocusRef = useRef<HTMLElement | null>(null);

  const loadProgressData = async () => {
    try {
      setLoading(true);
      setError(null);
      const progressData = await apiService.getAssessmentProgress(assessmentId);
      setProgress(Array.isArray(progressData) ? progressData : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load progress data');
    } finally {
      setLoading(false);
    }
  };

  const loadStudents = async () => {
    try {
      const studentsData = await apiService.getAssessmentStudents(assessmentId);
      setStudents(Array.isArray(studentsData) ? studentsData : []);
    } catch (err) {
      console.error('Error loading students:', err);
    }
  };

  const startPolling = () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    const interval = setInterval(async () => {
      try {
        const progressData = await apiService.getAssessmentProgress(assessmentId);
        setProgress(Array.isArray(progressData) ? progressData : []);
        setLastUpdated(new Date());
        setSecondsSinceUpdate(0);
      } catch (err) {
        console.error('Error polling progress:', err);
      }
    }, 10_000);
    setPollingInterval(interval);
  };

  const applyFilters = () => {
    // Ensure progress is an array
    const progressArray = Array.isArray(progress) ? progress : [];
    const studentsArray = Array.isArray(students) ? students : [];

    let filtered = progressArray.map(p => {
      const student = studentsArray.find(s => s.studentId === p.studentId);
      // The progress payload already carries name/email, so fall back to those
      // before degrading to the raw ID if the students list hasn't loaded yet.
      return {
        ...p,
        student: student || {
          studentId: p.studentId,
          name: p.name || p.studentId,
          email: p.email || '',
        },
      };
    });

    // Status filter
    if (statusFilter === 'done') {
      filtered = filtered.filter(p => p.status === 'completed' || p.status === 'submitted');
    } else if (statusFilter !== 'all') {
      filtered = filtered.filter(p => p.status === statusFilter);
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        p.student.name.toLowerCase().includes(query) ||
        p.student.email.toLowerCase().includes(query) ||
        p.student.studentId.toLowerCase().includes(query)
      );
    }

    setFilteredProgress(filtered);
  };

  // Load initial data (reset stale data first to avoid showing previous assessment's state)
  useEffect(() => {
    setProgress([]);
    setStudents([]);
    loadProgressData();
    loadStudents();
  }, [assessmentId]);

  // Poll for progress updates every 10s
  useEffect(() => {
    // Intentional: startPolling subscribes to an external timer and stores its
    // handle via setPollingInterval — effect-driven subscription setup, not a
    // render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startPolling();
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        setPollingInterval(null);
      }
    };
  }, [assessmentId]);

  // Apply filters when data changes
  useEffect(() => {
    // Intentional: derive filteredProgress from progress/students/filters when
    // any of them change. Single setState per data change, guarded by the dep
    // array, so it settles in one pass rather than cascading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyFilters();
  }, [progress, students, statusFilter, searchQuery]);

  // Tick the "last updated" counter (and current time) every second
  useEffect(() => {
    const ticker = setInterval(() => {
      setNow(Date.now());
      if (lastUpdated) {
        setSecondsSinceUpdate(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
      }
    }, 1000);
    return () => clearInterval(ticker);
  }, [lastUpdated]);

  const openEvalProgressStream = (studentId: string) => {
    if (evalStreams.current[studentId]) evalStreams.current[studentId].close();
    const es = apiService.openStudentEvaluationProgressStream(assessmentId, studentId);
    evalStreams.current[studentId] = es;
    es.onmessage = (event) => {
      try {
        const data: EvalProgress = JSON.parse(event.data);
        setEvalProgress(prev => ({ ...prev, [studentId]: data }));
        if (data.status === 'completed') {
          // Persist to localStorage so Evaluate button stays hidden after refresh
          try {
            const stored = localStorage.getItem(EVAL_DONE_KEY);
            const doneIds: string[] = stored ? JSON.parse(stored) : [];
            if (!doneIds.includes(studentId)) {
              localStorage.setItem(EVAL_DONE_KEY, JSON.stringify([...doneIds, studentId]));
            }
          } catch { /* ignore storage errors */ }
          es.close();
          delete evalStreams.current[studentId];
        } else if (data.status === 'failed') {
          es.close();
          delete evalStreams.current[studentId];
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      es.close();
      delete evalStreams.current[studentId];
      // Re-open the stream after a brief delay if evaluation was still in progress
      const lastProgress = evalProgress[studentId];
      if (lastProgress && lastProgress.status === 'evaluating') {
        setTimeout(() => openEvalProgressStream(studentId), 3000);
      }
    };
  };

  // Close all eval streams on unmount
  useEffect(() => {
    return () => {
      Object.values(evalStreams.current).forEach(es => es.close());
    };
  }, []);

  const handleEvaluateAll = async () => {
    // Ensure progress is an array
    const progressArray = Array.isArray(progress) ? progress : [];

    const completedStudents = progressArray
      .filter(p => p.status === 'completed')
      .map(p => p.studentId);

    if (completedStudents.length === 0) {
      setError('No completed assessments to evaluate');
      return;
    }

    try {
      setIsEvaluating(true);
      setLoading(true);
      setError(null);
      await apiService.evaluateAssessment(assessmentId, completedStudents);
      setError(null);
      // Open per-student progress streams
      completedStudents.forEach(sid => openEvalProgressStream(sid));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start evaluation';
      setError(message);
      addToast(message, 'error');
    } finally {
      setIsEvaluating(false);
      setLoading(false);
    }
  };

  const handleEvaluateSingle = async (studentId: string) => {
    setEvaluatingSingle(prev => ({ ...prev, [studentId]: true }));
    try {
      await apiService.evaluateAssessment(assessmentId, [studentId]);
      openEvalProgressStream(studentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start evaluation';
      setError(message);
      addToast(message, 'error');
    } finally {
      setEvaluatingSingle(prev => ({ ...prev, [studentId]: false }));
    }
  };

  const handleCopyLink = async (studentId: string) => {
    const link = `${STUDENT_APP_URL}/${studentId}/${assessmentId}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Fallback for browsers that block clipboard
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedStudentId(studentId);
    setTimeout(() => setCopiedStudentId(null), 2000);
  };

  const handleSendReminder = async (studentId: string) => {
    setSendingReminder(studentId);
    try {
      await apiService.sendReminder(assessmentId, studentId);
      setReminderSent(studentId);
      setTimeout(() => setReminderSent(null), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send reminder';
      setError(message);
      addToast(message, 'error');
    } finally {
      setSendingReminder(null);
    }
  };

  // Resend a fresh single-use invite link to one student (for expired/used links).
  // Reuses the bulk modal's subject/message if the instructor has customised them,
  // otherwise the backend falls back to the default invite template.
  const handleResendInvite = async (studentId: string) => {
    setResendingInvite(studentId);
    try {
      const opts: { subject?: string; message?: string } = {};
      if (inviteSubject.trim()) opts.subject = inviteSubject.trim();
      if (inviteMessage.trim()) opts.message = inviteMessage.trim();
      const result = await apiService.resendInvite(assessmentId, studentId, opts);
      if (result.emailSent) {
        setInviteResentId(studentId);
        setTimeout(() => setInviteResentId(null), 3000);
      } else {
        const message = 'No email on file for this student — could not resend the invite.';
        setError(message);
        addToast(message, 'warning');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resend invite';
      setError(message);
      addToast(message, 'error');
    } finally {
      setResendingInvite(null);
    }
  };

  const openInviteModal = () => {
    // Remember the trigger so focus can return to it when the dialog closes.
    inviteReturnFocusRef.current = document.activeElement as HTMLElement | null;
    const title = useAssessmentStore.getState().selectedAssessment?.title || 'your assessment';
    setInviteSubject(`Your assessment invitation: ${title}`);
    setInviteMessage(
      `Hi {{name}},\n\n` +
      `You have been invited to complete an assessment: {{title}}.\n\n` +
      `Click the link below to start:\n{{link}}\n\n` +
      `This link is single-use and expires in 7 days.\n\n` +
      `Good luck!`
    );
    setShowInviteModal(true);
  };

  const closeInviteModal = useCallback(() => {
    setShowInviteModal(false);
    inviteReturnFocusRef.current?.focus();
  }, []);

  // Focus the first field on open, trap Tab inside the dialog, close on Escape,
  // and lock background scroll — mirrors AppShell's SettingsModal.
  useEffect(() => {
    if (!showInviteModal) return;
    inviteSubjectRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeInviteModal();
        return;
      }
      if (e.key !== 'Tab') return;

      const dialog = inviteDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [showInviteModal, closeInviteModal]);

  const handleSendInvites = async () => {
    setIsSendingInvites(true);
    try {
      const opts: { subject?: string; message?: string } = {};
      if (inviteSubject.trim()) opts.subject = inviteSubject.trim();
      if (inviteMessage.trim()) opts.message = inviteMessage.trim();
      const result = await apiService.sendInvites(assessmentId, opts);
      closeInviteModal();
      setInvitesSent(true);
      try { localStorage.setItem(`invitesSent:${assessmentId}`, 'true'); } catch { /* */ }
      // Transient send result goes to the global toast queue rather than a local
      // ad-hoc message pinned inside the banner.
      addToast(
        `Sent ${result.sent} invite${result.sent !== 1 ? 's' : ''}${result.skipped > 0 ? ` (${result.skipped} skipped — no email)` : ''}`,
        'success',
        5000
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send invites';
      setError(message);
      addToast(message, 'error');
    } finally {
      setIsSendingInvites(false);
    }
  };

  const isInactive = (p: StudentProgress): boolean => {
    if (p.status === 'completed' || p.status === 'submitted') return false;
    const startedAt = p.startedAt;
    if (!startedAt) return false;
    return now - new Date(startedAt).getTime() > INACTIVE_THRESHOLD_MS;
  };

  const getProgressPercentage = (p: StudentProgress) => {
    return p.totalQuestions > 0 ? Math.round((p.answeredQuestions / p.totalQuestions) * 100) : 0;
  };

  // Ensure progress is an array for stats calculation
  const progressArray = Array.isArray(progress) ? progress : [];

  const stats = {
    total: progressArray.length,
    notStarted: progressArray.filter(p => p.status === 'not-started').length,
    inProgress: progressArray.filter(p => p.status === 'in-progress').length,
    completed: progressArray.filter(p => p.status === 'completed' || p.status === 'submitted').length,
  };
  const evaluatedCount = Object.values(evalProgress).filter(e => e.status === 'completed').length;
  const allSubmitted = stats.total > 0 && stats.completed === stats.total;
  const allEvaluated = stats.completed > 0 && evaluatedCount >= stats.completed;

  // Assessment phase status. This component owns the derivation; the chip's
  // colour and label come from the shared statusTokens module so the cohort
  // roll-up can never disagree with the per-row chips again (`All Submitted`
  // used to be success here while row `submitted` was accent, and `Evaluated`
  // shared `Open`'s accent tint despite being the opposite end of the lifecycle).
  const assessmentPhase: AssessmentPhase = allEvaluated ? 'Evaluated' : allSubmitted ? 'All Submitted' : stats.inProgress > 0 ? 'In Progress' : stats.notStarted === stats.total ? 'Not Started' : 'Open';
  const phaseToken = assessmentPhaseToken(assessmentPhase);
  const evaluateAllLabel = isEvaluating
    ? 'Evaluating...'
    : allEvaluated
    ? `Re-evaluate All (${stats.completed})`
    : `Evaluate All (${stats.completed})`;

  return (
    <div className="space-y-6">
      {/* Status Pill + Stats Cards */}
      <div className="flex items-center gap-3 mb-2">
        <span className={`px-3 py-1 rounded-full text-sm font-medium ${phaseToken.className}`}>
          {phaseToken.label}
        </span>
        {evaluatedCount > 0 && (
          <span className="text-sm text-slate tabular-nums" role="status" aria-live="polite">
            {evaluatedCount} of {stats.completed} evaluated
          </span>
        )}
      </div>

      {/* All-submitted notice. Informational only: the single canonical "run the
          evaluation" control is the toolbar button below, which is always present
          and carries the count — this banner used to duplicate it in a different
          colour, giving the page two competing primary actions. */}
      {allSubmitted && !allEvaluated && !isEvaluating && (
        <div
          className="bg-success/10 border border-success/30 rounded-xl p-4"
          role="status"
          aria-live="polite"
        >
          <p className="text-success font-medium">
            All <span className="tabular-nums">{stats.total}</span> students have submitted.
          </p>
          <p className="text-success text-sm">
            Use “{evaluateAllLabel}” below to generate scores and feedback.
          </p>
        </div>
      )}

      {/* Invite banner. Unlike evaluation, sending invites has no toolbar
          equivalent, so the button stays here as the only way to open the
          compose modal. */}
      {stats.total > 0 && stats.notStarted > 0 && (
        <div
          className={`${invitesSent ? 'bg-paper border-hairline' : 'bg-accent/[0.08] border-accent/20'} border rounded-xl p-4 flex items-center justify-between gap-4`}
        >
          <div>
            <p className={`${invitesSent ? 'text-ink' : 'text-accent'} font-medium`}>
              <span className="tabular-nums">{stats.notStarted}</span> student{stats.notStarted !== 1 ? 's haven\'t' : ' hasn\'t'} started yet.
            </p>
            <p className="text-slate text-sm">
              {invitesSent ? 'Invite emails have been sent.' : 'Send invite emails with their assessment links.'}
            </p>
          </div>
          <button
            type="button"
            onClick={openInviteModal}
            className={`${
              invitesSent
                ? 'border border-hairline text-ink hover:bg-ink/5'
                : 'bg-accent text-white hover:bg-accent-hover'
            } px-6 py-2.5 rounded-xl font-medium transition-colors whitespace-nowrap`}
          >
            {invitesSent ? 'Resend Invites' : 'Send Invites'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-sm text-slate mb-1">Total Students</div>
          <div className="text-2xl font-bold text-ink tabular-nums">{stats.total}</div>
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-sm text-slate mb-1">Not Started</div>
          <div className="text-2xl font-bold text-ink tabular-nums">{stats.notStarted}</div>
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-sm text-slate mb-1">In Progress</div>
          <div className="text-2xl font-bold text-caution tabular-nums">{stats.inProgress}</div>
        </div>
        <div className="bg-paper border border-hairline rounded-xl p-4">
          <div className="text-sm text-slate mb-1">Completed</div>
          <div className="text-2xl font-bold text-success tabular-nums">{stats.completed}</div>
        </div>
      </div>

      {/* Filters and Actions */}
      <div className="bg-paper border border-hairline rounded-xl p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1">
            {/* Search */}
            <div className="relative flex-1 max-w-md">
              <label htmlFor="progress-search" className="sr-only">
                Search students by name, email, or ID
              </label>
              <input
                id="progress-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, email, or ID..."
                className="w-full px-4 py-2 pl-10 bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none"
              />
              <svg
                aria-hidden="true"
                className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-slate"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>

            {/* Status Filter */}
            <label htmlFor="progress-status-filter" className="sr-only">
              Filter by status
            </label>
            <select
              id="progress-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-4 py-2 bg-ink/5 border border-hairline rounded-xl text-ink focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none"
            >
              <option value="all">All Status</option>
              <option value="not-started">Not Started</option>
              <option value="in-progress">In Progress</option>
              <option value="done">Completed / Submitted</option>
            </select>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleEvaluateAll}
              disabled={isEvaluating || stats.completed === 0}
              aria-busy={isEvaluating}
              /* Stays accent once everything is evaluated: a solid success fill is
                 ~3.4:1 against white and fails the 4.5:1 floor, and re-running the
                 evaluation is the same forward action either way. The state lives
                 in evaluateAllLabel ("Re-evaluate All"), not in the hue. */
              className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-accent hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {evaluateAllLabel}
            </button>
            <button
              type="button"
              onClick={() => { loadProgressData(); setLastUpdated(new Date()); setSecondsSinceUpdate(0); }}
              className="border border-hairline text-ink px-4 py-2 rounded-xl text-sm font-medium hover:bg-ink/5 transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
            >
              Refresh
            </button>
            {lastUpdated && (
              <span className="text-xs text-slate tabular-nums" role="status" aria-live="polite">
                Updated {secondsSinceUpdate}s ago
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Progress Table */}
      <div className="bg-paper border border-hairline rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink/5">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                  Student
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                  Progress
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                  Started At
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredProgress.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <p className="font-serif text-lg text-ink">
                      {searchQuery || statusFilter !== 'all'
                        ? 'No students match your filters'
                        : 'No student data available'}
                    </p>
                    <p className="mt-1 text-sm text-slate">
                      {searchQuery || statusFilter !== 'all'
                        ? 'Try a different search term or status.'
                        : 'Students appear here once they are enrolled in this assessment.'}
                    </p>
                  </td>
                </tr>
              ) : (
                filteredProgress.map((p) => {
                  const evaluated = evalProgress[p.studentId]?.status === 'completed';
                  const isDone = p.status === 'completed' || p.status === 'submitted';
                  const notYetStarted = p.status === 'not-started' || p.status === 'in-progress';
                  const statusToken = studentStatusToken(p.status);
                  return (
                  <tr key={p.studentId} className="hover:bg-ink/5">
                    <td className="px-4 py-3">
                      <div>
                        <div className="text-sm font-medium text-ink">
                          {p.student.name}
                        </div>
                        <div className="text-xs text-slate">{p.student.email}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusToken.className}`}
                      >
                        {statusToken.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center space-x-3">
                        <div className="flex-1 space-y-2">
                          {/* Submission progress */}
                          <div>
                            <div className="flex justify-between text-xs text-slate mb-1">
                              <span className="tabular-nums">{p.answeredQuestions} / {p.totalQuestions} answered</span>
                              <span className="tabular-nums">{getProgressPercentage(p)}%</span>
                            </div>
                            <div className="w-full bg-ink/10 rounded-full h-2">
                              <div
                                className="bg-accent h-2 rounded-full transition-all duration-300"
                                style={{ width: `${getProgressPercentage(p)}%` }}
                                role="progressbar"
                                aria-label={`Answer progress for ${p.student.name}`}
                                aria-valuenow={getProgressPercentage(p)}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              />
                            </div>
                          </div>
                          {/* Per-question evaluation progress (shown when evaluating) */}
                          {evalProgress[p.studentId] && evalProgress[p.studentId].status !== 'not_started' && (
                            <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span
                                  role="status"
                                  aria-live="polite"
                                  className={evalProgress[p.studentId].status === 'completed' ? 'text-success' : evalProgress[p.studentId].status === 'failed' ? 'text-danger' : 'text-caution'}
                                >
                                  {evalProgress[p.studentId].status === 'completed'
                                    ? 'Evaluated'
                                    : evalProgress[p.studentId].status === 'failed'
                                    ? 'Eval failed'
                                    : <>Evaluating… <span className="tabular-nums">{evalProgress[p.studentId].questionsEvaluated}/{evalProgress[p.studentId].totalQuestions}</span> questions</>}
                                </span>
                                <span className="text-slate tabular-nums">{evalProgress[p.studentId].percentage}%</span>
                              </div>
                              <div className="w-full bg-ink/10 rounded-full h-1.5">
                                <div
                                  className={`h-1.5 rounded-full transition-all duration-500 ${evalProgress[p.studentId].status === 'completed' ? 'bg-success' : evalProgress[p.studentId].status === 'failed' ? 'bg-danger' : 'bg-caution'}`}
                                  style={{ width: `${evalProgress[p.studentId].percentage}%` }}
                                  role="progressbar"
                                  aria-label={`Evaluation progress for ${p.student.name}`}
                                  aria-valuenow={evalProgress[p.studentId].percentage}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate tabular-nums">
                      {p.startedAt ? new Date(p.startedAt).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isInactive(p) && (
                          <span className="px-2 py-0.5 text-xs font-medium text-caution bg-caution/10 border border-caution/30 rounded-full">
                            Inactive 30m+
                          </span>
                        )}
                        {notYetStarted && (
                          reminderSent === p.studentId ? (
                            <span className="text-success text-xs font-medium" role="status" aria-live="polite">Sent ✓</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleSendReminder(p.studentId)}
                              disabled={sendingReminder === p.studentId}
                              aria-label={`Send reminder to ${p.student.name}`}
                              /* Promoted for a student who has started but stalled —
                                 nudging them is the useful move; for a student who
                                 never opened the link, a fresh invite is. */
                              className={rowActionClass(p.status === 'in-progress')}
                            >
                              {sendingReminder === p.studentId ? 'Sending…' : 'Send Reminder'}
                            </button>
                          )
                        )}
                        {notYetStarted && (
                          inviteResentId === p.studentId ? (
                            <span className="text-success text-xs font-medium" role="status" aria-live="polite">Invite sent ✓</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleResendInvite(p.studentId)}
                              disabled={resendingInvite === p.studentId}
                              aria-label={`Resend invite to ${p.student.name}`}
                              title="Email this student a fresh single-use link (new 7-day expiry). Use when their previous link expired or was already used."
                              className={rowActionClass(p.status === 'not-started')}
                            >
                              {resendingInvite === p.studentId ? 'Sending…' : 'Resend Invite'}
                            </button>
                          )
                        )}
                        {isDone && evaluated && (
                          <Link
                            to={`/assessments/${assessmentId}/student/${p.studentId}/results`}
                            aria-label={`View results for ${p.student.name}`}
                            className={rowActionClass(true)}
                          >
                            View Results
                          </Link>
                        )}
                        {isDone &&
                          (!evalProgress[p.studentId] || evalProgress[p.studentId].status === 'not_started') && (
                          <button
                            type="button"
                            onClick={() => handleEvaluateSingle(p.studentId)}
                            disabled={evaluatingSingle[p.studentId]}
                            aria-label={`Evaluate ${p.student.name}'s answers`}
                            className={rowActionClass(true)}
                          >
                            {evaluatingSingle[p.studentId] ? 'Starting…' : 'Evaluate'}
                          </button>
                        )}
                        {notYetStarted && (
                          <Link
                            to={`/assessments/${assessmentId}/questions/${p.studentId}`}
                            aria-label={`Edit questions for ${p.student.name}`}
                            className={rowActionClass(false)}
                          >
                            Edit Questions
                          </Link>
                        )}
                        <button
                          type="button"
                          onClick={() => handleCopyLink(p.studentId)}
                          title={`${STUDENT_APP_URL}/${p.studentId}/${assessmentId}`}
                          aria-label={`Copy assessment link for ${p.student.name}`}
                          className={rowActionClass(false)}
                        >
                          {copiedStudentId === p.studentId ? (
                            <span className="text-success" role="status" aria-live="polite">Copied ✓</span>
                          ) : (
                            'Copy Link'
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Invite Email Modal */}
      {showInviteModal && (
        <div
          className="fixed inset-0 backdrop-blur-[2px] flex items-center justify-center p-4 z-50"
          style={{ backgroundColor: 'var(--scrim)' }}
          onClick={closeInviteModal}
        >
          <div
            ref={inviteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-modal-title"
            onClick={(e) => e.stopPropagation()}
            className="bg-paper rounded-xl shadow-overlay max-w-lg w-full p-6"
          >
            <div className="flex items-start justify-between gap-4 mb-1">
              <h2 id="invite-modal-title" className="font-serif text-lg font-semibold text-ink">
                Send Invite Emails
              </h2>
              <button
                type="button"
                onClick={closeInviteModal}
                aria-label="Close invite email composer"
                className="flex-shrink-0 text-slate hover:text-ink transition-colors rounded"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
            <p className="text-sm text-slate mb-4">
              Customise the email sent to <span className="tabular-nums">{stats.total}</span> enrolled student{stats.total !== 1 ? 's' : ''}.
              Use <code className="bg-ink/5 px-1 rounded text-xs">{'{{name}}'}</code>, <code className="bg-ink/5 px-1 rounded text-xs">{'{{title}}'}</code>, and <code className="bg-ink/5 px-1 rounded text-xs">{'{{link}}'}</code> as placeholders.
            </p>

            <label htmlFor="invite-subject" className="block text-sm font-medium text-ink mb-1">Subject</label>
            <input
              id="invite-subject"
              ref={inviteSubjectRef}
              type="text"
              value={inviteSubject}
              onChange={(e) => setInviteSubject(e.target.value)}
              className="w-full px-3 py-2 bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none mb-4"
            />

            <label htmlFor="invite-message" className="block text-sm font-medium text-ink mb-1">Message</label>
            <textarea
              id="invite-message"
              value={inviteMessage}
              onChange={(e) => setInviteMessage(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none resize-y text-sm font-mono mb-4"
            />

            <div className="flex space-x-3">
              <button
                type="button"
                onClick={closeInviteModal}
                disabled={isSendingInvites}
                className="flex-1 border border-hairline text-ink px-4 py-2 rounded-xl font-medium hover:bg-ink/5 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendInvites}
                disabled={isSendingInvites}
                aria-busy={isSendingInvites}
                className="flex-1 bg-accent text-white px-4 py-2 rounded-xl font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
              >
                {isSendingInvites ? 'Sending...' : `Send to ${stats.total} Students`}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
