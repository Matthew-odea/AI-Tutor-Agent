"""
Integration tests for SQSJobDispatcher using moto-mocked SQS.

Covers:
- enqueue_question_generation
- enqueue_evaluation_batch
- _process_message routing
- Malformed message handling
- start_consumer / stop_consumer lifecycle
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from src.main.service.SQSJobDispatcher import SQSJobDispatcher

TABLE_NAME = "test_oral_assessments"
QUEUE_NAME = "test-jobs-queue"


@pytest.fixture()
def sqs_env(monkeypatch):
    """Set up moto-backed SQS queue and DynamoDB table."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")

    with mock_aws():
        # SQS
        sqs_client = boto3.client("sqs", region_name="us-east-1")
        resp = sqs_client.create_queue(QueueName=QUEUE_NAME)
        queue_url = resp["QueueUrl"]

        # DynamoDB
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

        yield queue_url, table, sqs_client


def _make_dispatcher(queue_url, table) -> SQSJobDispatcher:
    return SQSJobDispatcher(queue_url=queue_url, region="us-east-1", table=table)


# ─────────────────────────────────────────────────────────────
# Enqueue question generation
# ─────────────────────────────────────────────────────────────

class TestEnqueueQuestionGeneration:
    def test_enqueue_sends_messages(self, sqs_env):
        queue_url, table, sqs_client = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        students = [
            {"studentId": "s-1", "name": "Alice", "code": "print('hi')"},
            {"studentId": "s-2", "name": "Bob", "code": "x = 1"},
        ]
        count = dispatcher.enqueue_question_generation(
            job_id="job-1",
            assessment_id="a-1",
            students=students,
            assignment_brief="Build a BST",
        )

        assert count == 2

        # Verify messages are in the queue
        resp = sqs_client.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=10)
        messages = resp.get("Messages", [])
        assert len(messages) == 2

        body = json.loads(messages[0]["Body"])
        assert body["job_type"] == "question_generation"
        assert body["assignment_brief"] == "Build a BST"

    def test_enqueue_batches_over_ten_students(self, sqs_env):
        queue_url, table, sqs_client = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        students = [{"studentId": f"s-{i}", "name": f"Student {i}", "code": ""} for i in range(15)]
        count = dispatcher.enqueue_question_generation(
            job_id="job-2",
            assessment_id="a-1",
            students=students,
            assignment_brief="Brief",
        )

        assert count == 15


# ─────────────────────────────────────────────────────────────
# Enqueue evaluation batch
# ─────────────────────────────────────────────────────────────

class TestEnqueueEvaluationBatch:
    def test_enqueue_evaluation_messages(self, sqs_env):
        queue_url, table, sqs_client = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        students = [
            {"studentId": "s-1"},
            {"studentId": "s-2"},
            {"studentId": "s-3"},
        ]
        count = dispatcher.enqueue_evaluation_batch(
            job_id="eval-1",
            assessment_id="a-1",
            students=students,
        )

        assert count == 3

        resp = sqs_client.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=10)
        body = json.loads(resp["Messages"][0]["Body"])
        assert body["job_type"] == "evaluation"


class TestEnqueueReportGeneration:
    def test_enqueue_sends_one_message_for_the_whole_cohort(self, sqs_env):
        """Reports are per-assessment, not per-student — exactly one message."""
        queue_url, table, sqs_client = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        count = dispatcher.enqueue_report_generation(
            job_id="rep-1", assessment_id="a-1", milestone=2,
        )

        assert count == 1
        resp = sqs_client.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=10)
        assert len(resp["Messages"]) == 1
        body = json.loads(resp["Messages"][0]["Body"])
        assert body["job_type"] == "report_generation"
        assert body["assessment_id"] == "a-1"
        assert body["milestone"] == 2
        assert body["triggered_by"] == "auto_threshold"


# ─────────────────────────────────────────────────────────────
# Message processing
# ─────────────────────────────────────────────────────────────

class TestProcessMessage:
    def test_routes_question_generation_message(self, sqs_env):
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        question_svc = MagicMock()
        msg = {
            "Body": json.dumps({
                "job_type": "question_generation",
                "job_id": "j-1",
                "assessment_id": "a-1",
                "student_id": "s-1",
                "student_name": "Alice",
                "student_code": "x = 1",
                "assignment_brief": "Brief",
            }),
            "ReceiptHandle": "fake-receipt",
        }

        dispatcher._process_message(msg, question_svc, None)
        question_svc.generate_questions.assert_called_once()
        call_kwargs = question_svc.generate_questions.call_args
        assert call_kwargs[1]["student_id"] == "s-1" or call_kwargs.kwargs.get("student_id") == "s-1"

    def test_routes_evaluation_message(self, sqs_env):
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        eval_runner = MagicMock()
        msg = {
            "Body": json.dumps({
                "job_type": "evaluation",
                "job_id": "j-1",
                "assessment_id": "a-1",
                "student_id": "s-1",
            }),
            "ReceiptHandle": "fake-receipt",
        }

        dispatcher._process_message(msg, MagicMock(), eval_runner)
        eval_runner.evaluate_from_dynamodb.assert_called_once()

    def test_routes_report_generation_message(self, sqs_env):
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        report_svc = MagicMock()
        msg = {
            "Body": json.dumps({
                "job_type": "report_generation",
                "job_id": "j-1",
                "assessment_id": "a-1",
                "triggered_by": "auto_threshold",
                "milestone": 1,
            }),
            "ReceiptHandle": "fake-receipt",
        }

        dispatcher._process_message(msg, MagicMock(), None, report_svc)

        report_svc.generate_report.assert_called_once_with(
            "a-1", triggered_by="auto_threshold", milestone=1,
        )

    def test_report_message_without_service_is_discarded(self, sqs_env):
        """No report service configured must not wedge the consumer."""
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        msg = {
            "Body": json.dumps({
                "job_type": "report_generation", "job_id": "j-1", "assessment_id": "a-1",
            }),
            "ReceiptHandle": "fake-receipt",
        }

        dispatcher._process_message(msg, MagicMock(), None, None)  # should not raise

    def test_report_generation_failure_is_swallowed(self, sqs_env):
        """A failed report must not poison the queue for evaluation work."""
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        report_svc = MagicMock()
        report_svc.generate_report.side_effect = RuntimeError("aggregation blew up")
        msg = {
            "Body": json.dumps({
                "job_type": "report_generation", "job_id": "j-1", "assessment_id": "a-1",
            }),
            "ReceiptHandle": "fake-receipt",
        }

        dispatcher._process_message(msg, MagicMock(), None, report_svc)  # should not raise

    def test_malformed_json_deletes_message(self, sqs_env):
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        msg = {
            "Body": "not json {{{",
            "ReceiptHandle": "fake-receipt",
        }

        # Should not raise
        dispatcher._process_message(msg, MagicMock(), None)


# ─────────────────────────────────────────────────────────────
# Consumer lifecycle
# ─────────────────────────────────────────────────────────────

class TestConsumerLifecycle:
    def test_start_and_stop(self, sqs_env):
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        dispatcher.start_consumer(MagicMock())
        assert dispatcher.is_running() is True

        dispatcher.stop_consumer()
        # Give thread a moment to stop
        import time
        time.sleep(0.5)
        # _stopping is set
        assert dispatcher._stopping.is_set()

    def test_start_is_idempotent(self, sqs_env):
        queue_url, table, _ = sqs_env
        dispatcher = _make_dispatcher(queue_url, table)

        dispatcher.start_consumer(MagicMock())
        thread1 = dispatcher._consumer_thread
        dispatcher.start_consumer(MagicMock())
        thread2 = dispatcher._consumer_thread

        assert thread1 is thread2
        dispatcher.stop_consumer()


# ─────────────────────────────────────────────────────────────
# At-least-once delivery, retries, visibility
# ─────────────────────────────────────────────────────────────

import threading

from src.main.service import SQSJobDispatcher as dispatcher_module
from src.main.service.SQSJobDispatcher import resolve_queue_url


class _SerializedTable:
    """Applies each call one at a time, as real DynamoDB does per item — moto is
    not thread-safe. The lock covers one call, not a sequence, so a
    read-then-write in our code still races under it."""

    def __init__(self, inner):
        self._inner = inner
        self._lock = threading.Lock()

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if not callable(attr):
            return attr

        def locked(*args, **kwargs):
            with self._lock:
                return attr(*args, **kwargs)

        return locked


def _create_job(table, job_id="j-1", total=1):
    table.put_item(Item={
        "PK": f"JOB#{job_id}", "SK": "METADATA", "job_id": job_id, "status": "pending",
        "total_items": total, "processed_count": 0, "successful_count": 0, "failed_count": 0,
    })


def _job(table, job_id="j-1"):
    return table.get_item(Key={"PK": f"JOB#{job_id}", "SK": "METADATA"})["Item"]


def _eval_msg(student_id="s-1", job_id="j-1", receive_count=1):
    return {
        "Body": json.dumps({
            "job_type": "evaluation", "job_id": job_id, "assessment_id": "a-1", "student_id": student_id,
        }),
        "ReceiptHandle": "fake-receipt",
        "Attributes": {"ApproximateReceiveCount": str(receive_count)},
    }


class TestRedelivery:
    def test_redelivered_message_is_not_evaluated_or_counted_twice(self, sqs_env):
        """SQS redelivers a message whose delete was lost (crash after the work, or a
        failed delete). The second copy must not re-run Bedrock or recount."""
        queue_url, table, _ = sqs_env
        _create_job(table, total=2)
        dispatcher = _make_dispatcher(queue_url, table)
        runner = MagicMock()

        dispatcher._process_message(_eval_msg(), MagicMock(), runner)
        dispatcher._process_message(_eval_msg(receive_count=2), MagicMock(), runner)

        assert runner.evaluate_from_dynamodb.call_count == 1
        job = _job(table)
        assert int(job["processed_count"]) == 1
        assert job["status"] == "pending"  # 1 of 2 — a double count would have completed it

    def test_concurrent_duplicates_count_once(self, sqs_env):
        """Two workers holding the same message at once (visibility lapsed) both pass
        the duplicate check before either counts; the barrier forces that. Only the
        conditional counter keeps processed_count exact."""
        queue_url, table, _ = sqs_env
        _create_job(table, total=2)
        dispatcher = _make_dispatcher(queue_url, _SerializedTable(table))
        both_working = threading.Barrier(2, timeout=10)
        runner = MagicMock()
        runner.evaluate_from_dynamodb.side_effect = lambda *a: both_working.wait()

        threads = [
            threading.Thread(target=dispatcher._process_message, args=(_eval_msg(), MagicMock(), runner))
            for _ in range(2)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert runner.evaluate_from_dynamodb.call_count == 2
        job = _job(table)
        assert int(job["processed_count"]) == 1
        assert job["status"] == "pending"


class TestFailureRetry:
    def test_failure_is_left_for_retry_with_backoff(self, sqs_env):
        queue_url, table, _ = sqs_env
        _create_job(table)
        dispatcher = _make_dispatcher(queue_url, table)
        dispatcher.sqs = MagicMock()
        runner = MagicMock()
        runner.evaluate_from_dynamodb.side_effect = RuntimeError("Bedrock throttled")

        dispatcher._process_message(_eval_msg(receive_count=1), MagicMock(), runner)

        dispatcher.sqs.delete_message.assert_not_called()
        dispatcher.sqs.change_message_visibility.assert_called_once_with(
            QueueUrl=queue_url, ReceiptHandle="fake-receipt", VisibilityTimeout=60,
        )
        assert int(_job(table)["processed_count"]) == 0

    def test_final_attempt_counts_failure_and_leaves_message_for_dlq(self, sqs_env):
        """Bounded: the last allowed receive counts the student as failed (so the job
        completes) and does not delete, so the redrive policy moves it to the DLQ."""
        queue_url, table, _ = sqs_env
        _create_job(table)
        dispatcher = _make_dispatcher(queue_url, table)
        dispatcher.sqs = MagicMock()
        runner = MagicMock()
        runner.evaluate_from_dynamodb.side_effect = RuntimeError("poison")

        dispatcher._process_message(
            _eval_msg(receive_count=dispatcher_module._MAX_RECEIVES), MagicMock(), runner,
        )

        dispatcher.sqs.delete_message.assert_not_called()
        job = _job(table)
        assert int(job["failed_count"]) == 1
        assert job["status"] == "completed"


class TestVisibilityHeartbeat:
    def test_long_job_keeps_extending_visibility(self, sqs_env, monkeypatch):
        """An evaluation that outlasts the visibility timeout must not be handed to
        another worker mid-run. The runner blocks until a heartbeat is seen."""
        queue_url, table, _ = sqs_env
        _create_job(table)
        monkeypatch.setattr(dispatcher_module, "_HEARTBEAT_SECONDS", 0.01)
        dispatcher = _make_dispatcher(queue_url, table)
        dispatcher.sqs = MagicMock()
        beat = threading.Event()
        dispatcher.sqs.change_message_visibility.side_effect = lambda **kw: beat.set()
        runner = MagicMock()
        runner.evaluate_from_dynamodb.side_effect = lambda *a: beat.wait(timeout=5)

        dispatcher._process_message(_eval_msg(), MagicMock(), runner)

        assert beat.is_set()
        dispatcher.sqs.change_message_visibility.assert_called_with(
            QueueUrl=queue_url, ReceiptHandle="fake-receipt",
            VisibilityTimeout=dispatcher_module._VISIBILITY_TIMEOUT,
        )
        dispatcher.sqs.delete_message.assert_called_once()


class TestEnqueueFailure:
    def test_unsent_messages_are_counted_so_the_job_can_complete(self, sqs_env):
        """A message SQS refuses will never be processed; without counting it the job
        sits 'pending' forever and blocks re-generation for the assessment."""
        queue_url, table, _ = sqs_env
        _create_job(table, total=2)
        dispatcher = _make_dispatcher(queue_url, table)
        dispatcher.sqs = MagicMock()
        dispatcher.sqs.send_message_batch.return_value = {
            "Successful": [{"Id": "0"}], "Failed": [{"Id": "1", "Code": "InternalError"}],
        }

        sent = dispatcher.enqueue_evaluation_batch("j-1", "a-1", [{"studentId": "s-1"}, {"studentId": "s-2"}])

        assert sent == 1
        job = _job(table)
        assert int(job["failed_count"]) == 1
        assert job["processed_items"] == {"s-2"}


def test_resolve_queue_url_offline_returns_empty(monkeypatch):
    """No network must not raise through dependency injection."""
    from botocore.exceptions import EndpointConnectionError

    monkeypatch.delenv("SQS_JOBS_QUEUE_URL", raising=False)
    client = MagicMock()
    client.get_queue_url.side_effect = EndpointConnectionError(endpoint_url="https://sqs.us-east-1.amazonaws.com")
    monkeypatch.setattr(dispatcher_module.boto3, "client", lambda *a, **k: client)

    assert resolve_queue_url() == ""
