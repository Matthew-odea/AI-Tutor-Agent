/**
 * Instructor-app names for API shapes, aliased onto ./api.ts (generated from the backend's
 * OpenAPI schema by ./shared/generate-api-types.sh), so a DTO change breaks the type-check.
 */

import type { components } from './api';

export type Schemas = components['schemas'];

export type Assessment = Schemas['AssessmentResponse'];
export type CreateAssessmentRequest = Schemas['CreateAssessmentRequest'];
export type Student = Schemas['StudentResponse'];
export type UploadedStudent = Schemas['UploadedStudent'];
export type StudentProgress = Schemas['StudentProgressItem'];
export type AssessmentResults = Schemas['StudentResultItem'];

/** The 202 kickoff response until the first poll replaces it; only the poll carries startedAt/completedAt/error. */
export type QuestionGenerationJob =
  | Schemas['QuestionGenerationJobResponse']
  | Schemas['QuestionGenerationStatusResponse'];

/** Cohort summary report. Aggregate only — carries no per-student names, emails, or IDs. */
export type AssessmentReport = Schemas['AssessmentReport'];
