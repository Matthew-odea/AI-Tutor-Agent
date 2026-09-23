"""
Tests for Sprint 5 student router changes:
- Text answer submission (answer_type='text')
- Audio answer still works with new optional fields
- timeLimit exposed in questions response
- Submit answer requires either audio_url or text_content depending on type
"""

from unittest.mock import MagicMock, patch

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
_INSTRUCTOR = AuthPrincipal(user_id="inst-1", roles=["instructor"], source="jwt")

_QUESTION_WITH_LIMIT = {
    "id": "q-1",
    "text": "What is recursion?",
    "codeContext": None,
    "assessmentId": "a-1",
    "studentId": "s-1",
    "difficulty": "medium",
    "topic": "algorithms",
    "timeLimit": 90,
    "createdAt": "2026-01-01T00:00:00",
}

_QUESTION_NO_LIMIT = {**_QUESTION_WITH_LIMIT, "id": "q-2", "timeLimit": None}


def _build_client(principal=_STUDENT, svc=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_oral_assessment_service] = lambda: svc or MagicMock()
    return TestClient(app)


def _mock_svc(**kwargs):
    svc = MagicMock()
    svc.get_student_questions.return_value = kwargs.get("questions", [_QUESTION_WITH_LIMIT])
    svc.submit_answer.return_value = kwargs.get(
        "submit_answer_result",
        {
            "ok": True,
            "studentId": "s-1",
            "questionId": "q-1",
            "answerType": "audio",
            "audioUrl": "s3://bucket/audio.webm",
            "duration": 30,
            "textContent": None,
            "submittedAt": "2026-01-01T00:01:00",
            "assessmentId": "a-1",
        },
    )
    return svc


# ─────────────────────────────────────────────────────────────
# GET questions — timeLimit exposed
# ─────────────────────────────────────────────────────────────

def test_get_questions_includes_time_limit():
    svc = _mock_svc(questions=[_QUESTION_WITH_LIMIT])
    client = _build_client(svc=svc)

    resp = client.get("/api/student/s-1/assessment/a-1/questions")

    assert resp.status_code == 200
    body = resp.json()
    assert body["questions"][0]["timeLimit"] == 90


def test_get_questions_time_limit_null_when_not_set():
    svc = _mock_svc(questions=[_QUESTION_NO_LIMIT])
    client = _build_client(svc=svc)

    resp = client.get("/api/student/s-1/assessment/a-1/questions")

    assert resp.status_code == 200
    assert resp.json()["questions"][0]["timeLimit"] is None


# ─────────────────────────────────────────────────────────────
# POST answer — audio (existing flow still works)
# ─────────────────────────────────────────────────────────────

def test_submit_audio_answer_returns_200():
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "answer_type": "audio",
            "audio_url": "s3://bucket/audio.webm",
            "duration": 30,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["answerType"] == "audio"
    svc.submit_answer.assert_called_once()
    call_kwargs = svc.submit_answer.call_args[1]
    assert call_kwargs["answer_type"] == "audio"
    assert call_kwargs["audio_url"] == "s3://bucket/audio.webm"


def test_submit_audio_answer_default_type():
    """answer_type defaults to 'audio' when omitted."""
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "audio_url": "s3://bucket/audio.webm",
            "duration": 45,
        },
    )

    assert resp.status_code == 200
    call_kwargs = svc.submit_answer.call_args[1]
    assert call_kwargs["answer_type"] == "audio"


# ─────────────────────────────────────────────────────────────
# POST answer — text
# ─────────────────────────────────────────────────────────────

def test_submit_text_answer_returns_200():
    svc = _mock_svc(
        submit_answer_result={
            "ok": True,
            "studentId": "s-1",
            "questionId": "q-1",
            "answerType": "text",
            "audioUrl": None,
            "duration": None,
            "textContent": "Recursion is when a function calls itself.",
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
            "answer_type": "text",
            "text_content": "Recursion is when a function calls itself.",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["answerType"] == "text"
    assert body["textContent"] == "Recursion is when a function calls itself."
    svc.submit_answer.assert_called_once()
    call_kwargs = svc.submit_answer.call_args[1]
    assert call_kwargs["answer_type"] == "text"
    assert call_kwargs["text_content"] == "Recursion is when a function calls itself."


def test_submit_answer_missing_assessment_id_rejected():
    """assessment_id is now required — omitting it returns 422."""
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "answer_type": "audio",
            "audio_url": "s3://bucket/audio.webm",
            "duration": 30,
        },
    )

    assert resp.status_code == 422


def test_submit_answer_assessment_id_forwarded_to_service():
    """assessment_id from the request body is forwarded to the service."""
    svc = _mock_svc()
    client = _build_client(svc=svc)

    client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-99",
            "answer_type": "text",
            "text_content": "Some answer.",
        },
    )

    call_kwargs = svc.submit_answer.call_args[1]
    assert call_kwargs["assessment_id"] == "a-99"


def test_submit_text_answer_empty_string_rejected():
    """text_content with only whitespace / empty should fail Pydantic min_length."""
    svc = _mock_svc()
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "answer_type": "text",
            "text_content": "",
        },
    )

    assert resp.status_code == 422


def test_submit_text_answer_service_error_returns_400():
    svc = _mock_svc()
    svc.submit_answer.side_effect = OralAssessmentServiceError("question not found")
    client = _build_client(svc=svc)

    resp = client.post(
        "/api/student/s-1/answer",
        json={
            "question_id": "q-999",
            "assessment_id": "a-1",
            "answer_type": "text",
            "text_content": "Some answer text.",
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "submit_answer_failed"


# ─────────────────────────────────────────────────────────────
# Auth
# ─────────────────────────────────────────────────────────────

def test_submit_answer_wrong_student_forbidden():
    """Student s-1 cannot submit answers as s-2."""
    client = _build_client(principal=_STUDENT)

    resp = client.post(
        "/api/student/s-2/answer",
        json={
            "question_id": "q-1",
            "assessment_id": "a-1",
            "answer_type": "text",
            "text_content": "Some text",
        },
    )

    assert resp.status_code == 403
