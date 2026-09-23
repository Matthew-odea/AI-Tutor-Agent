"""Tests for POST /api/student/{student_id}/consent."""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import get_oral_assessment_service
from src.main.service.OralAssessmentService import OralAssessmentServiceError


_STUDENT = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt", assessment_id="a-1")


def _build_client(principal=_STUDENT, svc=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_oral_assessment_service] = lambda: svc or MagicMock()
    return TestClient(app)


def _mock_svc(**kwargs):
    svc = MagicMock()
    svc.record_consent.return_value = kwargs.get(
        "record_consent_result",
        {
            "ok": True,
            "studentId": "s-1",
            "assessmentId": "a-1",
            "granted": True,
            "recordedAt": "2026-06-22T10:00:00.000Z",
        },
    )
    return svc


def test_record_consent_returns_200():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/consent",
        json={
            "assessment_id": "a-1",
            "granted": True,
            "consent_version": "2026-06-10",
            "timestamp": "2026-06-22T10:00:00.000Z",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["granted"] is True
    svc.record_consent.assert_called_once()


def test_record_consent_forwards_all_fields():
    svc = _mock_svc()
    client = _build_client(principal=AuthPrincipal(user_id="s-1", roles=["student"], source="jwt", assessment_id="a-99"), svc=svc)

    client.post(
        "/api/student/s-1/consent",
        json={
            "assessment_id": "a-99",
            "granted": False,
            "consent_version": "2026-06-10",
            "timestamp": "2026-06-22T10:05:00.000Z",
        },
    )

    call_kwargs = svc.record_consent.call_args[1]
    assert call_kwargs["student_id"] == "s-1"
    assert call_kwargs["assessment_id"] == "a-99"
    assert call_kwargs["granted"] is False
    assert call_kwargs["consent_version"] == "2026-06-10"
    assert call_kwargs["timestamp"] == "2026-06-22T10:05:00.000Z"


def test_record_consent_declined_accepted():
    svc = _mock_svc(record_consent_result={
        "ok": True, "studentId": "s-1", "assessmentId": "a-1",
        "granted": False, "recordedAt": "2026-06-22T10:00:00.000Z",
    })
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/consent",
        json={
            "assessment_id": "a-1",
            "granted": False,
            "consent_version": "2026-06-10",
            "timestamp": "2026-06-22T10:00:00.000Z",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["granted"] is False


def test_record_consent_missing_granted_rejected():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/consent",
        json={
            "assessment_id": "a-1",
            "consent_version": "2026-06-10",
            "timestamp": "2026-06-22T10:00:00.000Z",
        },
    )

    assert resp.status_code == 422


def test_record_consent_service_error_returns_400():
    svc = _mock_svc()
    svc.record_consent.side_effect = OralAssessmentServiceError("db error")
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/consent",
        json={
            "assessment_id": "a-1",
            "granted": True,
            "consent_version": "2026-06-10",
            "timestamp": "2026-06-22T10:00:00.000Z",
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "consent_failed"


def test_record_consent_wrong_student_forbidden():
    """Student s-1 cannot record consent as s-2."""
    client = _build_client(principal=_STUDENT)

    resp = client.post(
        "/api/student/s-2/consent",
        json={
            "assessment_id": "a-1",
            "granted": True,
            "consent_version": "2026-06-10",
            "timestamp": "2026-06-22T10:00:00.000Z",
        },
    )

    assert resp.status_code == 403
