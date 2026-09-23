"""
DTOs for Instructor Assessment endpoints
"""

from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from datetime import datetime


# --- Request Models ---

class CreateAssessmentRequest(BaseModel):
    """Request to create a new assessment"""
    title: str = Field(..., description="Assessment title")
    course: str = Field(..., description="Course name/code")
    description: str = Field(default="", description="Assessment description")
    dueDate: str = Field(..., description="Due date (ISO format)")
    totalQuestions: int = Field(..., description="Number of questions to generate", ge=1, le=20)
    timeLimit: Optional[int] = Field(None, description="Time limit per question in minutes (1–30). Stored and served to students as seconds.", ge=1, le=30)
    accessMode: str = Field("open", description="'open' or 'scheduled'")
    scheduledWindowStart: Optional[str] = Field(None, description="ISO datetime for window start (scheduled mode)")
    scheduledWindowEnd: Optional[str] = Field(None, description="ISO datetime for window end (scheduled mode)")
    autoEvaluate: bool = Field(False, description="Automatically evaluate each student's answers as soon as that student submits")
    autoReport: bool = Field(True, description="Automatically generate a cohort summary report once enough students have submitted")
    autoReportThreshold: Optional[int] = Field(None, description="Submissions required before the first auto-report (default 10). Regenerates at each further multiple.", ge=1, le=10000)
    rubric: Optional[str] = Field(None, description="Custom grading rubric injected into the evaluation prompt")
    answerMode: str = Field("oral", description="'oral' or 'written' — controls student answer interface")
    preparationTime: Optional[int] = Field(None, description="Seconds of prep time shown before oral recording starts (0 = start immediately)", ge=0, le=300)
    proctored: Optional[bool] = Field(None, description="Webcam proctoring on/off. When unset, defaults to (answerMode == 'oral') for backward compatibility.")
    allowReview: bool = Field(False, description="Allow students to navigate back and revise earlier answers before final submit (written mode in v1).")
    feedbackRelease: str = Field("manual", description="'immediate' (results shown as soon as graded) or 'manual' (instructor must release).")
    maxScorePerQuestion: Optional[int] = Field(None, description="Override max marks per question (default 10)", ge=1, le=100)
    gradeCutoffs: Optional[Dict[str, float]] = Field(None, description="Override grade cutoffs as percentages, e.g. {'excellent': 90, 'competent': 75, 'developing': 60}")


class UploadedStudent(BaseModel):
    """Student data for bulk upload"""
    name: str
    email: str
    studentId: str
    code: str
    assignmentFile: Optional[str] = None


class UploadStudentsRequest(BaseModel):
    """Request to upload students to an assessment"""
    students: List[UploadedStudent] = Field(..., description="List of students to enroll")


class GenerateQuestionsBatchRequest(BaseModel):
    """Request to start batch question generation"""
    studentIds: Optional[List[str]] = Field(None, description="Specific student IDs (or all if empty)")


class EvaluateBatchRequest(BaseModel):
    """Request to start batch evaluation"""
    studentIds: Optional[List[str]] = Field(None, description="Specific student IDs (or all if empty)")


class UpdateBriefRequest(BaseModel):
    """Request to update the assignment brief"""
    brief: str = Field(..., description="Assignment brief text (min 50 characters)", min_length=50)


# --- Response Models ---

class AssessmentResponse(BaseModel):
    """Assessment data response"""
    id: str
    createdBy: Optional[str] = None
    title: str
    course: str
    description: str
    dueDate: str
    totalQuestions: int
    timeLimit: Optional[int] = None
    accessMode: str = "open"
    scheduledWindowStart: Optional[str] = None
    scheduledWindowEnd: Optional[str] = None
    assignmentBrief: Optional[str] = None
    autoEvaluate: bool = False
    autoReport: bool = True
    autoReportThreshold: Optional[int] = None
    rubric: Optional[str] = None
    answerMode: str = "oral"
    preparationTime: Optional[int] = None
    proctored: bool = False
    allowReview: bool = False
    feedbackRelease: str = "manual"
    maxScorePerQuestion: Optional[int] = None
    gradeCutoffs: Optional[Dict[str, float]] = None
    resultsReleased: bool = False
    status: str
    createdAt: str
    updatedAt: str


class AssessmentListResponse(BaseModel):
    """Response with list of assessments"""
    ok: bool = True
    assessments: List[AssessmentResponse]
    total: int


class StudentResponse(BaseModel):
    """Student enrollment data"""
    studentId: str
    name: str = ""
    email: str = ""
    code: str = ""
    assignmentFile: Optional[str] = ""
    status: str = ""
    enrolledAt: str = ""


class StudentListResponse(BaseModel):
    """Response with list of students"""
    ok: bool = True
    assessmentId: str
    students: List[StudentResponse]
    total: int


class StudentProgressItem(BaseModel):
    """Individual student progress"""
    studentId: str
    name: str
    email: str
    status: str
    totalQuestions: int
    answeredQuestions: int
    percentage: float
    startedAt: Optional[str] = None
    submittedAt: Optional[str] = None


class ProgressSummaryResponse(BaseModel):
    """Response with progress for all students"""
    ok: bool = True
    assessmentId: str
    students: List[StudentProgressItem]
    summary: dict  # Stats: total, not-started, in-progress, completed


class StudentResultItem(BaseModel):
    """Individual student result"""
    studentId: str
    name: str
    email: str
    totalScore: int
    maxScore: int
    percentage: float
    grade: str
    completedAt: Optional[str] = None


class ResultsSummaryResponse(BaseModel):
    """Response with results for all students"""
    ok: bool = True
    assessmentId: str
    results: List[StudentResultItem]
    summary: dict  # Stats: avg score, grade distribution


class AssessmentReportResponse(BaseModel):
    """Cohort summary report. Aggregate only — carries no per-student identifiers."""
    ok: bool = True
    assessmentId: str
    generated: bool = Field(..., description="False when no report has been generated yet")
    report: Optional[dict] = None


class GenerateReportResponse(BaseModel):
    """Response after a manual report generation request."""
    ok: bool = True
    assessmentId: str
    report: dict


class QuestionGenerationJobResponse(BaseModel):
    """Response after starting question generation"""
    ok: bool = True
    jobId: str
    assessmentId: str
    status: str  # pending, running, completed, failed
    totalStudents: int
    processedCount: int
    failedCount: int = 0
    message: str


class QuestionGenerationStatusResponse(BaseModel):
    """Response for generation job status check"""
    jobId: str
    assessmentId: str
    status: str
    totalStudents: int
    processedCount: int
    failedCount: int = 0
    startedAt: str
    completedAt: Optional[str] = None
    error: Optional[str] = None


class EvaluationJobResponse(BaseModel):
    """Response after starting evaluation"""
    ok: bool = True
    jobId: str
    assessmentId: str
    status: str
    totalStudents: int
    processedCount: int
    message: str


class EvaluationStatusResponse(BaseModel):
    """Response for evaluation job status check"""
    jobId: str
    assessmentId: str
    status: str
    totalStudents: int
    processedCount: int
    startedAt: str
    completedAt: Optional[str] = None
    error: Optional[str] = None


# ── Sprint 8: Results Dashboards (EPIC-6-1 to 6-4) ───────────────

class ScoreOverrideRequest(BaseModel):
    """Instructor override for a question score"""
    score: int = Field(..., description="Override score (0-10)", ge=0, le=10)
    comment: Optional[str] = Field(None, description="Instructor comment")


class ScoreOverrideResponse(BaseModel):
    """Response after applying a score override"""
    ok: bool = True
    assessmentId: str
    studentId: str
    questionId: str
    instructorScore: int
    comment: Optional[str] = None


class ProctorChunkItem(BaseModel):
    """Single proctoring chunk entry"""
    chunkIndex: int
    chunkUrl: str
    recordedAt: Optional[str] = None


class ProctorChunkHealthResponse(BaseModel):
    """Proctoring chunk manifest for a student"""
    ok: bool = True
    studentId: str
    assessmentId: str
    totalChunks: int
    missingIndexes: List[int]
    chunks: List[ProctorChunkItem]


class InstructorQuestionDetail(BaseModel):
    """Per-question detail in instructor student view"""
    questionId: str
    questionText: str
    answerType: Optional[str] = None
    audioUrl: Optional[str] = None
    videoUrl: Optional[str] = None
    textContent: Optional[str] = None
    duration: Optional[int] = None
    transcript: Optional[str] = None
    transcriptStatus: Optional[str] = None
    transcriptConfidence: Optional[float] = None
    aiScore: Optional[int] = None
    correctnessScore: Optional[int] = None
    understandingScore: Optional[int] = None
    instructorScore: Optional[int] = None
    effectiveScore: Optional[int] = None
    maxScore: int = 10
    feedback: Optional[str] = None
    strengths: Optional[str | list] = None
    weaknesses: Optional[str | list] = None
    improvements: Optional[str | list] = None
    suggestedImprovements: Optional[str | list] = None
    instructorComment: Optional[str] = None
    evaluatedAt: Optional[str] = None
    # Review flags (Tasks 4 & 5)
    needsReview: bool = False
    reviewReasons: Optional[List[str]] = None
    evaluationMethod: Optional[str] = None
    # Human reference score for the dual-scoring validity harness (Task 3)
    humanCorrectnessScore: Optional[int] = None
    humanUnderstandingScore: Optional[int] = None
    humanTotalScore: Optional[int] = None
    humanScoredBy: Optional[str] = None
    humanScoredAt: Optional[str] = None


class ConsentInfo(BaseModel):
    """Student's webcam-proctoring consent decision (granted=False = declined)."""
    granted: bool
    consentVersion: Optional[str] = None
    recordedAt: Optional[str] = None
    timestamp: Optional[str] = None


class InstructorStudentDetailResponse(BaseModel):
    """Per-student detailed results for instructor view"""
    ok: bool = True
    studentId: str
    studentName: str
    studentEmail: str
    assessmentId: str
    totalScore: float
    maxScore: int
    percentage: float
    grade: str
    submittedAt: Optional[str] = None
    questions: List[InstructorQuestionDetail]
    proctoring: ProctorChunkHealthResponse
    # None when the student never recorded a consent decision.
    consent: Optional[ConsentInfo] = None


class ReleaseResultsResponse(BaseModel):
    """Response after releasing results to students"""
    ok: bool = True
    assessmentId: str
    resultsReleased: bool
    warning: Optional[str] = None
    flaggedCount: Optional[int] = None


# ── Dual-scoring validity harness (Task 3) + review flagging (Task 5) ────────

class RecordHumanScoreRequest(BaseModel):
    """Record a human reference score for a question (dual-scoring harness)."""
    humanCorrectnessScore: int = Field(..., description="Human correctness score (0-5)", ge=0, le=5)
    humanUnderstandingScore: int = Field(..., description="Human understanding score (0-5)", ge=0, le=5)
    scoredBy: Optional[str] = Field(None, description="Identifier of the human scorer")


class RecordHumanScoreResponse(BaseModel):
    """Response after recording a human reference score."""
    ok: bool = True
    assessmentId: str
    studentId: str
    questionId: str
    humanCorrectnessScore: int
    humanUnderstandingScore: int
    humanTotalScore: int
    humanScoredBy: Optional[str] = None
    humanScoredAt: Optional[str] = None


class ScoreAgreementResponse(BaseModel):
    """AI-vs-human agreement summary across all dual-scored items."""
    ok: bool = True
    assessmentId: str
    dualScoredCount: int
    exactMatchRate: Optional[float] = None
    within1Rate: Optional[float] = None
    meanAbsoluteDifference: Optional[float] = None
    items: List[Dict[str, Any]] = []


class FlaggedEvaluationsResponse(BaseModel):
    """Evaluations flagged for human review before release."""
    ok: bool = True
    assessmentId: str
    flaggedCount: int
    items: List[Dict[str, Any]] = []


class SendReminderResponse(BaseModel):
    """Response after sending a reminder email"""
    ok: bool = True
    studentId: str
    assessmentId: str
    message: str


# ── Sprint 9: Question Preview and Editing (EPIC-3-3) ────────────────

class StudentQuestionItem(BaseModel):
    """A single student-specific generated question"""
    id: str
    text: str
    questionNumber: int
    questionType: str
    difficulty: str
    topic: str
    timeLimit: Optional[int] = None
    createdAt: str


class StudentQuestionListResponse(BaseModel):
    """Response with all questions for one student"""
    ok: bool = True
    assessmentId: str
    studentId: str
    questions: List[StudentQuestionItem]
    total: int


class UpdateStudentQuestionRequest(BaseModel):
    """Instructor edits the text (and optionally time limit) of a generated question"""
    text: str = Field(..., description="Updated question text", min_length=10)
    timeLimit: Optional[int] = Field(None, description="Per-question time limit in minutes (1–30). Stored as seconds.", ge=1, le=30)


class AddStudentQuestionRequest(BaseModel):
    """Instructor manually adds a question for a specific student"""
    text: str = Field(..., description="Question text", min_length=10)
    questionType: str = Field("manual", description="Question type")
    difficulty: str = Field("medium", description="easy / medium / hard")
    topic: str = Field("general", description="Question topic")
    timeLimit: Optional[int] = Field(None, description="Per-question time limit in minutes (1–30). Stored as seconds.", ge=1, le=30)


class StudentQuestionResponse(BaseModel):
    """Response after creating or updating a student question"""
    ok: bool = True
    question: StudentQuestionItem


class DeleteStudentQuestionResponse(BaseModel):
    """Response after deleting a student question"""
    ok: bool = True
    deletedId: str
