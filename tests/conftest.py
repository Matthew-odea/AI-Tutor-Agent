"""
Shared pytest fixtures.

The moto-based fixtures spin up real (mocked) AWS resources for integration
tests.  Unit tests that use MagicMock directly are unaffected.
"""
from __future__ import annotations

import os
import pytest
import boto3
from moto import mock_aws

# Table name used by all moto fixtures
ASSESSMENT_TABLE = "test_oral_assessments"
CHAT_TABLE = "test_chat_sessions"
AUTH_TABLE = "test_auth_users"
TEST_BUCKET = "test-assessment-bucket"
TEST_QUEUE = "test-jobs-queue"


@pytest.fixture()
def aws_credentials(monkeypatch):
    """Inject fake AWS credentials so moto never talks to real AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", ASSESSMENT_TABLE)
    monkeypatch.setenv("DYNAMODB_TABLE_NAME", CHAT_TABLE)
    monkeypatch.setenv("DYNAMODB_AUTH_USERS_TABLE", AUTH_TABLE)
    monkeypatch.setenv("S3_ASSESSMENT_BUCKET", TEST_BUCKET)
    monkeypatch.setenv("SQS_JOBS_QUEUE_URL", f"https://sqs.us-east-1.amazonaws.com/123456789012/{TEST_QUEUE}")


@pytest.fixture()
def mock_dynamodb(aws_credentials):
    """
    Yield a moto-backed DynamoDB table shaped like the oral assessments table.
    Callers receive the boto3 Table resource directly.
    """
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        table = dynamodb.create_table(
            TableName=ASSESSMENT_TABLE,
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
        table.meta.client.get_waiter("table_exists").wait(TableName=ASSESSMENT_TABLE)
        yield table


@pytest.fixture()
def conversation_memory(aws_credentials):
    """
    A DynamoDBConversationMemory on a moto-backed chat table.

    There is only one conversation store — DynamoDB — so tests that need somewhere
    to keep chat history use this rather than a stand-in.
    """
    from src.main.agentcore_setup.dynamodb_memory import DynamoDBConversationMemory

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        table = dynamodb.create_table(
            TableName=CHAT_TABLE,
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
        table.meta.client.get_waiter("table_exists").wait(TableName=CHAT_TABLE)
        yield DynamoDBConversationMemory(table_name=CHAT_TABLE, region="us-east-1", ttl_days=30)


@pytest.fixture()
def mock_s3(aws_credentials):
    """Yield a moto-backed S3 bucket for assessment media."""
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=TEST_BUCKET)
        yield s3


@pytest.fixture()
def mock_sqs(aws_credentials):
    """Yield a moto-backed SQS queue URL."""
    with mock_aws():
        sqs = boto3.client("sqs", region_name="us-east-1")
        resp = sqs.create_queue(QueueName=TEST_QUEUE)
        yield resp["QueueUrl"]


@pytest.fixture()
def mock_ses(aws_credentials):
    """Yield a moto-backed SES client with a verified identity."""
    with mock_aws():
        ses = boto3.client("ses", region_name="us-east-1")
        ses.verify_email_identity(EmailAddress="test@example.com")
        yield ses
