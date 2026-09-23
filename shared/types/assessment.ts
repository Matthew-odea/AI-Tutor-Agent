/**
 * Instructor-app names for API shapes. Every alias points into ./api.ts, which is
 * generated from the backend's OpenAPI schema (./shared/generate-api-types.sh), so
 * a backend DTO change breaks the frontend type-check instead of the page.
 */

import type { components } from './api';

export type Schemas = components['schemas'];

export type Assessment = Schemas['AssessmentResponse'];
export type CreateAssessmentRequest = Schemas['CreateAssessmentRequest'];
export type Student = Schemas['StudentResponse'];
export type UploadedStudent = Schemas['UploadedStudent'];
export type StudentProgress = Schemas['StudentProgressItem'];
export type AssessmentResults = Schemas['StudentResultItem'];

/**
 * A question-generation job as the UI tracks it: the 202 kickoff response until
 * the first poll replaces it with the generation-status response. Only the poll
 * carries `startedAt` / `completedAt` / `error`.
 */
export type QuestionGenerationJob =
  | Schemas['QuestionGenerationJobResponse']
  | Schemas['QuestionGenerationStatusResponse'];

/** Cohort summary report. Aggregate only — carries no per-student names, emails, or IDs. */
export type AssessmentReport = Schemas['AssessmentReport'];
