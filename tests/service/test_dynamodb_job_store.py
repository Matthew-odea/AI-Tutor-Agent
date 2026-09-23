"""Integration tests for DynamoDBJobStore using moto."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from src.main.service.DynamoDBJobStore import DynamoDBJobStore

TABLE_NAME = "test_oral_assessments"


@pytest.fixture()
def job_store(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE_NAME)

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        dynamodb.create_table(
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
        yield DynamoDBJobStore()


class TestCreateJob:
    def test_create_returns_job_id(self, job_store):
        job_id = job_store.create_job(
            job_type="question_generation",
            assessment_id="a-1",
            total_items=5,
        )
        assert isinstance(job_id, str)
        assert len(job_id) > 0

    def test_created_job_is_pending(self, job_store):
        job_id = job_store.create_job(
            job_type="evaluation",
            assessment_id="a-1",
            total_items=3,
        )
        job = job_store.get_job(job_id)
        assert job["status"] == "pending"
        assert job["total_items"] == 3
        assert job["processed_count"] == 0

    def test_create_with_metadata(self, job_store):
        job_id = job_store.create_job(
            job_type="evaluation",
            assessment_id="a-1",
            total_items=2,
            metadata={"custom": "value"},
        )
        job = job_store.get_job(job_id)
        assert job["metadata"]["custom"] == "value"


class TestGetJob:
    def test_get_nonexistent_returns_none(self, job_store):
        result = job_store.get_job("nonexistent-id")
        assert result is None


class TestUpdateStatus:
    def test_update_to_running(self, job_store):
        job_id = job_store.create_job("eval", "a-1", 5)
        job_store.update_status(job_id, "running")

        job = job_store.get_job(job_id)
        assert job["status"] == "running"

    def test_update_to_completed_sets_timestamp(self, job_store):
        job_id = job_store.create_job("eval", "a-1", 5)
        job_store.update_status(job_id, "completed")

        job = job_store.get_job(job_id)
        assert job["status"] == "completed"
        assert job["completed_at"] is not None

    def test_update_to_failed_with_error(self, job_store):
        job_id = job_store.create_job("eval", "a-1", 5)
        job_store.update_status(job_id, "failed", error="Something went wrong")

        job = job_store.get_job(job_id)
        assert job["status"] == "failed"
        assert job["error"] == "Something went wrong"


class TestIncrementProgress:
    def test_increment_success(self, job_store):
        job_id = job_store.create_job("eval", "a-1", 3)
        job_store.increment_progress(job_id, success=True)
        job_store.increment_progress(job_id, success=True)

        job = job_store.get_job(job_id)
        assert job["processed_count"] == 2
        assert job["successful_count"] == 2
        assert job["failed_count"] == 0

    def test_increment_failure(self, job_store):
        job_id = job_store.create_job("eval", "a-1", 3)
        job_store.increment_progress(job_id, success=False)

        job = job_store.get_job(job_id)
        assert job["processed_count"] == 1
        assert job["successful_count"] == 0
        assert job["failed_count"] == 1

    def test_mixed_success_and_failure(self, job_store):
        job_id = job_store.create_job("eval", "a-1", 4)
        job_store.increment_progress(job_id, success=True)
        job_store.increment_progress(job_id, success=True)
        job_store.increment_progress(job_id, success=False)
        job_store.increment_progress(job_id, success=True)

        job = job_store.get_job(job_id)
        assert job["processed_count"] == 4
        assert job["successful_count"] == 3
        assert job["failed_count"] == 1


class TestFullLifecycle:
    def test_create_run_complete(self, job_store):
        job_id = job_store.create_job("question_generation", "a-1", 3)

        job_store.update_status(job_id, "running")
        assert job_store.get_job(job_id)["status"] == "running"

        for _ in range(3):
            job_store.increment_progress(job_id, success=True)

        job_store.update_status(job_id, "completed")
        job = job_store.get_job(job_id)
        assert job["status"] == "completed"
        assert job["processed_count"] == 3
        assert job["successful_count"] == 3
