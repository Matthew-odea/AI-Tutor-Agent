from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import (
    get_evaluation_service,
    get_instructor_assessment_service,
    get_question_service,
)
from src.main.service.InstructorAssessmentService import InstructorAssessmentServiceError


def _build_client(principal: AuthPrincipal, instructor_service=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_instructor_assessment_service] = lambda: instructor_service or MagicMock()
    app.dependency_overrides[get_question_service] = lambda: MagicMock()
    app.dependency_overrides[get_evaluation_service] = lambda: MagicMock()
    # raise_server_exceptions=False so an unhandled error is served by the global
    # handler in api_errors.py instead of being re-raised into the test.
    return TestClient(app, raise_server_exceptions=False)


def _create_payload():
    return {
        "title": "A1",
        "course": "CS101",
        "description": "desc",
        "dueDate": "2026-03-01",
        "totalQuestions": 3,
        "timeLimit": 10,
    }


@pytest.mark.parametrize(
    "side_effect,expected_status,expected_code",
    [
        (InstructorAssessmentServiceError("bad assessment"), 400, "assessment_create_failed"),
        (RuntimeError("boom"), 500, "internal_error"),
    ],
)
def test_create_assessment_error_mappings(side_effect, expected_status, expected_code):
    svc = MagicMock()
    svc.create_assessment.side_effect = side_effect
    client = _build_client(AuthPrincipal(user_id="inst-1", roles=["instructor"], source="jwt"), svc)

    response = client.post(
        "/api/assessment/create",
        json=_create_payload(),
    )

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code


def test_list_assessments_forbidden_maps_to_auth_error():
    client = _build_client(AuthPrincipal(user_id="s-1", roles=["student"], source="jwt"), MagicMock())

    response = client.get("/api/assessment/list")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "auth_error"


def test_generate_questions_batch_passthrough_api_error_code():
    svc = MagicMock()
    svc.get_assessment.return_value = {
        "id": "a1",
        "createdBy": "inst-1",
        "title": "A1",
        "course": "CS101",
        "description": "d",
        "dueDate": "2026-03-01",
        "totalQuestions": 3,
        "timeLimit": 10,
        "status": "draft",
        "createdAt": "2026-02-18T00:00:00Z",
        "updatedAt": "2026-02-18T00:00:00Z",
    }
    svc.get_assessment_students.return_value = []

    client = _build_client(AuthPrincipal(user_id="inst-1", roles=["instructor"], source="jwt"), svc)

    response = client.post("/api/assessment/a1/generate-questions-batch", json={})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "no_students_to_process"
