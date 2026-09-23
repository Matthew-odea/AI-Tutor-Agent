"""
Integration tests for ResponseEvaluationRepository using moto.
"""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from src.main.service.ResponseEvaluationRepository import ResponseEvaluationRepository

TABLE = "test_oral_assessments"


@pytest.fixture()
def repo(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE)

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        dynamodb.create_table(
            TableName=TABLE,
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
        yield ResponseEvaluationRepository(table_name=TABLE, region="us-east-1")


def _seed_qa(repo, student_id="s-1", assessment_id="a-1"):
    pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
    repo.table.put_item(Item={"PK": pk, "SK": "QUESTION#q-1", "text": "Q1"})
    repo.table.put_item(Item={"PK": pk, "SK": "QUESTION#q-2", "text": "Q2"})
    repo.table.put_item(Item={"PK": pk, "SK": "ANSWER#q-1", "audioUrl": "s3://a.webm"})
    repo.table.put_item(Item={"PK": pk, "SK": "ANSWER#q-2", "audioUrl": "s3://b.webm"})


class TestCountAnswers:
    def test_count_with_answers(self, repo):
        _seed_qa(repo)
        assert repo.count_answers("s-1", "a-1") == 2

    def test_count_empty(self, repo):
        assert repo.count_answers("nobody", "a-1") == 0


class TestReadQuestions:
    def test_read_questions(self, repo):
        _seed_qa(repo)
        questions = repo.read_questions("s-1", "a-1")
        assert len(questions) == 2


class TestReadAnswers:
    def test_read_answers(self, repo):
        _seed_qa(repo)
        answers = repo.read_answers("s-1", "a-1")
        assert len(answers) == 2


class TestStoreEvaluation:
    def test_store_and_read_back(self, repo):
        evaluation = {
            "correctness_score": 4,
            "understanding_score": 3,
            "total_score": 7,
            "max_score": 10,
            "feedback": "Good work",
            "strengths": ["Clear"],
            "weaknesses": ["Missing edge cases"],
            "suggested_improvements": ["Add tests"],
        }
        repo.store_evaluation("s-1", "a-1", "q-1", evaluation)

        item = repo.table.get_item(Key={
            "PK": "STUDENT#s-1#ASSESSMENT#a-1",
            "SK": "EVALUATION#q-1",
        })["Item"]

        assert int(item["correctnessScore"]) == 4
        assert int(item["totalScore"]) == 7
        assert item["feedback"] == "Good work"


class TestStoreEvaluationReviewFlags:
    EVAL_KEY = {"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "EVALUATION#q-1"}

    def test_review_flags_persisted(self, repo):
        repo.store_evaluation("s-1", "a-1", "q-1", {
            "correctness_score": 0, "understanding_score": 0, "total_score": 0,
            "feedback": "flagged", "needs_review": True,
            "review_reasons": ["empty_transcript"], "evaluation_method": "unscored",
        })
        item = repo.table.get_item(Key=self.EVAL_KEY)["Item"]
        assert item["needsReview"] is True
        assert list(item["reviewReasons"]) == ["empty_transcript"]
        assert item["evaluationMethod"] == "unscored"

    def test_confidence_persisted_when_present(self, repo):
        repo.store_evaluation("s-1", "a-1", "q-1", {
            "correctness_score": 4, "understanding_score": 4, "total_score": 8,
            "feedback": "f", "transcript_confidence": 0.42,
        })
        item = repo.table.get_item(Key=self.EVAL_KEY)["Item"]
        assert float(item["transcriptConfidence"]) == 0.42

    def test_safe_defaults_when_flags_absent(self, repo):
        # A legacy-shaped evaluation dict with no flag fields stores safe defaults.
        repo.store_evaluation("s-1", "a-1", "q-1", {
            "correctness_score": 4, "understanding_score": 4, "total_score": 8, "feedback": "f",
        })
        item = repo.table.get_item(Key=self.EVAL_KEY)["Item"]
        assert item["needsReview"] is False
        assert list(item["reviewReasons"]) == []
        assert "transcriptConfidence" not in item


class TestHumanScore:
    EVAL_KEY = {"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "EVALUATION#q-1"}

    def _seed_ai_eval(self, repo):
        repo.store_evaluation("s-1", "a-1", "q-1", {
            "correctness_score": 4, "understanding_score": 3, "total_score": 7, "feedback": "ai",
        })

    def test_record_human_score(self, repo):
        self._seed_ai_eval(repo)
        result = repo.record_human_score(
            "s-1", "a-1", "q-1",
            human_correctness_score=5, human_understanding_score=4, scored_by="grader@example.edu",
        )
        assert result["humanTotalScore"] == 9
        item = repo.table.get_item(Key=self.EVAL_KEY)["Item"]
        assert int(item["humanCorrectnessScore"]) == 5
        assert int(item["humanUnderstandingScore"]) == 4
        assert int(item["humanTotalScore"]) == 9
        assert item["humanScoredBy"] == "grader@example.edu"
        # AI scores are untouched — the human score is a separate reference.
        assert int(item["totalScore"]) == 7

    def test_reevaluation_preserves_human_and_instructor_scores(self, repo):
        self._seed_ai_eval(repo)
        repo.record_human_score("s-1", "a-1", "q-1", human_correctness_score=5, human_understanding_score=5)
        repo.table.update_item(
            Key=self.EVAL_KEY,
            UpdateExpression="SET instructorScore = :s",
            ExpressionAttributeValues={":s": 9},
        )
        # Re-evaluate (put_item overwrite) with new AI scores.
        repo.store_evaluation("s-1", "a-1", "q-1", {
            "correctness_score": 2, "understanding_score": 2, "total_score": 4, "feedback": "re-run",
        })
        item = repo.table.get_item(Key=self.EVAL_KEY)["Item"]
        assert int(item["totalScore"]) == 4  # AI scores updated
        assert int(item["humanTotalScore"]) == 10  # human reference preserved
        assert int(item["instructorScore"]) == 9  # instructor override preserved


class _OverrideLandsBeforeWriteTable:
    """Applies an instructor override immediately before store_evaluation's write,
    i.e. after any read it made: the interleaving that loses the override."""

    def __init__(self, inner, key):
        self._inner, self._key, self._fired = inner, key, False

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _override_first(self):
        if not self._fired:
            self._fired = True
            self._inner.update_item(
                Key=self._key,
                UpdateExpression="SET instructorScore = :s",
                ExpressionAttributeValues={":s": 9},
            )

    def put_item(self, **kwargs):
        self._override_first()
        return self._inner.put_item(**kwargs)

    def update_item(self, **kwargs):
        self._override_first()
        return self._inner.update_item(**kwargs)


class TestReevaluationRace:
    EVAL_KEY = {"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "EVALUATION#q-1"}

    def test_override_written_during_reevaluation_survives(self, repo):
        """A redelivered or repeated evaluation must never wipe an instructor override,
        even one saved while the re-evaluation is in flight. Fails if store_evaluation
        goes back to read-then-put."""
        repo.store_evaluation("s-1", "a-1", "q-1", {"total_score": 7, "feedback": "first"})
        repo.table = _OverrideLandsBeforeWriteTable(repo.table, self.EVAL_KEY)

        repo.store_evaluation("s-1", "a-1", "q-1", {"total_score": 4, "feedback": "re-run"})

        item = repo.table.get_item(Key=self.EVAL_KEY)["Item"]
        assert int(item["instructorScore"]) == 9
        assert int(item["totalScore"]) == 4

    def test_stale_confidence_removed_on_reevaluation(self, repo):
        repo.store_evaluation("s-1", "a-1", "q-1", {"total_score": 7, "transcript_confidence": 0.4})
        repo.store_evaluation("s-1", "a-1", "q-1", {"total_score": 7})
        assert "transcriptConfidence" not in repo.table.get_item(Key=self.EVAL_KEY)["Item"]


class TestEvaluationProgress:
    def test_set_and_get_progress(self, repo):
        repo.set_evaluation_progress("s-1", "a-1", questions_evaluated=3, total_questions=5)

        progress = repo.get_evaluation_progress("s-1", "a-1")
        assert progress is not None
        assert int(progress["questionsEvaluated"]) == 3
        assert progress["status"] == "evaluating"

    def test_get_progress_nonexistent(self, repo):
        assert repo.get_evaluation_progress("nobody", "a-1") is None

    def test_set_progress_completed(self, repo):
        repo.set_evaluation_progress("s-1", "a-1", 5, 5, status="completed")
        progress = repo.get_evaluation_progress("s-1", "a-1")
        assert progress["status"] == "completed"
        assert progress["percentage"] == "100.0"
