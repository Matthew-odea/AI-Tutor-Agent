from __future__ import annotations

import logging
import os
import re

import asyncio
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Response
from fastapi.responses import HTMLResponse, StreamingResponse

from src.main.auth.dependencies import get_auth_service, require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.auth.service import AuthService
from src.main.controllers.api_errors import ApiError
from src.main.controllers.controller_dependencies import (
    get_assessment_report_service,
    get_evaluation_service,
    get_instructor_assessment_service,
    get_question_service,
    get_sqs_job_dispatcher,
)
from src.main.controllers.controller_helpers import (
    _assert_assessment_owner,
    _assert_instructor_access,
)
from src.main.dtos.InstructorAssessmentDTOs import (
    AddStudentQuestionRequest,
    AssessmentListResponse,
    AssessmentReportResponse,
    AssessmentResponse,
    CreateAssessmentRequest,
    DeleteStudentQuestionResponse,
    EvaluateBatchRequest,
    EvaluationJobResponse,
    EvaluationStatusResponse,
    FlaggedEvaluationsResponse,
    GenerateQuestionsBatchRequest,
    GenerateReportResponse,
    ImportFromEdRequest,
    ImportFromEdResponse,
    InstructorStudentDetailResponse,
    ProgressSummaryResponse,
    ProctorChunkHealthResponse,
    ProctorChunkItem,
    QuestionGenerationJobResponse,
    QuestionGenerationStatusResponse,
    RecordHumanScoreRequest,
    RecordHumanScoreResponse,
    ReleaseResultsResponse,
    ResultsSummaryResponse,
    ScoreAgreementResponse,
    ScoreOverrideRequest,
    ScoreOverrideResponse,
    SendInvitesRequest,
    SendInvitesResponse,
    SendReminderResponse,
    StudentInviteRequest,
    StudentInviteResponse,
    StudentQuestionItem,
    StudentQuestionListResponse,
    StudentQuestionResponse,
    StudentListResponse,
    StudentProgressItem,
    StudentResponse,
    StudentResultItem,
    UpdateBriefRequest,
    UpdateStudentQuestionRequest,
    UploadStudentsRequest,
    UploadStudentsResponse,
)
from src.main.service.AssessmentReportRenderer import render_report_html, render_report_pdf
from src.main.service.AssessmentReportService import AssessmentReportService, AssessmentReportServiceError
from src.main.service.BatchJobManager import JobType, get_batch_job_manager
from src.main.service.InstructorAssessmentService import InstructorAssessmentService, InstructorAssessmentServiceError
from src.main.service.SQSJobDispatcher import SQSJobDispatcher
from src.main.service.QuestionGenerationService import QuestionGenerationService
from src.main.service.ResponseEvaluationService import ResponseEvaluationService
from src.main.service.ResponseEvaluationRepository import ResponseEvaluationRepository


logger = logging.getLogger(__name__)


assessment_router = APIRouter(prefix="/api/assessment", tags=["assessment"])


@assessment_router.post("/create", response_model=AssessmentResponse, status_code=201)
async def create_assessment(
    request: CreateAssessmentRequest = Body(...),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: svc.create_assessment(
            title=request.title,
            course=request.course,
            description=request.description,
            due_date=request.dueDate,
            total_questions=request.totalQuestions,
            time_limit=request.timeLimit,
            owner_user_id=_principal.user_id,
            access_mode=request.accessMode,
            scheduled_window_start=request.scheduledWindowStart,
            scheduled_window_end=request.scheduledWindowEnd,
            auto_evaluate=request.autoEvaluate,
            auto_report=request.autoReport,
            auto_report_threshold=request.autoReportThreshold,
            rubric=request.rubric,
            answer_mode=request.answerMode,
            preparation_time=request.preparationTime,
            proctored=request.proctored,
            allow_review=request.allowReview,
            feedback_release=request.feedbackRelease,
            max_score_per_question=request.maxScorePerQuestion,
            grade_cutoffs=request.gradeCutoffs,
        ))
        return AssessmentResponse(**result)

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="assessment_create_failed", message=str(error))


@assessment_router.get("/list", response_model=AssessmentListResponse)
async def list_assessments(
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessments = await loop.run_in_executor(None, lambda: svc.list_assessments(owner_user_id=_principal.user_id))

        return AssessmentListResponse(
            ok=True,
            assessments=[AssessmentResponse(**item) for item in assessments],
            total=len(assessments),
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=500, code="assessment_list_failed", message=str(error))


@assessment_router.get("/{id}", response_model=AssessmentResponse)
async def get_assessment(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        return AssessmentResponse(**assessment)

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.post("/{id}/upload-students", response_model=UploadStudentsResponse, status_code=201)
async def upload_students(
    id: str,
    request: UploadStudentsRequest = Body(...),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        students = [student.model_dump() for student in request.students]

        await loop.run_in_executor(None, lambda: svc.upload_students(id, students))

        return {
            "ok": True,
            "assessmentId": id,
            "studentsUploaded": len(students),
        }

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="upload_students_failed", message=str(error))


@assessment_router.post("/{id}/import-ed", response_model=ImportFromEdResponse)
async def import_from_ed(
    id: str,
    request: ImportFromEdRequest = Body(...),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Import students and code from an Ed challenge using the Ed API."""
    from src.main.service.EdStemService import EdStemService, EdStemServiceError

    ed_token = request.edToken
    challenge_id = request.challengeId

    if not ed_token or not challenge_id:
        raise ApiError(status_code=400, code="missing_fields", message="edToken and challengeId are required")

    try:
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)

        ed = EdStemService(ed_token)
        students = await loop.run_in_executor(None, lambda: ed.import_challenge(int(challenge_id)))

        if students:
            await loop.run_in_executor(None, lambda: svc.upload_students(id, students))

        return {
            "ok": True,
            "studentsImported": len(students),
            "students": [{"studentId": s["studentId"], "name": s["name"], "hasCode": bool(s.get("code"))} for s in students],
        }

    except EdStemServiceError as error:
        raise ApiError(status_code=400, code="ed_import_failed", message=str(error))
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="ed_import_failed", message=str(error))


@assessment_router.get("/{id}/students", response_model=StudentListResponse)
async def get_assessment_students(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        students = await loop.run_in_executor(None, lambda: svc.get_assessment_students(id))

        return StudentListResponse(
            ok=True,
            assessmentId=id,
            students=[StudentResponse(**item) for item in students],
            total=len(students),
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_students_not_found", message=str(error))


@assessment_router.delete("/{id}", status_code=204)
async def delete_assessment(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Delete an assessment and all its data."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        await loop.run_in_executor(None, svc.delete_assessment, id)
        return None  # 204 No Content

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="delete_assessment_failed", message=str(error))


@assessment_router.post("/{id}/students/{student_id}/invite", response_model=StudentInviteResponse)
async def generate_student_invite(
    id: str,
    student_id: str,
    request: Optional[StudentInviteRequest] = Body(None),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    auth_service: AuthService = Depends(get_auth_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Generate a single-use invitation link for a specific student.

    Also backs the instructor "Resend invite" action: each call mints a *fresh*
    token (new jti, new 7-day expiry, unused) so a student whose previous link
    expired or was consumed gets a working one. Accepts optional
    { "subject": "...", "message": "..." } with {{name}}, {{title}}, {{link}}
    placeholders, matching the bulk send-invites endpoint."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)

        students = await loop.run_in_executor(None, lambda: svc.get_assessment_students(id))
        if not any(s["studentId"] == student_id for s in students):
            raise ApiError(
                status_code=404,
                code="student_not_enrolled",
                message=f"Student {student_id} is not enrolled in assessment {id}",
            )

        token = await loop.run_in_executor(None, lambda: auth_service.generate_student_invite_token(student_id, id))
        base_url = os.getenv("STUDENT_ASSESSMENT_BASE_URL", "http://localhost:5176")
        invite_link = f"{base_url}/invite?token={token}"

        # Send invite email (non-blocking — logs warning on failure)
        student = next((s for s in students if s["studentId"] == student_id), {})
        request = request or StudentInviteRequest()
        custom_subject = (request.subject or "").strip()
        custom_message = (request.message or "").strip()
        await loop.run_in_executor(None, lambda: auth_service.send_student_invite_email(
            student_email=student.get("email", ""),
            student_name=student.get("name", student_id),
            assessment_title=assessment.get("title", id),
            invite_link=invite_link,
            custom_subject=custom_subject,
            custom_message=custom_message,
        ))

        return {
            "ok": True,
            "studentId": student_id,
            "assessmentId": id,
            "inviteToken": token,
            "inviteLink": invite_link,
            "emailSent": bool(student.get("email")),
        }

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.post("/{id}/send-invites", response_model=SendInvitesResponse)
async def send_bulk_invites(
    id: str,
    request: Optional[SendInvitesRequest] = Body(None),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    auth_service: AuthService = Depends(get_auth_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Send invite emails to enrolled students.  Accepts optional customisation:
    { "subject": "...", "message": "...", "studentIds": [...], "next": "results" }
    Use {{name}}, {{title}}, {{link}} as placeholders in subject/message.

    studentIds restricts the send to those students; omit it to mail everyone
    enrolled. Needed for follow-up mail aimed at a subset (e.g. only students
    who actually submitted), so a targeted notice doesn't reach the whole roster.

    next="results" points {{link}} at the student's feedback rather than the
    assessment itself. Without it a student who has already submitted lands back
    in the question UI.
    """
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)

        enrolled_students = await loop.run_in_executor(None, lambda: svc.get_assessment_students(id))

        request = request or SendInvitesRequest()
        requested_ids = request.studentIds or []
        if requested_ids:
            wanted = set(requested_ids)
            enrolled_students = [s for s in enrolled_students if s["studentId"] in wanted]
            if not enrolled_students:
                raise ApiError(
                    status_code=400,
                    code="no_students_to_notify",
                    message="None of the given studentIds are enrolled in this assessment",
                )

        base_url = os.getenv("STUDENT_ASSESSMENT_BASE_URL", "http://localhost:5176")
        title = assessment.get("title", id)
        custom_subject = (request.subject or "").strip()
        custom_message = (request.message or "").strip()
        link_suffix = "&next=results" if request.next == "results" else ""

        def _send_all_invites():
            sent = 0
            skipped = 0
            for student in enrolled_students:
                email = student.get("email", "")
                if not email:
                    skipped += 1
                    continue
                try:
                    token = auth_service.generate_student_invite_token(student["studentId"], id)
                    invite_link = f"{base_url}/invite?token={token}{link_suffix}"
                    auth_service.send_student_invite_email(
                        student_email=email,
                        student_name=student.get("name", student["studentId"]),
                        assessment_title=title,
                        invite_link=invite_link,
                        custom_subject=custom_subject,
                        custom_message=custom_message,
                    )
                    sent += 1
                except Exception as e:
                    logger.warning(f"Failed to send invite to {student['studentId']}: {e}")
                    skipped += 1
            return sent, skipped

        sent, skipped = await loop.run_in_executor(None, _send_all_invites)

        return {
            "ok": True,
            "assessmentId": id,
            "sent": sent,
            "skipped": skipped,
            "total": len(enrolled_students),
        }
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.put("/{id}/brief", response_model=AssessmentResponse)
async def update_assessment_brief(
    id: str,
    request: UpdateBriefRequest = Body(...),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """
    Update the assignment brief for an assessment.
    The brief must be at least 50 characters.
    Only editable while the assessment is in draft or scheduled status.
    """
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        result = await loop.run_in_executor(None, lambda: svc.update_brief(id, request.brief))
        return AssessmentResponse(**result)

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="update_brief_failed", message=str(error))


@assessment_router.post("/{id}/generate-questions-batch", response_model=QuestionGenerationJobResponse, status_code=202)
async def generate_questions_batch(
    id: str,
    request: GenerateQuestionsBatchRequest = Body(...),
    instructor_svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    dispatcher: SQSJobDispatcher = Depends(get_sqs_job_dispatcher),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """
    Trigger batch question generation for all (or specified) enrolled students.
    One SQS message is enqueued per student; the in-process consumer processes
    them asynchronously. Job state is persisted to DynamoDB so it survives
    server restarts.
    """
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: instructor_svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)

        all_students = await loop.run_in_executor(None, lambda: instructor_svc.get_assessment_students(id))
        if request.studentIds:
            students_to_process = [s for s in all_students if s["studentId"] in request.studentIds]
        else:
            students_to_process = all_students

        if not students_to_process:
            raise ApiError(status_code=400, code="no_students_to_process", message="No students found to process")

        # Prevent duplicate generation: check if a job is already running for this assessment
        job_manager = get_batch_job_manager()
        existing_job_id = assessment.get("activeGenerationJobId")
        if existing_job_id:
            existing_job = await loop.run_in_executor(None, lambda: job_manager.get_job(existing_job_id))
            if existing_job and existing_job.get("status") in ("pending", "running"):
                return QuestionGenerationJobResponse(
                    ok=True,
                    jobId=existing_job_id,
                    assessmentId=id,
                    status=existing_job["status"],
                    totalStudents=int(existing_job.get("total_items", 0)),
                    processedCount=int(existing_job.get("processed_count", 0)),
                    message="Question generation is already in progress",
                )

        # Prefer the dedicated assignmentBrief field; fall back to description
        assignment_brief = (
            assessment.get("assignmentBrief")
            or assessment.get("description")
            or "No assignment brief provided"
        )

        job_id = await loop.run_in_executor(None, lambda: job_manager.create_job(
            job_type=JobType.QUESTION_GENERATION,
            assessment_id=id,
            total_items=len(students_to_process),
            metadata={"assessment_title": assessment["title"]},
        ))

        # Persist active job ID on assessment so duplicate requests are blocked server-side
        await loop.run_in_executor(None, lambda: instructor_svc.table.update_item(
            Key={"PK": f"ASSESSMENT#{id}", "SK": "METADATA"},
            UpdateExpression="SET activeGenerationJobId = :jid",
            ExpressionAttributeValues={":jid": job_id},
        ))

        enqueued = await loop.run_in_executor(None, lambda: dispatcher.enqueue_question_generation(
            job_id=job_id,
            assessment_id=id,
            students=students_to_process,
            assignment_brief=assignment_brief,
            course_name=assessment.get("course", ""),
            assessment_title=assessment.get("title", ""),
        ))

        return QuestionGenerationJobResponse(
            ok=True,
            jobId=job_id,
            assessmentId=id,
            status="pending",
            totalStudents=len(students_to_process),
            processedCount=0,
            message=f"Enqueued question generation for {enqueued}/{len(students_to_process)} students",
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="question_generation_batch_failed", message=str(error))


@assessment_router.get("/{id}/students/{studentId}/evaluation-progress")
async def stream_student_evaluation_progress(
    id: str,
    studentId: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """SSE stream for per-question evaluation progress for a single student.

    Emits one event per poll cycle (2 s) with:
      { questionsEvaluated, totalQuestions, percentage, status }

    Closes when status is 'completed' or 'failed', or after 10 min (300 polls).
    """
    import json as _json
    _assert_instructor_access(_principal)
    loop = asyncio.get_event_loop()
    assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
    _assert_assessment_owner(_principal, assessment)

    repo = ResponseEvaluationRepository()
    terminal = {"completed", "failed"}

    async def event_stream():
        _loop = asyncio.get_event_loop()
        for _ in range(300):  # max 10 min
            item = await _loop.run_in_executor(None, lambda: repo.get_evaluation_progress(studentId, id))
            if item is None:
                yield f"data: {_json.dumps({'status': 'not_started', 'questionsEvaluated': 0, 'totalQuestions': 0, 'percentage': 0})}\n\n"
                await asyncio.sleep(2)
                continue

            payload = _json.dumps({
                "questionsEvaluated": int(item.get("questionsEvaluated", 0)),
                "totalQuestions": int(item.get("totalQuestions", 0)),
                "percentage": float(item.get("percentage", 0)),
                "status": item.get("status", "evaluating"),
                "updatedAt": item.get("updatedAt"),
            })
            yield f"data: {payload}\n\n"
            if item.get("status") in terminal:
                break
            await asyncio.sleep(2)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@assessment_router.get("/{id}/generation-status/{jobId}", response_model=QuestionGenerationStatusResponse)
async def get_generation_status(
    id: str,
    jobId: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        job_manager = get_batch_job_manager()
        job = await loop.run_in_executor(None, lambda: job_manager.get_job(jobId))

        if not job:
            raise ApiError(status_code=404, code="job_not_found", message=f"Job {jobId} not found")

        if job["assessment_id"] != id:
            raise ApiError(status_code=400, code="job_assessment_mismatch", message="Job does not belong to this assessment")

        return QuestionGenerationStatusResponse(
            jobId=job["job_id"],
            assessmentId=job["assessment_id"],
            status=job["status"],
            totalStudents=job["total_items"],
            processedCount=job["processed_count"],
            failedCount=int(job.get("failed_count", 0)),
            startedAt=job["started_at"],
            completedAt=job.get("completed_at"),
            error=job.get("error"),
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.get("/{id}/progress", response_model=ProgressSummaryResponse)
async def get_assessment_progress(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        progress_list = await loop.run_in_executor(None, lambda: svc.get_assessment_progress(id))

        total = len(progress_list)
        not_started = sum(1 for p in progress_list if p["status"] == "not-started")
        in_progress = sum(1 for p in progress_list if p["status"] == "in-progress")
        completed = sum(1 for p in progress_list if p["status"] == "completed")

        return ProgressSummaryResponse(
            ok=True,
            assessmentId=id,
            students=[StudentProgressItem(**item) for item in progress_list],
            summary={
                "total": total,
                "notStarted": not_started,
                "inProgress": in_progress,
                "completed": completed,
            },
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_progress_not_found", message=str(error))


@assessment_router.post("/{id}/evaluate-batch", response_model=EvaluationJobResponse, status_code=202)
async def evaluate_batch(
    id: str,
    request: EvaluateBatchRequest = Body(...),
    instructor_svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    dispatcher: SQSJobDispatcher = Depends(get_sqs_job_dispatcher),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: instructor_svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)

        all_students = await loop.run_in_executor(None, lambda: instructor_svc.get_assessment_students(id))
        if request.studentIds:
            students_to_process = [s for s in all_students if s["studentId"] in request.studentIds]
        else:
            students_to_process = all_students

        if not students_to_process:
            raise ApiError(status_code=400, code="no_students_to_process", message="No students found to process")

        job_manager = get_batch_job_manager()
        job_id = await loop.run_in_executor(None, lambda: job_manager.create_job(
            job_type=JobType.EVALUATION,
            assessment_id=id,
            total_items=len(students_to_process),
            metadata={"assessment_title": assessment["title"]},
        ))

        enqueued = await loop.run_in_executor(None, lambda: dispatcher.enqueue_evaluation_batch(
            job_id=job_id,
            assessment_id=id,
            students=students_to_process,
        ))
        logger.info("[Job %s] Enqueued %d/%d evaluation messages", job_id, enqueued, len(students_to_process))

        return EvaluationJobResponse(
            ok=True,
            jobId=job_id,
            assessmentId=id,
            status="running",
            totalStudents=len(students_to_process),
            processedCount=0,
            message=f"Started evaluation for {len(students_to_process)} students",
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="evaluation_batch_failed", message=str(error))


@assessment_router.get("/{id}/evaluation-status/{jobId}", response_model=EvaluationStatusResponse)
async def get_evaluation_status(
    id: str,
    jobId: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        job_manager = get_batch_job_manager()
        job = await loop.run_in_executor(None, lambda: job_manager.get_job(jobId))

        if not job:
            raise ApiError(status_code=404, code="job_not_found", message=f"Job {jobId} not found")

        if job["assessment_id"] != id:
            raise ApiError(status_code=400, code="job_assessment_mismatch", message="Job does not belong to this assessment")

        return EvaluationStatusResponse(
            jobId=job["job_id"],
            assessmentId=job["assessment_id"],
            status=job["status"],
            totalStudents=job["total_items"],
            processedCount=job["processed_count"],
            startedAt=job["started_at"],
            completedAt=job.get("completed_at"),
            error=job.get("error"),
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.get("/{id}/results", response_model=ResultsSummaryResponse)
async def get_assessment_results(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        results_list = await loop.run_in_executor(None, lambda: svc.get_assessment_results(id))

        if results_list:
            avg_percentage = sum(item["percentage"] for item in results_list) / len(results_list)
            grade_counts = {}
            for item in results_list:
                grade = item["grade"]
                grade_counts[grade] = grade_counts.get(grade, 0) + 1
        else:
            avg_percentage = 0
            grade_counts = {}

        return ResultsSummaryResponse(
            ok=True,
            assessmentId=id,
            results=[StudentResultItem(**item) for item in results_list],
            summary={
                "averageScore": round(avg_percentage, 2),
                "gradeDistribution": grade_counts,
            },
        )

    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_results_not_found", message=str(error))


# ──────────────────────────────────────────────────────────────────────────────
# Cohort summary report (auto-generated on submission threshold)
# ──────────────────────────────────────────────────────────────────────────────

@assessment_router.get("/{id}/report", response_model=AssessmentReportResponse)
async def get_assessment_report(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    report_svc: AssessmentReportService = Depends(get_assessment_report_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Return the most recent cohort report, or generated=False if none exists yet."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        report = await loop.run_in_executor(None, lambda: report_svc.get_report(id))
        return AssessmentReportResponse(
            ok=True,
            assessmentId=id,
            generated=report is not None,
            report=report,
        )
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.post("/{id}/report/generate", response_model=GenerateReportResponse)
async def generate_assessment_report(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    report_svc: AssessmentReportService = Depends(get_assessment_report_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """
    Generate the cohort report on demand.

    Runs inline rather than via SQS: the instructor is waiting on the response,
    and the aggregation is a handful of DynamoDB queries. The automatic
    threshold path goes through the queue instead so it never blocks a
    student's submit.
    """
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        report = await loop.run_in_executor(
            None, lambda: report_svc.generate_report(id, triggered_by="manual")
        )
        return GenerateReportResponse(ok=True, assessmentId=id, report=report)
    except AssessmentReportServiceError as error:
        raise ApiError(status_code=500, code="report_generation_failed", message=str(error))
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.get("/{id}/report.html", response_class=HTMLResponse)
async def get_assessment_report_html(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    report_svc: AssessmentReportService = Depends(get_assessment_report_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """The cohort report as a one-page, self-contained HTML document."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        report = await loop.run_in_executor(None, lambda: report_svc.get_report(id))
        if report is None:
            raise ApiError(status_code=404, code="report_not_generated",
                           message="No report has been generated for this assessment yet")
        return HTMLResponse(content=render_report_html(report))
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.get("/{id}/report.pdf")
async def get_assessment_report_pdf(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    report_svc: AssessmentReportService = Depends(get_assessment_report_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """The same one-pager as a PDF."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        report = await loop.run_in_executor(None, lambda: report_svc.get_report(id))
        if report is None:
            raise ApiError(status_code=404, code="report_not_generated",
                           message="No report has been generated for this assessment yet")

        pdf = await loop.run_in_executor(None, lambda: render_report_pdf(report))
        safe_title = re.sub(r"[^A-Za-z0-9_-]+", "-", str(assessment.get("title", "report"))).strip("-")
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{safe_title or "report"}-summary.pdf"'},
        )
    except RuntimeError as error:
        # WeasyPrint's native libraries are missing in this environment.
        raise ApiError(status_code=503, code="pdf_rendering_unavailable", message=str(error))
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


# ──────────────────────────────────────────────────────────────────────────────
# Sprint 8 – Results Dashboards (EPIC-6-1 to 6-4)
# ──────────────────────────────────────────────────────────────────────────────

import json as _json


@assessment_router.get("/{id}/student/{student_id}/results", response_model=InstructorStudentDetailResponse)
async def get_student_detail(
    id: str,
    student_id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-6-2: Instructor per-student detailed results with transcript, playback URLs, and proctor chunk health."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        detail = await loop.run_in_executor(None, lambda: svc.get_student_detail(id, student_id))
        proctor_raw = detail.pop("proctoring")
        proctor_chunks = [ProctorChunkItem(**c) for c in proctor_raw.pop("chunks", [])]
        return InstructorStudentDetailResponse(
            **detail,
            proctoring=ProctorChunkHealthResponse(
                ok=True,
                chunks=proctor_chunks,
                **proctor_raw,
            ),
        )
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="student_detail_not_found", message=str(error))


@assessment_router.put("/{id}/student/{student_id}/question/{question_id}/override", response_model=ScoreOverrideResponse)
async def override_question_score(
    id: str,
    student_id: str,
    question_id: str,
    request: ScoreOverrideRequest = Body(...),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-6-2: Override an AI-assigned score for a specific question."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        result = await loop.run_in_executor(None, lambda: svc.override_question_score(id, student_id, question_id, request.score, request.comment))
        return ScoreOverrideResponse(ok=True, **result)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="override_failed", message=str(error))


@assessment_router.put("/{id}/release-results", response_model=ReleaseResultsResponse)
async def release_results(
    id: str,
    background: BackgroundTasks,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-6-3: Release results so students can view their feedback."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        result = await loop.run_in_executor(None, lambda: svc.release_results(id))

        # Email every submitted student after the response is sent. A BackgroundTask,
        # not a daemon thread: a redeploy killed daemon threads mid-send, so released
        # results silently never reached some students. One bad address is logged
        # and skipped; it must not fail the instructor's release.
        def _notify_students():
            try:
                students = svc.get_assessment_students(id)
                title = assessment.get("title", id)
                base_url = os.getenv("STUDENT_ASSESSMENT_BASE_URL", "http://localhost:5176")
                from_email = os.getenv("INVITE_FROM_EMAIL") or os.getenv("AUTH_PASSWORD_RESET_FROM_EMAIL", "")
                ses_region = os.getenv("AUTH_PASSWORD_RESET_SES_REGION", "") or os.getenv("AWS_DEFAULT_REGION", "us-east-1")
                if not from_email:
                    logger.warning("No INVITE_FROM_EMAIL configured; release notifications for %s not sent", id)
                    return
                import boto3
                ses = boto3.client("ses", region_name=ses_region)
                for s in students:
                    if s.get("status") != "submitted" or not s.get("email"):
                        continue
                    try:
                        results_link = f"{base_url}/{s['studentId']}/results/{id}"
                        ses.send_email(
                            Source=from_email,
                            Destination={"ToAddresses": [s["email"]]},
                            Message={
                                "Subject": {"Data": f"Results Available: {title}"},
                                "Body": {"Text": {"Data": (
                                    f"Hi {s.get('name', s['studentId'])},\n\n"
                                    f"Your results for \"{title}\" are now available.\n\n"
                                    f"View your results: {results_link}\n\n"
                                    f"Best regards,\nYour Instructor"
                                )}},
                            },
                        )
                    except Exception as e:
                        logger.warning(f"Failed to notify {s['studentId']}: {e}")
            except Exception as e:
                logger.warning(f"Failed to send release notifications: {e}")
        background.add_task(_notify_students)

        return ReleaseResultsResponse(ok=True, **result)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=404, code="assessment_not_found", message=str(error))


@assessment_router.put(
    "/{id}/student/{student_id}/question/{question_id}/human-score",
    response_model=RecordHumanScoreResponse,
)
async def record_human_score(
    id: str,
    student_id: str,
    question_id: str,
    request: RecordHumanScoreRequest = Body(...),
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Dual-scoring harness: record a HUMAN reference score for a question.
    Separate from the grade override — it does not change the student's grade."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        result = await loop.run_in_executor(
            None,
            lambda: svc.record_human_score(
                id, student_id, question_id,
                human_correctness_score=request.humanCorrectnessScore,
                human_understanding_score=request.humanUnderstandingScore,
                scored_by=request.scoredBy,
            ),
        )
        return RecordHumanScoreResponse(ok=True, **result)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="human_score_failed", message=str(error))


@assessment_router.get("/{id}/score-agreement", response_model=ScoreAgreementResponse)
async def get_score_agreement(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """AI-vs-human agreement summary across all dual-scored items (validity harness)."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        result = await loop.run_in_executor(None, lambda: svc.get_score_agreement(id))
        return ScoreAgreementResponse(ok=True, **result)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="score_agreement_failed", message=str(error))


@assessment_router.get("/{id}/flagged-evaluations", response_model=FlaggedEvaluationsResponse)
async def get_flagged_evaluations(
    id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """List evaluations flagged for human review (needs-review, fallback, or score divergence)."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        result = await loop.run_in_executor(None, lambda: svc.get_flagged_evaluations(id))
        return FlaggedEvaluationsResponse(ok=True, **result)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="flagged_evaluations_failed", message=str(error))


@assessment_router.post("/{id}/student/{student_id}/remind", response_model=SendReminderResponse)
async def send_reminder(
    id: str,
    student_id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-6-4: Send an email reminder to a student who has not yet submitted."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        message = await loop.run_in_executor(None, lambda: svc.send_reminder_email(id, student_id))
        return SendReminderResponse(ok=True, studentId=student_id, assessmentId=id, message=message)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="reminder_failed", message=str(error))


# ── EPIC-3-3: Question Preview and Editing ───────────────────────────────────

@assessment_router.get("/{id}/students/{student_id}/questions", response_model=StudentQuestionListResponse)
async def list_student_questions(
    id: str,
    student_id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-3-3: List all generated questions for a student."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        questions_raw = await loop.run_in_executor(None, lambda: svc.list_student_questions(id, student_id))
        questions = [StudentQuestionItem(**q) for q in questions_raw]
        return StudentQuestionListResponse(
            assessmentId=id, studentId=student_id, questions=questions, total=len(questions)
        )
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="list_questions_failed", message=str(error))


@assessment_router.put("/{id}/students/{student_id}/questions/{question_id}", response_model=StudentQuestionResponse)
async def update_student_question(
    id: str,
    student_id: str,
    question_id: str,
    body: UpdateStudentQuestionRequest,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-3-3: Edit a student question's text. Locked once assessment is open."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        updated = await loop.run_in_executor(None, lambda: svc.update_student_question(id, student_id, question_id, body.text, body.timeLimit))
        return StudentQuestionResponse(question=StudentQuestionItem(**updated))
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="update_question_failed", message=str(error))


@assessment_router.delete("/{id}/students/{student_id}/questions/{question_id}", response_model=DeleteStudentQuestionResponse)
async def delete_student_question(
    id: str,
    student_id: str,
    question_id: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-3-3: Delete a student question. Min 1 must remain. Locked once assessment is open."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        deleted_id = await loop.run_in_executor(None, lambda: svc.delete_student_question(id, student_id, question_id))
        return DeleteStudentQuestionResponse(deletedId=deleted_id)
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="delete_question_failed", message=str(error))


@assessment_router.post("/{id}/students/{student_id}/questions", response_model=StudentQuestionResponse, status_code=201)
async def add_student_question(
    id: str,
    student_id: str,
    body: AddStudentQuestionRequest,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-3-3: Manually add a question for a specific student. Locked once assessment is open."""
    try:
        _assert_instructor_access(_principal)
        loop = asyncio.get_event_loop()
        assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
        _assert_assessment_owner(_principal, assessment)
        added = await loop.run_in_executor(None, lambda: svc.add_student_question(
            id, student_id, body.text, body.questionType, body.difficulty, body.topic, body.timeLimit
        ))
        return StudentQuestionResponse(question=StudentQuestionItem(**added))
    except InstructorAssessmentServiceError as error:
        raise ApiError(status_code=400, code="add_question_failed", message=str(error))


@assessment_router.get("/{id}/evaluation-status-stream/{jobId}")
async def stream_evaluation_status(
    id: str,
    jobId: str,
    svc: InstructorAssessmentService = Depends(get_instructor_assessment_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """EPIC-6-1: SSE stream for evaluation job status (auto-refreshes results dashboard)."""
    _assert_instructor_access(_principal)
    loop = asyncio.get_event_loop()
    assessment = await loop.run_in_executor(None, lambda: svc.get_assessment(id))
    _assert_assessment_owner(_principal, assessment)

    terminal = {"completed", "failed"}
    job_manager = get_batch_job_manager()

    async def event_stream():
        _loop = asyncio.get_event_loop()
        while True:
            job = await _loop.run_in_executor(None, lambda: job_manager.get_job(jobId))
            if not job:
                yield f"event: error\ndata: {_json.dumps({'message': 'Job not found'})}\n\n"
                break
            payload = _json.dumps({
                "jobId": job["job_id"],
                "status": job["status"],
                "totalStudents": job["total_items"],
                "processedCount": job["processed_count"],
                "successfulCount": job.get("successful_count", 0),
                "failedCount": job.get("failed_count", 0),
                "completedAt": job.get("completed_at"),
            })
            yield f"data: {payload}\n\n"
            if job["status"] in terminal:
                break
            await asyncio.sleep(2)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
