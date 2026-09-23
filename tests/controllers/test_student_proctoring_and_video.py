"""
Tests for Sprint 6 student router changes:
- Video answer submission (answer_type='video')
- Proctoring chunk manifest endpoint
- video_url stored and returned correctly
- Proctoring chunk requires assessment_id, chunk_url, chunk_index
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import get_oral_assessment_service
from src.main.service.OralAssessmentService import OralAssessmentServiceError


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

_STUDENT = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt")


def _build_client(principal=_STUDENT, svc=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_oral_assessment_service] = lambda: svc or MagicMock()
    return TestClient(app)


def _mock_svc(**kwargs):
    svc = MagicMock()
    svc.submit_answer.return_value = kwargs.get(
        "submit_answer_result",
        {
            "ok": True,
            "studentId": "s-1",
            "questionId": "q-1",
            "answerType": "audio",
            "audioUrl": None,
            "duration": None,
            "textContent": None,
            "videoUrl": None,
            "submittedAt": "2026-01-01T00:01:00",
            "assessmentId": "a-1",
        },
    )
    svc.submit_proctor_chunk.return_value = kwargs.get(
        "proctor_chunk_result",
        {
            "ok": True,
            "studentId": "s-1",
            "assessmentId": "a-1",
            "chunkIndex": 0,
        },
    )
    return svc


# ─────────────────────────────────────────────────────────────
# POST answer — video
# ─────────────────────────────────────────────────────────────

def test_submit_video_answer_returns_200():
    svc = _mock_svc(
        submit_answer_result={
            "ok": True,
            "studentId": "s-1",
            "questionId": "q-1",
            "answerType": "video",
            "audioUrl": None,
            "duration": 45,
            "textContent": None,
            "videoUrl": "s3://bucket/video/s-1/q-1_1234.webm",
            "submittedAt": "2026-01-01T00:01:00",
            "assessmentId": "a-1",
        }
    )
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "answer_type": "video",
            "video_url": "s3://bucket/video/s-1/q-1_1234.webm",
            "duration": 45,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["answerType"] == "video"
    assert body["videoUrl"] == "s3://bucket/video/s-1/q-1_1234.webm"
    assert body["duration"] == 45
    svc.submit_answer.assert_called_once()
    call_kwargs = svc.submit_answer.call_args[1]
    assert call_kwargs["answer_type"] == "video"
    assert call_kwargs["video_url"] == "s3://bucket/video/s-1/q-1_1234.webm"


def test_submit_video_answer_video_url_forwarded_to_service():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "answer_type": "video",
            "video_url": "s3://bucket/video.webm",
            "duration": 60,
        },
    )

    call_kwargs = svc.submit_answer.call_args[1]
    assert call_kwargs["video_url"] == "s3://bucket/video.webm"
    assert call_kwargs["duration"] == 60


def test_submit_video_answer_service_error_returns_400():
    svc = _mock_svc()
    svc.submit_answer.side_effect = OralAssessmentServiceError("assessment window closed")
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "answer_type": "video",
            "video_url": "s3://bucket/video.webm",
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "submit_answer_failed"


# ─────────────────────────────────────────────────────────────
# POST proctoring-chunk
# ─────────────────────────────────────────────────────────────

def test_submit_proctor_chunk_returns_200():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/proctoring-chunk",
        json={
            "assessment_id": "a-1",
            "chunk_url": "s3://bucket/proctoring/a-1/s-1/chunk_000000.webm",
            "chunk_index": 0,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["chunkIndex"] == 0
    svc.submit_proctor_chunk.assert_called_once()


def test_submit_proctor_chunk_forwards_all_fields():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    client.post(
        "/api/student/s-1/proctoring-chunk",
        json={
            "assessment_id": "a-99",
            "chunk_url": "s3://bucket/proctoring/a-99/s-1/chunk_000003.webm",
            "chunk_index": 3,
            "timestamp": "2026-01-01T00:01:30",
        },
    )

    call_kwargs = svc.submit_proctor_chunk.call_args[1]
    assert call_kwargs["student_id"] == "s-1"
    assert call_kwargs["assessment_id"] == "a-99"
    assert call_kwargs["chunk_url"] == "s3://bucket/proctoring/a-99/s-1/chunk_000003.webm"
    assert call_kwargs["chunk_index"] == 3
    assert call_kwargs["timestamp"] == "2026-01-01T00:01:30"


def test_submit_proctor_chunk_missing_assessment_id_rejected():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/proctoring-chunk",
        json={
            "chunk_url": "s3://bucket/chunk.webm",
            "chunk_index": 0,
        },
    )

    assert resp.status_code == 422


def test_submit_proctor_chunk_negative_index_rejected():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/proctoring-chunk",
        json={
            "assessment_id": "a-1",
            "chunk_url": "s3://bucket/chunk.webm",
            "chunk_index": -1,
        },
    )

    assert resp.status_code == 422


def test_submit_proctor_chunk_service_error_returns_400():
    svc = _mock_svc()
    svc.submit_proctor_chunk.side_effect = OralAssessmentServiceError("db error")
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/proctoring-chunk",
        json={
            "assessment_id": "a-1",
            "chunk_url": "s3://bucket/chunk.webm",
            "chunk_index": 0,
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "proctor_chunk_failed"


def test_submit_proctor_chunk_wrong_student_forbidden():
    """Student s-1 cannot POST proctoring chunks as s-2."""
    client = _build_client(principal=_STUDENT)

    resp = client.post(
        "/api/student/s-2/proctoring-chunk",
        json={
            "assessment_id": "a-1",
            "chunk_url": "s3://bucket/chunk.webm",
            "chunk_index": 0,
        },
    )

    assert resp.status_code == 403
