/**
 * Instructor-app names for API shapes. Every alias points into ./api.ts, which is
 * generated from the backend's OpenAPI schema (./shared/generate-api-types.sh), so
 * a backend DTO change breaks the frontend type-check instead of the page.
 * Only AssessmentReport is hand-kept — see its comment.
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

/**
 * Cohort summary report. Aggregate only — deliberately carries no per-student
 * names, emails, or IDs so it can be exported or shared as-is.
 *
 * Hand-kept: the backend returns `report` as an untyped dict, so the OpenAPI
 * schema has nothing to generate from. Give AssessmentReportResponse.report a
 * Pydantic model and this can become an alias like the rest.
 */
export interface AssessmentReport {
  assessmentId: string;
  assessmentTitle: string;
  course: string;
  generatedAt: string;
  triggeredBy: 'auto_threshold' | 'manual';
  milestone?: number | null;
  counts: {
    enrolled: number;
    submitted: number;
    evaluated: number;
    notEvaluated: number;
  };
  scores: {
    average: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
    stdDev: number | null;
  };
  gradeDistribution: Record<string, number | Record<string, number>>;
  histogram: Array<{ bucket: string; count: number }>;
  dimensions: {
    answersEvaluated: number;
    averageCorrectness: number | null;
    averageUnderstanding: number | null;
    needsReviewCount: number;
  };
  /** LLM-written prose summary. Null when unavailable — the numbers stand alone. */
  narrative?: string | null;
}
