"""
Tests for Sprint 4 assessment router routes:
- Bank question CRUD (list, add, delete)
- Bank question AI suggest
- SSE generation-status stream
- Per-question time limit PATCH
- generate-questions-batch uses SQS dispatcher
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import (
    get_instructor_assessment_service,
    get_instructor_question_bank_service,
    get_question_service,
    get_sqs_job_dispatcher,
)
from src.main.service.InstructorAssessmentService import InstructorAssessmentServiceError
from src.main.service.InstructorQuestionBankService import InstructorQuestionBankServiceError


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

_INSTRUCTOR = AuthPrincipal(user_id="inst-1", roles=["instructor"], source="jwt")
_STUDENT = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt")

_ASSESSMENT = {
    "id": "a1",
    "createdBy": "inst-1",
    "title": "Sprint 4 Test",
    "course": "CS101",
    "description": "desc",
    "dueDate": "2026-06-01",
    "totalQuestions": 5,
    "timeLimit": 120,
    "status": "draft",
    "createdAt": "2026-01-01T00:00:00",
    "updatedAt": "2026-01-01T00:00:00",
}

_BANK_Q = {
    "id": "bq-1",
    "assessmentId": "a1",
    "text": "What is recursion?",
    "topic": "algorithms",
    "difficulty": "medium",
    "source": "manual",
    "timeLimit": None,
    "createdAt": "2026-01-01T00:00:00",
}


def _build_client(
    principal=_INSTRUCTOR,
    instructor_svc=None,
    bank_svc=None,
    dispatcher=None,
) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_instructor_assessment_service] = lambda: instructor_svc or MagicMock()
    app.dependency_overrides[get_instructor_question_bank_service] = lambda: bank_svc or MagicMock()
    app.dependency_overrides[get_sqs_job_dispatcher] = lambda: dispatcher or MagicMock()
    app.dependency_overrides[get_question_service] = lambda: MagicMock()
    return TestClient(app)


def _assessment_svc(bank_svc_questions=None):
    svc = MagicMock()
    svc.get_assessment.return_value = _ASSESSMENT
    svc.get_assessment_students.return_value = [
        {"studentId": "s-1", "name": "Alice", "email": "a@b.com", "code": "x = 1"}
    ]
    return svc


# ─────────────────────────────────────────────────────────────
# Bank question — list
# ─────────────────────────────────────────────────────────────

def test_list_bank_questions_returns_200():
    bank_svc = MagicMock()
    bank_svc.list_questions.return_value = [_BANK_Q]
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.get("/api/assessment/a1/bank-questions")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["total"] == 1
    assert body["questions"][0]["text"] == "What is recursion?"


def test_list_bank_questions_empty_returns_200():
    bank_svc = MagicMock()
    bank_svc.list_questions.return_value = []
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.get("/api/assessment/a1/bank-questions")

    assert resp.status_code == 200
    assert resp.json()["total"] == 0


def test_list_bank_questions_student_forbidden():
    client = _build_client(principal=_STUDENT)
    resp = client.get("/api/assessment/a1/bank-questions")
    assert resp.status_code == 403


def test_list_bank_questions_assessment_not_found_returns_404():
    svc = MagicMock()
    svc.get_assessment.side_effect = InstructorAssessmentServiceError("not found")
    client = _build_client(instructor_svc=svc)

    resp = client.get("/api/assessment/missing/bank-questions")

    assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────
# Bank question — add
# ─────────────────────────────────────────────────────────────

def test_add_bank_question_returns_201():
    bank_svc = MagicMock()
    bank_svc.add_question.return_value = _BANK_Q
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.post(
        "/api/assessment/a1/bank-questions",
        json={"text": "What is recursion?", "topic": "algorithms", "difficulty": "medium"},
    )

    assert resp.status_code == 201
    assert resp.json()["id"] == "bq-1"
    bank_svc.add_question.assert_called_once()


def test_add_bank_question_at_limit_returns_400():
    bank_svc = MagicMock()
    bank_svc.add_question.side_effect = InstructorQuestionBankServiceError("maximum")
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.post(
        "/api/assessment/a1/bank-questions",
        json={"text": "What is recursion?", "topic": "algorithms", "difficulty": "medium"},
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "add_bank_question_failed"


def test_add_bank_question_too_short_rejected_by_dto():
    client = _build_client(instructor_svc=_assessment_svc())

    resp = client.post(
        "/api/assessment/a1/bank-questions",
        json={"text": "Short", "topic": "x", "difficulty": "medium"},
    )

    assert resp.status_code == 422  # Pydantic min_length validation


def test_add_bank_question_with_time_limit():
    bank_svc = MagicMock()
    bank_svc.add_question.return_value = {**_BANK_Q, "timeLimit": 90}
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.post(
        "/api/assessment/a1/bank-questions",
        json={"text": "What is recursion?", "topic": "algorithms", "difficulty": "medium", "timeLimit": 90},
    )

    assert resp.status_code == 201
    _, kwargs = bank_svc.add_question.call_args
    assert kwargs["time_limit"] == 90


# ─────────────────────────────────────────────────────────────
# Bank question — delete
# ─────────────────────────────────────────────────────────────

def test_delete_bank_question_returns_204():
    bank_svc = MagicMock()
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.delete("/api/assessment/a1/bank-questions/bq-1")

    assert resp.status_code == 204
    bank_svc.delete_question.assert_called_once_with("a1", "bq-1")


def test_delete_bank_question_student_forbidden():
    client = _build_client(principal=_STUDENT)
    resp = client.delete("/api/assessment/a1/bank-questions/bq-1")
    assert resp.status_code == 403


# ─────────────────────────────────────────────────────────────
# Bank question — suggest
# ─────────────────────────────────────────────────────────────

def test_suggest_bank_questions_returns_suggestions():
    bank_svc = MagicMock()
    bank_svc.suggest_questions.return_value = [
        {"text": "Explain Big-O notation.", "topic": "algorithms", "difficulty": "medium", "source": "ai_suggested"},
        {"text": "What is a stack?", "topic": "data_structures", "difficulty": "easy", "source": "ai_suggested"},
    ]
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.post("/api/assessment/a1/bank-questions/suggest", json={"count": 2})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["total"] == 2
    # Suggestions must NOT have id or createdAt fields
    for s in body["suggestions"]:
        assert "id" not in s
        assert "createdAt" not in s
        assert s["source"] == "ai_suggested"


def test_suggest_bank_questions_service_error_returns_400():
    bank_svc = MagicMock()
    bank_svc.suggest_questions.side_effect = InstructorQuestionBankServiceError("brief too short")
    client = _build_client(instructor_svc=_assessment_svc(), bank_svc=bank_svc)

    resp = client.post("/api/assessment/a1/bank-questions/suggest", json={"count": 5})

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "suggest_bank_questions_failed"


def test_suggest_count_clamped_by_dto():
    """count > 10 should be rejected by Pydantic (le=10)."""
    client = _build_client(instructor_svc=_assessment_svc())
    resp = client.post("/api/assessment/a1/bank-questions/suggest", json={"count": 99})
    assert resp.status_code == 422


# ─────────────────────────────────────────────────────────────
# Per-question time limit PATCH
# ─────────────────────────────────────────────────────────────

def test_update_question_time_limit_sets_value():
    svc = _assessment_svc()
    svc.table = MagicMock()
    client = _build_client(instructor_svc=svc)

    resp = client.patch(
        "/api/assessment/a1/students/s-1/questions/q-1/time-limit",
        json={"timeLimit": 60},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["timeLimit"] == 60
    svc.table.update_item.assert_called_once()
    call_kwargs = svc.table.update_item.call_args[1]
    assert "SET timeLimit" in call_kwargs["UpdateExpression"]


def test_update_question_time_limit_null_removes_override():
    svc = _assessment_svc()
    svc.table = MagicMock()
    client = _build_client(instructor_svc=svc)

    resp = client.patch(
        "/api/assessment/a1/students/s-1/questions/q-1/time-limit",
        json={"timeLimit": None},
    )

    assert resp.status_code == 200
    assert resp.json()["timeLimit"] is None
    call_kwargs = svc.table.update_item.call_args[1]
    assert "REMOVE timeLimit" in call_kwargs["UpdateExpression"]


def test_update_question_time_limit_student_forbidden():
    client = _build_client(principal=_STUDENT)
    resp = client.patch(
        "/api/assessment/a1/students/s-1/questions/q-1/time-limit",
        json={"timeLimit": 60},
    )
    assert resp.status_code == 403


# ─────────────────────────────────────────────────────────────
# generate-questions-batch — uses SQS dispatcher
# ─────────────────────────────────────────────────────────────

@patch("src.main.controllers.assessment_router.get_batch_job_manager")
def test_generate_questions_batch_enqueues_via_sqs(mock_get_jm):
    mock_jm = MagicMock()
    mock_jm.create_job.return_value = "job-1"
    mock_get_jm.return_value = mock_jm

    dispatcher = MagicMock()
    dispatcher.enqueue_question_generation.return_value = 1

    client = _build_client(instructor_svc=_assessment_svc(), dispatcher=dispatcher)

    resp = client.post("/api/assessment/a1/generate-questions-batch", json={})

    assert resp.status_code == 202
    body = resp.json()
    assert body["ok"] is True
    assert body["status"] == "pending"
    dispatcher.enqueue_question_generation.assert_called_once()
    call_kwargs = dispatcher.enqueue_question_generation.call_args[1]
    assert call_kwargs["assessment_id"] == "a1"
    assert len(call_kwargs["students"]) == 1


def test_generate_questions_batch_no_students_returns_400():
    svc = _assessment_svc()
    svc.get_assessment_students.return_value = []
    client = _build_client(instructor_svc=svc)

    resp = client.post("/api/assessment/a1/generate-questions-batch", json={})

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "no_students_to_process"


@patch("src.main.controllers.assessment_router.get_batch_job_manager")
def test_generate_questions_batch_uses_assignment_brief_over_description(mock_get_jm):
    mock_jm = MagicMock()
    mock_jm.create_job.return_value = "job-1"
    mock_get_jm.return_value = mock_jm

    svc = _assessment_svc()
    svc.get_assessment.return_value = {
        **_ASSESSMENT,
        "assignmentBrief": "This is the real brief with detail.",
        "description": "Short fallback",
    }
    dispatcher = MagicMock()
    dispatcher.enqueue_question_generation.return_value = 1
    client = _build_client(instructor_svc=svc, dispatcher=dispatcher)

    client.post("/api/assessment/a1/generate-questions-batch", json={})

    call_kwargs = dispatcher.enqueue_question_generation.call_args[1]
    assert call_kwargs["assignment_brief"] == "This is the real brief with detail."


# ─────────────────────────────────────────────────────────────
# SSE generation-status stream
# ─────────────────────────────────────────────────────────────

def test_generation_status_stream_returns_event_stream():
    """Verify SSE endpoint returns text/event-stream content type."""
    svc = _assessment_svc()

    # Patch get_batch_job_manager so it returns a completed job immediately
    mock_job = {
        "job_id": "j1",
        "status": "completed",
        "total_items": 1,
        "processed_count": 1,
        "successful_count": 1,
        "failed_count": 0,
        "completed_at": "2026-01-01T01:00:00",
    }

    with patch(
        "src.main.controllers.assessment_router.get_batch_job_manager"
    ) as mock_mgr:
        mock_mgr.return_value.get_job.return_value = mock_job
        client = _build_client(instructor_svc=svc)

        with client.stream("GET", "/api/assessment/a1/generation-status/j1/stream") as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers["content-type"]
            content = b"".join(resp.iter_bytes())

    assert b'"status": "completed"' in content


def test_generation_status_stream_job_not_found_emits_error_event():
    svc = _assessment_svc()

    with patch(
        "src.main.controllers.assessment_router.get_batch_job_manager"
    ) as mock_mgr:
        mock_mgr.return_value.get_job.return_value = None
        client = _build_client(instructor_svc=svc)

        with client.stream("GET", "/api/assessment/a1/generation-status/bad-id/stream") as resp:
            content = b"".join(resp.iter_bytes())

    assert b"error" in content
    assert b"Job not found" in content
