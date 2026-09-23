from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime


class SubmitAnswerRequest(BaseModel):
    question_id: str = Field(..., description="Question identifier")
    assessment_id: str = Field(..., description="Assessment identifier")
    answer_type: str = Field("audio", description="'audio', 'text', 'video', or 'skipped'")
    audio_url: Optional[str] = Field(None, description="S3 URL of uploaded audio file (audio answers)")
    duration: Optional[int] = Field(None, description="Recording duration in seconds", ge=0)
    text_content: Optional[str] = Field(None, description="Written answer text (text answers)", min_length=1)
    video_url: Optional[str] = Field(None, description="S3 URL of uploaded video file (video answers)")
    # Sent by the skip path; the service ignores it. Declared so validation does not depend on extra-field tolerance
    mode: Optional[str] = Field(None, description="Answer mode hint: 'oral' or 'written'")


class SubmitAssessmentRequest(BaseModel):
    assessment_id: str = Field(..., description="Assessment identifier")


class QuestionResponse(BaseModel):
    """text is None for gated future questions."""
    id: str
    text: Optional[str] = None
    codeContext: Optional[str] = None
    assessmentId: str
    studentId: str
    difficulty: Optional[str] = None
    topic: Optional[str] = None
    timeLimit: Optional[int] = None
    createdAt: str
    # Only populated in allowReview mode, so the UI can pre-fill revisited answers
    priorAnswer: Optional[str] = None


class StudentQuestionsResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    questions: List[QuestionResponse]
    totalQuestions: int
    currentQuestionIndex: int = 0
    answerMode: str = "oral"
    preparationTime: Optional[int] = None
    proctored: Optional[bool] = None
    allowReview: bool = False
    assessmentTitle: Optional[str] = None
    assessmentCourse: Optional[str] = None
    assessmentDescription: Optional[str] = None


class SubmitAnswerResponse(BaseModel):
    ok: bool = True
    studentId: str
    questionId: str
    answerType: str = "audio"
    audioUrl: Optional[str] = None
    duration: Optional[int] = None
    textContent: Optional[str] = None
    videoUrl: Optional[str] = None
    submittedAt: str
    assessmentId: str


class SubmitProctorChunkRequest(BaseModel):
    assessment_id: str = Field(..., description="Assessment identifier")
    chunk_url: str = Field(..., description="S3 URL of the proctoring chunk")
    chunk_index: int = Field(..., description="Zero-based chunk sequence number", ge=0)
    timestamp: Optional[str] = Field(None, description="ISO timestamp when the chunk was captured")


class SubmitProctorChunkResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    chunkIndex: int


class SubmitConsentRequest(BaseModel):
    assessment_id: str = Field(..., description="Assessment identifier")
    granted: bool = Field(..., description="True if the student consented to proctoring, False if declined")
    consent_version: str = Field(..., description="Version of the consent text the student was shown")
    timestamp: str = Field(..., description="ISO 8601 timestamp of the decision (client-side)")


class SubmitConsentResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    granted: bool
    recordedAt: str


class SubmitAssessmentResponse(BaseModel):
    ok: bool = True
    studentId: str
    assessmentId: str
    status: str
    submittedAt: str
    assessmentTitle: str
    questionsAnswered: int
    totalQuestions: int


class StudentProgressResponse(BaseModel):
    studentId: str
    studentName: str
    studentEmail: str
    assessmentId: str
    assessmentTitle: str
    status: str
    totalQuestions: int
    answeredQuestions: int
    # Authoritative answered set (incl. skips); client uses it over position heuristics after a refresh
    answeredQuestionIds: List[str] = Field(default_factory=list)
    percentage: float
    startedAt: Optional[str] = None
    submittedAt: Optional[str] = None


class QuestionResultDetail(BaseModel):
    questionId: str
    questionNumber: Optional[int] = None
    questionText: str
    questionType: Optional[str] = None
    audioUrl: Optional[str] = None
    transcript: Optional[str] = None
    duration: Optional[int] = None
    totalScore: Optional[int] = None
    correctnessScore: Optional[int] = None
    understandingScore: Optional[int] = None
    maxScore: Optional[int] = None
    feedback: Optional[str] = None
    strengths: Optional[List[str]] = None
    weaknesses: Optional[List[str]] = None
    suggestedImprovements: Optional[List[str]] = None
    evaluatedAt: Optional[str] = None
    # True when the AI could not score this question and no instructor has yet.
    # It is excluded from totalScore and maxScore until someone does.
    awaitingReview: bool = False


class StudentResultsResponse(BaseModel):
    studentId: str
    studentName: str
    studentEmail: str
    assessmentId: str
    assessmentTitle: str
    status: str
    totalScore: int
    maxScore: int
    percentage: float
    grade: str  # Excellent, Competent, Developing, Unsatisfactory
    submittedAt: Optional[str] = None
    evaluatedQuestions: int
    totalQuestions: int
    # Non-zero means percentage is over a partial denominator: that many questions
    # are excluded pending instructor review.
    questionsAwaitingReview: int = 0
    questions: List[QuestionResultDetail]
