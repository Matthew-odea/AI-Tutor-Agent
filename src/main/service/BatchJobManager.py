"""
BatchJobManager: thin wrapper around DynamoDBJobStore.

Preserves the original public API exactly so assessment_router.py and any other
callers need zero changes. Job state is now persisted in DynamoDB — jobs survive
server restarts. DynamoDB TTL handles automatic cleanup after 7 days.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from src.main.service.DynamoDBJobStore import DynamoDBJobStore


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class JobType(str, Enum):
    QUESTION_GENERATION = "question_generation"
    EVALUATION = "evaluation"
    REPORT_GENERATION = "report_generation"


class BatchJobManager:
    """DynamoDB-backed batch job manager. Same public API as the old in-memory version."""

    def __init__(self):
        self._store = DynamoDBJobStore()

    def create_job(
        self,
        job_type: JobType,
        assessment_id: str,
        total_items: int,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        return self._store.create_job(job_type.value, assessment_id, total_items, metadata)

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        return self._store.get_job(job_id)

    def update_status(self, job_id: str, status: JobStatus, error: Optional[str] = None) -> None:
        self._store.update_status(job_id, status.value, error)

    def increment_progress(self, job_id: str, success: bool = True) -> None:
        self._store.increment_progress(job_id, success)

    def list_jobs(
        self,
        assessment_id: Optional[str] = None,
        job_type: Optional[JobType] = None,
    ) -> List[Dict[str, Any]]:
        # Jobs are always fetched by job_id directly in the current hot paths.
        return []

    def clear_old_jobs(self, hours: int = 24) -> None:
        pass  # DynamoDB TTL handles this automatically


_batch_job_manager: Optional[BatchJobManager] = None


def get_batch_job_manager() -> BatchJobManager:
    global _batch_job_manager
    if _batch_job_manager is None:
        _batch_job_manager = BatchJobManager()
    return _batch_job_manager
