// Core domain types for oral assessment system

export interface Assessment {
  id: string;
  title: string;
  description: string;
  course: string;
  dueDate: string;
  totalQuestions: number;
  timeLimit?: number; // minutes per question
  createdAt: string;
  createdBy: string;
  status: 'draft' | 'active' | 'completed' | 'archived';
  resultsReleased?: boolean;
  accessMode?: 'open' | 'scheduled';
  scheduledWindowStart?: string;
  scheduledWindowEnd?: string;
  assignmentBrief?: string;
}

export interface Student {
  id: string;
  name: string;
  email: string;
  studentId: string;
}

export interface Question {
  id: string;
  assessmentId: string;
  studentId: string;
  questionNumber: number;
  questionText: string;
  context?: string; // Student's code or assignment context
  expectedTopics?: string[];
  generatedAt: string;
}

export interface StudentAnswer {
  id: string;
  questionId: string;
  studentId: string;
  audioUrl: string;
  transcription?: string;
  recordedAt: string;
  duration: number; // seconds
}

export interface Evaluation {
  id: string;
  answerId: string;
  questionId: string;
  studentId: string;
  correctnessScore: number; // 0-5
  understandingScore: number; // 0-5
  feedback: string;
  strengths: string[];
  weaknesses: string[];
  evaluatedAt: string;
}

export interface StudentProgress {
  studentId: string;
  assessmentId: string;
  // Both progress endpoints (instructor StudentProgressItem and student
  // StudentProgressResponse) spell this `answeredQuestions`. Only the submit
  // response uses `questionsAnswered` — don't copy that name here.
  answeredQuestions: number;
  totalQuestions: number;
  name?: string;
  email?: string;
  percentage?: number;
  currentQuestion?: number;
  status: 'not-started' | 'in-progress' | 'completed' | 'submitted';
  startedAt?: string;
  submittedAt?: string;
}

export interface AssessmentResults {
  studentId: string;
  assessmentId: string;
  name?: string;
  email?: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: 'Excellent' | 'Competent' | 'Developing' | 'Unsatisfactory';
  evaluations: Evaluation[];
  overallFeedback: string;
  completedAt: string;
}

export interface UploadedStudent {
  name: string;
  email: string;
  studentId: string;
  code: string; // Student's submitted code
  assignmentFile?: string; // Path to assignment file
}

export interface QuestionGenerationJob {
  jobId: string;
  assessmentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  totalStudents: number;
  processedCount: number;
  failedCount: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface EvaluationJob {
  jobId: string;
  assessmentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  totalStudents: number;
  processedCount: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

// API Request/Response types
export interface CreateAssessmentRequest {
  title: string;
  description: string;
  course: string;
  dueDate: string;
  totalQuestions: number;
  timeLimit?: number;
  accessMode?: 'open' | 'scheduled';
  scheduledWindowStart?: string;
  scheduledWindowEnd?: string;
  answerMode?: 'oral' | 'written';
  preparationTime?: number;
  /** Webcam proctoring. Unset → backend defaults to (answerMode === 'oral'). */
  proctored?: boolean;
  /** Allow students to navigate back and revise answers before final submit (written v1). */
  allowReview?: boolean;
  /** 'immediate' shows results as soon as graded; 'manual' requires instructor release. */
  feedbackRelease?: 'immediate' | 'manual';
  /** Automatically evaluate each student's answers as soon as that student submits. */
  autoEvaluate?: boolean;
  /** Automatically generate a cohort report once enough students have submitted. */
  autoReport?: boolean;
  /** Submissions before the first auto-report (default 10); regenerates at each further multiple. */
  autoReportThreshold?: number;
}

/**
 * Cohort summary report. Aggregate only — deliberately carries no per-student
 * names, emails, or IDs so it can be exported or shared as-is.
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

export interface UploadStudentsRequest {
  assessmentId: string;
  students: UploadedStudent[];
}

export interface GenerateQuestionsRequest {
  assessmentId: string;
  studentIds?: string[]; // If empty, generate for all students
}

export interface SubmitAnswerRequest {
  questionId: string;
  studentId: string;
  audioFile: File;
}

export interface GetPresignedUrlRequest {
  assessmentId: string;
  studentId: string;
  questionId: string;
  fileName: string;
  contentType: string;
}

export interface PresignedUrlResponse {
  uploadUrl: string;
  fileUrl: string;
  key: string;
}
