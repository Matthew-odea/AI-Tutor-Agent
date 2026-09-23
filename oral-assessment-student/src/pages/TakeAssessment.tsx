import { useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { useAssessmentStore } from '../store/assessmentStore';
import QuestionDisplay from '../components/QuestionDisplay';
import ProgressTracker from '../components/ProgressTracker';
import AudioRecorder from '../components/AudioRecorder';
import TextAnswerInput from '../components/TextAnswerInput';
import QuestionTimer from '../components/QuestionTimer';
import ConsentModal from '../components/ConsentModal';
import PreAssessmentOverview from '../components/PreAssessmentOverview';
import HelpButton from '../components/HelpButton';
import DeviceCheck from '../components/DeviceCheck';
import ProctorCamera from '../components/ProctorCamera';
import CameraRevokedOverlay from '../components/CameraRevokedOverlay';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import {
  parseUrlParams,
  checkBrowserSupport,
  declinedConsentKey,
  hasDeclinedConsent,
} from '../utils/helpers';
import { runTimerExpiry } from '../utils/timerExpiry';
import { deferSubmitWhileOffline } from '../utils/offlineDefer';
import { estimateRemainingMinutes } from '../utils/timeEstimate';
import { useToastStore } from '../store/toastStore';

export default function TakeAssessment() {
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [isRestoringCamera, setIsRestoringCamera] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(() => {
    const { supported, missing } = checkBrowserSupport();
    return supported
      ? null
      : `Your browser is missing required features: ${missing.join(', ')}. ` +
        'Please use a modern browser like Chrome, Firefox, or Safari.';
  });
  const [assessmentStarted, setAssessmentStartedRaw] = useState(false);
  // Pre-flight gates, persisted to sessionStorage so a refresh never re-shows them.
  const [overviewConfirmed, setOverviewConfirmedRaw] = useState(false);
  const [deviceCheckPassed, setDeviceCheckPassedRaw] = useState(false);
  const [prepSecondsLeft, setPrepSecondsLeft] = useState<number | null>(null);
  const [prepDone, setPrepDone] = useState(false);
  const prepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rehydrateAttemptedRef = useRef(false);
  // One-shot `online` listener registered when the timer expires offline.
  const deferredSubmitRef = useRef<(() => void) | null>(null);

  const setAssessmentStarted = (v: boolean) => {
    setAssessmentStartedRaw(v);
    if (v && assessmentId) sessionStorage.setItem(`started_${assessmentId}`, 'true');
  };

  const setDeviceCheckPassed = (v: boolean) => {
    setDeviceCheckPassedRaw(v);
    if (v && assessmentId) sessionStorage.setItem(`devicecheck_${assessmentId}`, 'true');
  };

  const {
    studentId,
    assessmentId,
    assessment,
    questions,
    currentQuestionIndex,
    progress,
    isLoading,
    isUploading,
    error,
    answerMode,
    preparationTime,
    proctored,
    allowReview,
    textAnswer,
    isRecording,
    isPaused,
    recordingStartTime,
    proctorStream,
    isProctoringActive,
    cameraRevoked,
    consentGiven,
    proctoringRequested,
    proctoringDegraded,
    answeredQuestionIds,
    skippedQuestionIds,
    proctoringWarning,
    lastFailedAction,
    setStudentInfo,
    loadQuestions,
    loadProgress,
    goToQuestion,
    submitCurrentAnswer,
    submitCurrentTextAnswer,
    skipCurrentQuestion,
    submitCompleteAssessment,
    setTextAnswer,
    rehydrateDraft,
    recordConsentDecision,
    startProctoring,
    ensureProctoring,
    restoreProctoring,
    setConsentGiven,
    clearError,
    clearProctoringWarning,
    retryLastAction,
  } = useAssessmentStore();

  // consentGiven is true for both accept and decline, so decline is tracked separately.
  // Lazy-init from sessionStorage so a refresh restores it before the resume re-arm effect runs.
  const [proctoringDeclined, setProctoringDeclined] = useState<boolean>(() =>
    hasDeclinedConsent(parseUrlParams(window.location.pathname)?.assessmentId)
  );
  // Silent resume re-arm was rejected (getUserMedia needs a gesture); blocks until re-granted.
  const [resumeRegrantNeeded, setResumeRegrantNeeded] = useState(false);
  const resumeArmAttemptedRef = useRef(false);

  useEffect(() => {
    const urlParams = parseUrlParams(window.location.pathname);
    if (urlParams) {
      setStudentInfo(urlParams.studentId, urlParams.assessmentId);
    }
  }, [setStudentInfo]);

  useEffect(() => {
    if (studentId && assessmentId && questions.length === 0) {
      loadQuestions();
      loadProgress();
    }
  }, [studentId, assessmentId, questions.length, loadQuestions, loadProgress]);

  // Chromium needs returnValue set (not just preventDefault) to show the "Leave site?" dialog.
  useEffect(() => {
    if (!assessmentStarted) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [assessmentStarted]);

  // Restore pre-flight gate state from server + sessionStorage on refresh.
  useEffect(() => {
    if (questions.length === 0) return;
    if (!assessmentId) return;

    const serverInProgress = currentQuestionIndex > 0;
    const hasAnswered = answeredQuestionIds.size > 0 || (progress?.answeredQuestions ?? 0) > 0;
    const sessionConsent = sessionStorage.getItem(`consent_${assessmentId}`) === 'true';
    const sessionStarted = sessionStorage.getItem(`started_${assessmentId}`) === 'true';
    const sessionDeviceCheck = sessionStorage.getItem(`devicecheck_${assessmentId}`) === 'true';

    // Intentional one-shot restore from external persistence, not a render loop.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (serverInProgress || hasAnswered) {
      if (!consentGiven) setConsentGiven(true);
      setOverviewConfirmedRaw(true);
      setDeviceCheckPassedRaw(true);
      if (!assessmentStarted) setAssessmentStarted(true);
    } else {
      // On Q1 with nothing answered: fall back to sessionStorage.
      if (sessionConsent && !consentGiven) {
        setConsentGiven(true);
      }
      if (sessionStarted) {
        setOverviewConfirmedRaw(true);
        setDeviceCheckPassedRaw(true);
        if (!assessmentStarted) setAssessmentStartedRaw(true);
      } else if (sessionDeviceCheck) {
        setOverviewConfirmedRaw(true);
        setDeviceCheckPassedRaw(true);
      }
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [questions.length, currentQuestionIndex, assessmentId, answeredQuestionIds.size, progress]);

  // Resume re-arm: a refresh drops the proctoring stream, and a proctored session must
  // not silently continue un-proctored. Try a silent ensureProctoring once; if the browser
  // rejects it without a gesture, show the blocking re-grant overlay.
  useEffect(() => {
    if (questions.length === 0 || !assessmentId) return;
    if (resumeArmAttemptedRef.current) return;
    if (!proctored) return;
    const declined = proctoringDeclined || hasDeclinedConsent(assessmentId);
    if (!consentGiven || declined) return; // declined runs un-proctored, no block

    const serverInProgress = currentQuestionIndex > 0;
    const hasAnswered =
      answeredQuestionIds.size > 0 || (progress?.answeredQuestions ?? 0) > 0;
    const inProgress = serverInProgress || hasAnswered;
    if (!inProgress) return; // fresh start is handled by the consent flow

    if (answerMode !== 'oral') return;

    const hasLiveVideo =
      !!proctorStream && proctorStream.getVideoTracks().some((t) => t.readyState === 'live');
    if (hasLiveVideo) return;

    resumeArmAttemptedRef.current = true;
    (async () => {
      await ensureProctoring();
      // ensureProctoring swallows getUserMedia failures, so check for a live stream.
      const s = useAssessmentStore.getState();
      const live =
        !!s.proctorStream && s.proctorStream.getVideoTracks().some((t) => t.readyState === 'live');
      if (!live) setResumeRegrantNeeded(true);
    })();
  }, [
    questions.length,
    assessmentId,
    consentGiven,
    proctored,
    proctoringDeclined,
    currentQuestionIndex,
    answeredQuestionIds.size,
    progress,
    answerMode,
    proctorStream,
    ensureProctoring,
  ]);

  // Release media on unmount and pagehide (preferred over `unload` on mobile Safari).
  useEffect(() => {
    const releaseMedia = () => {
      const s = useAssessmentStore.getState();
      void s.stopProctoring();
      s.audioRecorder?.cleanup();
    };
    const handlePageHide = () => releaseMedia();
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      releaseMedia();
    };
  }, []);

  // Block the browser back button: a dummy history entry turns Back into a popstate.
  useEffect(() => {
    if (!assessmentStarted) return;
    window.history.pushState(null, '', window.location.href);
    const handlePopState = () => {
      window.history.pushState(null, '', window.location.href);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [assessmentStarted]);

  // Intentional synchronous per-question reset, keyed to the question index.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setPrepDone(false);
    setIsSubmittingAnswer(false);
    clearError();
    // Covers every advance path (submit, skip, server-driven index change) so text never leaks.
    setTextAnswer('');
    if (prepTimerRef.current) {
      clearInterval(prepTimerRef.current);
      prepTimerRef.current = null;
    }

    if (answerMode === 'oral' && preparationTime && preparationTime > 0 && assessmentStarted) {
      setPrepSecondsLeft(preparationTime);
    } else {
      setPrepSecondsLeft(null);
      setPrepDone(true);
    }

    return () => {
      if (prepTimerRef.current) {
        clearInterval(prepTimerRef.current);
        prepTimerRef.current = null;
      }
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [currentQuestionIndex, assessmentStarted, answerMode, preparationTime]);

  useEffect(() => {
    if (prepSecondsLeft === null || prepDone) return;
    if (prepSecondsLeft <= 0) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setPrepDone(true);
      setPrepSecondsLeft(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    prepTimerRef.current = setInterval(() => {
      setPrepSecondsLeft(prev => {
        if (prev === null || prev <= 1) {
          if (prepTimerRef.current) {
            clearInterval(prepTimerRef.current);
            prepTimerRef.current = null;
          }
          setPrepDone(true);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (prepTimerRef.current) {
        clearInterval(prepTimerRef.current);
        prepTimerRef.current = null;
      }
    };
  }, [prepSecondsLeft, prepDone]);

  // Draft recovery, once per mount. Must stay declared after the per-question reset effect
  // (and gated on assessmentStarted) so its setTextAnswer('') doesn't wipe the recovered text.
  useEffect(() => {
    if (rehydrateAttemptedRef.current) return;
    if (!assessmentStarted || !assessmentId || questions.length === 0) return;
    rehydrateAttemptedRef.current = true;
    // No cancel-on-cleanup flag: under StrictMode it would suppress the toast for a draft
    // the first run did recover. addToast is a global store, safe after unmount.
    (async () => {
      const recovered = await rehydrateDraft();
      if (recovered) {
        addToast('Recovered your unsaved answer from before the page reloaded.', 'info');
      }
    })();
  }, [assessmentStarted, assessmentId, questions.length, currentQuestionIndex, rehydrateDraft, addToast]);

  useEffect(() => {
    return () => {
      if (deferredSubmitRef.current) {
        window.removeEventListener('online', deferredSubmitRef.current);
        deferredSubmitRef.current = null;
      }
    };
  }, []);

  const handleConsentAccepted = async () => {
    // Record before the camera request so a refresh won't re-show the modal.
    setProctoringDeclined(false);
    await recordConsentDecision(true);

    setIsRequestingPermission(true);
    try {
      await startProctoring();
    } finally {
      setIsRequestingPermission(false);
    }
  };

  const handleConsentDeclined = async () => {
    // Persisted so a refresh restores proctoringDeclined and the resume re-arm skips the camera.
    setProctoringDeclined(true);
    if (assessmentId) sessionStorage.setItem(declinedConsentKey(assessmentId), 'true');
    await recordConsentDecision(false);
  };

  // Only offered when proctoring is optional. Recorded as a decline so the instructor sees it.
  const handleContinueWithoutRecording = async () => {
    setProctoringDeclined(true);
    if (assessmentId) sessionStorage.setItem(declinedConsentKey(assessmentId), 'true');
    await recordConsentDecision(false);
    useAssessmentStore.setState({ cameraRevoked: false, proctoringRequested: false });
    setResumeRegrantNeeded(false);
  };

  const handleRestoreCamera = async () => {
    setIsRestoringCamera(true);
    try {
      await restoreProctoring();
    } finally {
      setIsRestoringCamera(false);
    }
  };

  // Runs inside a click gesture, so getUserMedia is permitted here.
  const handleResumeRegrant = async () => {
    setIsRestoringCamera(true);
    try {
      await startProctoring();
      const s = useAssessmentStore.getState();
      const live =
        !!s.proctorStream && s.proctorStream.getVideoTracks().some((t) => t.readyState === 'live');
      if (live) setResumeRegrantNeeded(false);
    } finally {
      setIsRestoringCamera(false);
    }
  };

  // One-shot: replaces any pending listener and detaches before firing, so a flapping
  // connection can't double-submit.
  const registerDeferredSubmit = (run: () => void) => {
    if (deferredSubmitRef.current) {
      window.removeEventListener('online', deferredSubmitRef.current);
      deferredSubmitRef.current = null;
    }
    const onReconnect = () => {
      if (deferredSubmitRef.current) {
        window.removeEventListener('online', deferredSubmitRef.current);
        deferredSubmitRef.current = null;
      }
      const store = useAssessmentStore.getState();
      if (store.isUploading || isSubmittingAnswer || store.isStopping) return;
      run();
    };
    deferredSubmitRef.current = onReconnect;
    window.addEventListener('online', onReconnect);
  };

  const handleTimerExpire = async () => {
    const store = useAssessmentStore.getState();

    // Offline: defer, then re-run this whole expiry decision on reconnect against fresh state.
    if (!store.isOnline) {
      await deferSubmitWhileOffline({
        isInFlight: () => {
          const s = useAssessmentStore.getState();
          return s.isUploading || isSubmittingAnswer || s.isStopping;
        },
        isRecording: () => useAssessmentStore.getState().isRecording,
        answerMode: store.answerMode,
        stopRecording: () => useAssessmentStore.getState().stopRecording(),
        notify: (msg) => addToast(msg, 'warning'),
        registerReconnect: registerDeferredSubmit,
        runOnReconnect: () => {
          void handleTimerExpire();
        },
      });
      return;
    }

    // Getters read the store lazily so the blob produced by stopRecording is seen.
    await runTimerExpiry({
      // isStopping: a manual Stop in flight must not be raced by an expiry stop + skip.
      inFlight: store.isUploading || isSubmittingAnswer || store.isStopping,
      answerMode: store.answerMode,
      getIsRecording: () => useAssessmentStore.getState().isRecording,
      getRecordedBlob: () => useAssessmentStore.getState().recordedBlob,
      getTextAnswer: () => useAssessmentStore.getState().textAnswer,
      stopRecording: () => useAssessmentStore.getState().stopRecording(),
      notify: (msg) => addToast(msg, 'warning'),
      submitAudio: handleSubmitAudioAnswer,
      submitText: handleSubmitTextAnswer,
      skip: (mode) => skipCurrentQuestion(mode),
    });
  };

  const handleSubmitAudioAnswer = async () => {
    setIsSubmittingAnswer(true);
    try {
      await submitCurrentAnswer();
    } finally {
      setIsSubmittingAnswer(false);
    }
  };

  const handleSubmitTextAnswer = async () => {
    setIsSubmittingAnswer(true);
    try {
      await submitCurrentTextAnswer();
    } finally {
      setIsSubmittingAnswer(false);
    }
  };

  const handleNext = async () => {
    // Re-fetch in case the server-side advance hadn't landed yet.
    setIsSubmittingAnswer(true);
    try {
      await loadQuestions();
      await loadProgress();
    } finally {
      setIsSubmittingAnswer(false);
    }
  };

  const handleSubmitAssessment = async () => {
    const ok = await submitCompleteAssessment();
    if (ok) {
      setShowSubmitModal(false);
      setSubmitted(true);
    }
    // On failure the modal stays open and shows the store error.
  };

  if (submitted) {
    const title = assessment?.title || 'your assessment';
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
            <svg className="h-8 w-8 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-ink mb-2">Assessment Submitted</h2>
          <p className="text-slate mb-1">
            Your responses for <span className="font-medium">{title}</span> have been submitted for evaluation.
          </p>
          <p className="text-sm text-slate mb-6">
            Submitted {new Date().toLocaleString()}
          </p>
          <button
            onClick={() => navigate(`/${studentId}/results/${assessmentId}`)}
            className="w-full bg-primary-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-primary-700 transition-colors"
          >
            Check Results
          </button>
        </div>
      </div>
    );
  }

  if (isLoading && questions.length === 0) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <LoadingSpinner size="lg" message="Loading assessment..." />
      </div>
    );
  }

  if (error && questions.length === 0) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <ErrorMessage error={error} onDismiss={clearError} />
          <button
            onClick={() => window.location.reload()}
            className="mt-4 w-full bg-primary-600 text-white px-4 py-2 rounded-md hover:bg-primary-700"
          >
            Reload Page
          </button>
        </div>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-ink mb-2">
            No Questions Available
          </h2>
          <p className="text-slate">
            This assessment doesn't have any questions yet.
          </p>
        </div>
      </div>
    );
  }

  const currentQuestion = questions[currentQuestionIndex];

  // Index past the end (all answered): prompt submission.
  if (!currentQuestion) {
    const fallbackAnsweredCount = progress?.answeredQuestions || 0;
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-ink mb-2">Ready to Submit</h2>
          <p className="text-slate mb-4">
            You have answered {fallbackAnsweredCount} of {questions.length} questions. Submit your assessment to finish.
          </p>
          <button
            onClick={() => setShowSubmitModal(true)}
            className="bg-primary-600 text-white px-6 py-2 rounded-lg hover:bg-primary-700"
          >
            Submit Assessment
          </button>
        </div>
        {showSubmitModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-paper rounded-xl shadow-overlay max-w-md w-full p-6">
              <h2 className="text-xl font-bold text-ink mb-4">Submit Assessment?</h2>
              <p className="text-slate mb-2">
                You've answered{' '}
                <span className="font-semibold">{fallbackAnsweredCount}</span> out of{' '}
                <span className="font-semibold">{questions.length}</span> questions.
              </p>
              {fallbackAnsweredCount < questions.length && (
                <p className="text-caution text-sm mb-4">
                  Answers are submitted in order and are final. The {questions.length - fallbackAnsweredCount} unanswered question(s) can't be revisited.
                </p>
              )}
              {fallbackAnsweredCount >= questions.length && (
                <p className="text-slate text-sm mb-6">
                  Answers are submitted in order and are final. Once submitted, your assessment will be sent for evaluation.
                </p>
              )}
              {error && (
                <p className="text-danger text-sm mb-4 p-3 bg-danger/10 rounded-lg">
                  {error.message || 'Submission failed. Please try again.'}
                </p>
              )}
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowSubmitModal(false)}
                  disabled={isLoading}
                  className="flex-1 bg-ink/5 text-ink px-4 py-2 rounded-lg hover:bg-ink/10 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitAssessment}
                  disabled={isLoading || fallbackAnsweredCount < questions.length}
                  className="flex-1 bg-success text-white px-4 py-2 rounded-lg hover:bg-success/90 disabled:bg-ink/20 transition-colors"
                >
                  {isLoading ? 'Submitting...' : 'Submit'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const isLastQuestion = currentQuestionIndex === questions.length - 1;
  const answeredCount = progress?.answeredQuestions || 0;
  const currentAnswered = currentQuestion ? answeredQuestionIds.has(currentQuestion.id) : false;
  // Rough header estimate only (null with no limits); QuestionTimer is the authoritative clock.
  const questionsLeft = Math.max(0, questions.length - (currentQuestionIndex + 1));
  const remainingMinutesEstimate = estimateRemainingMinutes({
    questionCount: questions.length,
    currentIndex: currentQuestionIndex,
    perQuestionSeconds: questions.map((q) => q.timeLimit),
    fallbackPerQuestionSeconds: assessment?.timeLimit ?? null,
  });
  // Review mode is written-only for now.
  const reviewMode = answerMode === 'written' && allowReview;
  const allAnswered = questions.length > 0 && answeredCount >= questions.length;

  const assessmentInfo = assessment ?? {
    id: assessmentId ?? '',
    title: 'Oral Assessment',
    course: '',
    description: '',
    dueDate: '',
    totalQuestions: questions.length,
    timeLimit: questions[0]?.timeLimit,
    status: 'open',
  };

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      {/* Un-proctored: no modal, and consentGiven stays false so resume never arms a camera. */}
      {proctored && !consentGiven && questions.length > 0 && (
        <ConsentModal
          onConsent={handleConsentAccepted}
          onDecline={handleConsentDeclined}
          isRequestingPermission={isRequestingPermission}
        />
      )}

      {/* Pre-flight: overview -> device check (oral only) -> start. No timer runs here. */}
      {(consentGiven || !proctored) && !assessmentStarted && !overviewConfirmed && (
        <PreAssessmentOverview
          assessment={assessmentInfo}
          questionCount={questions.length}
          perQuestionSeconds={questions.map((q) => q.timeLimit)}
          startLabel={answerMode === 'written' ? 'Start Assessment' : 'Continue'}
          onStart={() => {
            if (answerMode === 'written') {
              setDeviceCheckPassed(true);
              setAssessmentStarted(true);
            } else {
              setOverviewConfirmedRaw(true);
            }
          }}
        />
      )}

      {(consentGiven || !proctored) &&
        !assessmentStarted &&
        overviewConfirmed &&
        !deviceCheckPassed && (
          <DeviceCheck
            answerMode={answerMode === 'written' ? 'written' : 'oral'}
            requireCamera={isProctoringActive}
            onReady={() => {
              setDeviceCheckPassed(true);
              setAssessmentStarted(true);
            }}
          />
        )}

      {assessmentStarted && <div>

      {browserError && (
        <div className="bg-danger text-white px-4 py-3 flex items-center justify-between">
          <span className="text-sm">{browserError}</span>
          <button onClick={() => setBrowserError(null)} className="ml-4 text-white/80 hover:text-white text-lg leading-none">&times;</button>
        </div>
      )}

      {proctoringWarning && (
        <div className="bg-caution/10 border-b border-caution/30 text-caution px-4 py-3 flex items-center justify-between">
          <span className="text-sm">{proctoringWarning}</span>
          <button onClick={clearProctoringWarning} className="ml-4 text-caution hover:text-caution/80 text-lg leading-none">&times;</button>
        </div>
      )}

      {proctoringDegraded && (
        <div className="bg-caution/10 border-b border-caution/30 text-caution px-4 py-3 flex items-center justify-between">
          <span className="text-sm">Proctoring degraded — retrying upload. Your answers are unaffected.</span>
        </div>
      )}

      {cameraRevoked && (
        <CameraRevokedOverlay
          onRestore={handleRestoreCamera}
          isRestoring={isRestoringCamera}
          proctoringOptional={proctoringDeclined}
          onContinueWithout={proctoringDeclined ? handleContinueWithoutRecording : undefined}
        />
      )}

      {/* Resume re-grant overlay; dismisses itself once a live stream returns. */}
      {resumeRegrantNeeded && !cameraRevoked && !(proctoringRequested && isProctoringActive) && (
        <CameraRevokedOverlay
          title="Re-grant camera to continue"
          description="Your assessment is proctored. After reloading, we need to restart your camera. Please allow camera and microphone access, then click below to continue."
          onRestore={handleResumeRegrant}
          isRestoring={isRestoringCamera}
          proctoringOptional={proctoringDeclined}
          onContinueWithout={proctoringDeclined ? handleContinueWithoutRecording : undefined}
        />
      )}

      {proctored && <ProctorCamera stream={proctorStream} isRecording={isProctoringActive} />}

      <header className="bg-paper border-b border-hairline flex-shrink-0">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <h1 className="text-2xl font-bold text-ink">
            {assessment?.title ?? 'Assessment'}
          </h1>
          <div className="flex items-center justify-between mt-2">
            {/* The API sends no instructor contact, so HelpButton renders generic copy. */}
            <HelpButton />
            <div className="flex items-center space-x-4">
              <div className="text-sm font-medium text-slate text-right">
                <div>
                  Question {currentQuestionIndex + 1} of {questions.length}
                </div>
                <div className="text-xs font-normal text-slate mt-0.5">
                  {questionsLeft > 0
                    ? `${questionsLeft} question${questionsLeft === 1 ? '' : 's'} left`
                    : 'Last question'}
                  {remainingMinutesEstimate !== null && (
                    <> · ~{remainingMinutesEstimate} min left</>
                  )}
                </div>
              </div>
              {/* The only answer clock and the only trigger for stop+submit on expiry.
                  Written: counts from question mount. Oral: anchored to recording start,
                  so thinking time before Start doesn't eat the limit. */}
              {(answerMode === 'written' || (answerMode === 'oral' && isRecording && recordingStartTime !== null)) && (
                <QuestionTimer
                  timeLimitSeconds={answerMode === 'oral' ? (currentQuestion.timeLimit ?? 300) : currentQuestion.timeLimit}
                  resetKey={answerMode === 'oral' ? `${currentQuestion.id}-rec-${recordingStartTime}` : currentQuestion.id}
                  paused={answerMode === 'oral' && isPaused}
                  /* Only written persists its anchor so a refresh can't reset the clock; a refresh
                     ends an oral recording, so its clock restarts by design. */
                  persistKey={
                    answerMode === 'written' && assessmentId
                      ? `qtimer_start_${assessmentId}_${currentQuestion.id}`
                      : undefined
                  }
                  /* Review mode: display only, never auto-submit. */
                  onExpire={reviewMode ? undefined : handleTimerExpire}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {error && (
            <div className="mb-4">
              <ErrorMessage error={error} onDismiss={clearError} />
              {lastFailedAction && (
                <button
                  onClick={retryLastAction}
                  className="mt-2 bg-primary-600 text-white px-4 py-2 rounded-md hover:bg-primary-700 text-sm"
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {isSubmittingAnswer && !error && (
            <div className="mb-4 flex items-center space-x-3 bg-accent/[0.06] border border-accent/20 rounded-xl px-4 py-3">
              <svg className="animate-spin motion-reduce:animate-none h-5 w-5 text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-sm text-accent font-medium">Submitting answer and loading next question...</span>
            </div>
          )}

          {/* Navigable only in review mode. */}
          <div className="mb-4">
            <ProgressTracker
              currentIndex={currentQuestionIndex}
              totalQuestions={questions.length}
              answeredCount={answeredCount}
              questionIds={questions.map((q) => q.id)}
              answeredQuestionIds={answeredQuestionIds}
              skippedQuestionIds={skippedQuestionIds}
              onNavigate={reviewMode ? goToQuestion : undefined}
            />
          </div>

          <div className="mb-4">
            <QuestionDisplay question={currentQuestion} />
          </div>

          <div className="mb-4">
            {answerMode === 'oral' ? (
              prepDone ? (
                <AudioRecorder
                  onSubmit={handleSubmitAudioAnswer}
                  timeLimit={currentQuestion.timeLimit ?? 300}
                />
              ) : (
                <div className="bg-accent/10 border border-accent/20 rounded-xl p-8 text-center">
                  <p className="text-sm font-medium text-accent mb-2">Preparation Time</p>
                  <div className="text-6xl font-bold text-ink mb-4 tabular-nums">
                    {prepSecondsLeft !== null
                      ? `${Math.floor(prepSecondsLeft / 60)}:${String(prepSecondsLeft % 60).padStart(2, '0')}`
                      : '—'}
                  </div>
                  <p className="text-sm text-slate mb-6">
                    Read the question carefully. When the countdown ends, press Start Recording to answer. Your answer time begins once you start recording.
                  </p>
                  <button
                    onClick={() => { setPrepDone(true); setPrepSecondsLeft(null); if (prepTimerRef.current) { clearInterval(prepTimerRef.current); prepTimerRef.current = null; } }}
                    className="bg-primary-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-primary-700 transition-colors"
                  >
                    I'm Ready
                  </button>
                </div>
              )
            ) : (
              <TextAnswerInput
                value={textAnswer}
                onChange={setTextAnswer}
                onSubmit={handleSubmitTextAnswer}
                isSubmitting={isUploading}
              />
            )}
          </div>

          {reviewMode ? (
            /* Review mode: free navigation; submit enabled once every question is answered. */
            <div className="flex justify-between items-center pb-6">
              <button
                type="button"
                onClick={() => goToQuestion(currentQuestionIndex - 1)}
                disabled={currentQuestionIndex === 0 || isUploading}
                className="flex items-center space-x-2 bg-ink/5 text-ink px-5 py-3 rounded-lg hover:bg-ink/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                <span>Previous</span>
              </button>
              <div className="flex items-center space-x-3">
                {!isLastQuestion && (
                  <button
                    type="button"
                    onClick={() => goToQuestion(currentQuestionIndex + 1)}
                    disabled={isUploading}
                    className="flex items-center space-x-2 bg-primary-600 text-white px-5 py-3 rounded-lg hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span>Next</span>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowSubmitModal(true)}
                  disabled={!allAnswered || isUploading}
                  title={!allAnswered ? 'Answer every question before submitting' : undefined}
                  className="flex items-center space-x-2 bg-success text-white px-6 py-3 rounded-lg hover:bg-success/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  <span>Submit Assessment</span>
                </button>
              </div>
            </div>
          ) : (
            <div className={`flex justify-end items-center ${isProctoringActive ? 'pb-32' : 'pb-6'}`}>
              {isLastQuestion ? (
                <button
                  onClick={() => setShowSubmitModal(true)}
                  disabled={!currentAnswered || isSubmittingAnswer}
                  className="flex items-center space-x-2 bg-success text-white px-8 py-3 rounded-lg hover:bg-success/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  <span>Submit Assessment</span>
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleNext}
                  disabled={!currentAnswered || isSubmittingAnswer}
                  className="flex items-center space-x-2 bg-primary-600 text-white px-6 py-3 rounded-lg hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isSubmittingAnswer ? (
                    <>
                      <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Loading next...</span>
                    </>
                  ) : (
                    <>
                      <span>Next Question</span>
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd"
                          d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                          clipRule="evenodd" />
                      </svg>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </main>

      {showSubmitModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-paper rounded-xl shadow-overlay max-w-md w-full p-6">
            <h2 className="text-xl font-bold text-ink mb-4">
              Submit Assessment?
            </h2>
            <p className="text-slate mb-2">
              You've answered{' '}
              <span className="font-semibold">{answeredCount}</span> out of{' '}
              <span className="font-semibold">{questions.length}</span> questions.
            </p>
            {answeredCount < questions.length && (
              <p className="text-caution text-sm mb-4">
                {reviewMode
                  ? `${questions.length - answeredCount} question(s) still need an answer before you can submit.`
                  : `Answers are submitted in order and are final. The ${questions.length - answeredCount} unanswered question(s) can't be revisited.`}
              </p>
            )}
            {answeredCount >= questions.length && (
              <p className="text-slate text-sm mb-6">
                {reviewMode
                  ? 'You can keep editing your answers until you submit. Once you submit, your assessment is final and sent for evaluation.'
                  : 'Answers are submitted in order and are final. Once submitted, your assessment will be sent for evaluation.'}
              </p>
            )}
            {error && (
              <p className="text-danger text-sm mb-4 p-3 bg-danger/10 rounded-lg">
                {error.message || 'Submission failed. Please try again.'}
              </p>
            )}
            <div className="flex space-x-3">
              <button
                onClick={() => { setShowSubmitModal(false); }}
                disabled={isLoading}
                className="flex-1 bg-ink/5 text-ink px-4 py-2 rounded-lg hover:bg-ink/10 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitAssessment}
                disabled={isLoading || answeredCount < questions.length}
                className="flex-1 bg-success text-white px-4 py-2 rounded-lg hover:bg-success/90 disabled:bg-ink/20 transition-colors"
              >
                {isLoading ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      </div>}{/* end assessmentStarted wrapper */}
    </div>
  );
}
