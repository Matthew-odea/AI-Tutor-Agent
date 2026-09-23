"""
Question generation router: generate-questions-batch dispatches via SQS.

Covers:
- generate-questions-batch uses SQS dispatcher
"""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import (
    get_instructor_assessment_service,
    get_question_service,
    get_sqs_job_dispatcher,
)


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

_INSTRUCTOR = AuthPrincipal(user_id="inst-1", roles=["instructor"], source="jwt")

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

def _build_client(
    principal=_INSTRUCTOR,
    instructor_svc=None,
    dispatcher=None,
) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_instructor_assessment_service] = lambda: instructor_svc or MagicMock()
    app.dependency_overrides[get_sqs_job_dispatcher] = lambda: dispatcher or MagicMock()
    app.dependency_overrides[get_question_service] = lambda: MagicMock()
    return TestClient(app)


def _assessment_svc():
    svc = MagicMock()
    svc.get_assessment.return_value = _ASSESSMENT
    svc.get_assessment_students.return_value = [
        {"studentId": "s-1", "name": "Alice", "email": "a@b.com", "code": "x = 1"}
    ]
    return svc


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
