from __future__ import annotations

import asyncio
import logging

import io

from fastapi import APIRouter, BackgroundTasks, Body, Depends
from fastapi.responses import StreamingResponse as _StreamingResponse

from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.api_errors import ApiError
from src.main.controllers.controller_helpers import _assert_student_access
from src.main.controllers.controller_dependencies import (
    get_assessment_report_service,
    get_instructor_assessment_service,
    get_oral_assessment_service,
    get_sqs_job_dispatcher,
)
from src.main.service.AssessmentReportService import AssessmentReportService
from src.main.service.BatchJobManager import JobType, get_batch_job_manager
from src.main.service.InstructorAssessmentService import InstructorAssessmentService, InstructorAssessmentServiceError
from src.main.service.SQSJobDispatcher import SQSJobDispatcher
from src.main.dtos.StudentAssessmentDTOs import (
    QuestionResponse,
    StudentProgressResponse,
    StudentQuestionsResponse,
    StudentResultsResponse,
    SubmitAnswerRequest,
    SubmitAnswerResponse,
    SubmitAssessmentRequest,
    SubmitAssessmentResponse,
    SubmitConsentRequest,
    SubmitConsentResponse,
    SubmitProctorChunkRequest,
    SubmitProctorChunkResponse,
)
from src.main.service.OralAssessmentService import OralAssessmentService, OralAssessmentServiceError


logger = logging.getLogger(__name__)


student_router = APIRouter(prefix="/api/student", tags=["student"])


@student_router.get("/{student_id}/assessment/{assessment_id}/questions", response_model=StudentQuestionsResponse)
async def get_student_questions(
    student_id: str,
    assessment_id: str,
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_student_access(_principal, student_id, assessment_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: svc.get_student_questions(student_id, assessment_id))

        # result is now {"questions": [...], "answerMode": ..., "preparationTime": ...}
        raw_questions = result.get("questions", []) if isinstance(result, dict) else result

        question_dtos = [
            QuestionResponse(
                id=q["id"],
                text=q.get("text", ""),
                codeContext=q.get("codeContext"),
                assessmentId=q.get("assessmentId", assessment_id),
                studentId=q.get("studentId", student_id),
                difficulty=q.get("difficulty"),
                topic=q.get("topic"),
                timeLimit=q.get("timeLimit"),
                createdAt=q.get("createdAt", ""),
                priorAnswer=q.get("priorAnswer"),
            )
            for q in raw_questions
        ]

        return StudentQuestionsResponse(
            studentId=student_id,
            assessmentId=assessment_id,
            questions=question_dtos,
            totalQuestions=len(question_dtos),
            currentQuestionIndex=result.get("currentQuestionIndex", 0) if isinstance(result, dict) else 0,
            answerMode=result.get("answerMode", "oral") if isinstance(result, dict) else "oral",
            preparationTime=result.get("preparationTime") if isinstance(result, dict) else None,
            proctored=result.get("proctored") if isinstance(result, dict) else None,
            allowReview=result.get("allowReview", False) if isinstance(result, dict) else False,
            assessmentTitle=result.get("assessmentTitle") if isinstance(result, dict) else None,
            assessmentCourse=result.get("assessmentCourse") if isinstance(result, dict) else None,
            assessmentDescription=result.get("assessmentDescription") if isinstance(result, dict) else None,
        )

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=404, code="student_questions_not_found", message=str(error))


@student_router.post("/{student_id}/answer", response_model=SubmitAnswerResponse)
async def submit_answer(
    student_id: str,
    request: SubmitAnswerRequest = Body(...),
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_student_access(_principal, student_id, request.assessment_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: svc.submit_answer(
            student_id=student_id,
            question_id=request.question_id,
            assessment_id=request.assessment_id,
            answer_type=request.answer_type,
            audio_url=request.audio_url,
            duration=request.duration,
            text_content=request.text_content,
            video_url=request.video_url,
        ))

        return SubmitAnswerResponse(**result)

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=400, code="submit_answer_failed", message=str(error))


@student_router.put("/{student_id}/submit", response_model=SubmitAssessmentResponse)
async def submit_assessment(
    student_id: str,
    background: BackgroundTasks,
    request: SubmitAssessmentRequest = Body(...),
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    instructor_svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    dispatcher: SQSJobDispatcher = Depends(get_sqs_job_dispatcher),
    report_svc: AssessmentReportService = Depends(get_assessment_report_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_student_access(_principal, student_id, request.assessment_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: svc.submit_assessment(
            student_id=student_id,
            assessment_id=request.assessment_id,
        ))

        # Auto-evaluate THIS student's answers as soon as they submit. Evaluation
        # is per-student, not gated on the whole roster finishing: an open or
        # formative assessment may never reach 100% submission (only a subset of
        # enrolled students ever participate), so a "wait for all" gate would mean
        # feedback never fires. Runs as a BackgroundTask so the student's submit
        # response isn't blocked on enqueueing, and the work is owned by the server's
        # request lifecycle rather than a daemon thread killed mid-flight on redeploy.
        def _auto_evaluate_student():
            try:
                assessment = instructor_svc.get_assessment(request.assessment_id)
                if not assessment.get("autoEvaluate"):
                    # Logged rather than returning quietly: this branch silently
                    # swallowed every auto-evaluation for months because the
                    # assessment view dropped the flag entirely.
                    logger.info(
                        "[AutoEval] Skipped for student %s — autoEvaluate is off for assessment %s",
                        student_id, request.assessment_id,
                    )
                    return
                job_manager = get_batch_job_manager()
                job_id = job_manager.create_job(
                    job_type=JobType.EVALUATION,
                    assessment_id=request.assessment_id,
                    total_items=1,
                    metadata={
                        "assessment_title": assessment.get("title", ""),
                        "trigger": "auto_on_submit",
                        "student_id": student_id,
                    },
                )
                enqueued = dispatcher.enqueue_evaluation_batch(
                    job_id=job_id,
                    assessment_id=request.assessment_id,
                    students=[{"studentId": student_id}],
                )
                if enqueued:
                    logger.info(
                        "[AutoEval] Enqueued evaluation for student %s in assessment %s (job %s, %d message)",
                        student_id, request.assessment_id, job_id, enqueued,
                    )
                else:
                    # enqueue_evaluation_batch swallows ClientError and returns 0,
                    # so without this the job sits at pending forever and nobody
                    # finds out the student was never marked.
                    logger.error(
                        "[AutoEval] Enqueue produced no message for student %s in assessment %s "
                        "(job %s) — student will not be marked until re-run",
                        student_id, request.assessment_id, job_id,
                    )
            except Exception as auto_err:
                logger.error("[AutoEval] Failed to trigger per-student auto-evaluation: %s", auto_err)

        # Generate a cohort report once submissions cross a threshold multiple
        # (default every 10). The old "all enrolled have submitted" gate never
        # opened for a large cohort — Quiz 1 stalled at 26/395 — so the trigger
        # is count-based. claim_milestone() makes this exactly-once per
        # milestone even when several students submit concurrently.
        def _maybe_generate_report():
            try:
                decision = report_svc.should_generate_on_submit(request.assessment_id)
                if not decision:
                    return
                job_manager = get_batch_job_manager()
                job_id = job_manager.create_job(
                    job_type=JobType.REPORT_GENERATION,
                    assessment_id=request.assessment_id,
                    total_items=1,
                    metadata={
                        "trigger": "auto_threshold",
                        "milestone": decision["milestone"],
                        "threshold": decision["threshold"],
                        "submitted_count": decision["submittedCount"],
                    },
                )
                dispatcher.enqueue_report_generation(
                    job_id=job_id,
                    assessment_id=request.assessment_id,
                    triggered_by="auto_threshold",
                    milestone=decision["milestone"],
                )
                logger.info(
                    "[AutoReport] Enqueued report for assessment %s at %d submissions "
                    "(milestone %d, job %s)",
                    request.assessment_id, decision["submittedCount"],
                    decision["milestone"], job_id,
                )
            except Exception as report_err:
                logger.error("[AutoReport] Failed to trigger threshold report: %s", report_err)

        background.add_task(_auto_evaluate_student)
        background.add_task(_maybe_generate_report)

        return SubmitAssessmentResponse(**result)

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=400, code="submit_assessment_failed", message=str(error))


@student_router.get("/{student_id}/assessment/{assessment_id}/progress", response_model=StudentProgressResponse)
async def get_student_progress(
    student_id: str,
    assessment_id: str,
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_student_access(_principal, student_id, assessment_id)
        loop = asyncio.get_event_loop()
        progress = await loop.run_in_executor(None, lambda: svc.get_student_progress(student_id, assessment_id))
        return StudentProgressResponse(**progress)

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=404, code="student_progress_not_found", message=str(error))


@student_router.get("/{student_id}/assessment/{assessment_id}/results", response_model=StudentResultsResponse)
async def get_student_results(
    student_id: str,
    assessment_id: str,
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_student_access(_principal, student_id, assessment_id)
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, lambda: svc.get_student_results(student_id, assessment_id))
        return StudentResultsResponse(**results)

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=404, code="student_results_not_found", message=str(error))


@student_router.post("/{student_id}/proctoring-chunk", response_model=SubmitProctorChunkResponse)
async def submit_proctor_chunk(
    student_id: str,
    request: SubmitProctorChunkRequest = Body(...),
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_student_access(_principal, student_id, request.assessment_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: svc.submit_proctor_chunk(
            student_id=student_id,
            assessment_id=request.assessment_id,
            chunk_url=request.chunk_url,
            chunk_index=request.chunk_index,
            timestamp=request.timestamp,
        ))
        return SubmitProctorChunkResponse(**result)

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=400, code="proctor_chunk_failed", message=str(error))


@student_router.post("/{student_id}/consent", response_model=SubmitConsentResponse)
async def record_consent(
    student_id: str,
    request: SubmitConsentRequest = Body(...),
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Record the student's webcam-proctoring consent decision (granted or declined)."""
    try:
        _assert_student_access(_principal, student_id, request.assessment_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: svc.record_consent(
            student_id=student_id,
            assessment_id=request.assessment_id,
            granted=request.granted,
            consent_version=request.consent_version,
            timestamp=request.timestamp,
        ))
        return SubmitConsentResponse(**result)

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=400, code="consent_failed", message=str(error))


# ──────────────────────────────────────────────────────────────────────────────
# Sprint 8 – Student Results PDF (EPIC-6-3)
# ──────────────────────────────────────────────────────────────────────────────

@student_router.get("/{student_id}/assessment/{assessment_id}/results/pdf")
async def get_student_results_pdf(
    student_id: str,
    assessment_id: str,
    svc: OralAssessmentService = Depends(get_oral_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-6-3: Generate a PDF results report for a student."""
    try:
        _assert_student_access(_principal, student_id, assessment_id)
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, lambda: svc.get_student_results(student_id, assessment_id))

        try:
            from reportlab.lib.pagesizes import A4
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            from reportlab.lib.units import cm
            from reportlab.lib import colors
            from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
            from reportlab.lib.enums import TA_CENTER, TA_LEFT
        except ImportError:
            raise ApiError(status_code=500, code="pdf_unavailable", message="PDF generation library not installed")

        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=2*cm, rightMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm)
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle("Title", parent=styles["Heading1"], alignment=TA_CENTER, fontSize=18)
        h2_style = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, spaceAfter=4)
        body_style = styles["BodyText"]
        grade_colors = {
            "Excellent": colors.HexColor("#10b981"),
            "Competent": colors.HexColor("#3b82f6"),
            "Developing": colors.HexColor("#f59e0b"),
            "Unsatisfactory": colors.HexColor("#ef4444"),
        }

        story = []
        story.append(Paragraph(results.get("assessmentTitle", "Assessment Results"), title_style))
        story.append(Spacer(1, 0.3*cm))
        story.append(Paragraph(f"Student: {results.get('studentName', student_id)}", body_style))
        story.append(Spacer(1, 0.5*cm))
        story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#e2e8f0")))
        story.append(Spacer(1, 0.5*cm))

        grade = results.get("grade", "")
        grade_color = grade_colors.get(grade, colors.black)
        summary_data = [
            ["Overall Score", f"{results.get('totalScore', 0)} / {results.get('maxScore', 0)}"],
            ["Percentage", f"{results.get('percentage', 0)}%"],
            ["Grade", grade],
        ]
        summary_table = Table(summary_data, colWidths=[4*cm, 8*cm])
        summary_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f1f5f9")),
            ("TEXTCOLOR", (1, 2), (1, 2), grade_color),
            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 11),
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("PADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(summary_table)
        story.append(Spacer(1, 1*cm))

        story.append(Paragraph("Question Feedback", h2_style))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#e2e8f0")))
        story.append(Spacer(1, 0.3*cm))

        for i, q in enumerate(results.get("questions", []), 1):
            story.append(Paragraph(f"<b>Q{i}:</b> {q.get('questionText', '')}", body_style))
            score = q.get("score")
            max_s = q.get("maxScore", 10)
            if score is not None:
                story.append(Paragraph(f"Score: {score}/{max_s}", body_style))
            if q.get("feedback"):
                story.append(Paragraph(f"<i>Feedback:</i> {q['feedback']}", body_style))
            if q.get("strengths"):
                story.append(Paragraph(f"<i>Strengths:</i> {q['strengths']}", body_style))
            if q.get("improvements"):
                story.append(Paragraph(f"<i>Areas for improvement:</i> {q['improvements']}", body_style))
            story.append(Spacer(1, 0.4*cm))

        doc.build(story)
        buf.seek(0)

        filename = f"results_{student_id}_{assessment_id}.pdf"
        return _StreamingResponse(
            buf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except OralAssessmentServiceError as error:
        raise ApiError(status_code=404, code="student_results_not_found", message=str(error))
