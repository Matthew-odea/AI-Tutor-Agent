"""Integration tests for InstructorAssessmentService using moto-mocked DynamoDB."""
from __future__ import annotations

from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from src.main.service.InstructorAssessmentService import (
    InstructorAssessmentService,
    InstructorAssessmentServiceError,
)

TABLE_NAME = "test_oral_assessments"


@pytest.fixture()
def dynamo_env(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE_NAME)

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        table = dynamodb.create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
                {"AttributeName": "GSI1PK", "AttributeType": "S"},
                {"AttributeName": "GSI1SK", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "InstructorAssessmentsIndex",
                    "KeySchema": [
                        {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                        {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                },
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        table.meta.client.get_waiter("table_exists").wait(TableName=TABLE_NAME)
        yield table


def _create_service(table) -> InstructorAssessmentService:
    svc = InstructorAssessmentService()
    svc.table = table
    svc.catalog.table = table
    svc.enrollment.table = table
    svc.progress_aggregator.table = table
    svc.results_aggregator.table = table
    return svc


class TestCreateAssessment:
    def test_create_returns_assessment_data(self, dynamo_env):
        svc = _create_service(dynamo_env)
        result = svc.create_assessment(
            title="Midterm Oral",
            course="COMP9021",
            description="Test assessment",
            due_date="2026-04-01T23:59:00Z",
            total_questions=5,
            owner_user_id="instructor-1",
        )

        assert result["title"] == "Midterm Oral"
        assert result["course"] == "COMP9021"
        assert result["status"] == "draft"
        assert result["createdBy"] == "instructor-1"
        assert "id" in result

    def test_create_persists_to_dynamodb(self, dynamo_env):
        table = dynamo_env
        svc = _create_service(table)
        result = svc.create_assessment(
            title="Final Oral",
            course="COMP9021",
            description="Final exam",
            due_date="2026-06-01T23:59:00Z",
            total_questions=8,
        )

        item = table.get_item(Key={
            "PK": f"ASSESSMENT#{result['id']}",
            "SK": "METADATA",
        })
        assert item["Item"]["title"] == "Final Oral"

    def test_create_with_optional_fields(self, dynamo_env):
        svc = _create_service(dynamo_env)
        result = svc.create_assessment(
            title="Scheduled Oral",
            course="COMP9021",
            description="Scheduled",
            due_date="2026-04-01T23:59:00Z",
            total_questions=5,
            time_limit=3,
            access_mode="scheduled",
            scheduled_window_start="2026-04-01T09:00:00Z",
            scheduled_window_end="2026-04-01T17:00:00Z",
            auto_evaluate=True,
            rubric="Custom rubric text",
            answer_mode="text",
            preparation_time=30,
        )

        assert result["accessMode"] == "scheduled"
        assert result["autoEvaluate"] is True
        assert result["rubric"] == "Custom rubric text"
        assert result["answerMode"] == "text"


class TestListAndGet:
    def test_list_returns_created_assessments(self, dynamo_env):
        svc = _create_service(dynamo_env)
        svc.create_assessment(title="A1", course="C", description="D", due_date="2026-04-01", total_questions=5, owner_user_id="i-1")
        svc.create_assessment(title="A2", course="C", description="D", due_date="2026-04-01", total_questions=5, owner_user_id="i-1")

        assessments = svc.list_assessments(owner_user_id="i-1")
        assert len(assessments) >= 2

    def test_get_existing_assessment(self, dynamo_env):
        svc = _create_service(dynamo_env)
        created = svc.create_assessment(title="Get Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        fetched = svc.get_assessment(created["id"])
        assert fetched["title"] == "Get Test"

    def test_get_nonexistent_raises(self, dynamo_env):
        svc = _create_service(dynamo_env)
        with pytest.raises(InstructorAssessmentServiceError):
            svc.get_assessment("nonexistent-id")


class TestUploadStudents:
    def test_upload_students_enrolls(self, dynamo_env):
        table = dynamo_env
        svc = _create_service(table)
        assessment = svc.create_assessment(title="Upload Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        students = [
            {"name": "Alice", "email": "alice@test.com", "studentId": "s-1", "code": "print('hi')"},
            {"name": "Bob", "email": "bob@test.com", "studentId": "s-2", "code": "x = 1"},
        ]
        result = svc.upload_students(assessment["id"], students)
        assert result["studentsUploaded"] == 2

    def test_upload_to_nonexistent_assessment_raises(self, dynamo_env):
        svc = _create_service(dynamo_env)
        with pytest.raises(InstructorAssessmentServiceError):
            svc.upload_students("fake-id", [{"name": "A", "email": "a@b.com", "studentId": "s-1"}])


class TestUpdateBrief:
    def test_update_brief_success(self, dynamo_env):
        svc = _create_service(dynamo_env)
        assessment = svc.create_assessment(title="Brief Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        brief_text = "A" * 60  # meets 50-char minimum
        result = svc.update_brief(assessment["id"], brief_text)
        assert result.get("assignmentBrief") == brief_text

    def test_update_brief_too_short_raises(self, dynamo_env):
        svc = _create_service(dynamo_env)
        assessment = svc.create_assessment(title="Brief Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        with pytest.raises(InstructorAssessmentServiceError, match="50 characters"):
            svc.update_brief(assessment["id"], "too short")


class TestUpdateSchedule:
    def test_update_to_scheduled(self, dynamo_env):
        svc = _create_service(dynamo_env)
        assessment = svc.create_assessment(title="Schedule Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        result = svc.update_schedule(
            assessment["id"],
            access_mode="scheduled",
            scheduled_window_start="2026-04-01T09:00:00Z",
            scheduled_window_end="2026-04-01T17:00:00Z",
        )
        assert result["accessMode"] == "scheduled"

    def test_scheduled_without_window_raises(self, dynamo_env):
        svc = _create_service(dynamo_env)
        assessment = svc.create_assessment(title="Schedule Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        with pytest.raises(InstructorAssessmentServiceError, match="required"):
            svc.update_schedule(assessment["id"], access_mode="scheduled")

    def test_invalid_access_mode_raises(self, dynamo_env):
        svc = _create_service(dynamo_env)
        assessment = svc.create_assessment(title="Schedule Test", course="C", description="D", due_date="2026-04-01", total_questions=5)

        with pytest.raises(InstructorAssessmentServiceError, match="must be"):
            svc.update_schedule(assessment["id"], access_mode="invalid")


class TestScoringConfigAndDualScoring:
    def test_create_assessment_persists_scoring_overrides(self, dynamo_env):
        svc = _create_service(dynamo_env)
        result = svc.create_assessment(
            title="T", course="COMP1010", description="d", due_date="2026-12-01",
            total_questions=5, max_score_per_question=20,
            grade_cutoffs={"excellent": 50, "competent": 30, "developing": 10},
        )
        item = dynamo_env.get_item(Key={"PK": f"ASSESSMENT#{result['id']}", "SK": "METADATA"})["Item"]
        assert int(item["maxScorePerQuestion"]) == 20
        assert float(item["gradeCutoffs"]["excellent"]) == 50

    def test_create_assessment_without_overrides_omits_config(self, dynamo_env):
        svc = _create_service(dynamo_env)
        result = svc.create_assessment(
            title="T", course="COMP1010", description="d", due_date="2026-12-01", total_questions=5,
        )
        item = dynamo_env.get_item(Key={"PK": f"ASSESSMENT#{result['id']}", "SK": "METADATA"})["Item"]
        assert "maxScorePerQuestion" not in item
        assert "gradeCutoffs" not in item

    def test_record_human_score_persists_and_leaves_ai_untouched(self, dynamo_env):
        svc = _create_service(dynamo_env)
        a_id, s_id, q_id = "a-1", "s-1", "q-1"
        pk = f"STUDENT#{s_id}#ASSESSMENT#{a_id}"
        dynamo_env.put_item(Item={
            "PK": pk, "SK": f"EVALUATION#{q_id}",
            "totalScore": Decimal("8"), "correctnessScore": Decimal("4"),
            "understandingScore": Decimal("4"), "maxScore": Decimal("10"),
        })
        res = svc.record_human_score(
            a_id, s_id, q_id, human_correctness_score=5, human_understanding_score=3, scored_by="grader",
        )
        assert res["humanTotalScore"] == 8
        item = dynamo_env.get_item(Key={"PK": pk, "SK": f"EVALUATION#{q_id}"})["Item"]
        assert int(item["humanTotalScore"]) == 8
        assert item["humanScoredBy"] == "grader"
        assert int(item["totalScore"]) == 8  # AI score untouched by the human reference


class TestOverrideQuestionScore:
    """Overrides are bounded by the question's real max, not a fixed 10."""

    def _seed(self, table, *, eval_max=None, assessment_max=None):
        svc = _create_service(table)
        assessment = svc.create_assessment(
            title="Override", course="C", description="D", due_date="2026-12-01",
            total_questions=2, max_score_per_question=assessment_max,
        )
        aid = assessment["id"]
        pk = f"STUDENT#s-1#ASSESSMENT#{aid}"
        item = {"PK": pk, "SK": "EVALUATION#q-1", "totalScore": Decimal("7")}
        if eval_max is not None:
            item["maxScore"] = Decimal(str(eval_max))
        table.put_item(Item=item)
        return svc, aid, pk

    def test_allows_score_above_10_when_question_max_is_higher(self, dynamo_env):
        svc, aid, pk = self._seed(dynamo_env, eval_max=20, assessment_max=20)
        res = svc.override_question_score(aid, "s-1", "q-1", 18, "strong answer")
        assert res["instructorScore"] == 18
        item = dynamo_env.get_item(Key={"PK": pk, "SK": "EVALUATION#q-1"})["Item"]
        assert int(item["instructorScore"]) == 18

    def test_rejects_score_above_question_max(self, dynamo_env):
        svc, aid, pk = self._seed(dynamo_env, eval_max=5, assessment_max=5)
        with pytest.raises(InstructorAssessmentServiceError, match="outside 0-5"):
            svc.override_question_score(aid, "s-1", "q-1", 6)
        item = dynamo_env.get_item(Key={"PK": pk, "SK": "EVALUATION#q-1"})["Item"]
        assert "instructorScore" not in item

    def test_falls_back_to_assessment_max_when_evaluation_has_none(self, dynamo_env):
        svc, aid, _ = self._seed(dynamo_env, assessment_max=15)
        assert svc.override_question_score(aid, "s-1", "q-1", 15)["instructorScore"] == 15
        with pytest.raises(InstructorAssessmentServiceError):
            svc.override_question_score(aid, "s-1", "q-1", 16)

    def test_default_max_is_10(self, dynamo_env):
        svc, aid, _ = self._seed(dynamo_env)
        with pytest.raises(InstructorAssessmentServiceError):
            svc.override_question_score(aid, "s-1", "q-1", 11)


def test_score_override_request_accepts_scores_above_10():
    from pydantic import ValidationError
    from src.main.dtos.InstructorAssessmentDTOs import ScoreOverrideRequest

    assert ScoreOverrideRequest(score=18).score == 18
    with pytest.raises(ValidationError):
        ScoreOverrideRequest(score=-1)
