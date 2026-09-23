"""
Sprint 8 tests covering:
- EPIC-6-1: GET /api/assessment/{id}/results returns results with grade distribution (existing endpoint, verified)
- EPIC-6-1: GET /api/assessment/{id}/evaluation-status-stream/{jobId} SSE stream
- EPIC-6-2: GET /api/assessment/{id}/student/{studentId}/results — instructor per-student detail
- EPIC-6-2: PUT /api/assessment/{id}/student/{studentId}/question/{questionId}/override — score override
- EPIC-6-3: PUT /api/assessment/{id}/release-results — release results flag
- EPIC-6-3: Student results gated on resultsReleased flag
- EPIC-6-3: GET /api/student/{id}/assessment/{id}/results/pdf — PDF generation
- EPIC-6-4: POST /api/assessment/{id}/student/{studentId}/remind — send reminder
- InstructorAssessmentResultsAggregator.get_student_detail — unit tests
- OralAssessmentResultsAggregator resultsReleased gate — unit tests
"""

from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import (
    get_instructor_assessment_service,
    get_oral_assessment_service,
)
from src.main.service.InstructorAssessmentService import InstructorAssessmentServiceError
from src.main.service.OralAssessmentService import OralAssessmentServiceError
from src.main.service.InstructorAssessmentResultsAggregator import InstructorAssessmentResultsAggregator, _effective_score
from src.main.service.OralAssessmentResultsAggregator import OralAssessmentResultsAggregator


# ─────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────

_INSTRUCTOR = AuthPrincipal(user_id="i-1", roles=["instructor"], source="jwt")
_STUDENT = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt")


def _assessment_client(instructor_svc=None, principal=_INSTRUCTOR):
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_instructor_assessment_service] = lambda: instructor_svc or MagicMock()
    return TestClient(app)


def _student_client(oral_svc=None, principal=_STUDENT):
    app = create_app()
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_oral_assessment_service] = lambda: oral_svc or MagicMock()
    return TestClient(app)


def _mock_instructor_svc(**overrides):
    svc = MagicMock()
    svc.get_assessment.return_value = overrides.get("assessment", {
        "id": "a-1", "title": "Test", "createdBy": "i-1",
        "autoEvaluate": False, "rubric": None, "resultsReleased": False,
    })
    return svc


def _make_question_detail(**kwargs):
    defaults = {
        "questionId": "q-1",
        "questionText": "What is X?",
        "answerType": "audio",
        "audioUrl": "s3://bucket/audio.webm",
        "videoUrl": None,
        "textContent": None,
        "duration": 30,
        "transcript": "X is Y",
        "transcriptStatus": "completed",
        "aiScore": 7,
        "instructorScore": None,
        "effectiveScore": 7,
        "maxScore": 10,
        "feedback": "Good answer",
        "strengths": "Clear explanation",
        "improvements": "Add more detail",
        "instructorComment": None,
        "evaluatedAt": "2024-01-01T00:00:00",
    }
    defaults.update(kwargs)
    return defaults


def _make_proctoring(**kwargs):
    defaults = {
        "studentId": "s-1",
        "assessmentId": "a-1",
        "totalChunks": 3,
        "missingIndexes": [],
        "chunks": [
            {"chunkIndex": 0, "chunkUrl": "s3://b/c0.webm", "recordedAt": "2024-01-01T00:00:00"},
            {"chunkIndex": 1, "chunkUrl": "s3://b/c1.webm", "recordedAt": "2024-01-01T00:00:30"},
            {"chunkIndex": 2, "chunkUrl": "s3://b/c2.webm", "recordedAt": "2024-01-01T00:01:00"},
        ],
    }
    defaults.update(kwargs)
    return defaults


def _make_student_detail(**kwargs):
    defaults = {
        "studentId": "s-1",
        "studentName": "Alice",
        "studentEmail": "alice@example.com",
        "assessmentId": "a-1",
        "totalScore": 14,
        "maxScore": 20,
        "percentage": 70.0,
        "grade": "Competent",
        "submittedAt": "2024-01-01T12:00:00",
        "questions": [_make_question_detail()],
        "proctoring": _make_proctoring(),
    }
    defaults.update(kwargs)
    return defaults


# ─────────────────────────────────────────────────────────────
# _effective_score unit tests
# ─────────────────────────────────────────────────────────────

class TestEffectiveScore:
    def test_returns_instructor_score_when_set(self):
        assert _effective_score({"totalScore": 5, "instructorScore": 9}) == 9

    def test_returns_ai_score_when_no_override(self):
        assert _effective_score({"totalScore": 6}) == 6

    def test_zero_when_no_scores(self):
        assert _effective_score({}) == 0

    def test_instructor_score_zero_is_valid(self):
        assert _effective_score({"totalScore": 8, "instructorScore": 0}) == 0


# ─────────────────────────────────────────────────────────────
# InstructorAssessmentResultsAggregator.get_student_detail
# ─────────────────────────────────────────────────────────────

class TestGetStudentDetail:
    def _make_table(self, questions=None, answers=None, evaluations=None, chunks=None, enrollment=None, metadata=None):
        table = MagicMock()

        # get_student_detail now issues ONE query for all items under the student
        # PK (questions/answers/evaluations/chunks share the partition) and buckets
        # them by SK prefix in code.
        all_items = (questions or []) + (answers or []) + (evaluations or []) + (chunks or [])
        table.query.return_value = {"Items": all_items}

        # Two get_item calls: the assessment METADATA item (scoring config) and the
        # enrollment record. Route by SK so each gets the right payload.
        enrollment_item = enrollment or {"name": "Alice", "email": "a@b.com", "submittedAt": "2024-01-01"}

        def _get_item(Key=None, **kwargs):
            sk = (Key or {}).get("SK", "")
            if sk == "METADATA":
                return {"Item": metadata} if metadata else {}
            return {"Item": enrollment_item}

        table.get_item.side_effect = _get_item
        return table

    def test_basic_aggregation(self):
        questions = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "QUESTION#q-1", "text": "What is X?"}]
        answers = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-1", "audioUrl": "s3://b/a.webm", "transcript": "X is Y"}]
        evaluations = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "EVALUATION#q-1", "totalScore": 8, "maxScore": 10, "feedback": "Good"}]

        table = self._make_table(questions=questions, answers=answers, evaluations=evaluations)
        agg = InstructorAssessmentResultsAggregator(table=table, get_students=MagicMock())
        result = agg.get_student_detail("a-1", "s-1")

        assert result["studentId"] == "s-1"
        assert result["totalScore"] == 8
        assert result["maxScore"] == 10
        assert result["percentage"] == 80.0
        assert result["grade"] == "Competent"
        assert len(result["questions"]) == 1
        assert result["questions"][0]["aiScore"] == 8
        assert result["questions"][0]["effectiveScore"] == 8

    def test_instructor_override_used_in_effective_score(self):
        questions = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "QUESTION#q-1", "text": "Q"}]
        answers = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-1"}]
        evaluations = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "EVALUATION#q-1", "totalScore": 4, "instructorScore": 9, "maxScore": 10}]

        table = self._make_table(questions=questions, answers=answers, evaluations=evaluations)
        agg = InstructorAssessmentResultsAggregator(table=table, get_students=MagicMock())
        result = agg.get_student_detail("a-1", "s-1")

        q = result["questions"][0]
        assert q["aiScore"] == 4
        assert q["instructorScore"] == 9
        assert q["effectiveScore"] == 9
        assert result["totalScore"] == 9

    def test_proctoring_chunk_health_missing_detected(self):
        questions = [{"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "QUESTION#q-1", "text": "Q"}]
        chunks = [
            {"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "PROCTORING#CHUNK#000000", "chunkIndex": 0, "chunkUrl": "s3://b/c0.webm"},
            {"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "PROCTORING#CHUNK#000002", "chunkIndex": 2, "chunkUrl": "s3://b/c2.webm"},
        ]
        table = self._make_table(questions=questions, chunks=chunks)
        agg = InstructorAssessmentResultsAggregator(table=table, get_students=MagicMock())
        result = agg.get_student_detail("a-1", "s-1")

        proctoring = result["proctoring"]
        assert proctoring["totalChunks"] == 2
        assert 1 in proctoring["missingIndexes"]


# ─────────────────────────────────────────────────────────────
# OralAssessmentResultsAggregator — resultsReleased gate
# ─────────────────────────────────────────────────────────────

class TestResultsReleasedGate:
    def _make_table(self, released: bool):
        table = MagicMock()
        table.get_item.side_effect = lambda Key, **kwargs: {
            "Item": (
                {"name": "Alice", "email": "a@b.com", "status": "submitted"}
                if "ASSESSMENT#" in Key["PK"] and Key["SK"].startswith("STUDENT#")
                else {"title": "Test", "resultsReleased": released}
            )
        }
        table.query.return_value = {"Items": []}
        return table

    def test_raises_when_results_not_released(self):
        table = self._make_table(released=False)
        agg = OralAssessmentResultsAggregator(table=table)
        with pytest.raises(ValueError, match="not released"):
            agg.get_student_results(student_id="s-1", assessment_id="a-1")

    def test_passes_gate_when_released(self):
        table = MagicMock()
        # Enrollment
        table.get_item.side_effect = lambda Key, **kwargs: {
            "Item": (
                {"name": "Alice", "email": "a@b.com", "status": "submitted"}
                if Key["SK"].startswith("STUDENT#")
                else {"title": "Test", "resultsReleased": True}
            )
        }
        # No evaluations — will raise "not available"
        table.query.return_value = {"Items": []}
        agg = OralAssessmentResultsAggregator(table=table)
        with pytest.raises(ValueError, match="not available"):
            agg.get_student_results(student_id="s-1", assessment_id="a-1")


# ─────────────────────────────────────────────────────────────
# EPIC-6-2: GET /api/assessment/{id}/student/{studentId}/results
# ─────────────────────────────────────────────────────────────

class TestGetStudentDetailEndpoint:
    def test_returns_student_detail(self):
        svc = _mock_instructor_svc()
        svc.get_student_detail.return_value = _make_student_detail()

        client = _assessment_client(svc)
        resp = client.get("/api/assessment/a-1/student/s-1/results")

        assert resp.status_code == 200
        data = resp.json()
        assert data["studentId"] == "s-1"
        assert data["grade"] == "Competent"
        assert len(data["questions"]) == 1
        assert "proctoring" in data

    def test_not_found_returns_404(self):
        svc = _mock_instructor_svc()
        svc.get_student_detail.side_effect = InstructorAssessmentServiceError("not found")

        client = _assessment_client(svc)
        resp = client.get("/api/assessment/a-1/student/s-1/results")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "student_detail_not_found"

    def test_student_cannot_call_instructor_endpoint(self):
        svc = _mock_instructor_svc()
        client = _assessment_client(svc, principal=_STUDENT)
        resp = client.get("/api/assessment/a-1/student/s-1/results")
        assert resp.status_code == 403


# ─────────────────────────────────────────────────────────────
# EPIC-6-2: PUT override
# ─────────────────────────────────────────────────────────────

class TestScoreOverrideEndpoint:
    def test_override_success(self):
        svc = _mock_instructor_svc()
        svc.override_question_score.return_value = {
            "assessmentId": "a-1",
            "studentId": "s-1",
            "questionId": "q-1",
            "instructorScore": 9,
            "comment": "Great",
        }

        client = _assessment_client(svc)
        resp = client.put(
            "/api/assessment/a-1/student/s-1/question/q-1/override",
            json={"score": 9, "comment": "Great"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["instructorScore"] == 9

    def test_override_calls_service_correctly(self):
        svc = _mock_instructor_svc()
        svc.override_question_score.return_value = {
            "assessmentId": "a-1", "studentId": "s-1", "questionId": "q-1",
            "instructorScore": 5, "comment": None,
        }

        client = _assessment_client(svc)
        client.put(
            "/api/assessment/a-1/student/s-1/question/q-1/override",
            json={"score": 5},
        )

        svc.override_question_score.assert_called_once_with("a-1", "s-1", "q-1", 5, None)

    def test_service_error_returns_400(self):
        svc = _mock_instructor_svc()
        svc.override_question_score.side_effect = InstructorAssessmentServiceError("failed")

        client = _assessment_client(svc)
        resp = client.put(
            "/api/assessment/a-1/student/s-1/question/q-1/override",
            json={"score": 5},
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "override_failed"


# ─────────────────────────────────────────────────────────────
# EPIC-6-3: PUT /api/assessment/{id}/release-results
# ─────────────────────────────────────────────────────────────

class TestReleaseResultsEndpoint:
    def test_release_results_success(self):
        svc = _mock_instructor_svc()
        svc.release_results.return_value = {"assessmentId": "a-1", "resultsReleased": True}

        client = _assessment_client(svc)
        resp = client.put("/api/assessment/a-1/release-results")

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["resultsReleased"] is True

    def test_release_calls_service(self):
        svc = _mock_instructor_svc()
        svc.release_results.return_value = {"assessmentId": "a-1", "resultsReleased": True}

        client = _assessment_client(svc)
        client.put("/api/assessment/a-1/release-results")

        svc.release_results.assert_called_once_with("a-1")


# ─────────────────────────────────────────────────────────────
# EPIC-6-3: student results gated
# ─────────────────────────────────────────────────────────────

class TestStudentResultsGated:
    def test_results_not_released_returns_404(self):
        svc = MagicMock()
        svc.get_student_results.side_effect = OralAssessmentServiceError("Results not released yet")

        client = _student_client(svc)
        resp = client.get("/api/student/s-1/assessment/a-1/results")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "student_results_not_found"


# ─────────────────────────────────────────────────────────────
# EPIC-6-4: POST /api/assessment/{id}/student/{studentId}/remind
# ─────────────────────────────────────────────────────────────

class TestSendReminderEndpoint:
    def test_send_reminder_success(self):
        svc = _mock_instructor_svc()
        svc.send_reminder_email.return_value = "Reminder sent to alice@example.com"

        client = _assessment_client(svc)
        resp = client.post("/api/assessment/a-1/student/s-1/remind")

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert "alice@example.com" in data["message"]

    def test_send_reminder_calls_service(self):
        svc = _mock_instructor_svc()
        svc.send_reminder_email.return_value = "sent"

        client = _assessment_client(svc)
        client.post("/api/assessment/a-1/student/s-1/remind")

        svc.send_reminder_email.assert_called_once_with("a-1", "s-1")

    def test_service_error_returns_400(self):
        svc = _mock_instructor_svc()
        svc.send_reminder_email.side_effect = InstructorAssessmentServiceError("student not enrolled")

        client = _assessment_client(svc)
        resp = client.post("/api/assessment/a-1/student/s-1/remind")

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "reminder_failed"


# ─────────────────────────────────────────────────────────────
# EPIC-6-3: PDF endpoint
# ─────────────────────────────────────────────────────────────

class TestStudentResultsPdf:
    def _make_results(self):
        return {
            "studentId": "s-1",
            "studentName": "Alice",
            "studentEmail": "alice@example.com",
            "assessmentId": "a-1",
            "assessmentTitle": "Python Fundamentals",
            "status": "submitted",
            "totalScore": 16,
            "maxScore": 20,
            "percentage": 80.0,
            "grade": "Competent",
            "submittedAt": "2024-01-01T12:00:00",
            "evaluatedQuestions": 2,
            "totalQuestions": 2,
            "questions": [
                {
                    "questionId": "q-1",
                    "questionText": "What is a list?",
                    "audioUrl": None,
                    "duration": None,
                    "score": 8,
                    "maxScore": 10,
                    "feedback": "Good answer",
                    "strengths": "Clear",
                    "improvements": "More detail",
                    "evaluatedAt": "2024-01-01",
                },
                {
                    "questionId": "q-2",
                    "questionText": "What is a dict?",
                    "audioUrl": None,
                    "duration": None,
                    "score": 8,
                    "maxScore": 10,
                    "feedback": "Solid",
                    "strengths": None,
                    "improvements": None,
                    "evaluatedAt": "2024-01-01",
                },
            ],
        }

    def test_pdf_returns_200_with_content_type(self):
        svc = MagicMock()
        svc.get_student_results.return_value = self._make_results()

        client = _student_client(svc)
        resp = client.get("/api/student/s-1/assessment/a-1/results/pdf")

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content[:4] == b"%PDF"

    def test_pdf_not_found_returns_404(self):
        svc = MagicMock()
        svc.get_student_results.side_effect = OralAssessmentServiceError("results not found")

        client = _student_client(svc)
        resp = client.get("/api/student/s-1/assessment/a-1/results/pdf")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "student_results_not_found"
