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

// The bare axios.put to S3 doesn't inherit apiClient's timeout. Generous but finite, so a
// stall aborts with ECONNABORTED (retryable) instead of hanging.
const S3_PUT_TIMEOUT_MS = 120000;

const RETRY_MAX_ATTEMPTS = 3; // includes the initial attempt
const RETRY_BASE_DELAY_MS = 400;

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 60000,
});

/** Network errors, timeouts and 5xx. Never 4xx: 401/403 belong to the token-refresh interceptor. */
export function isTransientError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const ax = err as AxiosError;
  if (ax.code === 'ECONNABORTED') return true; // timeout
  if (ax.response) {
    return ax.response.status >= 500;
  }
  return Boolean(ax.request) || ax.code === 'ERR_NETWORK';
}

/** Exponential backoff + jitter. The final error is re-thrown unchanged for handleApiError. */
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
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
}

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('studentToken');
  if (token) {
    config.headers = config.headers ?? {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// Auto-refresh on 401/403 by re-exchanging the student's own invite token (honoured while
// the assessment window is open); nothing here can mint a token from a student id alone.
// Single-flight: N concurrent 401/403s share one exchange and all replay (or all reject).
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
      if (localStorage.getItem('inviteToken')) {
        originalRequest._retried = true;
        try {
          const token = await refreshToken();
          originalRequest.headers = originalRequest.headers ?? {};
          originalRequest.headers['Authorization'] = `Bearer ${token}`;
          return apiClient(originalRequest);
        } catch {
          // Refresh failed: fall through and reject the original error.
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

export const handleApiError = (error: AxiosError): never => {
  if (error.response) {
    // Failures use the {ok: false, error: {code, message}} envelope; `detail` is FastAPI's fallback.
    const responseData = error.response.data as { detail?: string; error?: { code?: string; message?: string } };
    const serverMessage = responseData?.error?.message || responseData?.detail;
    let message = serverMessage || error.message;
    const windowMessage = TIME_UP_MESSAGES[responseData?.error?.code ?? ''];

    // Friendlier copy for window errors, bare 404s and all 403s; otherwise keep the server's message.
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
    throw {
      message: 'Could not reach the server — please check your internet connection and try again.',
      status: 0,
    } as ApiError;
  } else {
    throw {
      message: error.message || 'An unexpected error occurred',
    } as ApiError;
  }
};

// The wire types answerMode as a plain string; the UI only knows 'oral' | 'written'.
export type QuestionsResponse = Omit<Schemas['StudentQuestionsResponse'], 'answerMode'> & {
  answerMode: AnswerMode;
};

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
 * Records a genuine non-answer (zero credit, never evaluated as content).
 * Older backends reject answer_type 'skipped' with 400/422; skipCurrentQuestion falls back.
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

// Bump whenever the consent wording or scope changes, so each record says which text was shown.
export const CONSENT_VERSION = '2026-06-10';

/**
 * granted:false is the instructor app's audit signal that the student declined recording.
 * Callers must treat failure as non-blocking (see recordConsentDecision).
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

// Goes through apiClient (not fetch) to inherit the auth and token-refresh interceptors.
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

// The server builds the S3 key from this plus the student id in the auth token.
export type UploadTarget =
  | { kind: 'audio'; questionId: string }
  | { kind: 'proctoring'; assessmentId: string; chunkIndex: number };

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

export async function uploadAudioToS3(
  uploadUrl: string,
  audioBlob: Blob,
  onProgress?: (progress: number) => void
): Promise<void> {
  try {
    await withRetry(() =>
      axios.put(uploadUrl, audioBlob, {
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
