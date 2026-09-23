import { create } from 'zustand';
import type {
  Question,
  Progress,
  Results,
  Assessment,
  ApiError,
} from '../types';
import {
  getQuestions,
  type QuestionsResponse,
  submitAnswer,
  submitTextAnswer,
  submitSkip,
  submitAssessment,
  getProgress,
  getResults,
  recordConsent,
  CONSENT_VERSION,
} from '../services/api';
import { useToastStore } from './toastStore';

import { uploadAudio, validateAudioBlob } from '../services/s3';
import {
  saveAudioDraft,
  loadAudioDraft,
  clearAudioDraft,
  saveTextDraft,
  loadTextDraft,
  clearTextDraft,
} from '../services/draftStore';
import AudioRecorder from '../services/audio';
import ProctoringRecorder from '../services/proctoring';
import {
  isResultsStillPending,
  NO_ORAL_ANSWER_SENTINEL,
  TIME_EXPIRED_SENTINEL,
} from '../utils/resultHelpers';

interface AssessmentStore {
  studentId: string | null;
  assessmentId: string | null;
  assessment: Assessment | null;

  questions: Question[];
  currentQuestionIndex: number;

  progress: Progress | null;

  isRecording: boolean;
  isStopping: boolean; // a stop() is in flight — dedupes manual-Stop vs timer-expiry race
  isPaused: boolean;
  recordingDuration: number;
  recordedBlob: Blob | null;
  recordingStartTime: number | null;
  audioRecorder: AudioRecorder | null;

  isPlaying: boolean;
  playbackUrl: string | null;

  isUploading: boolean;
  uploadProgress: number;

  answerMode: 'oral' | 'written';
  preparationTime: number | null; // seconds; null = no prep phase
  // Instructor-set. proctored defaults true until questions load; the consent modal
  // only renders once questions exist, so there is no flash.
  proctored: boolean;
  allowReview: boolean;
  textAnswer: string;

  proctorStream: MediaStream | null;
  proctoring: ProctoringRecorder | null;
  isProctoringActive: boolean;
  cameraRevoked: boolean;
  consentGiven: boolean;
  // "Session is supposed to be proctored" (vs isProctoringActive = a live stream now).
  // Lets the resume flow detect a refresh dropped the stream and re-arm or block.
  proctoringRequested: boolean;
  // Chunk uploads failing after retry. Non-blocking banner, unlike cameraRevoked's overlay.
  proctoringDegraded: boolean;
  // Reused by the per-question AudioRecorder; a second getUserMedia clashes on Safari/iOS.
  proctorAudioTrack: MediaStreamTrack | null;

  results: Results | null;
  isResultsReady: boolean;
  isResultsPending: boolean;
  resultsPollCount: number; // background polls only; the foreground fetch is not counted
  resultsPollExhausted: boolean; // poll cap reached; UI falls back to manual "Check again"

  answeredQuestionIds: Set<string>;
  // Skips are not answers and must never render the green "answered" check.
  skippedQuestionIds: Set<string>;

  proctoringWarning: string | null;
  lastFailedAction: string | null;
  isLoading: boolean;
  error: ApiError | null;
  isOnline: boolean;

  setStudentInfo: (studentId: string, assessmentId: string) => void;
  // Returns a cleanup fn that removes the listeners.
  initNetworkListeners: () => () => void;
  loadQuestions: () => Promise<void>;
  loadProgress: () => Promise<void>;
  setAnswerMode: (mode: 'oral' | 'written') => void;
  setTextAnswer: (text: string) => void;
  // Restores a persisted audio/text draft after a refresh. True if anything was recovered. Never throws.
  rehydrateDraft: () => Promise<boolean>;

  initializeRecorder: () => Promise<void>;
  startRecording: () => void;
  stopRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  cancelRecording: () => void;

  playRecording: () => void;
  stopPlayback: () => void;

  startProctoring: () => Promise<void>;
  ensureProctoring: () => Promise<void>;
  stopProctoring: () => Promise<void>;
  restoreProctoring: () => Promise<void>;
  setConsentGiven: (given: boolean) => void;
  setProctoringDegraded: (degraded: boolean) => void;
  recordConsentDecision: (granted: boolean) => Promise<void>;

  nextQuestion: () => void;
  previousQuestion: () => void;
  goToQuestion: (index: number) => void;

  submitCurrentAnswer: () => Promise<void>;
  submitCurrentTextAnswer: () => Promise<void>;
  skipCurrentQuestion: (mode?: 'oral' | 'written') => Promise<void>;
  submitCompleteAssessment: () => Promise<boolean>;

  loadResults: (options?: { background?: boolean }) => Promise<void>;
  setResultsPollExhausted: (exhausted: boolean) => void;
  resetResultsPolling: () => void;

  clearError: () => void;
  clearProctoringWarning: () => void;
  retryLastAction: () => Promise<void>;
  reset: () => void;
}

export const useAssessmentStore = create<AssessmentStore>((set, get) => ({
  studentId: null,
  assessmentId: null,
  assessment: null,
  questions: [],
  currentQuestionIndex: 0,
  progress: null,
  isRecording: false,
  isStopping: false,
  isPaused: false,
  recordingDuration: 0,
  recordedBlob: null,
  recordingStartTime: null,
  audioRecorder: null,
  isPlaying: false,
  playbackUrl: null,
  isUploading: false,
  uploadProgress: 0,
  answerMode: 'oral' as 'oral' | 'written',
  preparationTime: null,
  proctored: true,
  allowReview: false,
  textAnswer: '',
  proctorStream: null,
  proctoring: null,
  isProctoringActive: false,
  cameraRevoked: false,
  consentGiven: false,
  proctoringRequested: false,
  proctoringDegraded: false,
  proctorAudioTrack: null,
  results: null,
  isResultsReady: false,
  isResultsPending: false,
  resultsPollCount: 0,
  resultsPollExhausted: false,
  answeredQuestionIds: new Set<string>(),
  skippedQuestionIds: new Set<string>(),
  proctoringWarning: null,
  lastFailedAction: null,
  isLoading: false,
  error: null,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,

  setStudentInfo: (studentId: string, assessmentId: string) => {
    // Same store as the session token, so identity survives a refresh or new tab.
    localStorage.setItem('studentId', studentId);
    localStorage.setItem('assessmentId', assessmentId);
    set({ studentId, assessmentId, error: null });
  },

  initNetworkListeners: () => {
    if (typeof window === 'undefined') return () => {};
    const handleOnline = () => set({ isOnline: true });
    const handleOffline = () => set({ isOnline: false });
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    set({ isOnline: navigator.onLine });
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  },

  setAnswerMode: (mode: 'oral' | 'written') => {
    set({ answerMode: mode });
  },

  setTextAnswer: (text: string) => {
    set({ textAnswer: text });
    // Never persist '': the per-question reset effect calls this with '' on mount and
    // would clobber a good draft before rehydrate reads it. Clearing is explicit elsewhere.
    const { assessmentId, questions, currentQuestionIndex } = get();
    const questionId = questions[currentQuestionIndex]?.id;
    if (assessmentId && questionId && text.trim() !== '') {
      saveTextDraft(assessmentId, questionId, text);
    }
  },

  rehydrateDraft: async (): Promise<boolean> => {
    const { assessmentId, questions, currentQuestionIndex } = get();
    if (!assessmentId) return false;
    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) return false;

    let recovered = false;

    try {
      const draft = await loadAudioDraft(assessmentId);
      if (draft) {
        // Re-read after the await: the index may have advanced during the IndexedDB read.
        const liveQuestion = get().questions[get().currentQuestionIndex];
        if (liveQuestion && draft.questionId === liveQuestion.id) {
          // Never clobber a recording made this session.
          if (get().recordedBlob === null) {
            set({ recordedBlob: draft.blob, recordingDuration: draft.durationSeconds });
            recovered = true;
          }
        } else {
          // Stale: server has moved past this draft's question.
          await clearAudioDraft(assessmentId);
        }
      }
    } catch (error) {
      console.warn('[assessmentStore] audio rehydrate failed (non-fatal):', error);
    }

    try {
      const textDraft = loadTextDraft(assessmentId);
      if (textDraft) {
        const liveQuestion = get().questions[get().currentQuestionIndex];
        if (liveQuestion && textDraft.questionId === liveQuestion.id) {
          if (get().textAnswer.trim() === '' && textDraft.text.trim() !== '') {
            set({ textAnswer: textDraft.text });
            recovered = true;
          }
        } else {
          clearTextDraft(assessmentId);
        }
      }
    } catch (error) {
      console.warn('[assessmentStore] text rehydrate failed (non-fatal):', error);
    }

    return recovered;
  },

  loadQuestions: async () => {
    const { studentId, assessmentId } = get();
    if (!studentId || !assessmentId) {
      set({ error: { message: 'Student ID or Assessment ID not set' } });
      return;
    }

    if (get().isLoading) return; // race guard against concurrent fetches
    set({ isLoading: true, error: null });

    try {
      const result: QuestionsResponse = await getQuestions(studentId, assessmentId);
      set({
        questions: result.questions,
        currentQuestionIndex: result.currentQuestionIndex,
        answerMode: result.answerMode,
        preparationTime: result.preparationTime ?? null,
        proctored: result.proctored ?? (result.answerMode === 'oral'),
        allowReview: result.allowReview ?? false,
        assessment: {
          id: assessmentId!,
          title: result.assessmentTitle || 'Assessment',
          course: result.assessmentCourse || '',
          description: result.assessmentDescription || '',
          dueDate: '',
          totalQuestions: result.questions.length,
          timeLimit: result.questions[0]?.timeLimit,
          status: 'open',
          answerMode: result.answerMode,
          preparationTime: result.preparationTime,
          proctored: result.proctored ?? (result.answerMode === 'oral'),
          allowReview: result.allowReview ?? false,
        },
        isLoading: false,
      });
    } catch (error) {
      set({ error: error as ApiError, isLoading: false });
    }
  },

  loadProgress: async () => {
    const { studentId, assessmentId, questions } = get();
    if (!studentId || !assessmentId) return;

    try {
      const progress = await getProgress(studentId, assessmentId);
      // Prefer server answered ids, unioned with the store's ids re-read after the await
      // so an answer recorded mid-fetch isn't un-marked. Older backends omit the field:
      // fall back to "first N questions are answered".
      const ids = progress.answeredQuestionIds
        ? new Set<string>([...progress.answeredQuestionIds, ...get().answeredQuestionIds])
        : new Set<string>(
            questions.slice(0, progress.answeredQuestions).map((q) => q.id)
          );
      set({ progress, answeredQuestionIds: ids });
    } catch (error) {
      console.error('Failed to load progress:', error);
    }
  },

  initializeRecorder: async () => {
    try {
      const recorder = new AudioRecorder();
      // Reuse the live proctoring mic track: a second capture throws NotReadableError on Safari/iOS.
      const { proctorAudioTrack, isProctoringActive } = get();
      const reuseTrack =
        isProctoringActive && proctorAudioTrack && proctorAudioTrack.readyState === 'live'
          ? proctorAudioTrack
          : undefined;
      await recorder.initialize(reuseTrack);
      set({ audioRecorder: recorder, error: null });
    } catch (error) {
      set({
        error: {
          message: error instanceof Error ? error.message : 'Failed to initialize recorder',
        },
      });
      throw error;
    }
  },

  startRecording: () => {
    const { audioRecorder } = get();
    if (!audioRecorder) {
      set({ error: { message: 'Recorder not initialized' } });
      return;
    }

    try {
      audioRecorder.start();
      set({
        isRecording: true,
        isPaused: false,
        recordingStartTime: Date.now(),
        recordedBlob: null,
        playbackUrl: null,
        error: null,
      });

      const interval = setInterval(() => {
        const { isRecording, isPaused, audioRecorder } = get();
        if (!isRecording || !audioRecorder) {
          clearInterval(interval);
          return;
        }
        // getDuration() keeps growing during a pause (startTime is corrected on resume),
        // so skip updates to stay in step with the frozen header QuestionTimer.
        if (isPaused) return;
        set({ recordingDuration: audioRecorder.getDuration() });
      }, 1000);
    } catch (error) {
      set({
        error: {
          message: error instanceof Error ? error.message : 'Failed to start recording',
        },
      });
    }
  },

  stopRecording: async () => {
    const { audioRecorder, isStopping } = get();
    if (!audioRecorder) return;

    // Dedupe manual Stop vs timer expiry: a second stop() rejects, recordedBlob stays null
    // and expiry would skip the question, losing the answer. handleTimerExpire also checks this.
    if (isStopping) return;
    set({ isStopping: true });

    try {
      const blob = await audioRecorder.stop();
      const duration = audioRecorder.getDuration();
      set({ isRecording: false, isPaused: false, recordedBlob: blob, recordingDuration: duration, isStopping: false });

      // Fire-and-forget persist so a refresh before upload can recover the answer.
      const { assessmentId, questions, currentQuestionIndex } = get();
      const questionId = questions[currentQuestionIndex]?.id;
      if (assessmentId && questionId) {
        void saveAudioDraft({ assessmentId, questionId, blob, durationSeconds: duration }).catch(() => {});
      }
    } catch (error) {
      set({
        error: {
          message: error instanceof Error ? error.message : 'Failed to stop recording',
        },
        isRecording: false,
        isStopping: false,
      });
    }
  },

  pauseRecording: () => {
    const { audioRecorder } = get();
    if (!audioRecorder) return;
    audioRecorder.pause();
    set({ isPaused: true });
  },

  resumeRecording: () => {
    const { audioRecorder } = get();
    if (!audioRecorder) return;
    audioRecorder.resume();
    set({ isPaused: false });
  },

  cancelRecording: () => {
    const { audioRecorder, assessmentId } = get();

    // No early return on a null recorder: a rehydrated draft can exist before (or without)
    // recorder init, and "Re-record" must still clear it.
    try {
      if (audioRecorder && audioRecorder.getState() !== 'inactive') audioRecorder.stop();
    } catch (error) {
      console.error('Error stopping recorder:', error);
    }

    set({
      isRecording: false,
      isPaused: false,
      recordedBlob: null,
      recordingDuration: 0,
      recordingStartTime: null,
      playbackUrl: null,
    });

    if (assessmentId) void clearAudioDraft(assessmentId);
  },

  playRecording: () => {
    const { recordedBlob, audioRecorder } = get();
    if (!recordedBlob || !audioRecorder) return;

    const url = audioRecorder.createAudioUrl(recordedBlob);
    const audio = new Audio(url);

    audio.onended = () => {
      set({ isPlaying: false });
      audioRecorder.releaseAudioUrl(url);
    };

    audio.play();
    set({ isPlaying: true, playbackUrl: url });
  },

  stopPlayback: () => {
    set({ isPlaying: false });
  },

  setConsentGiven: (given: boolean) => {
    set({ consentGiven: given });
  },

  setProctoringDegraded: (degraded: boolean) => {
    set({ proctoringDegraded: degraded });
  },

  // Local state + sessionStorage are the student-side source of truth (the app never reads
  // the server record). The server write is best-effort and must never block the student.
  recordConsentDecision: async (granted: boolean) => {
    const { assessmentId, studentId } = get();
    set({ consentGiven: true });
    if (assessmentId) sessionStorage.setItem(`consent_${assessmentId}`, 'true');

    if (!studentId || !assessmentId) return;
    try {
      await recordConsent(studentId, assessmentId, {
        granted,
        consentVersion: CONSENT_VERSION,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('[consent] failed to record consent server-side (non-blocking):', error);
      useToastStore.getState().addToast(
        'We could not record your consent with the server, but you can continue. Your decision is saved locally.',
        'warning'
      );
    }
  },

  startProctoring: async () => {
    const { studentId, assessmentId } = get();
    if (!studentId || !assessmentId) return;

    try {
      // Audio is included so the per-question AudioRecorder can reuse this track.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      const proctor = new ProctoringRecorder({
        studentId,
        assessmentId,
        onPermissionRevoked: () => {
          set({ cameraRevoked: true, isProctoringActive: false });
        },
        onChunkUploaded: (chunkIndex) => {
          console.debug(`[Proctoring] chunk ${chunkIndex} uploaded`);
          if (get().proctoringDegraded) set({ proctoringDegraded: false });
        },
        onError: (error) => {
          console.warn('[Proctoring] chunk upload error:', error.message);
          set({ proctoringDegraded: true });
        },
      });

      proctor.start(stream);
      const audioTrack = stream.getAudioTracks()[0] ?? null;
      set({
        proctorStream: stream,
        proctoring: proctor,
        proctorAudioTrack: audioTrack,
        isProctoringActive: true,
        cameraRevoked: false,
        proctoringRequested: true,
      });
    } catch (error) {
      console.warn('Failed to start proctoring:', error);
      // Non-blocking: the assessment continues, with a visible warning.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      set({
        proctoringWarning: `Camera/proctoring could not be started: ${msg}. The assessment will continue without proctoring.`,
      });
    }
  },

  // Idempotent re-arm for the resume flow after a mid-exam refresh.
  ensureProctoring: async () => {
    const { proctorStream } = get();
    const hasLiveVideo =
      !!proctorStream && proctorStream.getVideoTracks().some((t) => t.readyState === 'live');
    if (hasLiveVideo) return;
    await get().startProctoring();
  },

  stopProctoring: async () => {
    const { proctoring, proctorStream } = get();
    // Safe to call twice (submit + unmount): stop() no-ops when inactive and refs are nulled below.
    if (proctoring) {
      proctoring.stop();
      await proctoring.drain();
    }
    if (proctorStream) {
      proctorStream.getTracks().forEach((t) => t.stop());
    }
    set({
      proctoring: null,
      proctorStream: null,
      proctorAudioTrack: null,
      isProctoringActive: false,
    });
  },

  restoreProctoring: async () => {
    await get().stopProctoring();
    await get().startProctoring();
  },

  // Navigation is server-driven: advancing happens by re-fetching after submit.
  nextQuestion: () => {
    // No-op
  },

  previousQuestion: () => {
    // No-op: going back is not allowed
  },

  goToQuestion: (index: number) => {
    // Jumping is only allowed in review mode.
    const { allowReview, questions, currentQuestionIndex } = get();
    if (!allowReview) return;
    if (index < 0 || index >= questions.length || index === currentQuestionIndex) return;
    const target = questions[index];
    set({ currentQuestionIndex: index, textAnswer: target?.priorAnswer ?? '', error: null });
  },

  submitCurrentAnswer: async () => {
    const {
      studentId,
      assessmentId,
      recordedBlob,
      recordingDuration,
      questions,
      currentQuestionIndex,
    } = get();

    if (!studentId || !assessmentId || !recordedBlob) {
      set({ error: { message: 'No recording to submit' } });
      return;
    }

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) {
      set({ error: { message: 'Invalid question' } });
      return;
    }

    set({ isUploading: true, uploadProgress: 0, error: null });

    try {
      validateAudioBlob(recordedBlob);

      const audioUrl = await uploadAudio(
        recordedBlob,
        currentQuestion.id,
        (progress) => { set({ uploadProgress: progress.percentage }); }
      );

      await submitAnswer(studentId, currentQuestion.id, assessmentId, audioUrl, recordingDuration);

      // Blob is cleared only after success so a failure can retry without re-recording.
      const newAnsweredIds = new Set(get().answeredQuestionIds);
      newAnsweredIds.add(currentQuestion.id);
      // recordingStartTime reset keeps the next question's header timer anchored to its own start.
      set({ isUploading: false, uploadProgress: 0, recordedBlob: null, recordingDuration: 0, recordingStartTime: null, playbackUrl: null, answeredQuestionIds: newAnsweredIds });

      void clearAudioDraft(assessmentId);

      // Server has advanced currentQuestionIdx; re-fetch to get the next question.
      await get().loadQuestions();
      await get().loadProgress();
    } catch (error) {
      set({ error: error as ApiError, isUploading: false, uploadProgress: 0, lastFailedAction: 'submitCurrentAnswer' });
    }
  },

  submitCurrentTextAnswer: async () => {
    const {
      studentId,
      assessmentId,
      textAnswer,
      questions,
      currentQuestionIndex,
    } = get();

    if (!studentId || !assessmentId || !textAnswer.trim()) {
      set({ error: { message: 'No text answer to submit' } });
      return;
    }

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) {
      set({ error: { message: 'Invalid question' } });
      return;
    }

    set({ isUploading: true, error: null });

    try {
      const submitted = textAnswer.trim();
      await submitTextAnswer(studentId, currentQuestion.id, assessmentId, submitted);

      const newAnsweredIds = new Set(get().answeredQuestionIds);
      newAnsweredIds.add(currentQuestion.id);

      if (get().allowReview) {
        // Review mode: stay on the question (don't jump to the server frontier) and
        // mirror the saved text into priorAnswer so navigating back pre-fills it.
        const newSkipped = new Set(get().skippedQuestionIds);
        newSkipped.delete(currentQuestion.id);
        const updatedQuestions = get().questions.map((q) =>
          q.id === currentQuestion.id ? { ...q, priorAnswer: submitted } : q
        );
        set({
          isUploading: false,
          answeredQuestionIds: newAnsweredIds,
          skippedQuestionIds: newSkipped,
          questions: updatedQuestions,
        });
        clearTextDraft(assessmentId);
        await get().loadProgress();
        return;
      }

      set({ isUploading: false, textAnswer: '', answeredQuestionIds: newAnsweredIds });

      clearTextDraft(assessmentId);

      await get().loadQuestions();
      await get().loadProgress();
    } catch (error) {
      set({ error: error as ApiError, isUploading: false, lastFailedAction: 'submitCurrentTextAnswer' });
    }
  },

  // Records an explicit non-answer on expiry. `mode` picks the fallback marker if the
  // backend rejects answer_type 'skipped'.
  skipCurrentQuestion: async (mode: 'oral' | 'written' = get().answerMode) => {
    const { studentId, assessmentId, questions, currentQuestionIndex } = get();
    if (!studentId || !assessmentId) return;

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) return;

    const advance = async () => {
      const newSkippedIds = new Set(get().skippedQuestionIds);
      newSkippedIds.add(currentQuestion.id);
      set({ isUploading: false, skippedQuestionIds: newSkippedIds, textAnswer: '' });
      clearTextDraft(assessmentId);
      void clearAudioDraft(assessmentId);
      await get().loadQuestions();
      await get().loadProgress();
    };

    set({ isUploading: true, error: null });
    try {
      await submitSkip(studentId, currentQuestion.id, assessmentId, mode);
      await advance();
    } catch (error) {
      const apiErr = error as ApiError;
      // Backends without 'skipped' support reject with 400/422: fall back to a text
      // marker so the server still advances. Anything else is a real error.
      const unsupportedType = apiErr?.status === 400 || apiErr?.status === 422;
      if (!unsupportedType) {
        set({ error: apiErr, isUploading: false });
        return;
      }
      // Oral uses a machine-detectable sentinel; '(time expired)' reads like a written answer.
      const marker = mode === 'oral' ? NO_ORAL_ANSWER_SENTINEL : TIME_EXPIRED_SENTINEL;
      console.warn(
        `[skip] backend rejected answer_type:'skipped' (status ${apiErr?.status}); ` +
        `falling back to text marker "${marker}" for ${mode} mode. ` +
        `Backend should implement the 'skipped' contract (see submitSkip in api.ts).`
      );
      try {
        await submitTextAnswer(studentId, currentQuestion.id, assessmentId, marker);
        await advance();
      } catch (fallbackError) {
        set({ error: fallbackError as ApiError, isUploading: false });
      }
    }
  },

  submitCompleteAssessment: async (): Promise<boolean> => {
    const { studentId, assessmentId } = get();
    if (!studentId || !assessmentId) return false;

    set({ isLoading: true, error: null });

    try {
      await submitAssessment(studentId, assessmentId);
      await get().loadProgress();
      await get().stopProctoring();
      set({ isLoading: false });
      return true;
    } catch (err) {
      const apiErr = err as ApiError;
      // "already submitted" is idempotent success.
      if (apiErr?.message?.toLowerCase().includes('already submitted')) {
        await get().loadProgress();
        set({ isLoading: false, error: null });
        return true;
      }
      set({ error: apiErr, isLoading: false });
      return false;
    }
  },

  // `background: true` (auto-poll) leaves isLoading alone so the spinner doesn't flicker,
  // and increments resultsPollCount.
  loadResults: async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    const { studentId, assessmentId } = get();
    if (!studentId || !assessmentId) return;

    if (background) {
      set({ resultsPollCount: get().resultsPollCount + 1 });
    } else {
      set({ isLoading: true, error: null });
    }

    try {
      const results = await getResults(studentId, assessmentId);
      // "Still evaluating" is a 202 with only `detail`; axios resolves it here, so the
      // status===202 check in isResultsPendingError never fires. Treat as pending.
      if (!results || !Array.isArray(results.questions)) {
        set({
          isResultsReady: false,
          isResultsPending: true,
          error: null,
          ...(background ? {} : { isLoading: false }),
        });
        return;
      }
      set({
        results,
        isResultsReady: true,
        isResultsPending: false,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      const apiErr = error as ApiError;
      set({
        error: apiErr,
        isResultsReady: false,
        isResultsPending: isResultsStillPending(apiErr),
        ...(background ? {} : { isLoading: false }),
      });
    }
  },

  setResultsPollExhausted: (exhausted: boolean) => {
    set({ resultsPollExhausted: exhausted });
  },

  // Manual "Check again": re-arms the auto-poll loop.
  resetResultsPolling: () => {
    set({ resultsPollCount: 0, resultsPollExhausted: false, error: null });
  },

  clearError: () => {
    set({ error: null, lastFailedAction: null });
  },

  clearProctoringWarning: () => {
    set({ proctoringWarning: null });
  },

  retryLastAction: async () => {
    const { lastFailedAction } = get();
    set({ error: null, lastFailedAction: null });
    if (lastFailedAction === 'submitCurrentAnswer') {
      await get().submitCurrentAnswer();
    } else if (lastFailedAction === 'submitCurrentTextAnswer') {
      await get().submitCurrentTextAnswer();
    }
  },

  reset: () => {
    const { audioRecorder, proctoring, proctorStream, assessmentId } = get();
    if (audioRecorder) audioRecorder.cleanup();
    if (proctoring) { proctoring.stop(); }
    if (proctorStream) proctorStream.getTracks().forEach((t) => t.stop());

    if (assessmentId) {
      clearTextDraft(assessmentId);
      void clearAudioDraft(assessmentId);
    }

    set({
      studentId: null,
      assessmentId: null,
      assessment: null,
      questions: [],
      currentQuestionIndex: 0,
      progress: null,
      isRecording: false,
      isStopping: false,
      isPaused: false,
      recordingDuration: 0,
      recordedBlob: null,
      recordingStartTime: null,
      audioRecorder: null,
      isPlaying: false,
      playbackUrl: null,
      isUploading: false,
      uploadProgress: 0,
      answerMode: 'oral' as 'oral' | 'written',
      preparationTime: null,
      proctored: true,
      allowReview: false,
      textAnswer: '',
      proctorStream: null,
      proctoring: null,
      isProctoringActive: false,
      cameraRevoked: false,
      consentGiven: false,
      proctoringRequested: false,
      proctoringDegraded: false,
      proctorAudioTrack: null,
      results: null,
      isResultsReady: false,
      isResultsPending: false,
      resultsPollCount: 0,
      resultsPollExhausted: false,
      answeredQuestionIds: new Set<string>(),
      skippedQuestionIds: new Set<string>(),
      proctoringWarning: null,
      lastFailedAction: null,
      isLoading: false,
      error: null,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    });
  },
}));

export default useAssessmentStore;
