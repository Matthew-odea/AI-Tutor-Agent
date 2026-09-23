"""
Server-side enforcement of an assessment's stored time limits, through the real
student routes and the real OralAssessmentService (moto DynamoDB).

- scheduledWindowStart/End (accessMode='scheduled') gate question fetch, answer
  and skip. Closed -> 409 assessment_closed; not yet open -> 409 assessment_not_open.
- dueDate gates only the final PUT /submit -> 409 assessment_deadline_passed.

The instructor app sends <input type="datetime-local"> values unchanged, so stored
times can carry an offset, a Z, or nothing. Offsets are honoured; a bare time is
read as UTC (see the naive-time test).
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import (
    get_assessment_report_service,
    get_instructor_assessment_service,
    get_oral_assessment_service,
    get_sqs_job_dispatcher,
)
from tests.service.test_oral_assessment_service import (  # noqa: F401 (fixture)
    _create_service,
    _seed_assessment,
    _seed_enrollment,
    _seed_questions,
    dynamo_env,
)

_STUDENT = AuthPrincipal(user_id="s-1", roles=["student"], source="jwt", assessment_id="a-1")


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _client(table) -> TestClient:
    app = create_app()
    svc = _create_service(table)
    app.dependency_overrides[require_auth_principal] = lambda: _STUDENT
    app.dependency_overrides[get_oral_assessment_service] = lambda: svc
    for dep in (get_instructor_assessment_service, get_sqs_job_dispatcher, get_assessment_report_service):
        app.dependency_overrides[dep] = lambda: MagicMock()
    return TestClient(app)


def _scheduled(table, start: str, end: str):
    _seed_assessment(table, access_mode="scheduled")
    table.update_item(
        Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
        UpdateExpression="SET scheduledWindowStart = :s, scheduledWindowEnd = :e",
        ExpressionAttributeValues={":s": start, ":e": end},
    )
    _seed_enrollment(table)
    _seed_questions(table, count=2)


def _answer(client, answer_type="text"):
    body = {"assessment_id": "a-1", "question_id": "q-1", "answer_type": answer_type}
    if answer_type == "text":
        body["text_content"] = "an answer"
    return client.post("/api/student/s-1/answer", json=body)


def _assert_window_error(resp, code):
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == code


def test_answer_inside_window_is_accepted(dynamo_env):
    now = datetime.now(timezone.utc)
    _scheduled(dynamo_env, _iso(now - timedelta(hours=1)), _iso(now + timedelta(hours=1)))
    client = _client(dynamo_env)

    assert client.get("/api/student/s-1/assessment/a-1/questions").status_code == 200
    resp = _answer(client)
    assert resp.status_code == 200, resp.text


def test_answer_and_skip_after_window_close_are_rejected(dynamo_env):
    now = datetime.now(timezone.utc)
    _scheduled(dynamo_env, _iso(now - timedelta(hours=2)), _iso(now - timedelta(seconds=1)))
    client = _client(dynamo_env)

    _assert_window_error(_answer(client), "assessment_closed")
    _assert_window_error(_answer(client, "skipped"), "assessment_closed")
    _assert_window_error(client.get("/api/student/s-1/assessment/a-1/questions"), "assessment_closed")
    # Nothing was written.
    assert "Item" not in dynamo_env.get_item(Key={"PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "ANSWER#q-1"})


def test_questions_before_window_opens_are_refused(dynamo_env):
    now = datetime.now(timezone.utc)
    _scheduled(dynamo_env, _iso(now + timedelta(hours=1)), _iso(now + timedelta(hours=2)))
    client = _client(dynamo_env)

    _assert_window_error(client.get("/api/student/s-1/assessment/a-1/questions"), "assessment_not_open")
    # Refused before startedAt/questionOrder are frozen.
    enrollment = dynamo_env.get_item(Key={"PK": "ASSESSMENT#a-1", "SK": "STUDENT#s-1"})["Item"]
    assert "startedAt" not in enrollment


def test_window_end_with_utc_offset_is_compared_as_an_instant(dynamo_env):
    # Closed an hour ago, written in Sydney time: the wall-clock digits are 9 hours
    # AHEAD of now in UTC, so dropping the offset would wrongly keep it open.
    sydney = timezone(timedelta(hours=10))
    now = datetime.now(timezone.utc)
    _scheduled(
        dynamo_env,
        (now - timedelta(hours=3)).astimezone(sydney).isoformat(),
        (now - timedelta(hours=1)).astimezone(sydney).isoformat(),
    )
    _assert_window_error(_answer(_client(dynamo_env)), "assessment_closed")


def test_naive_window_times_are_read_as_utc(dynamo_env):
    # What datetime-local sends today (no offset). Pinned so a change to this
    # reading is deliberate: an instructor east of UTC gets a window that closes late.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _scheduled(
        dynamo_env,
        (now - timedelta(hours=2)).isoformat(timespec="minutes"),
        (now - timedelta(minutes=2)).isoformat(timespec="minutes"),
    )
    _assert_window_error(_answer(_client(dynamo_env)), "assessment_closed")


def _ready_to_submit(table, due: str):
    _seed_assessment(table)
    table.update_item(
        Key={"PK": "ASSESSMENT#a-1", "SK": "METADATA"},
        UpdateExpression="SET dueDate = :d",
        ExpressionAttributeValues={":d": due},
    )
    _seed_enrollment(table)
    table.put_item(Item={
        "PK": "STUDENT#s-1#ASSESSMENT#a-1", "SK": "PROGRESS",
        "totalQuestions": 1, "answeredQuestions": 1, "status": "completed",
    })


def test_submit_after_due_date_is_rejected(dynamo_env):
    _ready_to_submit(dynamo_env, _iso(datetime.now(timezone.utc) - timedelta(minutes=1)))
    resp = _client(dynamo_env).put("/api/student/s-1/submit", json={"assessment_id": "a-1"})

    _assert_window_error(resp, "assessment_deadline_passed")
    enrollment = dynamo_env.get_item(Key={"PK": "ASSESSMENT#a-1", "SK": "STUDENT#s-1"})["Item"]
    assert "submittedAt" not in enrollment


def test_submit_before_due_date_is_accepted(dynamo_env):
    _ready_to_submit(dynamo_env, _iso(datetime.now(timezone.utc) + timedelta(hours=1)))
    resp = _client(dynamo_env).put("/api/student/s-1/submit", json={"assessment_id": "a-1"})
    assert resp.status_code == 200, resp.text
