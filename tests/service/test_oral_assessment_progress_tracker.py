"""PROGRESS totals must match the served question set; legacy BANK_QUESTION# items are ignored (moto DynamoDB)."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from src.main.service.OralAssessmentProgressTracker import OralAssessmentProgressTracker
from src.main.service.OralAssessmentService import OralAssessmentService, OralAssessmentServiceError

TABLE_NAME = "test_progress_tracker"
PK = "STUDENT#s-1#ASSESSMENT#a-1"


@pytest.fixture()
def table(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE_NAME)
    monkeypatch.setenv("S3_ASSESSMENT_BUCKET", "test-bucket")
    with mock_aws():
        t = boto3.resource("dynamodb", region_name="us-east-1").create_table(
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
        yield t


def _seed(table, *, student_questions=2, bank_questions=2):
    table.put_item(Item={"PK": "ASSESSMENT#a-1", "SK": "METADATA", "title": "T", "accessMode": "open"})
    table.put_item(Item={"PK": "STUDENT#s-1", "SK": "ASSESSMENT#a-1", "status": "enrolled"})
    table.put_item(Item={"PK": "ASSESSMENT#a-1", "SK": "STUDENT#s-1", "status": "enrolled"})
    for i in range(1, student_questions + 1):
        table.put_item(Item={
            "PK": PK, "SK": f"QUESTION#q-{i}", "id": f"q-{i}",
            "text": f"Q{i}?", "questionNumber": i, "questionType": "specific",
        })
    # Legacy shape from the removed question-bank feature.
    for i in range(1, bank_questions + 1):
        table.put_item(Item={
            "PK": "ASSESSMENT#a-1", "SK": f"BANK_QUESTION#b-{i}", "id": f"b-{i}",
            "text": f"Bank {i}?", "questionType": "general",
        })


def _answer(table, question_id):
    table.put_item(Item={
        "PK": PK, "SK": f"ANSWER#{question_id}", "questionId": question_id,
        "answerType": "text", "textContent": "x", "status": "submitted",
    })


def _progress(table):
    return table.get_item(Key={"PK": PK, "SK": "PROGRESS"})["Item"]


def test_progress_ignores_legacy_bank_questions(table):
    _seed(table)
    _answer(table, "q-1")
    _answer(table, "q-2")

    OralAssessmentProgressTracker(table=table).update_progress("s-1", "a-1")

    item = _progress(table)
    assert int(item["totalQuestions"]) == 2
    assert item["status"] == "completed"


def _service(table) -> OralAssessmentService:
    svc = OralAssessmentService()
    svc.table = table
    svc.question_access.table = table
    svc.progress_tracker.table = table
    svc.answer_submission.table = table
    svc.results_aggregator.table = table
    return svc


def test_tracker_and_service_totals_agree_and_submit_needs_only_served_questions(table):
    _seed(table)
    svc = _service(table)
    svc.get_student_questions("s-1", "a-1")  # establishes questionOrder, as the student app does
    svc.submit_answer(student_id="s-1", question_id="q-1", assessment_id="a-1",
                      answer_type="text", text_content="answer")

    assert int(_progress(table)["totalQuestions"]) == svc.get_student_progress("s-1", "a-1")["totalQuestions"] == 2
    with pytest.raises(OralAssessmentServiceError, match="only 1/2"):
        svc.submit_assessment("s-1", "a-1")

    svc.submit_answer(student_id="s-1", question_id="q-2", assessment_id="a-1",
                      answer_type="text", text_content="answer")
    assert svc.submit_assessment("s-1", "a-1")["status"] == "submitted"
