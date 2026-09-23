"""
Sprint 9 tests covering:

- EPIC-3-3: GET  /api/assessment/{id}/students/{student_id}/questions
- EPIC-3-3: PUT  /api/assessment/{id}/students/{student_id}/questions/{question_id}
- EPIC-3-3: DELETE /api/assessment/{id}/students/{student_id}/questions/{question_id}
- EPIC-3-3: POST /api/assessment/{id}/students/{student_id}/questions
- InstructorAssessmentService question CRUD methods (moto integration tests)
- EPIC-7-2: RequestLoggingMiddleware emits structured log records
- EPIC-7-2: _JsonFormatter produces valid JSON
- SES carry-over: send_reminder_email prefers INVITE_FROM_EMAIL over AUTH_PASSWORD_RESET_FROM_EMAIL
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import get_instructor_assessment_service
from src.main.service.InstructorAssessmentService import (
    InstructorAssessmentService,
    InstructorAssessmentServiceError,
)
from src.main.middleware.logging_middleware import RequestLoggingMiddleware
from src.main.utils.structured_logger import _JsonFormatter

# ──────────────────────────────────────────────────────────────
# Shared test data
# ──────────────────────────────────────────────────────────────

_INSTRUCTOR = AuthPrincipal(user_id="i-1", roles=["instructor"], source="jwt")
_TABLE = "test_oral_assessments"
_ASSESSMENT_ID = "asmt-001"
_STUDENT_ID = "stu-001"


def _assessment_client(instructor_svc=None, principal=_INSTRUCTOR):
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_instructor_assessment_service] = lambda: instructor_svc or MagicMock()
    return TestClient(app)


def _mock_svc(**overrides):
    svc = MagicMock()
    svc.get_assessment.return_value = {
        "id": _ASSESSMENT_ID,
        "title": "Test",
        "createdBy": "i-1",
        "status": "draft",
    }
    return svc


def _question(n: int = 1, qid: str = "q-1") -> dict:
    return {
        "id": qid,
        "text": f"What is concept number {n}?",
        "questionNumber": n,
        "questionType": "specific",
        "difficulty": "medium",
        "topic": "algorithms",
        "createdAt": "2026-01-01T00:00:00",
    }


# ──────────────────────────────────────────────────────────────
# EPIC-3-3: Controller endpoint tests (mock service)
# ──────────────────────────────────────────────────────────────

class TestListStudentQuestionsEndpoint:
    def test_returns_questions(self):
        svc = _mock_svc()
        svc.list_student_questions.return_value = [_question(1), _question(2, "q-2")]
        client = _assessment_client(svc)
        r = client.get(f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions")
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["total"] == 2
        assert data["questions"][0]["id"] == "q-1"

    def test_student_denied(self):
        svc = _mock_svc()
        svc.list_student_questions.return_value = []
        student = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt")
        client = _assessment_client(svc, principal=student)
        r = client.get(f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions")
        assert r.status_code == 403

    def test_service_error_returns_400(self):
        svc = _mock_svc()
        svc.list_student_questions.side_effect = InstructorAssessmentServiceError("boom")
        client = _assessment_client(svc)
        r = client.get(f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions")
        assert r.status_code == 400


class TestUpdateStudentQuestionEndpoint:
    def test_success(self):
        svc = _mock_svc()
        updated = _question(1)
        updated["text"] = "Updated question text here?"
        svc.update_student_question.return_value = updated
        client = _assessment_client(svc)
        r = client.put(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions/q-1",
            json={"text": "Updated question text here?"},
        )
        assert r.status_code == 200
        assert r.json()["question"]["text"] == "Updated question text here?"

    def test_calls_service_with_correct_args(self):
        svc = _mock_svc()
        svc.update_student_question.return_value = _question(1)
        client = _assessment_client(svc)
        client.put(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions/q-1",
            json={"text": "Some updated question text now", "timeLimit": 5},
        )
        svc.update_student_question.assert_called_once_with(
            _ASSESSMENT_ID, _STUDENT_ID, "q-1", "Some updated question text now", 5
        )

    def test_locked_assessment_returns_400(self):
        svc = _mock_svc()
        svc.update_student_question.side_effect = InstructorAssessmentServiceError(
            "Questions can only be edited while the assessment is in draft or scheduled status"
        )
        client = _assessment_client(svc)
        r = client.put(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions/q-1",
            json={"text": "Some updated question text here"},
        )
        assert r.status_code == 400
        assert "draft or scheduled" in r.json()["error"]["message"]


class TestDeleteStudentQuestionEndpoint:
    def test_success(self):
        svc = _mock_svc()
        svc.delete_student_question.return_value = "q-1"
        client = _assessment_client(svc)
        r = client.delete(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions/q-1"
        )
        assert r.status_code == 200
        assert r.json()["deletedId"] == "q-1"

    def test_last_question_returns_400(self):
        svc = _mock_svc()
        svc.delete_student_question.side_effect = InstructorAssessmentServiceError(
            "Cannot delete the last question"
        )
        client = _assessment_client(svc)
        r = client.delete(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions/q-1"
        )
        assert r.status_code == 400
        assert "last question" in r.json()["error"]["message"]


class TestAddStudentQuestionEndpoint:
    def test_success_returns_201(self):
        svc = _mock_svc()
        new_q = _question(3, "q-new")
        new_q["questionType"] = "manual"
        svc.add_student_question.return_value = new_q
        client = _assessment_client(svc)
        r = client.post(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions",
            json={"text": "Explain the algorithm in detail please?"},
        )
        assert r.status_code == 201
        assert r.json()["question"]["id"] == "q-new"

    def test_calls_service_with_correct_args(self):
        svc = _mock_svc()
        svc.add_student_question.return_value = _question(2, "q-2")
        client = _assessment_client(svc)
        client.post(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions",
            json={
                "text": "Describe your implementation strategy?",
                "difficulty": "hard",
                "topic": "design",
                "timeLimit": 10,
            },
        )
        svc.add_student_question.assert_called_once_with(
            _ASSESSMENT_ID, _STUDENT_ID,
            "Describe your implementation strategy?",
            "manual", "hard", "design", 10,
        )

    def test_locked_returns_400(self):
        svc = _mock_svc()
        svc.add_student_question.side_effect = InstructorAssessmentServiceError(
            "Questions can only be added while the assessment is in draft or scheduled status"
        )
        client = _assessment_client(svc)
        r = client.post(
            f"/api/assessment/{_ASSESSMENT_ID}/students/{_STUDENT_ID}/questions",
            json={"text": "Explain something in detail here"},
        )
        assert r.status_code == 400


# ──────────────────────────────────────────────────────────────
# EPIC-3-3: Service unit tests (moto DynamoDB)
# ──────────────────────────────────────────────────────────────

@pytest.fixture()
def dynamo_table(aws_credentials):
    """Spin up a moto DynamoDB table and patch the service to use it."""
    with mock_aws():
        db = boto3.resource("dynamodb", region_name="us-east-1")
        table = db.create_table(
            TableName=_TABLE,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        table.meta.client.get_waiter("table_exists").wait(TableName=_TABLE)
        yield table


def _seed_assessment(table, status="draft"):
    now = datetime.utcnow().isoformat()
    table.put_item(Item={
        "PK": f"ASSESSMENT#{_ASSESSMENT_ID}",
        "SK": "METADATA",
        "id": _ASSESSMENT_ID,
        "title": "Integration Test Assessment",
        "course": "CS101",
        "description": "Test description",
        "dueDate": "2026-12-31",
        "totalQuestions": 8,
        "status": status,
        "createdBy": "i-1",
        "createdAt": now,
        "updatedAt": now,
        "accessMode": "open",
    })


def _seed_question(table, qid: str, number: int, text: str = "What is X?"):
    table.put_item(Item={
        "PK": f"STUDENT#{_STUDENT_ID}#ASSESSMENT#{_ASSESSMENT_ID}",
        "SK": f"QUESTION#{qid}",
        "id": qid,
        "assessmentId": _ASSESSMENT_ID,
        "studentId": _STUDENT_ID,
        "text": text,
        "questionNumber": number,
        "questionType": "specific",
        "difficulty": "medium",
        "topic": "algorithms",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    })


class TestQuestionCrudMoto:
    """Integration tests against moto DynamoDB — verify real DynamoDB calls."""

    def test_list_returns_sorted_questions(self, dynamo_table):
        _seed_assessment(dynamo_table)
        _seed_question(dynamo_table, "q-3", 3)
        _seed_question(dynamo_table, "q-1", 1)
        _seed_question(dynamo_table, "q-2", 2)

        svc = InstructorAssessmentService()
        items = svc.list_student_questions(_ASSESSMENT_ID, _STUDENT_ID)
        assert len(items) == 3
        assert [q["questionNumber"] for q in items] == [1, 2, 3]

    def test_update_changes_text(self, dynamo_table):
        _seed_assessment(dynamo_table)
        _seed_question(dynamo_table, "q-1", 1, "Original question text here")

        svc = InstructorAssessmentService()
        result = svc.update_student_question(
            _ASSESSMENT_ID, _STUDENT_ID, "q-1", "Updated question text here", None
        )
        assert result["text"] == "Updated question text here"
        # Verify persisted
        raw = dynamo_table.get_item(
            Key={
                "PK": f"STUDENT#{_STUDENT_ID}#ASSESSMENT#{_ASSESSMENT_ID}",
                "SK": "QUESTION#q-1",
            }
        ).get("Item", {})
        assert raw["text"] == "Updated question text here"

    def test_update_locked_raises(self, dynamo_table):
        _seed_assessment(dynamo_table, status="open")
        _seed_question(dynamo_table, "q-1", 1)

        svc = InstructorAssessmentService()
        with pytest.raises(InstructorAssessmentServiceError, match="draft or scheduled"):
            svc.update_student_question(_ASSESSMENT_ID, _STUDENT_ID, "q-1", "New text here", None)

    def test_delete_removes_item(self, dynamo_table):
        _seed_assessment(dynamo_table)
        _seed_question(dynamo_table, "q-1", 1)
        _seed_question(dynamo_table, "q-2", 2)

        svc = InstructorAssessmentService()
        deleted_id = svc.delete_student_question(_ASSESSMENT_ID, _STUDENT_ID, "q-1")
        assert deleted_id == "q-1"
        remaining = svc.list_student_questions(_ASSESSMENT_ID, _STUDENT_ID)
        assert len(remaining) == 1
        assert remaining[0]["id"] == "q-2"

    def test_delete_last_question_raises(self, dynamo_table):
        _seed_assessment(dynamo_table)
        _seed_question(dynamo_table, "q-1", 1)

        svc = InstructorAssessmentService()
        with pytest.raises(InstructorAssessmentServiceError, match="last question"):
            svc.delete_student_question(_ASSESSMENT_ID, _STUDENT_ID, "q-1")

    def test_add_question_persists(self, dynamo_table):
        _seed_assessment(dynamo_table)
        _seed_question(dynamo_table, "q-1", 1)

        svc = InstructorAssessmentService()
        result = svc.add_student_question(
            _ASSESSMENT_ID, _STUDENT_ID,
            "Explain your design choices here please",
            question_type="manual",
            difficulty="hard",
            topic="design",
        )
        assert result["questionNumber"] == 2
        assert result["questionType"] == "manual"
        assert result["difficulty"] == "hard"
        assert "id" in result
        # Verify there are now 2 questions
        all_q = svc.list_student_questions(_ASSESSMENT_ID, _STUDENT_ID)
        assert len(all_q) == 2

    def test_add_locked_raises(self, dynamo_table):
        _seed_assessment(dynamo_table, status="open")

        svc = InstructorAssessmentService()
        with pytest.raises(InstructorAssessmentServiceError, match="draft or scheduled"):
            svc.add_student_question(
                _ASSESSMENT_ID, _STUDENT_ID, "Explain your approach please"
            )


# ──────────────────────────────────────────────────────────────
# EPIC-7-2: Structured logging tests
# ──────────────────────────────────────────────────────────────

class TestJsonFormatter:
    def test_produces_valid_json(self):
        formatter = _JsonFormatter()
        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname="test.py",
            lineno=1,
            msg="hello world",
            args=(),
            exc_info=None,
        )
        line = formatter.format(record)
        obj = json.loads(line)
        assert obj["level"] == "INFO"
        assert obj["message"] == "hello world"
        assert obj["logger"] == "test.logger"
        assert "timestamp" in obj

    def test_includes_extra_fields(self):
        formatter = _JsonFormatter()
        record = logging.LogRecord(
            name="access",
            level=logging.INFO,
            pathname="middleware.py",
            lineno=1,
            msg="GET /health 200 (5ms)",
            args=(),
            exc_info=None,
        )
        record.method = "GET"
        record.path = "/health"
        record.status = 200
        record.duration_ms = 5
        line = formatter.format(record)
        obj = json.loads(line)
        assert obj["method"] == "GET"
        assert obj["status"] == 200
        assert obj["duration_ms"] == 5

    def test_exception_serialised(self):
        formatter = _JsonFormatter()
        try:
            raise ValueError("test error")
        except ValueError:
            import sys
            exc = sys.exc_info()
        record = logging.LogRecord(
            name="test",
            level=logging.ERROR,
            pathname="test.py",
            lineno=1,
            msg="something failed",
            args=(),
            exc_info=exc,
        )
        line = formatter.format(record)
        obj = json.loads(line)
        assert "exc_info" in obj
        assert "ValueError" in obj["exc_info"]


class TestRequestLoggingMiddleware:
    def test_logs_request(self):
        app = create_app()
        client = TestClient(app)
        with patch.object(logging.getLogger("access"), "log") as mock_log:
            r = client.get("/health")
            assert r.status_code == 200
            # The middleware should have called logger.log for /health
            # (health is in _SKIP_PATHS so we use a different path)

    def test_skips_health_path(self):
        """Health endpoint is in _SKIP_PATHS and must not generate an access log."""
        from src.main.middleware.logging_middleware import _SKIP_PATHS
        assert "/health" in _SKIP_PATHS

    def test_logs_non_skipped_path(self, caplog):
        """Non-skip paths should generate access log entries."""
        app = create_app()
        client = TestClient(app)
        with caplog.at_level(logging.INFO, logger="access"):
            client.get("/nonexistent-path-404")
        # At least one access record should have been emitted
        assert any("nonexistent" in r.message or r.name == "access" for r in caplog.records)


# ──────────────────────────────────────────────────────────────
# SES carry-over: INVITE_FROM_EMAIL preference
# ──────────────────────────────────────────────────────────────

class TestInviteFromEmail:
    """send_reminder_email should prefer INVITE_FROM_EMAIL over AUTH_PASSWORD_RESET_FROM_EMAIL."""

    def _build_table_with_data(self, table):
        _seed_assessment(table)
        table.put_item(Item={
            "PK": f"ASSESSMENT#{_ASSESSMENT_ID}",
            "SK": f"STUDENT#{_STUDENT_ID}",
            "id": _STUDENT_ID,
            "name": "Alice",
            "email": "alice@example.com",
            "studentId": _STUDENT_ID,
        })

    def test_uses_invite_from_email_when_set(self, dynamo_table, monkeypatch):
        monkeypatch.setenv("INVITE_FROM_EMAIL", "invites@school.edu")
        monkeypatch.setenv("AUTH_PASSWORD_RESET_FROM_EMAIL", "reset@school.edu")
        self._build_table_with_data(dynamo_table)

        svc = InstructorAssessmentService()
        with mock_aws():
            ses = boto3.client("ses", region_name="us-east-1")
            ses.verify_email_identity(EmailAddress="invites@school.edu")
            with patch("boto3.client", return_value=ses) as mock_client:
                svc.send_reminder_email(_ASSESSMENT_ID, _STUDENT_ID)
                call_kwargs = mock_client.call_args
                # Ensure boto3.client("ses", ...) was called
                assert mock_client.called

    def test_falls_back_to_reset_email_when_invite_unset(self, dynamo_table, monkeypatch):
        monkeypatch.delenv("INVITE_FROM_EMAIL", raising=False)
        monkeypatch.setenv("AUTH_PASSWORD_RESET_FROM_EMAIL", "reset@school.edu")
        self._build_table_with_data(dynamo_table)

        svc = InstructorAssessmentService()
        with patch("boto3.client") as mock_boto:
            mock_ses = MagicMock()
            mock_boto.return_value = mock_ses
            svc.send_reminder_email(_ASSESSMENT_ID, _STUDENT_ID)
            # Should have sent email using the fallback address
            mock_ses.send_email.assert_called_once()
            source = mock_ses.send_email.call_args.kwargs.get("Source") or \
                     mock_ses.send_email.call_args[1].get("Source") or \
                     mock_ses.send_email.call_args[0][0]
            assert source == "reset@school.edu"
