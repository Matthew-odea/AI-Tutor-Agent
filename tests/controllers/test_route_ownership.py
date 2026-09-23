"""
Every route that names a tenant's thing must refuse a caller from another tenant.

`test_route_auth.py` proves every route needs *a* principal. This proves the
principal may touch the specific assessment, student, question, job, S3 key or
workspace the request names. There are two instructors (each owning one
assessment, one student each) and two students (each holding the session token
an invite exchange gives them), all on moto. Every id-bearing route is called
across the tenant line and must be refused.

Same shape as `test_route_auth.py`: the sweep finds every route with an id in its
path, query or body. A new one must either be covered by a rule in
`_attempts()` or be named in `NOT_TENANT_SCOPED` with a reason, so a new
id-bearing route without a test fails the build.
"""
from __future__ import annotations

import re
import typing
from unittest.mock import MagicMock

import boto3
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from moto import mock_aws

TABLE = "ownership_assessments"
CHAT_TABLE = "ownership_chat"
BUCKET = "ownership-bucket"
S3_URL = f"https://{BUCKET}.s3.us-east-1.amazonaws.com"

# Tenant A: instructor inst-a owns a-A, where stu-x is enrolled. Tenant B mirrors it.
A = {"id": "a-A", "student_id": "stu-x", "studentId": "stu-x", "question_id": "q-x1", "jobId": "job-a"}

# Id-bearing routes that are deliberately not tenant-scoped, and why.
NOT_TENANT_SCOPED = {
    ("DELETE", "/internal/context/delete"):
        "RAG documents have no owner field: the corpus is shared by all instructors, so any "
        "instructor may delete any document. Known gap, reported; needs an ownership model first",
    ("POST", "/internal/history/workspaces"):
        "body user_id is ignored and the caller becomes the owner; see "
        "test_body_user_id_never_sets_the_owner",
}

_ID_FIELD = re.compile(r"(^id$|_id$|Id$|Ids$|_ids$|_url$|Url$|key$)")


def _api_routes(app):
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, route.path, route


def _is_id_bearing(route: APIRoute) -> bool:
    names = [p.name for p in route.dependant.path_params + route.dependant.query_params]
    for body in route.dependant.body_params:
        annotation = body.field_info.annotation
        for model in typing.get_args(annotation) or (annotation,):
            names += list(getattr(model, "model_fields", {}))
    return any(_ID_FIELD.search(name) for name in names)


def _fill(value, subs: dict):
    """Substitute {placeholders} in a path or a (nested) request body."""
    if isinstance(value, str):
        for key, sub in subs.items():
            value = value.replace("{" + key + "}", sub)
        return value
    if isinstance(value, dict):
        return {k: _fill(v, subs) for k, v in value.items()}
    return value


def _path(path: str, subs: dict) -> str:
    filled = _fill(path, subs)
    missing = re.findall(r"\{([^}]+)\}", filled)
    assert not missing, f"{path}: no fixture value for path parameter(s) {missing} — add one"
    return filled


# Student routes: bodies that validate, so a refusal cannot hide behind a 422.
_STUDENT_BODIES = {
    ("POST", "/api/student/{student_id}/answer"):
        {"question_id": "q-x1", "assessment_id": "{assessment_id}", "answer_type": "text", "text_content": "hi"},
    ("PUT", "/api/student/{student_id}/submit"): {"assessment_id": "{assessment_id}"},
    ("POST", "/api/student/{student_id}/proctoring-chunk"): {
        "assessment_id": "{assessment_id}",
        "chunk_url": S3_URL + "/proctoring/{assessment_id}/{student_id}/chunk_000000.webm",
        "chunk_index": 0,
    },
    ("POST", "/api/student/{student_id}/consent"): {
        "assessment_id": "{assessment_id}", "granted": True,
        "consent_version": "v1", "timestamp": "2026-09-01T00:00:00Z",
    },
}

_HISTORY_BODIES = {
    ("POST", "/internal/history/views"): {"workspace_id": "{workspace_id}", "view_type": "chat"},
    ("POST", "/internal/history/views/{view_session_id}/message"): {"query": "hi"},
    ("POST", "/internal/history/codememory"): {"workspace_id": "{workspace_id}"},
    ("PATCH", "/internal/history/codememory/{code_memory_id}"): {"current_code": "x"},
    ("POST", "/internal/history/programs"): {"workspace_id": "{workspace_id}"},
    ("PATCH", "/internal/history/programs/{program_id}"): {"title": "x"},
    ("POST", "/internal/history/codememory/{code_memory_id}/threads"): {"title": "t"},
    ("POST", "/internal/history/threads/{thread_id}/message"): {"query": "hi"},
    ("POST", "/internal/history/edit-proposal"): {"query": "x", "thread_id": "{thread_id}"},
}

REFUSED = {403, 404}
# A media key under someone else's prefix must fail on ownership, not on anything
# incidental (question order, a duplicate), so the message is checked too.
FOREIGN_KEY = "not an upload belonging to this student"


def _attempts(method: str, path: str, world) -> list[tuple[str, str, dict | None, set | str]] | None:
    """(actor, url, body, expected) for each cross-tenant try, or None if no rule covers it.

    expected is REFUSED, or FOREIGN_KEY for a 400 that must carry that message."""
    if path.startswith("/api/assessment/{id}"):
        # The router-wide guard runs before body validation, so {} is enough.
        tries = [
            ("inst_b", _path(path, A), {}, REFUSED),  # another instructor
            ("stu_x", _path(path, A), {}, REFUSED),   # a student of that very assessment
        ]
        if "{jobId}" in path:  # own assessment, someone else's job
            tries.append(("inst_b", _path(path, {**A, "id": "a-B"}), {}, REFUSED))
        return tries

    if path.startswith("/api/student/{student_id}"):
        body = _STUDENT_BODIES.get((method, path))
        tries = []
        for actor, student, assessment in [
            ("stu_x", "stu-y", "a-B"),   # another student's record
            ("stu_x", "stu-x", "a-B"),   # own id, an assessment the token was not issued for
            ("inst_b", "stu-x", "a-A"),  # an instructor, of another assessment
            ("signup_y", "stu-y", "a-B"),  # a login token whose subject equals the student id
        ]:
            subs = {"student_id": student, "assessment_id": assessment}
            tries.append((actor, _path(path, subs), _fill(body, subs), REFUSED))
        # A student storing someone else's media key, then reading it back presigned.
        foreign = {
            ("POST", "/api/student/{student_id}/answer"): [
                {"question_id": "q-x1", "assessment_id": "a-A", "answer_type": "audio",
                 "audio_url": S3_URL + "/audio/stu-y/q-y1_1.webm"},
                {"question_id": "q-x1", "assessment_id": "a-A", "answer_type": "video",
                 "video_url": S3_URL + "/proctoring/a-B/stu-y/chunk_000000.webm"},
            ],
            ("POST", "/api/student/{student_id}/proctoring-chunk"): [
                {"assessment_id": "a-A", "chunk_index": 0,
                 "chunk_url": S3_URL + "/proctoring/a-B/stu-y/chunk_000000.webm"},
                {"assessment_id": "a-A", "chunk_index": 0,
                 "chunk_url": S3_URL + "/proctoring/a-A/stu-x/../../a-B/stu-y/chunk_000000.webm"},
            ],
        }.get((method, path), [])
        tries += [("stu_x", _path(path, {"student_id": "stu-x"}), b, FOREIGN_KEY) for b in foreign]
        return tries

    if path == "/api/s3/upload-url":
        # The key is built from the principal, so the only id a caller controls is the
        # assessment folder of a proctoring chunk.
        return [("stu_x", path + "?kind=proctoring&content_type=video/webm&assessment_id=a-B&chunk_index=0",
                 None, REFUSED)]

    if path.startswith("/internal/history"):
        subs = world["history_a"]
        return [("inst_b", _path(path, subs), _fill(_HISTORY_BODIES.get((method, path)), subs), REFUSED)]

    return None


# ─────────────────────────────────────────────────────────────
# Fixture: two tenants on moto
# ─────────────────────────────────────────────────────────────

def _key_table(dynamodb, name, gsi=False):
    extra = {}
    attributes = [{"AttributeName": "PK", "AttributeType": "S"}, {"AttributeName": "SK", "AttributeType": "S"}]
    if gsi:
        attributes += [{"AttributeName": "GSI1PK", "AttributeType": "S"}, {"AttributeName": "GSI1SK", "AttributeType": "S"}]
        extra["GlobalSecondaryIndexes"] = [{
            "IndexName": "InstructorAssessmentsIndex",
            "KeySchema": [{"AttributeName": "GSI1PK", "KeyType": "HASH"}, {"AttributeName": "GSI1SK", "KeyType": "RANGE"}],
            "Projection": {"ProjectionType": "ALL"},
        }]
    return dynamodb.create_table(
        TableName=name,
        KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
        AttributeDefinitions=attributes,
        BillingMode="PAY_PER_REQUEST",
        **extra,
    )


def _seed_tenant(table, assessment_id, owner, student_id, question_id):
    table.put_item(Item={
        "PK": f"ASSESSMENT#{assessment_id}", "SK": "METADATA", "GSI1PK": "ASSESSMENT", "GSI1SK": assessment_id,
        "id": assessment_id, "createdBy": owner, "title": f"Quiz {assessment_id}", "course": "COMP9021",
        "dueDate": "2099-01-01T00:00:00Z", "totalQuestions": 1, "status": "draft",
        "accessMode": "open", "createdAt": "2026-09-01T00:00:00Z",
    })
    # questionOrder frozen as on first access, so an answer for question_id would otherwise be accepted.
    table.put_item(Item={"PK": f"ASSESSMENT#{assessment_id}", "SK": f"STUDENT#{student_id}",
                         "studentId": student_id, "name": student_id, "email": "", "status": "not-started",
                         "questionOrder": [question_id], "currentQuestionIdx": 0})
    table.put_item(Item={"PK": f"STUDENT#{student_id}", "SK": f"ASSESSMENT#{assessment_id}"})
    table.put_item(Item={"PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}", "SK": f"QUESTION#{question_id}",
                         "id": question_id, "text": "Explain recursion.", "questionNumber": 1, "questionType": "manual",
                         "difficulty": "medium", "topic": "recursion",
                         "createdAt": "2026-09-01T00:00:00Z"})


@pytest.fixture(scope="module")
def world():
    from src.main.auth import dependencies as auth_deps
    from src.main.auth.models import AuthPrincipal
    from src.main.controllers import assessment_router
    from src.main.controllers import controller_dependencies as deps

    with pytest.MonkeyPatch.context() as mp, mock_aws():
        for key, value in {
            "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
            "AWS_SESSION_TOKEN": "testing", "AWS_DEFAULT_REGION": "us-east-1",
            "DYNAMODB_ASSESSMENT_TABLE": TABLE, "DYNAMODB_TABLE_NAME": CHAT_TABLE,
            "DYNAMODB_AUTH_USERS_TABLE": "ownership_auth_users", "S3_ASSESSMENT_BUCKET": BUCKET,
            "AUTH_JWT_SECRET": "ownership-test-secret-" + "x" * 20,
            "NEO4J_URI": "bolt://localhost:7687", "NEO4J_PASSWORD": "testing",
            "SQS_JOBS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/000000000000/ownership",
        }.items():
            mp.setenv(key, value)

        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        table = _key_table(dynamodb, TABLE, gsi=True)
        _key_table(dynamodb, CHAT_TABLE)
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
        _seed_tenant(table, "a-A", "inst-a", "stu-x", "q-x1")
        _seed_tenant(table, "a-B", "inst-b", "stu-y", "q-y1")
        # A legacy assessment with no createdBy: it belongs to nobody.
        table.put_item(Item={
            "PK": "ASSESSMENT#a-legacy", "SK": "METADATA", "GSI1PK": "ASSESSMENT", "GSI1SK": "a-legacy",
            "id": "a-legacy", "title": "Legacy", "course": "C", "dueDate": "2099-01-01T00:00:00Z",
            "totalQuestions": 1, "createdAt": "2026-01-01T00:00:00Z",
        })

        from src.main.agentcore_setup.dynamodb_history import DynamoDBHistoryStore
        from src.main.service.InstructorAssessmentService import InstructorAssessmentService
        from src.main.service.OralAssessmentService import OralAssessmentService
        from src.main.service.S3UploadService import S3UploadService

        history = DynamoDBHistoryStore(table_name=CHAT_TABLE, region="us-east-1")
        ws = history.create_workspace("A's workspace", "inst-a")["workspace_id"]
        memory = history.create_code_memory(ws, "python", "print(1)")["code_memory_id"]
        history_a = {
            "workspace_id": ws,
            "view_session_id": history.create_view_session(ws, "chat", None)["view_session_id"],
            "code_memory_id": memory,
            "program_id": history.create_program(ws, memory, "python", "p", "")["program_id"],
            "thread_id": history.create_thread(memory, "t")["thread_id"],
        }

        jobs = {
            # Terminal, so a stream that leaks past a missing guard ends (and fails the
            # test) instead of polling forever.
            "job-a": {"job_id": "job-a", "assessment_id": "a-A", "status": "completed", "total_items": 1,
                      "processed_count": 0, "started_at": "2026-09-01T00:00:00Z"},
        }
        mp.setattr(assessment_router, "get_batch_job_manager",
                   lambda: MagicMock(get_job=lambda job_id: jobs.get(job_id)))
        mp.setattr(assessment_router, "ResponseEvaluationRepository",
                   lambda: MagicMock(get_evaluation_progress=lambda *_: {"status": "completed"}))

        # Real JWTs from a fresh AuthService. Its lru_cache is also read directly by
        # the history routes, so clear it rather than only overriding the dependency.
        auth_deps.get_auth_service.cache_clear()
        auth = auth_deps.get_auth_service()

        def login(user_id, role):
            return auth.issue_access_token(AuthPrincipal(user_id=user_id, roles=[role]))["access_token"]

        tokens = {
            "inst_a": login("inst-a", "instructor"),
            "inst_b": login("inst-b", "instructor"),
            "stu_x": auth.issue_student_session_token("stu-x", "a-A")["access_token"],
            "stu_y": auth.issue_student_session_token("stu-y", "a-B")["access_token"],
            # Signup is open and a signed-up user's id is their email. If an instructor
            # used an email as a student id, anyone can hold a login token with that subject.
            "signup_y": login("stu-y", "student"),
        }

        from app import create_app

        app = create_app()
        instructor_svc, oral_svc = InstructorAssessmentService(), OralAssessmentService()
        overrides = {
            deps.get_instructor_assessment_service: lambda: instructor_svc,
            deps.get_oral_assessment_service: lambda: oral_svc,
            deps.get_history_store: lambda: history,
            deps.get_s3_upload_service: lambda: S3UploadService(bucket_name=BUCKET, region="us-east-1"),
        }
        # Nothing refused should reach these; a MagicMock answering means a guard is missing.
        for dep in (deps.get_sqs_job_dispatcher, deps.get_assessment_report_service, deps.get_chat_service,
                    deps.get_context_service, deps.get_analytics_service, deps.get_evaluation_service,
                    deps.get_question_service):
            overrides[dep] = lambda: MagicMock()  # the class itself would read as *args query params
        app.dependency_overrides.update(overrides)

        yield {"app": app, "client": TestClient(app, raise_server_exceptions=False),
               "tokens": tokens, "table": table, "history_a": history_a}

        auth_deps.get_auth_service.cache_clear()


def _call(world, actor, method, url, body=None):
    headers = {"Authorization": f"Bearer {world['tokens'][actor]}"}
    return world["client"].request(method, url, json=body, headers=headers)


# ─────────────────────────────────────────────────────────────
# The gate
# ─────────────────────────────────────────────────────────────

def test_every_id_bearing_route_has_an_ownership_case(world):
    uncovered = [
        f"{method} {path}"
        for method, path, route in _api_routes(world["app"])
        if _is_id_bearing(route)
        and (method, path) not in NOT_TENANT_SCOPED
        and _attempts(method, path, world) is None
    ]
    assert not uncovered, (
        "These routes take an id but nothing tests that another tenant is refused:\n  "
        + "\n  ".join(sorted(uncovered))
        + "\n\nAdd a rule to _attempts(), or list the route in NOT_TENANT_SCOPED with a reason."
    )


def test_not_tenant_scoped_allowlist_has_no_stale_entries(world):
    live = {(method, path) for method, path, _ in _api_routes(world["app"])}
    stale = [f"{m} {p}" for m, p in NOT_TENANT_SCOPED if (m, p) not in live]
    assert not stale, "NOT_TENANT_SCOPED lists routes that no longer exist:\n  " + "\n  ".join(stale)


def test_cross_tenant_requests_are_refused(world):
    failures = []
    for method, path, route in _api_routes(world["app"]):
        if (method, path) in NOT_TENANT_SCOPED or not _is_id_bearing(route):
            continue
        for actor, url, body, expected in _attempts(method, path, world) or []:
            response = _call(world, actor, method, url, body)
            envelope = response.headers.get("content-type", "").startswith("application/json") \
                and response.json().get("ok") is False
            if expected == FOREIGN_KEY:
                ok = response.status_code == 400 and FOREIGN_KEY in response.text
            else:
                ok = response.status_code in expected
            if not (ok and envelope):
                failures.append(f"{actor} {method} {url} -> {response.status_code} {response.text[:160]}")
    assert not failures, "Cross-tenant requests that were not refused:\n  " + "\n  ".join(failures)

    # A refused media key was refused before the write, not after it.
    stored = [item for item in world["table"].scan()["Items"]
              if item["PK"].startswith("STUDENT#stu-x")
              and "stu-y" in f"{item.get('audioUrl')}{item.get('videoUrl')}{item.get('chunkUrl')}"]
    assert not stored


# ─────────────────────────────────────────────────────────────
# The fixture is real: owners get through
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("actor,method,url,body", [
    ("inst_a", "GET", "/api/assessment/a-A", None),
    ("inst_a", "GET", "/api/assessment/a-A/students/stu-x/questions", None),
    ("inst_a", "GET", "/api/assessment/a-A/generation-status/job-a", None),
    ("stu_x", "GET", "/api/student/stu-x/assessment/a-A/questions", None),
    ("stu_x", "POST", "/api/student/stu-x/proctoring-chunk",
     {"assessment_id": "a-A", "chunk_index": 0, "chunk_url": S3_URL + "/proctoring/a-A/stu-x/chunk_000000.webm"}),
    ("stu_x", "POST", "/api/s3/upload-url?kind=proctoring&content_type=video/webm&assessment_id=a-A&chunk_index=0", None),
])
def test_owners_are_let_through(world, actor, method, url, body):
    response = _call(world, actor, method, url, body)
    assert response.status_code == 200, response.text


def test_owners_are_let_through_history(world):
    ws = world["history_a"]["workspace_id"]
    assert _call(world, "inst_a", "GET", f"/internal/history/workspaces/{ws}/views").status_code == 200


def test_someone_elses_assessment_answers_exactly_like_a_missing_one(world):
    """A 403 for "exists, not yours" beside a 404 for "no such id" tells a caller which ids exist."""
    for method, suffix, body in [("GET", "", None), ("PUT", "/brief", {"brief": "x" * 60}),
                                 ("DELETE", "", None)]:
        theirs = _call(world, "inst_b", method, f"/api/assessment/a-A{suffix}", body)
        missing = _call(world, "inst_b", method, f"/api/assessment/no-such-id{suffix}", body)
        assert (theirs.status_code, theirs.json()) == (missing.status_code, missing.json()) == (
            404, {"ok": False, "error": {"code": "assessment_not_found", "message": "Assessment not found"}})


def test_list_shows_only_the_callers_assessments(world):
    ids = {a["id"] for a in _call(world, "inst_b", "GET", "/api/assessment/list").json()["assessments"]}
    assert ids == {"a-B"}  # not a-A, and not the ownerless legacy assessment


def test_body_user_id_never_sets_the_owner(world):
    response = _call(world, "inst_b", "POST", "/internal/history/workspaces", {"title": "t", "user_id": "inst-a"})
    assert response.status_code == 200
    assert response.json()["user_id"] == "inst-b"
