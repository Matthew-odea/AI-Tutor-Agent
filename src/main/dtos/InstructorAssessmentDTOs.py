from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Union
from datetime import datetime


# Requests

class CreateAssessmentRequest(BaseModel):
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
    name: str
    email: str
    studentId: str
    code: str
    assignmentFile: Optional[str] = None


class UploadStudentsRequest(BaseModel):
    students: List[UploadedStudent] = Field(..., description="List of students to enroll")


class GenerateQuestionsBatchRequest(BaseModel):
    studentIds: Optional[List[str]] = Field(None, description="Specific student IDs (or all if empty)")


class EvaluateBatchRequest(BaseModel):
    studentIds: Optional[List[str]] = Field(None, description="Specific student IDs (or all if empty)")


class UpdateBriefRequest(BaseModel):
    brief: str = Field(..., description="Assignment brief text (min 50 characters)", min_length=50)


# Responses

class AssessmentResponse(BaseModel):
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
    ok: bool = True
    assessments: List[AssessmentResponse]
    total: int


class StudentResponse(BaseModel):
    studentId: str
    name: str = ""
    email: str = ""
    code: str = ""
    assignmentFile: Optional[str] = ""
    status: str = ""
    enrolledAt: str = ""


class StudentListResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    students: List[StudentResponse]
    total: int


class StudentProgressItem(BaseModel):
    studentId: str
    name: str
    email: str
    status: str
    totalQuestions: int
    answeredQuestions: int
    percentage: float
    startedAt: Optional[str] = None
    submittedAt: Optional[str] = None


class ProgressSummary(BaseModel):
    """Student counts by status."""
    total: int
    notStarted: int
    inProgress: int
    completed: int


class ProgressSummaryResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    students: List[StudentProgressItem]
    summary: ProgressSummary


class StudentResultItem(BaseModel):
    studentId: str
    name: str
    email: str
    totalScore: int
    maxScore: int
    percentage: float
    grade: str
    completedAt: Optional[str] = None


class ResultsSummary(BaseModel):
    averageScore: float
    gradeDistribution: Dict[str, int]


class ResultsSummaryResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    results: List[StudentResultItem]
    summary: ResultsSummary


class ReportCounts(BaseModel):
    enrolled: int
    submitted: int
    evaluated: int
    notEvaluated: int


class ReportScores(BaseModel):
    """Percentage statistics over evaluated students; all None when none are evaluated."""
    average: Optional[float]
    median: Optional[float]
    min: Optional[float]
    max: Optional[float]
    stdDev: Optional[float]


class GradeCutoffs(BaseModel):
    excellent: float
    competent: float
    developing: float


class ReportHistogramBucket(BaseModel):
    bucket: str
    count: int


class ReportDimensions(BaseModel):
    answersEvaluated: int
    averageCorrectness: Optional[float]
    averageUnderstanding: Optional[float]
    needsReviewCount: int


class AssessmentReport(BaseModel):
    """Cohort summary report, as built by AssessmentReportService.generate_report."""
    assessmentId: str
    assessmentTitle: str
    course: str
    generatedAt: str
    triggeredBy: str = Field(..., description="'manual' or 'auto_threshold'")
    milestone: Optional[int]
    counts: ReportCounts
    scores: ReportScores
    # Grade band -> count, plus a "_cutoffs" key holding the cutoffs used.
    gradeDistribution: Dict[str, Union[int, GradeCutoffs]]
    histogram: List[ReportHistogramBucket]
    dimensions: ReportDimensions
    narrative: Optional[str] = Field(..., description="LLM prose summary; None when unavailable")


class AssessmentReportResponse(BaseModel):
    """Cohort summary report. Aggregate only, carries no per-student identifiers."""
    ok: bool = True
    assessmentId: str
    generated: bool = Field(..., description="False when no report has been generated yet")
    report: Optional[AssessmentReport] = None


class GenerateReportResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    report: AssessmentReport


class QuestionGenerationJobResponse(BaseModel):
    ok: bool = True
    jobId: str
    assessmentId: str
    status: str  # pending, running, completed, failed
    totalStudents: int
    processedCount: int
    failedCount: int = 0
    message: str


class QuestionGenerationStatusResponse(BaseModel):
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
    ok: bool = True
    jobId: str
    assessmentId: str
    status: str
    totalStudents: int
    processedCount: int
    message: str


class EvaluationStatusResponse(BaseModel):
    jobId: str
    assessmentId: str
    status: str
    totalStudents: int
    processedCount: int
    startedAt: str
    completedAt: Optional[str] = None
    error: Optional[str] = None


# Results, overrides and proctoring

class ScoreOverrideRequest(BaseModel):
    # le=100 is only the absolute ceiling (maxScorePerQuestion's own cap); the service
    # validates against the question's actual max.
    score: int = Field(..., description="Override score (0 to the question's max score)", ge=0, le=100)
    comment: Optional[str] = Field(None, description="Instructor comment")


class ScoreOverrideResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    studentId: str
    questionId: str
    instructorScore: int
    comment: Optional[str] = None


class ProctorChunkItem(BaseModel):
    chunkIndex: int
    chunkUrl: str
    recordedAt: Optional[str] = None


class ProctorChunkHealthResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    totalChunks: int
    missingIndexes: List[int]
    chunks: List[ProctorChunkItem]


class InstructorQuestionDetail(BaseModel):
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
    strengths: Optional[str | List[str]] = None
    weaknesses: Optional[str | List[str]] = None
    improvements: Optional[str | List[str]] = None
    suggestedImprovements: Optional[str | List[str]] = None
    instructorComment: Optional[str] = None
    evaluatedAt: Optional[str] = None
    needsReview: bool = False
    reviewReasons: Optional[List[str]] = None
    evaluationMethod: Optional[str] = None
    # Dual-scoring harness reference score, separate from instructorScore
    humanCorrectnessScore: Optional[int] = None
    humanUnderstandingScore: Optional[int] = None
    humanTotalScore: Optional[int] = None
    humanScoredBy: Optional[str] = None
    humanScoredAt: Optional[str] = None


class ConsentInfo(BaseModel):
    """Webcam-proctoring consent decision (granted=False means declined)."""
    granted: bool
    consentVersion: Optional[str] = None
    recordedAt: Optional[str] = None
    timestamp: Optional[str] = None


class InstructorStudentDetailResponse(BaseModel):
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
    ok: bool = True
    assessmentId: str
    resultsReleased: bool
    warning: Optional[str] = None
    flaggedCount: Optional[int] = None


# Dual-scoring harness and review flags

class RecordHumanScoreRequest(BaseModel):
    """Human reference score for the dual-scoring harness; kept separate from the instructor override."""
    humanCorrectnessScore: int = Field(..., description="Human correctness score (0-5)", ge=0, le=5)
    humanUnderstandingScore: int = Field(..., description="Human understanding score (0-5)", ge=0, le=5)
    scoredBy: Optional[str] = Field(None, description="Identifier of the human scorer")


class RecordHumanScoreResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    studentId: str
    questionId: str
    humanCorrectnessScore: int
    humanUnderstandingScore: int
    humanTotalScore: int
    humanScoredBy: Optional[str] = None
    humanScoredAt: Optional[str] = None


class ScoreAgreementItem(BaseModel):
    """One dual-scored answer: AI score vs the human reference score."""
    studentId: str
    questionId: str
    aiTotal: int
    humanTotal: int
    difference: int
    aiCorrectness: Optional[int]
    humanCorrectness: Optional[int]
    aiUnderstanding: Optional[int]
    humanUnderstanding: Optional[int]


class ScoreAgreementResponse(BaseModel):
    """AI-vs-human agreement across all dual-scored items."""
    ok: bool = True
    assessmentId: str
    dualScoredCount: int
    exactMatchRate: Optional[float] = None
    within1Rate: Optional[float] = None
    meanAbsoluteDifference: Optional[float] = None
    items: List[ScoreAgreementItem] = []


class FlaggedEvaluationItem(BaseModel):
    studentId: str
    questionId: str
    reasons: List[str]
    aiScore: Optional[int]
    evaluationMethod: Optional[str]


class FlaggedEvaluationsResponse(BaseModel):
    """Evaluations flagged for human review before release."""
    ok: bool = True
    assessmentId: str
    flaggedCount: int
    items: List[FlaggedEvaluationItem] = []


class UploadStudentsResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    studentsUploaded: int


class ImportFromEdRequest(BaseModel):
    """Both fields are required; a missing or empty one answers 400 missing_fields."""
    edToken: Optional[str] = None
    challengeId: Optional[int] = None


class ImportedStudentSummary(BaseModel):
    studentId: str
    name: Optional[str]
    hasCode: bool


class ImportFromEdResponse(BaseModel):
    ok: bool = True
    studentsImported: int
    students: List[ImportedStudentSummary]


class StudentInviteRequest(BaseModel):
    """Optional email customisation; {{name}}, {{title}}, {{link}} are substituted."""
    subject: Optional[str] = None
    message: Optional[str] = None


class StudentInviteResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    inviteToken: str
    inviteLink: str
    emailSent: bool = Field(..., description="False when the student has no email on file")


class SendInvitesRequest(StudentInviteRequest):
    studentIds: Optional[List[str]] = Field(None, description="Restrict the send to these students; omit for everyone enrolled")
    next: Optional[str] = Field(None, description="'results' points the link at the student's feedback")


class SendInvitesResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    sent: int
    skipped: int = Field(..., description="Students with no email, or whose send failed")
    total: int


class SendReminderResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    message: str


# Per-student question editing

class StudentQuestionItem(BaseModel):
    id: str
    text: str
    questionNumber: int
    questionType: str
    difficulty: str
    topic: str
    timeLimit: Optional[int] = None
    createdAt: str


class StudentQuestionListResponse(BaseModel):
    ok: bool = True
    assessmentId: str
    studentId: str
    questions: List[StudentQuestionItem]
    total: int


class UpdateStudentQuestionRequest(BaseModel):
    text: str = Field(..., description="Updated question text", min_length=10)
    timeLimit: Optional[int] = Field(None, description="Per-question time limit in minutes (1–30). Stored as seconds.", ge=1, le=30)


class AddStudentQuestionRequest(BaseModel):
    text: str = Field(..., description="Question text", min_length=10)
    questionType: str = Field("manual", description="Question type")
    difficulty: str = Field("medium", description="easy / medium / hard")
    topic: str = Field("general", description="Question topic")
    timeLimit: Optional[int] = Field(None, description="Per-question time limit in minutes (1–30). Stored as seconds.", ge=1, le=30)


class StudentQuestionResponse(BaseModel):
    ok: bool = True
    question: StudentQuestionItem


class DeleteStudentQuestionResponse(BaseModel):
    ok: bool = True
    deletedId: str
