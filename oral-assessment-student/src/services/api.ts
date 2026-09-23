/**
 * API Service Layer - Handles all backend communication
 */

import axios, { AxiosError } from 'axios';
import type {
  AnswerMode,
  Progress,
  Results,
  Schemas,
  UploadUrlResponse,
  ApiError,
} from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

// Explicit upper bound for the bare-axios S3 PUT (the apiClient `timeout` does NOT
// apply to module-level `axios.put`). Presigned S3 PUTs of large audio can be slow,
// so the bound is generous — but finite, so a stalled upload aborts with
// ECONNABORTED (which withRetry treats as retryable) instead of hanging forever.
const S3_PUT_TIMEOUT_MS = 120000;

// Retry tuning for transient failures on the submit/upload path.
const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + up to 2 retries
const RETRY_BASE_DELAY_MS = 400;

// Create axios instance with default config
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 60000, // 60 second timeout (accommodates large audio uploads on slow networks)
});

/**
 * True for transient failures that are worth retrying: network errors (request
 * made, no response), request timeouts (ECONNABORTED), and server 5xx. NEVER
 * true for 4xx — those are deterministic, and 401/403 are handled by the
 * token-refresh interceptor, not by re-firing the same request.
 */
export function isTransientError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const ax = err as AxiosError;
  if (ax.code === 'ECONNABORTED') return true; // timeout
  if (ax.response) {
    return ax.response.status >= 500; // 5xx only; 4xx is non-retryable
  }
  // No response but a request was made => network-level failure.
  return Boolean(ax.request) || ax.code === 'ERR_NETWORK';
}

/**
 * Run `fn`, retrying transient failures with bounded exponential backoff + jitter.
 * The final error (after retries are exhausted, or immediately for a non-retryable
 * error) is re-thrown unchanged so callers' existing `handleApiError` path is
 * preserved verbatim.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    retries?: number;
    baseDelayMs?: number;
    isRetryable?: (err: unknown) => boolean;
  }
): Promise<T> {
  const maxAttempts = opts?.retries ?? RETRY_MAX_ATTEMPTS;
  const baseDelayMs = opts?.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const isRetryable = opts?.isRetryable ?? isTransientError;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      // Stop if we've used all attempts or the error isn't transient.
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
}

// Attach student session token to every request if present
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('studentToken');
  if (token) {
    config.headers = config.headers ?? {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor: auto-refresh the session token on 401/403.
//
// The session is renewed by re-exchanging the student's own invite token — the
// same link they were emailed — which the backend honours for as long as the
// assessment window is open. Nothing here can mint a token for a student ID alone.
//
// Single-flight: a module-level promise holds the in-flight exchange. The FIRST
// request to 401/403 starts it; every concurrent 401/403 AWAITS the same promise
// instead of starting its own (or being spuriously rejected). When it resolves,
// every waiter re-issues with the fresh token; if it rejects, every waiter
// rejects. Net: N concurrent 401/403s => exactly ONE exchange, all N replayed.
// Cleared in `finally` so a later expiry can refresh again.
let refreshPromise: Promise<string> | null = null;

function refreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;
  const inviteToken = localStorage.getItem('inviteToken');
  if (!inviteToken) {
    return Promise.reject(new Error('No invite token stored for session renewal'));
  }
  refreshPromise = (async () => {
    try {
      const resp = await apiClient.post<Schemas['StudentInviteExchangeResponse']>(
        '/api/auth/student/exchange',
        { invite_token: inviteToken } satisfies Schemas['StudentInviteExchangeRequest']
      );
      const token = resp.data.access_token;
      localStorage.setItem('studentToken', token);
      localStorage.setItem('authToken', token);
      return token;
    } finally {
      // Allow the next expiry to trigger a fresh refresh.
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as typeof error.config & { _retried?: boolean };
    if (
      originalRequest &&
      !originalRequest._retried &&
      (error.response?.status === 401 || error.response?.status === 403) &&
      !originalRequest.url?.includes('/auth/student/exchange')
    ) {
      // Renewal requires the student's stored invite token.
      if (localStorage.getItem('inviteToken')) {
        originalRequest._retried = true;
        try {
          // Join the in-flight refresh if one exists, otherwise start it.
          const token = await refreshToken();
          originalRequest.headers = originalRequest.headers ?? {};
          originalRequest.headers['Authorization'] = `Bearer ${token}`;
          return apiClient(originalRequest);
        } catch {
          // Token refresh also failed — fall through to normal error handling.
        }
      }
    }
    return Promise.reject(error);
  }
);

// The server refuses these once the assessment's stored times say so (409).
const TIME_UP_MESSAGES: Record<string, string> = {
  assessment_not_open: "This assessment hasn't opened yet. Check the start time with your instructor.",
  assessment_closed: 'This assessment has closed, so answers can no longer be submitted.',
  assessment_deadline_passed: 'The due date for this assessment has passed, so it can no longer be submitted.',
};

// Error handler
export const handleApiError = (error: AxiosError): never => {
  if (error.response) {
    // Server responded with an error status
    // The backend answers every failure in the envelope {ok: false, error: {code, message}};
    // `detail` is FastAPI's default shape and only kept as a fallback.
    const responseData = error.response.data as { detail?: string; error?: { code?: string; message?: string } };
    const serverMessage = responseData?.error?.message || responseData?.detail;
    let message = serverMessage || error.message;
    const windowMessage = TIME_UP_MESSAGES[responseData?.error?.code ?? ''];

    // Provide clearer messages for common status codes, but preserve domain-specific detail messages
    if (windowMessage) {
      message = windowMessage;
    } else if (error.response.status === 404 && (!serverMessage || serverMessage === 'Not Found')) {
      message = 'Assessment not found — please check your link or contact your instructor.';
    } else if (error.response.status === 403) {
      message = 'Access denied — this assessment link may have expired. Retrying...';
    }

    const apiError: ApiError = {
      message,
      status: error.response.status,
      details: error.response.data,
    };
    throw apiError;
  } else if (error.request) {
    // Request made but no response received (network issue)
    throw {
      message: 'Could not reach the server — please check your internet connection and try again.',
      status: 0,
    } as ApiError;
  } else {
    // Something else went wrong
    throw {
      message: error.message || 'An unexpected error occurred',
    } as ApiError;
  }
};

/**
 * The questions response with `answerMode` narrowed: the wire types it as a
 * plain string, the UI only knows 'oral' | 'written'.
 */
export type QuestionsResponse = Omit<Schemas['StudentQuestionsResponse'], 'answerMode'> & {
  answerMode: AnswerMode;
};

/**
 * Get all questions for a student's assessment
 */
export async function getQuestions(
  studentId: string,
  assessmentId: string
): Promise<QuestionsResponse> {
  try {
    const { data } = await apiClient.get<Schemas['StudentQuestionsResponse']>(
      `/api/student/${studentId}/assessment/${assessmentId}/questions`
    );
    return { ...data, answerMode: data.answerMode === 'written' ? 'written' : 'oral' };
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Submit an audio answer for a question
 */
export async function submitAnswer(
  studentId: string,
  questionId: string,
  assessmentId: string,
  audioUrl: string,
  duration: number
): Promise<void> {
  try {
    await withRetry(() =>
      apiClient.post(`/api/student/${studentId}/answer`, {
        question_id: questionId,
        assessment_id: assessmentId,
        answer_type: 'audio',
        audio_url: audioUrl,
        duration,
      } satisfies Schemas['SubmitAnswerRequest'])
    );
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Submit a text answer for a question
 */
export async function submitTextAnswer(
  studentId: string,
  questionId: string,
  assessmentId: string,
  textContent: string
): Promise<void> {
  try {
    await withRetry(() =>
      apiClient.post(`/api/student/${studentId}/answer`, {
        question_id: questionId,
        assessment_id: assessmentId,
        answer_type: 'text',
        text_content: textContent,
      } satisfies Schemas['SubmitAnswerRequest'])
    );
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Submit an explicit "skipped / no answer" marker for a question. The server
 * records it as a non-answer (zero credit) and never evaluates it as content.
 */
export async function submitSkip(
  studentId: string,
  questionId: string,
  assessmentId: string,
  mode: 'oral' | 'written'
): Promise<void> {
  try {
    await apiClient.post(`/api/student/${studentId}/answer`, {
      question_id: questionId,
      assessment_id: assessmentId,
      answer_type: 'skipped',
      mode,
    } satisfies Schemas['SubmitAnswerRequest']);
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Consent record version. Bumped whenever the wording/scope of the consent the
 * student agrees to changes, so each server-side record is unambiguous about
 * WHICH consent text was shown. Co-located with recordConsent below.
 */
export const CONSENT_VERSION = '2026-06-10';

/**
 * Record the student's webcam-proctoring consent decision server-side.
 *
 * A `granted: false` record is the instructor app's signal that the student
 * DECLINED recording. The caller (recordConsentDecision in the store) treats
 * this as best-effort: a failure is logged and toasted, never blocking.
 */
export async function recordConsent(
  studentId: string,
  assessmentId: string,
  payload: { granted: boolean; consentVersion: string; timestamp: string }
): Promise<void> {
  try {
    await apiClient.post(`/api/student/${studentId}/consent`, {
      assessment_id: assessmentId,
      granted: payload.granted,
      consent_version: payload.consentVersion,
      timestamp: payload.timestamp,
    } satisfies Schemas['SubmitConsentRequest']);
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Log a proctoring chunk manifest entry
 */
export async function submitProctorChunk(
  studentId: string,
  assessmentId: string,
  chunkUrl: string,
  chunkIndex: number
): Promise<void> {
  try {
    await apiClient.post(`/api/student/${studentId}/proctoring-chunk`, {
      assessment_id: assessmentId,
      chunk_url: chunkUrl,
      chunk_index: chunkIndex,
      timestamp: new Date().toISOString(),
    } satisfies Schemas['SubmitProctorChunkRequest']);
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Submit the complete assessment
 */
export async function submitAssessment(
  studentId: string,
  assessmentId: string
): Promise<void> {
  try {
    await withRetry(() =>
      apiClient.put(`/api/student/${studentId}/submit`, {
        assessment_id: assessmentId,
      } satisfies Schemas['SubmitAssessmentRequest'])
    );
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Get current progress for student's assessment
 */
export async function getProgress(
  studentId: string,
  assessmentId: string
): Promise<Progress> {
  try {
    const response = await apiClient.get<Progress>(
      `/api/student/${studentId}/assessment/${assessmentId}/progress`
    );
    return response.data;
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Get evaluation results for completed assessment
 */
export async function getResults(
  studentId: string,
  assessmentId: string
): Promise<Results> {
  try {
    const response = await apiClient.get<Results>(
      `/api/student/${studentId}/assessment/${assessmentId}/results`
    );
    return response.data;
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Download the results PDF for a completed assessment.
 *
 * Routed through `apiClient` so it inherits the auth-injection and 401/403
 * token-refresh interceptors (a raw `fetch` would bypass both). Returns the raw
 * PDF blob; the caller is responsible for triggering the browser download.
 */
export async function getResultsPdf(
  studentId: string,
  assessmentId: string
): Promise<Blob> {
  try {
    const response = await apiClient.get(
      `/api/student/${studentId}/assessment/${assessmentId}/results/pdf`,
      { responseType: 'blob' }
    );
    return response.data as Blob;
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * What the upload is for. The server builds the S3 key from this plus the
 * student id in the auth token — the client never names the key.
 */
export type UploadTarget =
  | { kind: 'audio'; questionId: string }
  | { kind: 'proctoring'; assessmentId: string; chunkIndex: number };

/**
 * Get S3 presigned upload URL for a media file
 */
export async function getUploadUrl(
  target: UploadTarget,
  contentType: string = 'audio/webm'
): Promise<UploadUrlResponse> {
  const params = new URLSearchParams({ kind: target.kind, content_type: contentType });
  if (target.kind === 'audio') {
    params.set('question_id', target.questionId);
  } else {
    params.set('assessment_id', target.assessmentId);
    params.set('chunk_index', String(target.chunkIndex));
  }

  try {
    const response = await withRetry(() =>
      apiClient.post<UploadUrlResponse>(`/api/s3/upload-url?${params.toString()}`)
    );
    return response.data;
  } catch (error) {
    return handleApiError(error as AxiosError);
  }
}

/**
 * Upload audio file directly to S3
 */
export async function uploadAudioToS3(
  uploadUrl: string,
  audioBlob: Blob,
  onProgress?: (progress: number) => void
): Promise<void> {
  try {
    await withRetry(() =>
      axios.put(uploadUrl, audioBlob, {
        // Explicit finite bound: the bare `axios.put` does NOT inherit apiClient's
        // timeout. On a stall this aborts with ECONNABORTED (retried by withRetry)
        // instead of hanging "Uploading… X%" forever.
        timeout: S3_PUT_TIMEOUT_MS,
        headers: {
          'Content-Type': audioBlob.type,
        },
        onUploadProgress: (progressEvent) => {
          if (onProgress && progressEvent.total) {
            const percentCompleted = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            onProgress(percentCompleted);
          }
        },
      })
    );
  } catch (error) {
    throw {
      message: 'Failed to upload audio file',
      details: error,
    } as ApiError;
  }
}

export default {
  getQuestions,
  submitAnswer,
  submitTextAnswer,
  submitSkip,
  recordConsent,
  submitProctorChunk,
  submitAssessment,
  getProgress,
  getResults,
  getResultsPdf,
  getUploadUrl,
  uploadAudioToS3,
};
