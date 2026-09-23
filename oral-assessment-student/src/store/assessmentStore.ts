/**
 * Zustand Store - Global state management for student assessment
 */

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
import { isResultsStillPending } from '../utils/resultHelpers';

interface AssessmentStore {
  // Student info
  studentId: string | null;
  assessmentId: string | null;
  assessment: Assessment | null;

  // Questions
  questions: Question[];
  currentQuestionIndex: number;

  // Progress
  progress: Progress | null;

  // Recording state (audio)
  isRecording: boolean;
  isStopping: boolean; // a stop() is in flight — dedupes manual-Stop vs timer-expiry race
  isPaused: boolean;
  recordingDuration: number;
  recordedBlob: Blob | null;
  recordingStartTime: number | null;
  audioRecorder: AudioRecorder | null;

  // Playback (audio)
  isPlaying: boolean;
  playbackUrl: string | null;

  // Upload state
  isUploading: boolean;
  uploadProgress: number;

  // Answer mode — set by instructor, not student
  answerMode: 'oral' | 'written';
  preparationTime: number | null; // seconds of prep time for oral mode (null = no prep phase)
  // Behaviour flags — set by instructor. proctored defaults true until questions load
  // (the consent modal only renders once questions are present, so there is no flash).
  proctored: boolean;
  allowReview: boolean;
  textAnswer: string;

  // Proctoring state
  proctorStream: MediaStream | null;
  proctoring: ProctoringRecorder | null;
  isProctoringActive: boolean;
  cameraRevoked: boolean;
  consentGiven: boolean;
  // "This session is SUPPOSED to be proctored", distinct from proctorStream /
  // isProctoringActive (which reflect a live stream actually existing right now).
  // Set true on a successful startProctoring; lets the resume flow detect that a
  // refresh dropped the live stream and re-arm (or block) instead of silently
  // continuing un-proctored.
  proctoringRequested: boolean;
  // Non-blocking signal that proctoring chunk uploads are failing (post-retry).
  // Distinct from cameraRevoked, which is a BLOCKING full-screen overlay. Drives
  // a yellow "retrying upload" banner only.
  proctoringDegraded: boolean;
  // The proctoring stream's audio track, kept so the per-question AudioRecorder
  // can reuse it instead of opening a second getUserMedia (Safari/iOS mic clash).
  proctorAudioTrack: MediaStreamTrack | null;

  // Results
  results: Results | null;
  isResultsReady: boolean;
  // Grading still in progress (drives the "Evaluating Your Assessment" panel)
  isResultsPending: boolean;
  // Number of background polls performed (the foreground/initial fetch is not counted)
  resultsPollCount: number;
  // True once the polling cap is reached — UI shows a manual "Check again" instead
  resultsPollExhausted: boolean;

  // Per-question answered tracking
  answeredQuestionIds: Set<string>;
  // Questions resolved by a skip (time expired with nothing to submit). Tracked
  // separately from answeredQuestionIds so the UI can render them distinctly —
  // a skip is NOT an answer and must never show the green "answered" check.
  skippedQuestionIds: Set<string>;

  // Proctoring warning (non-blocking)
  proctoringWarning: string | null;

  // Last failed action (for retry)
  lastFailedAction: string | null;

  // Loading and error states
  isLoading: boolean;
  error: ApiError | null;

  // Network connectivity — driven by navigator.onLine + online/offline events.
  isOnline: boolean;

  // Actions
  setStudentInfo: (studentId: string, assessmentId: string) => void;
  // Register window online/offline listeners that mirror connectivity into
  // `isOnline`. Returns a cleanup fn that removes them (call on unmount).
  initNetworkListeners: () => () => void;
  loadQuestions: () => Promise<void>;
  loadProgress: () => Promise<void>;
  setAnswerMode: (mode: 'oral' | 'written') => void;
  setTextAnswer: (text: string) => void;
  // Restore an in-flight answer (audio blob and/or typed text) persisted by a
  // prior session after a refresh/crash. Returns true if anything was recovered
  // (so the caller can surface a recovery toast). Never throws.
  rehydrateDraft: () => Promise<boolean>;

  // Recording actions (audio)
  initializeRecorder: () => Promise<void>;
  startRecording: () => void;
  stopRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  cancelRecording: () => void;

  // Playback actions (audio)
  playRecording: () => void;
  stopPlayback: () => void;

  // Proctoring actions
  startProctoring: () => Promise<void>;
  // Idempotent re-arm: no-op if a live proctoring video stream already exists,
  // otherwise (re)acquires it. Used by the resume flow after a refresh.
  ensureProctoring: () => Promise<void>;
  stopProctoring: () => Promise<void>;
  restoreProctoring: () => Promise<void>;
  setConsentGiven: (given: boolean) => void;
  setProctoringDegraded: (degraded: boolean) => void;
  // Record a consent decision: sets local consentGiven + persists sessionStorage,
  // then best-effort POSTs the server record (never blocks, never throws).
  recordConsentDecision: (granted: boolean) => Promise<void>;

  // Navigation
  nextQuestion: () => void;
  previousQuestion: () => void;
  goToQuestion: (index: number) => void;

  // Submission
  submitCurrentAnswer: () => Promise<void>;
  submitCurrentTextAnswer: () => Promise<void>;
  skipCurrentQuestion: (mode?: 'oral' | 'written') => Promise<void>;
  submitCompleteAssessment: () => Promise<boolean>;

  // Results
  loadResults: (options?: { background?: boolean }) => Promise<void>;
  setResultsPollExhausted: (exhausted: boolean) => void;
  resetResultsPolling: () => void;

  // Utility
  clearError: () => void;
  clearProctoringWarning: () => void;
  retryLastAction: () => Promise<void>;
  reset: () => void;
}

export const useAssessmentStore = create<AssessmentStore>((set, get) => ({
  // Initial state
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
    // Same store as the session token (localStorage), so identity survives a
    // refresh or a new tab.
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
    // Sync once on registration in case connectivity changed before mount.
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
    // Persist the draft so a refresh/crash can recover it. Only persist a
    // NON-empty answer: this action is also called with '' by the per-question
    // reset effect on mount/question-change, and persisting that empty value
    // would clobber a still-good draft before rehydrate can read it. Explicit
    // clearing happens on confirmed submit / skip / cancel / reset instead.
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

    // ── Audio draft (IndexedDB) ──
    try {
      const draft = await loadAudioDraft(assessmentId);
      if (draft) {
        // Re-read the LIVE current question after the async load — the index may
        // have advanced during the IndexedDB read, so matching against a stale
        // pre-await snapshot could leak an old draft onto a new question.
        const liveQuestion = get().questions[get().currentQuestionIndex];
        if (liveQuestion && draft.questionId === liveQuestion.id) {
          // Only restore when there is no fresh recording in memory — a draft
          // must NEVER clobber a recording the student just made this session.
          if (get().recordedBlob === null) {
            set({ recordedBlob: draft.blob, recordingDuration: draft.durationSeconds });
            recovered = true;
          }
        } else {
          // Stale: the server has advanced past the question this draft belongs
          // to. Discard it so it can't trigger a phantom recovery on this one.
          await clearAudioDraft(assessmentId);
        }
      }
    } catch (error) {
      console.warn('[assessmentStore] audio rehydrate failed (non-fatal):', error);
    }

    // ── Text draft (sessionStorage) ──
    try {
      const textDraft = loadTextDraft(assessmentId);
      if (textDraft) {
        // Re-read the live current question here too (the audio load above was
        // async), for the same stale-snapshot reason.
        const liveQuestion = get().questions[get().currentQuestionIndex];
        if (liveQuestion && textDraft.questionId === liveQuestion.id) {
          // Only restore into an EMPTY field so we never overwrite something the
          // student has already typed this session.
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

  // Load questions from backend
  loadQuestions: async () => {
    const { studentId, assessmentId } = get();
    if (!studentId || !assessmentId) {
      set({ error: { message: 'Student ID or Assessment ID not set' } });
      return;
    }

    if (get().isLoading) return; // prevent concurrent fetches (race guard)
    set({ isLoading: true, error: null });

    try {
      const result: QuestionsResponse = await getQuestions(studentId, assessmentId);
      set({
        questions: result.questions,
        currentQuestionIndex: result.currentQuestionIndex,
        answerMode: result.answerMode,
        preparationTime: result.preparationTime ?? null,
        // proctored falls back to (answerMode === 'oral') if the backend omits it.
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

  // Load progress
  loadProgress: async () => {
    const { studentId, assessmentId, questions } = get();
    if (!studentId || !assessmentId) return;

    try {
      const progress = await getProgress(studentId, assessmentId);
      // Prefer the server's authoritative answered-id list when it ships: gate
      // Next/Submit on real answer IDENTITY, not array position. Union it with
      // the ids tracked in the store RIGHT NOW — re-read after the await, not a
      // stale pre-await snapshot — so an answer recorded while this fetch was in
      // flight isn't briefly un-marked by the progress read.
      //
      // When the field is absent (today's backend), fall back to the legacy
      // "first N questions by current array order are answered" heuristic so
      // behavior against the current backend is unchanged.
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

  // ─── Audio recording ───────────────────────────────────────────

  initializeRecorder: async () => {
    try {
      const recorder = new AudioRecorder();
      // Reuse the proctoring audio track when proctoring is active so we don't
      // open a second concurrent mic capture (the Safari/iOS NotReadableError).
      // The track is only passed when still live; otherwise fall back to no-arg
      // getUserMedia. When not proctoring, proctorAudioTrack is null → no arg.
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
        // Freeze the clock while paused so the recorder's remaining-time display
        // stays equal to the (also-frozen) header QuestionTimer. getDuration() keeps
        // growing on wall-clock during a pause (startTime is only corrected on
        // resume), so we must skip the update rather than read it here.
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

    // Dedupe concurrent stops (manual Stop button racing the timer-expiry handler).
    // Without this the second caller hits audioRecorder.stop() in the 'inactive'
    // state, which rejects; recordedBlob stays null and the expiry path would then
    // SKIP the question — permanently losing a recorded answer on a forward-only flow.
    // isStopping is also folded into handleTimerExpire's re-entrancy guard so the
    // expiry handler never independently stops + skips while a manual stop is underway.
    if (isStopping) return;
    set({ isStopping: true });

    try {
      const blob = await audioRecorder.stop();
      const duration = audioRecorder.getDuration();
      set({ isRecording: false, isPaused: false, recordedBlob: blob, recordingDuration: duration, isStopping: false });

      // Durably persist the captured answer so a refresh/crash before upload can
      // recover it (forward-only flow has no other recovery path). Fire-and-forget:
      // never block the UI state update above, and never let a persistence failure
      // throw out of stopRecording — draftStore already swallows its own errors,
      // the extra .catch is belt-and-braces.
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

    // Stop the live recorder if one is active. This is deliberately NOT an early
    // return on a missing recorder: after a refresh, rehydrateDraft can restore
    // recordedBlob from IndexedDB while audioRecorder is still null (its async
    // init/getUserMedia is pending, or the mic was denied), yet AudioRecorder
    // renders "Re-record" purely from recordedBlob — so discarding must clear the
    // state + draft even when there is no recorder to stop.
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

    // The student explicitly discarded this take — drop the persisted draft so a
    // later refresh can't resurrect it.
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

  // ─── Proctoring ────────────────────────────────────────────────

  setConsentGiven: (given: boolean) => {
    set({ consentGiven: given });
  },

  setProctoringDegraded: (degraded: boolean) => {
    set({ proctoringDegraded: degraded });
  },

  // Record the student's consent/decline decision. Local state + the existing
  // sessionStorage key are the INTERIM source of truth (the server read endpoint
  // is out of scope — see recordConsent in api.ts). The server WRITE is
  // best-effort: a failure must never block the student, only a non-blocking toast.
  recordConsentDecision: async (granted: boolean) => {
    const { assessmentId, studentId } = get();
    // Local + sessionStorage first so the UI proceeds regardless of the network.
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
      // Degrade gracefully — never block the student on a consent-record failure.
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
      // Request a combined video+audio stream.
      // This stream is shared with the VideoRecorder when the student uses video
      // answer mode, avoiding a second getUserMedia call and the potential
      // NotReadableError on devices that don't allow two concurrent camera streams.
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
          // A genuine success clears the non-blocking degraded indicator.
          if (get().proctoringDegraded) set({ proctoringDegraded: false });
        },
        onError: (error) => {
          console.warn('[Proctoring] chunk upload error:', error.message);
          // Post-retry failure — surface the non-blocking degraded banner.
          set({ proctoringDegraded: true });
        },
      });

      proctor.start(stream);
      // Save the audio track so the per-question AudioRecorder can reuse it.
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
      // Non-blocking — assessment can still proceed if camera request fails here
      // Surface a visible warning so the student knows proctoring is inactive
      const msg = error instanceof Error ? error.message : 'Unknown error';
      set({
        proctoringWarning: `Camera/proctoring could not be started: ${msg}. The assessment will continue without proctoring.`,
      });
    }
  },

  // Idempotent: if a live proctoring video track already exists, no-op. Otherwise
  // (re)acquire the stream via startProctoring. Used by the resume flow so a
  // mid-exam refresh re-arms the camera instead of continuing un-proctored.
  ensureProctoring: async () => {
    const { proctorStream } = get();
    const hasLiveVideo =
      !!proctorStream && proctorStream.getVideoTracks().some((t) => t.readyState === 'live');
    if (hasLiveVideo) return; // already proctoring
    await get().startProctoring();
  },

  stopProctoring: async () => {
    const { proctoring, proctorStream } = get();
    // Guard against a double-stop (e.g. submit + unmount cleanup both firing):
    // ProctoringRecorder.stop() already no-ops when inactive, and we null the
    // refs below so a second call sees nothing to stop — no double-stop errors.
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

  // ─── Navigation (server-driven — no client-side jumping) ────────

  nextQuestion: () => {
    // No-op: advancement is handled by re-fetching after submit
  },

  previousQuestion: () => {
    // No-op: going back is not allowed
  },

  goToQuestion: (index: number) => {
    // Client-side jumping is only allowed in review mode (allowReview). In the strict
    // flow this stays a no-op so sequential, server-driven navigation is unchanged.
    const { allowReview, questions, currentQuestionIndex } = get();
    if (!allowReview) return;
    if (index < 0 || index >= questions.length || index === currentQuestionIndex) return;
    const target = questions[index];
    // Pre-fill the editor with the prior answer for the question we're landing on.
    set({ currentQuestionIndex: index, textAnswer: target?.priorAnswer ?? '', error: null });
  },

  // ─── Submission ────────────────────────────────────────────────

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

      // Only clear blob AFTER successful submission (preserves blob for retry on failure)
      const newAnsweredIds = new Set(get().answeredQuestionIds);
      newAnsweredIds.add(currentQuestion.id);
      // Reset recordingStartTime too so the next question's header timer stays
      // anchored to its OWN recording start (see QuestionTimer wiring in TakeAssessment).
      set({ isUploading: false, uploadProgress: 0, recordedBlob: null, recordingDuration: 0, recordingStartTime: null, playbackUrl: null, answeredQuestionIds: newAnsweredIds });

      // Upload confirmed — drop the durable draft so it can't resurface as a
      // phantom recovery on the next question. Only AFTER success (a failed
      // upload keeps recordedBlob + draft intact for retryLastAction).
      void clearAudioDraft(assessmentId);

      // Re-fetch: server has advanced currentQuestionIdx, next question content is now available
      await get().loadQuestions();
      await get().loadProgress();
    } catch (error) {
      // Keep recordedBlob intact so student can retry without re-recording
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
        // Review mode: saving an answer must NOT advance or yank the student to the
        // server frontier. Stay on the question, reflect the saved text locally (so
        // navigating away and back pre-fills correctly), and clear any skip marker.
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

      // Submit confirmed — drop the durable text draft so it can't resurface on
      // the next question.
      clearTextDraft(assessmentId);

      // Re-fetch: server has advanced currentQuestionIdx
      await get().loadQuestions();
      await get().loadProgress();
    } catch (error) {
      set({ error: error as ApiError, isUploading: false, lastFailedAction: 'submitCurrentTextAnswer' });
    }
  },

  // Record an explicit non-answer when a question expires with nothing to submit.
  // `mode` controls how we degrade if the backend rejects the new 'skipped' contract:
  // oral falls back to a machine-detectable sentinel, written keeps the legacy marker.
  skipCurrentQuestion: async (mode: 'oral' | 'written' = get().answerMode) => {
    const { studentId, assessmentId, questions, currentQuestionIndex } = get();
    if (!studentId || !assessmentId) return;

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) return;

    const advance = async () => {
      // A skip is NOT an answer: record it in skippedQuestionIds (so the
      // ProgressTracker renders it distinctly, never as a green check) and
      // clear any stale draft so it can't leak into the next written question.
      const newSkippedIds = new Set(get().skippedQuestionIds);
      newSkippedIds.add(currentQuestion.id);
      set({ isUploading: false, skippedQuestionIds: newSkippedIds, textAnswer: '' });
      // Drop both durable drafts for this assessment — the question is resolved
      // with no answer, so neither a typed nor a recorded draft should survive.
      clearTextDraft(assessmentId);
      void clearAudioDraft(assessmentId);
      await get().loadQuestions();
      await get().loadProgress();
    };

    set({ isUploading: true, error: null });
    try {
      // Preferred path: an explicit 'skipped' answer so an oral question is NEVER
      // recorded as a substantive text response (see submitSkip contract in api.ts).
      await submitSkip(studentId, currentQuestion.id, assessmentId, mode);
      await advance();
    } catch (error) {
      const apiErr = error as ApiError;
      // The backend may not support answer_type:'skipped' yet and reject it with
      // 400/422. Degrade gracefully so the server still advances — but with a marker
      // an evaluator can never mistake for a real answer.
      const unsupportedType = apiErr?.status === 400 || apiErr?.status === 422;
      if (!unsupportedType) {
        // Auth/network/not-found etc. — surface it, don't paper over with a fake answer.
        set({ error: apiErr, isUploading: false });
        return;
      }
      // Oral: an unambiguous, machine-detectable "no oral answer" sentinel
      // (NOT '(time expired)', which reads like a written response).
      // Written: preserve the historical '(time expired)' marker.
      const marker = mode === 'oral' ? '[NO_ORAL_ANSWER]' : '(time expired)';
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
      // "already submitted" is idempotent success — treat as OK
      if (apiErr?.message?.toLowerCase().includes('already submitted')) {
        await get().loadProgress();
        set({ isLoading: false, error: null });
        return true;
      }
      set({ error: apiErr, isLoading: false });
      return false;
    }
  },

  // Load results.
  //
  // `background: true` is used by the auto-poll loop: it does NOT touch the
  // global `isLoading` flag (so the full-screen spinner never flickers between
  // polls) and increments `resultsPollCount`. The initial/foreground load keeps
  // the original behavior (spinner on, error cleared).
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
      // A 2xx is not automatically a results payload: "still evaluating" comes
      // back as a 202 whose body carries only a `detail` message, and axios
      // resolves every 2xx into this branch (which is why the status===202 arm
      // of isResultsPendingError never fires). Rendering that body would crash
      // ViewResults on results.questions, so treat it as pending and let the
      // poll loop keep going.
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
        // "Still pending" (not released / being evaluated) is not a hard error.
        isResultsPending: isResultsStillPending(apiErr),
        // Leave isLoading untouched on background polls; clear it on foreground.
        ...(background ? {} : { isLoading: false }),
      });
    }
  },

  setResultsPollExhausted: (exhausted: boolean) => {
    set({ resultsPollExhausted: exhausted });
  },

  // Reset the poll counters and clear any pending error so a manual "Check again"
  // starts a fresh foreground attempt and re-arms the auto-poll loop.
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

    // Drop any durable drafts for this assessment before we lose its id below.
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
      // Keep connectivity reflecting reality across a reset — don't force `true`.
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    });
  },
}));

export default useAssessmentStore;
