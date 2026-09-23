#!/usr/bin/env python3
"""
Create the three DynamoDB tables the app needs, against DynamoDB Local.

DynamoDB Local starts with no tables, so a fresh checkout has nothing to read or
write until this has run. `docker-compose up -d` runs it for you; run it by hand
after a `docker-compose down -v`, or if you started DynamoDB Local yourself:

    AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8001 python scripts/dynamodb_local_bootstrap.py

Re-running is safe: tables that already exist are left exactly as they are.

Key schemas match the moto-backed fixtures in tests/conftest.py and the terraform
definitions, so what you get locally is the shape the tests and production use.

It refuses to run without AWS_ENDPOINT_URL_DYNAMODB, so it can never create tables
in a real AWS account.
"""
from __future__ import annotations

import os
import sys
import time

import boto3
from botocore.exceptions import ClientError, EndpointConnectionError

PK_SK_TABLE = {
    "KeySchema": [
        {"AttributeName": "PK", "KeyType": "HASH"},
        {"AttributeName": "SK", "KeyType": "RANGE"},
    ],
    "AttributeDefinitions": [
        {"AttributeName": "PK", "AttributeType": "S"},
        {"AttributeName": "SK", "AttributeType": "S"},
    ],
}

# oral_assessments additionally carries the GSI that lists an instructor's
# assessments (InstructorAssessmentCatalog queries it by name).
ASSESSMENT_TABLE = {
    "KeySchema": PK_SK_TABLE["KeySchema"],
    "AttributeDefinitions": PK_SK_TABLE["AttributeDefinitions"]
    + [
        {"AttributeName": "GSI1PK", "AttributeType": "S"},
        {"AttributeName": "GSI1SK", "AttributeType": "S"},
    ],
    "GlobalSecondaryIndexes": [
        {
            "IndexName": "InstructorAssessmentsIndex",
            "KeySchema": [
                {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
            ],
            "Projection": {"ProjectionType": "ALL"},
        }
    ],
}

# auth_users is keyed by email alone, not PK/SK.
AUTH_USERS_TABLE = {
    "KeySchema": [{"AttributeName": "email", "KeyType": "HASH"}],
    "AttributeDefinitions": [{"AttributeName": "email", "AttributeType": "S"}],
}


def tables() -> list[tuple[str, dict]]:
    """(table name, schema) for the three tables the app reads and writes."""
    return [
        (os.getenv("DYNAMODB_TABLE_NAME", "chat_sessions"), PK_SK_TABLE),
        (os.getenv("DYNAMODB_ASSESSMENT_TABLE", "oral_assessments"), ASSESSMENT_TABLE),
        (os.getenv("DYNAMODB_AUTH_USERS_TABLE", "auth_users"), AUTH_USERS_TABLE),
    ]


def wait_for_endpoint(client, endpoint: str, attempts: int = 30) -> None:
    """DynamoDB Local takes a second or two to accept connections after start."""
    for attempt in range(1, attempts + 1):
        try:
            client.list_tables()
            return
        except (EndpointConnectionError, ClientError) as exc:
            if isinstance(exc, ClientError):
                raise
            if attempt == attempts:
                raise
            time.sleep(1)
    raise RuntimeError(f"DynamoDB Local at {endpoint} never came up")


def create_table(client, name: str, schema: dict) -> str:
    try:
        client.create_table(TableName=name, BillingMode="PAY_PER_REQUEST", **schema)
    except client.exceptions.ResourceInUseException:
        return "already exists"
    client.get_waiter("table_exists").wait(TableName=name)
    return "created"


def main() -> int:
    endpoint = os.getenv("AWS_ENDPOINT_URL_DYNAMODB", "").strip()
    if not endpoint:
        print(
            "AWS_ENDPOINT_URL_DYNAMODB is not set. This script only ever talks to "
            "DynamoDB Local; set it to http://localhost:8001 and try again.",
            file=sys.stderr,
        )
        return 1

    # Dummy credentials: DynamoDB Local ignores them, and without them boto3 would
    # look for real ones.
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "local")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "local")

    client = boto3.client(
        "dynamodb",
        endpoint_url=endpoint,
        region_name=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
    )
    wait_for_endpoint(client, endpoint)

    for name, schema in tables():
        print(f"{name}: {create_table(client, name, schema)}")
    print(f"DynamoDB Local ready at {endpoint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
