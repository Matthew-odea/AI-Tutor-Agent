from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import get_oral_assessment_service
from src.main.service.OralAssessmentService import OralAssessmentServiceError


def _build_client(principal: AuthPrincipal, oral_service=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_oral_assessment_service] = lambda: oral_service or MagicMock()
    return TestClient(app, raise_server_exceptions=False)


def _answer_payload():
    return {
        "question_id": "q1",
        "assessment_id": "a1",
        "audio_url": "https://example.com/audio.webm",
        "duration": 42,
    }


@pytest.mark.parametrize(
    "side_effect,expected_status,expected_code",
    [
        (OralAssessmentServiceError("invalid answer"), 400, "submit_answer_failed"),
        (RuntimeError("boom"), 500, "internal_error"),
    ],
)
def test_submit_answer_error_mappings(side_effect, expected_status, expected_code):
    svc = MagicMock()
    svc.submit_answer.side_effect = side_effect
    client = _build_client(AuthPrincipal(user_id="s-1", roles=["student"], source="jwt", assessment_id="a1"), svc)

    response = client.post(
        "/api/student/s-1/answer",
        json=_answer_payload(),
    )

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code


def test_student_access_denied_maps_to_auth_error():
    client = _build_client(AuthPrincipal(user_id="someone-else", roles=["student"], source="jwt"), MagicMock())

    response = client.post(
        "/api/student/s-1/answer",
        json=_answer_payload(),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "auth_error"


def test_get_results_maps_not_found_code():
    svc = MagicMock()
    svc.get_student_results.side_effect = OralAssessmentServiceError("results pending")
    client = _build_client(AuthPrincipal(user_id="s-1", roles=["student"], source="jwt", assessment_id="a1"), svc)

    response = client.get("/api/student/s-1/assessment/a1/results")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "student_results_not_found"
