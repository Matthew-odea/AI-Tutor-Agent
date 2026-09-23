"""Controller tests for the cohort report endpoints and the per-question
evaluation-progress SSE stream.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import (
    get_assessment_report_service,
    get_instructor_assessment_service,
)
from src.main.service.AssessmentReportService import AssessmentReportServiceError

_INSTRUCTOR = AuthPrincipal(user_id="i-1", roles=["instructor"], source="jwt")
_OTHER_INSTRUCTOR = AuthPrincipal(user_id="i-2", roles=["instructor"], source="jwt")
_STUDENT = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt")

_REPORT = {
    "assessmentId": "a-1",
    "assessmentTitle": "Quiz 1",
    "course": "COMP9021",
    "generatedAt": "2026-08-04T00:00:00+00:00",
    "triggeredBy": "auto_threshold",
    "milestone": 1,
    "counts": {"enrolled": 30, "submitted": 12, "evaluated": 10, "notEvaluated": 20},
    "scores": {"average": 71.5, "median": 72.0, "min": 40.0, "max": 95.0, "stdDev": 14.2},
    "gradeDistribution": {"Excellent": 2, "Competent": 4, "Developing": 3, "Needs Improvement": 1},
    "histogram": [{"bucket": "70-79", "count": 4}],
    "dimensions": {
        "answersEvaluated": 80,
        "averageCorrectness": 3.6,
        "averageUnderstanding": 3.4,
        "needsReviewCount": 2,
    },
    "narrative": "The cohort is tracking around 71%.",
}


def _client(report_svc=None, instructor_svc=None, principal=_INSTRUCTOR, assessment=None):
    app = create_app()
    svc = instructor_svc or MagicMock()
    if instructor_svc is None:
        svc.get_assessment.return_value = assessment or {"id": "a-1", "title": "Quiz 1", "createdBy": "i-1"}
    app.dependency_overrides[require_auth_principal] = lambda: principal
    app.dependency_overrides[get_instructor_assessment_service] = lambda: svc
    app.dependency_overrides[get_assessment_report_service] = lambda: report_svc or MagicMock()
    return TestClient(app)


class TestGetReport:
    def test_returns_stored_report(self):
        report_svc = MagicMock()
        report_svc.get_report.return_value = _REPORT
        resp = _client(report_svc).get("/api/assessment/a-1/report")

        assert resp.status_code == 200
        body = resp.json()
        assert body["generated"] is True
        assert body["report"]["scores"]["average"] == 71.5
        assert body["report"]["narrative"] == "The cohort is tracking around 71%."

    def test_reports_not_generated_yet(self):
        report_svc = MagicMock()
        report_svc.get_report.return_value = None
        resp = _client(report_svc).get("/api/assessment/a-1/report")

        assert resp.status_code == 200
        assert resp.json()["generated"] is False
        assert resp.json()["report"] is None

    def test_student_is_rejected(self):
        resp = _client(principal=_STUDENT).get("/api/assessment/a-1/report")
        assert resp.status_code in (401, 403)

    def test_other_instructor_is_rejected(self):
        """Cohort statistics for someone else's class are not readable."""
        resp = _client(principal=_OTHER_INSTRUCTOR).get("/api/assessment/a-1/report")
        assert resp.status_code in (401, 403, 404)


class TestGenerateReport:
    def test_generates_on_demand(self):
        report_svc = MagicMock()
        report_svc.generate_report.return_value = _REPORT
        resp = _client(report_svc).post("/api/assessment/a-1/report/generate")

        assert resp.status_code == 200
        assert resp.json()["report"]["counts"]["evaluated"] == 10
        assert report_svc.generate_report.call_args.kwargs["triggered_by"] == "manual"

    def test_generation_failure_returns_500(self):
        report_svc = MagicMock()
        report_svc.generate_report.side_effect = AssessmentReportServiceError("dynamo down")
        resp = _client(report_svc).post("/api/assessment/a-1/report/generate")

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "report_generation_failed"

    def test_student_cannot_generate(self):
        resp = _client(principal=_STUDENT).post("/api/assessment/a-1/report/generate")
        assert resp.status_code in (401, 403)


class TestEvaluationProgressStream:
    """The stream backing the instructor's live 'Evaluating… 4/8 questions' bar."""

    def _stream_client(self, progress_item, principal=_INSTRUCTOR):
        app = create_app()
        svc = MagicMock()
        svc.get_assessment.return_value = {"id": "a-1", "title": "Quiz 1", "createdBy": "i-1"}
        app.dependency_overrides[require_auth_principal] = lambda: principal
        app.dependency_overrides[get_instructor_assessment_service] = lambda: svc
        repo = MagicMock()
        repo.get_evaluation_progress.return_value = progress_item
        patcher = patch(
            "src.main.controllers.assessment_router.ResponseEvaluationRepository",
            return_value=repo,
        )
        patcher.start()
        return TestClient(app), patcher

    def test_emits_per_question_counts_and_closes_on_completed(self):
        client, patcher = self._stream_client({
            "questionsEvaluated": 8, "totalQuestions": 8,
            "percentage": "100.0", "status": "completed",
            "updatedAt": "2026-08-04T00:00:00Z",
        })
        try:
            with client.stream("GET", "/api/assessment/a-1/students/s-1/evaluation-progress") as resp:
                assert resp.status_code == 200
                body = "".join(resp.iter_text())
        finally:
            patcher.stop()

        assert '"questionsEvaluated": 8' in body
        assert '"totalQuestions": 8' in body
        assert '"status": "completed"' in body

    def test_failed_status_also_closes_the_stream(self):
        client, patcher = self._stream_client({
            "questionsEvaluated": 3, "totalQuestions": 8,
            "percentage": "37.5", "status": "failed",
        })
        try:
            with client.stream("GET", "/api/assessment/a-1/students/s-1/evaluation-progress") as resp:
                body = "".join(resp.iter_text())
        finally:
            patcher.stop()

        assert '"status": "failed"' in body
        assert '"questionsEvaluated": 3' in body

    def test_student_cannot_read_the_stream(self):
        client, patcher = self._stream_client(None, principal=_STUDENT)
        try:
            resp = client.get("/api/assessment/a-1/students/s-1/evaluation-progress")
        finally:
            patcher.stop()
        assert resp.status_code in (401, 403)
