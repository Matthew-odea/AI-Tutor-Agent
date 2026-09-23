"""
Integration tests for OralAssessmentService using moto-mocked DynamoDB.

Covers the core student flow:
- get_student_questions
- submit_answer (audio, text, video)
- get_student_progress
- submit_assessment
- get_student_results
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from src.main.service.OralAssessmentService import (
    OralAssessmentService,
    OralAssessmentServiceError,
)

TABLE_NAME = "test_oral_assessments"


@pytest.fixture()
def dynamo_env(monkeypatch):
    """Set env vars and yield a moto-backed DynamoDB table."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE_NAME)
    monkeypatch.setenv("S3_ASSESSMENT_BUCKET", "test-bucket")

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
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        table.meta.client.get_waiter("table_exists").wait(TableName=TABLE_NAME)
        yield table


def _seed_assessment(table, assessment_id="a-1", title="Test Assessment", access_mode="open"):
    """Create assessment metadata."""
    table.put_item(Item={
        "PK": f"ASSESSMENT#{assessment_id}",
        "SK": "METADATA",
        "title": title,
        "course": "COMP9021",
        "description": "Test",
        "accessMode": access_mode,
        "resultsReleased": False,
    })


def _seed_enrollment(table, student_id="s-1", assessment_id="a-1", status="enrolled"):
    """Enroll a student in an assessment."""
    # Primary enrollment record (used by question access)
    table.put_item(Item={
        "PK": f"STUDENT#{student_id}",
        "SK": f"ASSESSMENT#{assessment_id}",
        "name": "Test Student",
        "email": "student@test.com",
        "status": status,
    })
    # Assessment-student record (used by progress/submission)
    table.put_item(Item={
        "PK": f"ASSESSMENT#{assessment_id}",
        "SK": f"STUDENT#{student_id}",
        "name": "Test Student",
        "email": "student@test.com",
        "status": status,
    })


def _seed_questions(table, student_id="s-1", assessment_id="a-1", count=3):
    """Seed student-specific questions."""
    for i in range(1, count + 1):
        table.put_item(Item={
            "PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
            "SK": f"QUESTION#q-{i}",
            "id": f"q-{i}",
            "text": f"Question {i}?",
            "questionNumber": i,
            "questionType": "specific",
            "difficulty": "medium",
        })


def _create_service(table) -> OralAssessmentService:
    """Create an OralAssessmentService wired to the moto table."""
    svc = OralAssessmentService()
    # Override the auto-created resources with the moto table
    svc.table = table
    svc.progress_tracker.table = table
    svc.question_access.table = table
    svc.answer_submission.table = table
    svc.results_aggregator.table = table
    return svc


# ─────────────────────────────────────────────────────────────
# get_student_questions
# ─────────────────────────────────────────────────────────────

class TestGetStudentQuestions:
    def test_returns_questions_for_enrolled_student(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=3)
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        assert len(result["questions"]) == 3
        assert result["answerMode"] == "oral"
        assert result["assessmentTitle"] == "Test Assessment"

    def test_legacy_bank_questions_are_not_served(self, dynamo_env):
        # Marking only reads the student's own QUESTION# items, so serving a
        # BANK_QUESTION# would give the student a question that never gets marked.
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        table.put_item(Item={"PK": "ASSESSMENT#a-1", "SK": "BANK_QUESTION#b-1", "id": "b-1", "text": "legacy"})
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        assert len(result["questions"]) == 2
        assert "b-1" not in [q["id"] for q in result["questions"]]

    def test_unenrolled_student_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="not enrolled"):
            svc.get_student_questions("unknown", "a-1")

    def test_returns_empty_when_no_questions(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        # Returns dict with empty questions list
        assert result["questions"] == []
        assert result["currentQuestionIndex"] == 0

    def test_proctored_defaults_from_answer_mode_when_absent(self, dynamo_env):
        """Legacy assessment (no proctored field, no answerMode) → proctored True (oral)."""
        table = dynamo_env
        _seed_assessment(table)  # no answerMode → 'oral', no proctored field
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        assert result["proctored"] is True
        assert result["allowReview"] is False

    def test_written_assessment_defaults_unproctored(self, dynamo_env):
        """answerMode='written' with no explicit proctored flag → proctored False."""
        table = dynamo_env
        _seed_assessment(table)
        table.update_item(
            Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
            UpdateExpression="SET answerMode = :m",
            ExpressionAttributeValues={":m": "written"},
        )
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        assert result["answerMode"] == "written"
        assert result["proctored"] is False

    def test_null_time_limit_does_not_crash(self, dynamo_env):
        """Regression: an assessment with no per-question timer persists timeLimit as
        null (the formative flow). get_student_questions must not int(None)-crash."""
        table = dynamo_env
        _seed_assessment(table)
        # create_assessment stores null when no per-question limit is set; the key is
        # present with a null value, so .get(..., 0) returns None, not the default.
        table.update_item(
            Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
            UpdateExpression="SET timeLimit = :tl",
            ExpressionAttributeValues={":tl": None},
        )
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        assert len(result["questions"]) == 2


# ─────────────────────────────────────────────────────────────
# submit_answer
# ─────────────────────────────────────────────────────────────

def _seed_question_order(table, student_id="s-1", assessment_id="a-1", question_ids=None):
    """Set questionOrder and currentQuestionIdx on the enrollment record so submit_answer passes ordering validation."""
    if question_ids is None:
        question_ids = ["q-1"]
    table.update_item(
        Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": f"STUDENT#{student_id}"},
        UpdateExpression="SET questionOrder = :qo, currentQuestionIdx = :ci",
        ExpressionAttributeValues={":qo": question_ids, ":ci": 0},
    )


class TestSubmitAnswer:
    def test_submit_audio_answer(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        _seed_question_order(table, question_ids=["q-1", "q-2"])
        svc = _create_service(table)

        result = svc.submit_answer(
            student_id="s-1",
            question_id="q-1",
            assessment_id="a-1",
            answer_type="audio",
            audio_url="s3://bucket/audio/s-1/q-1_1.webm",
            duration=30,
        )

        assert result["ok"] is True
        assert result["answerType"] == "audio"
        assert result["audioUrl"] == "s3://bucket/audio/s-1/q-1_1.webm"

        # Verify stored in DynamoDB
        response = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "ANSWER#q-1",
        })
        assert response["Item"]["audioUrl"] == "s3://bucket/audio/s-1/q-1_1.webm"

    def test_submit_text_answer(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        _seed_question_order(table, question_ids=["q-1"])
        svc = _create_service(table)

        result = svc.submit_answer(
            student_id="s-1",
            question_id="q-1",
            assessment_id="a-1",
            answer_type="text",
            text_content="Binary search divides the array in half...",
        )

        assert result["ok"] is True
        assert result["answerType"] == "text"

        response = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "ANSWER#q-1",
        })
        assert "textContent" in response["Item"]

    def test_submit_video_answer(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        _seed_question_order(table, question_ids=["q-1"])
        svc = _create_service(table)

        result = svc.submit_answer(
            student_id="s-1",
            question_id="q-1",
            assessment_id="a-1",
            answer_type="video",
            video_url="s3://bucket/audio/s-1/q-1_1.webm",
            duration=60,
        )

        assert result["ok"] is True
        assert result["answerType"] == "video"

    def test_submit_skipped_answer(self, dynamo_env):
        """A skipped answer stores a clean non-answer: answerType='skipped' with
        no media/text content, and still counts as answered."""
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        _seed_question_order(table, question_ids=["q-1"])
        svc = _create_service(table)

        result = svc.submit_answer(
            student_id="s-1",
            question_id="q-1",
            assessment_id="a-1",
            answer_type="skipped",
        )

        assert result["ok"] is True
        assert result["answerType"] == "skipped"

        item = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "ANSWER#q-1",
        })["Item"]
        assert item["answerType"] == "skipped"
        assert item["status"] == "submitted"
        # No media or text content is stored for a skip.
        assert "audioUrl" not in item
        assert "videoUrl" not in item
        assert "textContent" not in item
        assert "duration" not in item


def _enable_review(table, assessment_id="a-1"):
    """Flip allowReview=True on the assessment metadata."""
    table.update_item(
        Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": "METADATA"},
        UpdateExpression="SET allowReview = :r",
        ExpressionAttributeValues={":r": True},
    )


def _current_idx(table, student_id="s-1", assessment_id="a-1") -> int:
    item = table.get_item(Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": f"STUDENT#{student_id}"})["Item"]
    return int(item.get("currentQuestionIdx", 0))


class TestReviewMode:
    """allowReview=True: free navigation + revise. Strict path must stay byte-for-byte."""

    def test_allows_out_of_order_submission(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _enable_review(table)
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        _seed_question_order(table, question_ids=["q-1", "q-2"])
        svc = _create_service(table)

        # q-2 submitted before q-1 — allowed in review mode.
        result = svc.submit_answer(
            student_id="s-1", question_id="q-2", assessment_id="a-1",
            answer_type="text", text_content="answer to two first",
        )
        assert result["ok"] is True

    def test_rejects_question_not_in_order(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _enable_review(table)
        _seed_enrollment(table)
        _seed_questions(table, count=2)
        _seed_question_order(table, question_ids=["q-1", "q-2"])
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="out of order"):
            svc.submit_answer(
                student_id="s-1", question_id="q-999", assessment_id="a-1",
                answer_type="text", text_content="not a real question",
            )

    def test_allows_revision_upsert(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _enable_review(table)
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        _seed_question_order(table, question_ids=["q-1"])
        svc = _create_service(table)

        svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                          answer_type="text", text_content="first attempt")
        # Re-submit the same question with revised text — allowed (overwrite).
        svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                          answer_type="text", text_content="revised attempt")

        item = table.get_item(Key={"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-1"})["Item"]
        assert item["textContent"] == "revised attempt"

    def test_strict_mode_rejects_revision_when_flag_absent(self, dynamo_env):
        """No allowReview field → today's behaviour: second submit raises 'already submitted'."""
        table = dynamo_env
        _seed_assessment(table)  # no allowReview
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        _seed_question_order(table, question_ids=["q-1"])
        svc = _create_service(table)

        svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                          answer_type="text", text_content="first")
        with pytest.raises(OralAssessmentServiceError, match="already submitted"):
            svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                              answer_type="text", text_content="second")

    def test_frontier_only_index_advance(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _enable_review(table)
        _seed_enrollment(table)
        _seed_questions(table, count=3)
        _seed_question_order(table, question_ids=["q-1", "q-2", "q-3"])
        svc = _create_service(table)

        # Submit q-2 first (not the frontier) — index stays at 0.
        svc.submit_answer(student_id="s-1", question_id="q-2", assessment_id="a-1",
                          answer_type="text", text_content="two")
        assert _current_idx(table) == 0
        # Submit q-1 (the frontier) — index advances to 1.
        svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                          answer_type="text", text_content="one")
        assert _current_idx(table) == 1
        # Revise q-1 (no longer the frontier) — index unchanged.
        svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                          answer_type="text", text_content="one-revised")
        assert _current_idx(table) == 1

    def test_get_questions_ungates_and_attaches_prior_answer(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _enable_review(table)
        _seed_enrollment(table)
        _seed_questions(table, count=3)
        # A prior written answer to q-1.
        table.put_item(Item={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-1",
            "questionId": "q-1", "answerType": "text", "textContent": "my earlier answer",
        })
        svc = _create_service(table)

        result = svc.get_student_questions("s-1", "a-1")
        qs = {q["id"]: q for q in result["questions"]}
        assert len(qs) == 3
        # Un-gated: every question keeps its text (no stripping of "future" questions).
        assert all(q.get("text") for q in qs.values())
        assert qs["q-1"]["priorAnswer"] == "my earlier answer"
        assert qs["q-2"].get("priorAnswer") is None


# ─────────────────────────────────────────────────────────────
# get_student_progress
# ─────────────────────────────────────────────────────────────

class TestGetStudentProgress:
    def test_progress_with_no_answers(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        # Seed assessment-level questions (used by progress query)
        for i in range(1, 4):
            table.put_item(Item={
                "PK": "ASSESSMENT#a-1",
                "SK": f"QUESTION#q-{i}",
                "text": f"Q{i}",
            })
        svc = _create_service(table)

        progress = svc.get_student_progress("s-1", "a-1")
        assert progress["totalQuestions"] == 3
        assert progress["answeredQuestions"] == 0
        assert progress["percentage"] == 0
        assert progress["answeredQuestionIds"] == []

    def test_progress_after_answering(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        for i in range(1, 4):
            table.put_item(Item={
                "PK": "ASSESSMENT#a-1",
                "SK": f"QUESTION#q-{i}",
                "text": f"Q{i}",
            })
        # Seed one answer
        table.put_item(Item={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "ANSWER#q-1",
            "questionId": "q-1",
            "status": "submitted",
        })
        svc = _create_service(table)

        progress = svc.get_student_progress("s-1", "a-1")
        assert progress["answeredQuestions"] == 1
        assert progress["percentage"] == pytest.approx(33.3, abs=0.1)
        # Authoritative answered-id list, not just a count.
        assert progress["answeredQuestionIds"] == ["q-1"]

    def test_progress_answered_ids_includes_skips(self, dynamo_env):
        """answeredQuestionIds lists every question with an answer record,
        including skipped ones, regardless of order."""
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        for i in range(1, 4):
            table.put_item(Item={
                "PK": "ASSESSMENT#a-1",
                "SK": f"QUESTION#q-{i}",
                "text": f"Q{i}",
            })
        # q-1 answered, q-3 skipped, q-2 untouched.
        table.put_item(Item={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-1",
            "questionId": "q-1", "answerType": "audio", "status": "submitted",
        })
        table.put_item(Item={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-3",
            "questionId": "q-3", "answerType": "skipped", "status": "submitted",
        })
        svc = _create_service(table)

        progress = svc.get_student_progress("s-1", "a-1")
        assert progress["answeredQuestions"] == 2
        assert sorted(progress["answeredQuestionIds"]) == ["q-1", "q-3"]

    def test_progress_unenrolled_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="not enrolled"):
            svc.get_student_progress("unknown", "a-1")


# ─────────────────────────────────────────────────────────────
# submit_assessment
# ─────────────────────────────────────────────────────────────

class TestSubmitAssessment:
    def test_submit_completed_assessment(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        _seed_questions(table, count=2)

        # Seed progress record showing all answered
        table.put_item(Item={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "PROGRESS",
            "totalQuestions": 2,
            "answeredQuestions": 2,
            "status": "completed",
        })
        svc = _create_service(table)

        result = svc.submit_assessment("s-1", "a-1")
        assert result["ok"] is True
        assert result["status"] == "submitted"
        assert result["questionsAnswered"] == 2

        # Verify enrollment updated
        enrollment = table.get_item(Key={
            "PK": "ASSESSMENT#a-1",
            "SK": "STUDENT#s-1",
        })["Item"]
        assert enrollment["status"] == "submitted"
        assert "submittedAt" in enrollment

    def test_submit_incomplete_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)

        table.put_item(Item={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "PROGRESS",
            "totalQuestions": 3,
            "answeredQuestions": 1,
            "status": "in-progress",
        })
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="only 1/3"):
            svc.submit_assessment("s-1", "a-1")

    def test_submit_no_progress_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        _seed_enrollment(table)
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="No progress found"):
            svc.submit_assessment("s-1", "a-1")


# ─────────────────────────────────────────────────────────────
# get_student_results
# ─────────────────────────────────────────────────────────────

class TestGetStudentResults:
    def _seed_full_assessment(self, table):
        """Seed a fully evaluated assessment."""
        _seed_assessment(table)
        # Enable results release
        table.update_item(
            Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
            UpdateExpression="SET resultsReleased = :r",
            ExpressionAttributeValues={":r": True},
        )
        _seed_enrollment(table, status="submitted")

        pk = "STUDENT#s-1#ASSESSMENT#a-1"
        # Questions
        table.put_item(Item={
            "PK": pk, "SK": "QUESTION#q-1",
            "text": "What is a list?", "questionType": "general",
        })
        table.put_item(Item={
            "PK": pk, "SK": "QUESTION#q-2",
            "text": "Explain your code", "questionType": "specific",
        })
        # Answers
        table.put_item(Item={
            "PK": pk, "SK": "ANSWER#q-1",
            "audioUrl": "s3://bucket/a1.webm", "duration": 30,
        })
        table.put_item(Item={
            "PK": pk, "SK": "ANSWER#q-2",
            "audioUrl": "s3://bucket/a2.webm", "duration": 45,
        })
        # Evaluations
        table.put_item(Item={
            "PK": pk, "SK": "EVALUATION#q-1",
            "totalScore": 8, "maxScore": 10,
            "correctnessScore": 4, "understandingScore": 4,
            "feedback": "Good answer",
            "strengths": ["Clear"], "weaknesses": [], "suggestedImprovements": [],
        })
        table.put_item(Item={
            "PK": pk, "SK": "EVALUATION#q-2",
            "totalScore": 9, "maxScore": 10,
            "correctnessScore": 5, "understandingScore": 4,
            "feedback": "Excellent",
            "strengths": ["Detailed"], "weaknesses": [], "suggestedImprovements": [],
        })

    def test_returns_results_with_scores(self, dynamo_env):
        table = dynamo_env
        self._seed_full_assessment(table)
        svc = _create_service(table)

        results = svc.get_student_results("s-1", "a-1")
        assert results["totalScore"] == 17
        assert results["maxScore"] == 20
        assert results["percentage"] == 85.0
        assert results["grade"] == "Competent"
        assert len(results["questions"]) == 2

    def test_results_not_released_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)  # resultsReleased = False
        _seed_enrollment(table, status="submitted")

        pk = "STUDENT#s-1#ASSESSMENT#a-1"
        table.put_item(Item={
            "PK": pk, "SK": "QUESTION#q-1", "text": "Q1",
        })
        table.put_item(Item={
            "PK": pk, "SK": "EVALUATION#q-1",
            "totalScore": 5, "maxScore": 10,
            "correctnessScore": 3, "understandingScore": 2,
        })
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="not released"):
            svc.get_student_results("s-1", "a-1")

    def test_immediate_feedback_release_bypasses_gate(self, dynamo_env):
        """feedbackRelease='immediate' returns results even when resultsReleased is False."""
        table = dynamo_env
        _seed_assessment(table)  # resultsReleased = False
        table.update_item(
            Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
            UpdateExpression="SET feedbackRelease = :f",
            ExpressionAttributeValues={":f": "immediate"},
        )
        _seed_enrollment(table, status="submitted")

        pk = "STUDENT#s-1#ASSESSMENT#a-1"
        table.put_item(Item={"PK": pk, "SK": "QUESTION#q-1", "text": "Q1", "questionType": "general"})
        table.put_item(Item={"PK": pk, "SK": "ANSWER#q-1", "audioUrl": "s3://b/a1.webm", "duration": 30})
        table.put_item(Item={
            "PK": pk, "SK": "EVALUATION#q-1",
            "totalScore": 5, "maxScore": 10,
            "correctnessScore": 3, "understandingScore": 2,
            "feedback": "ok", "strengths": [], "weaknesses": [], "suggestedImprovements": [],
        })
        svc = _create_service(table)

        results = svc.get_student_results("s-1", "a-1")
        assert results["totalScore"] == 5
        assert len(results["questions"]) == 1

    def test_unenrolled_student_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="not enrolled"):
            svc.get_student_results("unknown", "a-1")


# ─────────────────────────────────────────────────────────────
# Assessment window checks
# ─────────────────────────────────────────────────────────────

class TestAssessmentWindow:
    def test_open_access_skips_window_check(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table, access_mode="open")
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        svc = _create_service(table)

        # Should not raise
        result = svc.get_student_questions("s-1", "a-1")
        assert len(result["questions"]) == 1

    def test_scheduled_past_window_raises(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table, access_mode="scheduled")
        table.update_item(
            Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
            UpdateExpression="SET scheduledWindowStart = :s, scheduledWindowEnd = :e",
            ExpressionAttributeValues={
                ":s": "2020-01-01T00:00:00Z",
                ":e": "2020-01-02T00:00:00Z",
            },
        )
        _seed_enrollment(table)
        _seed_questions(table, count=1)
        svc = _create_service(table)

        with pytest.raises(OralAssessmentServiceError, match="closed"):
            svc.get_student_questions("s-1", "a-1")


# ─────────────────────────────────────────────────────────────
# Proctor chunks
# ─────────────────────────────────────────────────────────────

class TestProctorChunk:
    def test_submit_proctor_chunk(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        result = svc.submit_proctor_chunk(
            student_id="s-1",
            assessment_id="a-1",
            chunk_url="s3://bucket/proctoring/a-1/s-1/chunk_000000.webm",
            chunk_index=0,
        )
        assert result["ok"] is True

        # Verify stored
        item = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "PROCTORING#CHUNK#000000",
        })
        assert item["Item"]["chunkUrl"] == "s3://bucket/proctoring/a-1/s-1/chunk_000000.webm"


class TestRecordConsent:
    def test_record_consent_granted(self, dynamo_env):
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        result = svc.record_consent(
            student_id="s-1",
            assessment_id="a-1",
            granted=True,
            consent_version="2026-06-10",
            timestamp="2026-06-22T10:00:00.000Z",
        )
        assert result["ok"] is True
        assert result["granted"] is True
        assert result["recordedAt"]

        item = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "CONSENT",
        })["Item"]
        assert item["granted"] is True
        assert item["consentVersion"] == "2026-06-10"
        assert item["timestamp"] == "2026-06-22T10:00:00.000Z"

    def test_record_consent_declined_is_durable(self, dynamo_env):
        """granted=False is stored as a real record (the instructor's decline signal)."""
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        result = svc.record_consent(
            student_id="s-1",
            assessment_id="a-1",
            granted=False,
            consent_version="2026-06-10",
            timestamp="2026-06-22T10:00:00.000Z",
        )
        assert result["granted"] is False

        item = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "CONSENT",
        })["Item"]
        assert item["granted"] is False

    def test_record_consent_overwrites_prior_decision(self, dynamo_env):
        """A later decision is idempotent — it overwrites the single CONSENT item."""
        table = dynamo_env
        _seed_assessment(table)
        svc = _create_service(table)

        svc.record_consent("s-1", "a-1", True, "2026-06-10", "2026-06-22T10:00:00.000Z")
        svc.record_consent("s-1", "a-1", False, "2026-06-10", "2026-06-22T10:05:00.000Z")

        item = table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "CONSENT",
        })["Item"]
        assert item["granted"] is False
        assert item["timestamp"] == "2026-06-22T10:05:00.000Z"
