"""
DynamoDB-backed job store.

Replaces the in-memory BatchJobManager storage so job state survives server restarts.
DynamoDB TTL (7-day) handles cleanup automatically — no manual purge needed.
"""
from __future__ import annotations

import os
import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_TTL_SECONDS = 7 * 24 * 3600  # 7 days


class DynamoDBJobStore:
    """
    Persists batch job state to DynamoDB using the existing assessment table.

    Item schema:
        PK: JOB#{job_id}
        SK: METADATA
        job_id, job_type, assessment_id, status,
        total_items, processed_count, successful_count, failed_count,
        started_at, completed_at, error, metadata, TTL
    """

    def __init__(self):
        region = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        table_name = os.getenv("DYNAMODB_ASSESSMENT_TABLE", "oral_assessments")
        dynamodb = boto3.resource("dynamodb", region_name=region)
        self._table = dynamodb.Table(table_name)

    # ------------------------------------------------------------------
    # Public API — mirrors the old BatchJobManager interface exactly
    # ------------------------------------------------------------------

    def create_job(
        self,
        job_type: str,
        assessment_id: str,
        total_items: int,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        job_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        ttl = int((now + timedelta(seconds=_TTL_SECONDS)).timestamp())

        self._table.put_item(Item={
            "PK": f"JOB#{job_id}",
            "SK": "METADATA",
            "job_id": job_id,
            "job_type": job_type,
            "assessment_id": assessment_id,
            "status": "pending",
            "total_items": total_items,
            "processed_count": 0,
            "successful_count": 0,
            "failed_count": 0,
            "started_at": now.isoformat(),
            "completed_at": None,
            "error": None,
            "metadata": metadata or {},
            "TTL": ttl,
        })
        logger.info("Created job %s (type=%s, assessment=%s)", job_id, job_type, assessment_id)
        return job_id

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        try:
            response = self._table.get_item(Key={"PK": f"JOB#{job_id}", "SK": "METADATA"})
            item = response.get("Item")
            return self._deserialise(item) if item else None
        except ClientError as exc:
            logger.error("Failed to get job %s from DynamoDB: %s", job_id, exc)
            return None

    def update_status(self, job_id: str, status: str, error: Optional[str] = None) -> None:
        expr = "SET #s = :status"
        names = {"#s": "status"}
        values: Dict[str, Any] = {":status": status}

        if error:
            expr += ", #err = :error"
            names["#err"] = "error"
            values[":error"] = error

        if status in ("completed", "failed"):
            expr += ", completed_at = :ca"
            values[":ca"] = datetime.now(timezone.utc).isoformat()

        try:
            self._table.update_item(
                Key={"PK": f"JOB#{job_id}", "SK": "METADATA"},
                UpdateExpression=expr,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            logger.error("Failed to update status for job %s: %s", job_id, exc)

    def increment_progress(self, job_id: str, success: bool = True) -> None:
        """Atomic counter update — safe for concurrent threads without a lock."""
        try:
            self._table.update_item(
                Key={"PK": f"JOB#{job_id}", "SK": "METADATA"},
                UpdateExpression=(
                    "ADD processed_count :one, "
                    "successful_count :s, "
                    "failed_count :f"
                ),
                ExpressionAttributeValues={
                    ":one": 1,
                    ":s": 1 if success else 0,
                    ":f": 0 if success else 1,
                },
            )
        except ClientError as exc:
            logger.error("Failed to increment progress for job %s: %s", job_id, exc)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _deserialise(item: Dict[str, Any]) -> Dict[str, Any]:
        """Convert DynamoDB item (Decimal types) to plain Python dict."""
        return {
            "job_id": item.get("job_id"),
            "job_type": item.get("job_type"),
            "assessment_id": item.get("assessment_id"),
            "status": item.get("status"),
            "total_items": int(item.get("total_items", 0)),
            "processed_count": int(item.get("processed_count", 0)),
            "successful_count": int(item.get("successful_count", 0)),
            "failed_count": int(item.get("failed_count", 0)),
            "started_at": item.get("started_at"),
            "completed_at": item.get("completed_at"),
            "error": item.get("error"),
            "metadata": item.get("metadata", {}),
        }
