"""HTTP tests for the dual-scoring, review-flagging and configurable-scoring endpoints.

Mounts only assessment_router on a bare FastAPI app so app.py is never imported.

"""
from __future__ import annotations

import boto3
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws

from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.api_errors import register_exception_handlers
from src.main.controllers.assessment_router import assessment_router
from src.main.controllers.controller_dependencies import get_instructor_assessment_service
from src.main.service.InstructorAssessmentService import InstructorAssessmentService

TABLE = "test_oral_assessments"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE)

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        table = dynamodb.create_table(
            TableName=TABLE,
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
            GlobalSecondaryIndexes=[{
                "IndexName": "InstructorAssessmentsIndex",
                "KeySchema": [
                    {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                    {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }],
            BillingMode="PAY_PER_REQUEST",
        )
        table.meta.client.get_waiter("table_exists").wait(TableName=TABLE)

        svc = InstructorAssessmentService()
        svc.table = table
        svc.catalog.table = table
        svc.enrollment.table = table
        svc.progress_aggregator.table = table
        svc.results_aggregator.table = table

        app = FastAPI()
        register_exception_handlers(app)
        app.include_router(assessment_router)
        app.dependency_overrides[require_auth_principal] = lambda: AuthPrincipal(
            user_id="instr-1", roles=["admin"], source="authorization"
        )
        app.dependency_overrides[get_instructor_assessment_service] = lambda: svc

        yield TestClient(app), svc, table


def _setup_assessment_with_eval(svc, table, *, needs_review=False):
    assessment = svc.create_assessment(
        title="T", course="COMP1010", description="d", due_date="2026-12-01",
        total_questions=3, owner_user_id="instr-1",
    )
    a_id = assessment["id"]
    svc.upload_students(a_id, [{"name": "Alice", "email": "alice@example.edu", "studentId": "s-1", "code": "x=1"}])
    item = {
        "PK": f"STUDENT#s-1#ASSESSMENT#{a_id}", "SK": "EVALUATION#q-1",
        "questionId": "q-1", "totalScore": 8, "correctnessScore": 4, "understandingScore": 4, "maxScore": 10,
    }
    if needs_review:
        item.update({"needsReview": True, "reviewReasons": ["low_confidence_transcript"]})
    table.put_item(Item=item)
    return a_id


def test_record_human_score_then_agreement(client):
    test_client, svc, table = client
    a_id = _setup_assessment_with_eval(svc, table)

    resp = test_client.put(
        f"/api/assessment/{a_id}/student/s-1/question/q-1/human-score",
        json={"humanCorrectnessScore": 4, "humanUnderstandingScore": 3},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["humanTotalScore"] == 7

    agree = test_client.get(f"/api/assessment/{a_id}/score-agreement")
    assert agree.status_code == 200, agree.text
    body = agree.json()
    assert body["dualScoredCount"] == 1
    assert body["meanAbsoluteDifference"] == 1.0  # |8 - 7|
    assert body["within1Rate"] == 1.0


def test_human_score_out_of_range_rejected(client):
    test_client, svc, table = client
    a_id = _setup_assessment_with_eval(svc, table)
    resp = test_client.put(
        f"/api/assessment/{a_id}/student/s-1/question/q-1/human-score",
        json={"humanCorrectnessScore": 9, "humanUnderstandingScore": 3},  # 9 > max 5
    )
    assert resp.status_code == 422


def test_flagged_evaluations_endpoint(client):
    test_client, svc, table = client
    a_id = _setup_assessment_with_eval(svc, table, needs_review=True)
    resp = test_client.get(f"/api/assessment/{a_id}/flagged-evaluations")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["flaggedCount"] == 1
    assert body["items"][0]["studentId"] == "s-1"
    assert "low_confidence_transcript" in body["items"][0]["reasons"]


def test_create_assessment_with_scoring_overrides(client):
    test_client, _svc, _table = client
    resp = test_client.post("/api/assessment/create", json={
        "title": "Cfg", "course": "COMP1010", "dueDate": "2026-12-01", "totalQuestions": 5,
        "maxScorePerQuestion": 20,
        "gradeCutoffs": {"excellent": 50, "competent": 30, "developing": 10},
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["maxScorePerQuestion"] == 20
    assert body["gradeCutoffs"]["excellent"] == 50


def test_create_assessment_rejects_invalid_cutoffs(client):
    test_client, _svc, _table = client
    resp = test_client.post("/api/assessment/create", json={
        "title": "Bad", "course": "COMP1010", "dueDate": "2026-12-01", "totalQuestions": 5,
        "gradeCutoffs": {"excellent": 50, "competent": 80, "developing": 60},  # mis-ordered
    })
    assert resp.status_code == 400, resp.text
