"""SQS producer plus an in-process consumer thread for evaluation, question-generation and report jobs.

Delivery is at-least-once, so the consumer is idempotent per (job, item): the job record keeps the set of
counted items, a redelivery for a counted item is deleted without redoing the work, and the counter update
is conditional. A heartbeat extends visibility while a message is worked on; a failed message is retried
with backoff and, after _MAX_RECEIVES attempts, counted as failed and moved to the DLQ by SQS.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from decimal import Decimal
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)

_VISIBILITY_TIMEOUT = 900       # 15 min — set on every receive, overriding the queue default
_HEARTBEAT_SECONDS = _VISIBILITY_TIMEOUT // 3  # re-extend visibility well before it lapses
_LONG_POLL_SECONDS = 10
# One at a time: messages held in a local batch are not heartbeated, so a batch
# of slow evaluations would expire the later ones and hand them to another worker.
_MAX_MESSAGES_PER_RECEIVE = 1
_MAX_RECEIVES = 3               # must equal maxReceiveCount in the queue's redrive policy (terraform)
_RETRY_BACKOFF_SECONDS = 60     # a failed message reappears after 60s, then 120s
_CONSUMER_ERROR_BACKOFF = 5     # seconds


class SQSJobDispatcher:
    def __init__(self, *, queue_url: str, region: str, table):
        """table is the DynamoDB Table holding JOB# progress records."""
        self.queue_url = queue_url
        self.table = table
        self.sqs = boto3.client("sqs", region_name=region)
        self._consumer_thread: Optional[threading.Thread] = None
        self._stopping = threading.Event()


    def enqueue_evaluation_batch(
        self,
        job_id: str,
        assessment_id: str,
        students: List[Dict[str, Any]],
    ) -> int:
        """One message per student. Returns how many were enqueued."""
        enqueued = self._enqueue_per_student(job_id, [
            {
                "job_type": "evaluation",
                "job_id": job_id,
                "assessment_id": assessment_id,
                "student_id": student["studentId"],
            }
            for student in students
        ])

        logger.info(
            "Enqueued %d/%d evaluation messages for job %s",
            enqueued, len(students), job_id,
        )
        return enqueued

    def enqueue_question_generation(
        self,
        job_id: str,
        assessment_id: str,
        students: List[Dict[str, Any]],
        assignment_brief: str,
        course_name: str = "",
        assessment_title: str = "",
    ) -> int:
        """One message per student. Returns how many were enqueued."""
        enqueued = self._enqueue_per_student(job_id, [
            {
                "job_type": "question_generation",
                "job_id": job_id,
                "assessment_id": assessment_id,
                "student_id": student["studentId"],
                "student_name": student["name"],
                "student_code": student.get("code", ""),
                "assignment_brief": assignment_brief,
                "course_name": course_name,
                "assessment_title": assessment_title,
            }
            for student in students
        ])

        logger.info(
            "Enqueued %d/%d question-generation messages for job %s",
            enqueued,
            len(students),
            job_id,
        )
        return enqueued

    def _enqueue_per_student(self, job_id: str, bodies: List[Dict[str, Any]]) -> int:
        """Send one message per body, 10 per SQS call. Returns the number sent.

        A message SQS refuses is counted on the job as a failed item straight
        away; otherwise processed_count could never reach total_items and the
        job would sit 'pending' forever.
        """
        enqueued = 0
        for offset in range(0, len(bodies), 10):
            chunk = bodies[offset:offset + 10]
            entries = [{"Id": str(i), "MessageBody": json.dumps(b)} for i, b in enumerate(chunk)]
            try:
                resp = self.sqs.send_message_batch(QueueUrl=self.queue_url, Entries=entries)
                failed_ids = {f["Id"] for f in resp.get("Failed", [])}
                if failed_ids:
                    logger.error("[Job %s] SQS batch send failures: %s", job_id, resp["Failed"])
            except ClientError as e:
                logger.error("[Job %s] SQS batch send error: %s", job_id, e)
                failed_ids = {entry["Id"] for entry in entries}
            for entry, body in zip(entries, chunk):
                if entry["Id"] in failed_ids:
                    self._increment_job_progress(job_id, body["student_id"], success=False)
            enqueued += len(chunk) - len(failed_ids)
        return enqueued

    def enqueue_report_generation(
        self,
        job_id: str,
        assessment_id: str,
        *,
        triggered_by: str = "auto_threshold",
        milestone: Optional[int] = None,
    ) -> int:
        """One message per job (not per student): the report is a whole-cohort aggregate."""
        try:
            self.sqs.send_message(
                QueueUrl=self.queue_url,
                MessageBody=json.dumps({
                    "job_type": "report_generation",
                    "job_id": job_id,
                    "assessment_id": assessment_id,
                    "triggered_by": triggered_by,
                    "milestone": milestone,
                }),
            )
            logger.info(
                "Enqueued report generation for assessment %s (job %s, milestone %s)",
                assessment_id, job_id, milestone,
            )
            return 1
        except ClientError as e:
            logger.error("SQS report-generation send error: %s", e)
            return 0


    def start_consumer(
        self,
        question_generation_service: Any,
        evaluation_workflow_runner: Optional[Any] = None,
        report_service: Optional[Any] = None,
    ) -> None:
        """Start the supervised consumer thread; no-op if already running."""
        if self._consumer_thread and self._consumer_thread.is_alive():
            logger.debug("SQS consumer already running")
            return

        self._stopping.clear()

        def _supervised() -> None:
            logger.info("SQS consumer supervisor started")
            while not self._stopping.is_set():
                try:
                    self._consume_loop(question_generation_service, evaluation_workflow_runner, report_service)
                except Exception as e:
                    logger.error(
                        "SQS consumer exited unexpectedly, restarting in %ds: %s",
                        _CONSUMER_ERROR_BACKOFF, e,
                    )
                    time.sleep(_CONSUMER_ERROR_BACKOFF)
            logger.info("SQS consumer supervisor stopped")

        self._consumer_thread = threading.Thread(
            target=_supervised,
            daemon=True,
            name="sqs-consumer-supervisor",
        )
        self._consumer_thread.start()
        logger.info("SQS job consumer started (queue: %s)", self.queue_url)

    def is_running(self) -> bool:
        return bool(self._consumer_thread and self._consumer_thread.is_alive())

    def stop_consumer(self) -> None:
        """Signal the consumer to stop after its current receive cycle."""
        self._stopping.set()

    def _consume_loop(
        self,
        question_generation_service: Any,
        evaluation_workflow_runner: Optional[Any] = None,
        report_service: Optional[Any] = None,
    ) -> None:
        logger.info("SQS consumer loop running")
        while not self._stopping.is_set():
            try:
                response = self.sqs.receive_message(
                    QueueUrl=self.queue_url,
                    MaxNumberOfMessages=_MAX_MESSAGES_PER_RECEIVE,
                    WaitTimeSeconds=_LONG_POLL_SECONDS,
                    VisibilityTimeout=_VISIBILITY_TIMEOUT,
                    AttributeNames=["ApproximateReceiveCount"],
                )
                messages = response.get("Messages", [])
                for msg in messages:
                    self._process_message(msg, question_generation_service, evaluation_workflow_runner, report_service)

            except ClientError as e:
                if e.response["Error"]["Code"] == "AWS.SimpleQueueService.NonExistentQueue":
                    logger.warning("SQS queue not found — consumer pausing 30s: %s", self.queue_url)
                    time.sleep(30)
                else:
                    logger.error("SQS receive error: %s", e)
                    time.sleep(_CONSUMER_ERROR_BACKOFF)
            except Exception as e:
                logger.error("SQS consumer loop unexpected error: %s", e)
                time.sleep(_CONSUMER_ERROR_BACKOFF)

        logger.info("SQS consumer loop stopped")

    def _process_message(
        self,
        msg: Dict[str, Any],
        question_generation_service: Any,
        evaluation_workflow_runner: Optional[Any] = None,
        report_service: Optional[Any] = None,
    ) -> None:
        """Process one SQS message.

        Deleted on success, on a malformed body, and when its job already counted
        this item (a redelivery). A failure is left on the queue to be retried.
        """
        receipt = msg["ReceiptHandle"]
        try:
            body = json.loads(msg["Body"])
        except json.JSONDecodeError as e:
            logger.error("Malformed SQS message body (deleting): %s", e)
            self._delete_message(receipt)
            return

        job_type = body.get("job_type", "question_generation")
        job_id = body.get("job_id", "unknown")
        student_id = body.get("student_id", "unknown")
        # The idempotency key: one message per student per job (one per job for reports).
        item_key = body.get("student_id") or job_type
        receive_count = int(msg.get("Attributes", {}).get("ApproximateReceiveCount", 1))

        if self._already_processed(job_id, item_key):
            logger.info("[Job %s] %s for %s already processed — duplicate delivery, deleting", job_id, job_type, item_key)
            self._delete_message(receipt)
            return

        logger.info("[Job %s] Processing %s for student %s (attempt %d)", job_id, job_type, student_id, receive_count)

        stop_heartbeat = threading.Event()
        heartbeat = threading.Thread(
            target=self._keep_invisible, args=(receipt, stop_heartbeat), daemon=True, name="sqs-heartbeat",
        )
        heartbeat.start()
        error: Optional[Exception] = None
        try:
            outcome = self._run_job(body, question_generation_service, evaluation_workflow_runner, report_service)
        except Exception as e:
            outcome, error = None, e
        finally:
            stop_heartbeat.set()
            heartbeat.join()

        if error is not None:
            if receive_count < _MAX_RECEIVES:
                logger.warning(
                    "[Job %s] %s failed for %s (attempt %d/%d), will retry: %s",
                    job_id, job_type, student_id, receive_count, _MAX_RECEIVES, error,
                )
                self._change_visibility(receipt, _RETRY_BACKOFF_SECONDS * receive_count)
            else:
                # Not deleted: SQS moves it to the DLQ instead of delivering it again.
                logger.error(
                    "[Job %s] %s failed for %s on final attempt %d, leaving it for the DLQ: %s",
                    job_id, job_type, student_id, receive_count, error,
                )
                self._increment_job_progress(job_id, item_key, success=False)
            return

        if outcome is not None:
            self._increment_job_progress(job_id, item_key, success=outcome)
        self._delete_message(receipt)

    def _run_job(
        self,
        body: Dict[str, Any],
        question_generation_service: Any,
        evaluation_workflow_runner: Optional[Any],
        report_service: Optional[Any],
    ) -> Optional[bool]:
        """Do the work for one message. Returns the outcome to count, or None for an unknown job type."""
        job_type = body.get("job_type", "question_generation")
        job_id = body.get("job_id", "unknown")
        student_id = body.get("student_id", "unknown")
        assessment_id = body.get("assessment_id", "")

        if job_type == "question_generation":
            question_generation_service.generate_questions(
                assignment_brief=body.get("assignment_brief", ""),
                student_code=body.get("student_code", ""),
                student_name=body.get("student_name", student_id),
                student_id=student_id,
                assessment_id=assessment_id,
                course_name=body.get("course_name", ""),
                assessment_title=body.get("assessment_title", ""),
            )
            logger.info("[Job %s] Question generation succeeded for student %s", job_id, student_id)
            return True

        if job_type == "evaluation":
            if evaluation_workflow_runner is None:
                logger.warning("[Job %s] Evaluation runner not configured — skipping", job_id)
                return False
            # Runs synchronously in the consumer thread — each student evaluated fully
            # before the next message is picked up.
            evaluation_workflow_runner.evaluate_from_dynamodb(job_id, student_id, assessment_id)
            logger.info("[Job %s] Evaluation succeeded for student %s", job_id, student_id)
            return True

        if job_type == "report_generation":
            if report_service is None:
                logger.warning("[Job %s] Report service not configured — skipping", job_id)
                return False
            report_service.generate_report(
                assessment_id,
                triggered_by=body.get("triggered_by", "auto_threshold"),
                milestone=body.get("milestone"),
            )
            logger.info("[Job %s] Report generation succeeded for assessment %s", job_id, assessment_id)
            return True

        logger.warning("Unknown job_type '%s' — discarding message", job_type)
        return None

    def _keep_invisible(self, receipt_handle: str, stop: threading.Event) -> None:
        """Heartbeat: keep a message hidden from other workers while it is being worked on."""
        while not stop.wait(_HEARTBEAT_SECONDS):
            self._change_visibility(receipt_handle, _VISIBILITY_TIMEOUT)

    def _change_visibility(self, receipt_handle: str, seconds: int) -> None:
        try:
            self.sqs.change_message_visibility(
                QueueUrl=self.queue_url,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=seconds,
            )
        except ClientError as e:
            logger.warning("Failed to change SQS message visibility: %s", e)

    def _delete_message(self, receipt_handle: str) -> None:
        try:
            self.sqs.delete_message(
                QueueUrl=self.queue_url,
                ReceiptHandle=receipt_handle,
            )
        except ClientError as e:
            logger.warning("Failed to delete SQS message: %s", e)

    def _already_processed(self, job_id: str, item_key: str) -> bool:
        """True if this job has already counted this item, i.e. the message is a redelivery."""
        try:
            item = self.table.get_item(
                Key={"PK": f"JOB#{job_id}", "SK": "METADATA"},
                ProjectionExpression="processed_items",
            ).get("Item") or {}
        except ClientError as e:
            logger.warning("Could not check job %s for duplicate delivery: %s", job_id, e)
            return False
        return item_key in item.get("processed_items", set())

    def _increment_job_progress(self, job_id: str, item_key: str, success: bool) -> None:
        """Count one item on the job, at most once.

        The item key goes into a string set in the same conditional update, so
        a redelivered or concurrently duplicated message cannot count twice
        and push processed_count past total_items.
        """
        try:
            self.table.update_item(
                Key={"PK": f"JOB#{job_id}", "SK": "METADATA"},
                UpdateExpression=(
                    "ADD processed_count :one, successful_count :s, failed_count :f, processed_items :items"
                ),
                ConditionExpression="NOT contains(processed_items, :key)",
                ExpressionAttributeValues={
                    ":one": 1,
                    ":s": 1 if success else 0,
                    ":f": 0 if success else 1,
                    ":items": {item_key},
                    ":key": item_key,
                },
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                logger.info("[Job %s] %s already counted — not counting again", job_id, item_key)
            else:
                logger.error("Failed to update job progress for %s: %s", job_id, e)
            return
        self._maybe_complete_job(job_id)

    def _maybe_complete_job(self, job_id: str) -> None:
        try:
            resp = self.table.get_item(Key={"PK": f"JOB#{job_id}", "SK": "METADATA"})
            item = resp.get("Item")
            if not item:
                return
            total = int(item.get("total_items", 0))
            processed = int(item.get("processed_count", 0))
            if total > 0 and processed >= total:
                self.table.update_item(
                    Key={"PK": f"JOB#{job_id}", "SK": "METADATA"},
                    UpdateExpression="SET #s = :done, completed_at = :ca",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={
                        ":done": "completed",
                        ":ca": _utc_now(),
                    },
                    ConditionExpression="attribute_exists(PK)",
                )
                logger.info("[Job %s] All %d items processed — marked completed", job_id, total)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                logger.error("Failed to complete job %s: %s", job_id, e)
        except Exception as e:
            logger.error("Unexpected error completing job %s: %s", job_id, e)


def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()



def resolve_queue_url(queue_name: str = "ai-tutor-jobs", region: str = "us-east-1") -> str:
    """SQS_JOBS_QUEUE_URL if set, else look it up by name; "" if not found."""
    explicit = os.getenv("SQS_JOBS_QUEUE_URL", "")
    if explicit:
        return explicit

    try:
        sqs = boto3.client("sqs", region_name=region)
        resp = sqs.get_queue_url(QueueName=queue_name)
        url = resp["QueueUrl"]
        logger.info("Resolved SQS queue URL: %s", url)
        return url
    except (ClientError, BotoCoreError) as e:
        # BotoCoreError covers no network / no credentials / no region, which
        # otherwise propagate through dependency injection and fail every route
        # that takes the dispatcher (including student submit).
        logger.warning("Could not resolve SQS queue URL for '%s': %s", queue_name, e)
        return ""
