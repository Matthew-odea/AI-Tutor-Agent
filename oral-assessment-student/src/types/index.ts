/**
 * Types for the student app.
 *
 * API shapes are aliases onto shared/types/api.ts, which is generated from the
 * backend's OpenAPI schema (./shared/generate-api-types.sh). A backend DTO
 * change therefore breaks `npm run type-check` here instead of the page at runtime.
 * Anything declared locally below is a client-only shape that never crosses the wire.
 */

import type { components } from '../../../shared/types/api';

export type Schemas = components['schemas'];

/** GET /api/student/{id}/assessment/{aid}/questions → questions[] */
export type Question = Schemas['QuestionResponse'];

/** GET /api/student/{id}/assessment/{aid}/progress */
export type Progress = Schemas['StudentProgressResponse'];

/** GET /api/student/{id}/assessment/{aid}/results → questions[] */
export type QuestionResult = Schemas['QuestionResultDetail'];

/** GET /api/student/{id}/assessment/{aid}/results */
export type Results = Schemas['StudentResultsResponse'];

export type AnswerMode = 'oral' | 'written';

/**
 * Client-side assessment summary, assembled by the store from the questions
 * response. Not an API shape.
 */
export interface Assessment {
  id: string;
  title: string;
  course: string;
  description: string;
  dueDate: string;
  totalQuestions: number;
  timeLimit?: number | null;
  status: string;
  answerMode?: AnswerMode;
  preparationTime?: number | null;
  /** Webcam proctoring. Unset → treat as (answerMode === 'oral'). */
  proctored?: boolean;
  /** Student may navigate back and revise answers before final submit (written v1). */
  allowReview?: boolean;
}

/** POST /api/s3/upload-url */
export type UploadUrlResponse = Schemas['UploadUrlResponse'];

/** Normalised client error thrown by services/api.ts. Not an API shape. */
export interface ApiError {
  message: string;
  status?: number;
  details?: unknown;
}
