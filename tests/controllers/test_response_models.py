"""
Every JSON route declares a response_model, and adding one did not change what it returns.

`shared/types/api.ts` is generated from the OpenAPI schema, and the frontends alias
their API types onto it. A route with no response_model, or one whose model holds a
bare `dict`, types as `unknown` there and the frontend falls back to a hand-typed
cast that nothing checks. The first two tests are the gate, in the allowlist style
of test_route_auth.py.

Adding a response_model also makes FastAPI drop any field the model does not
declare, so a missed field is a silent frontend regression. The rest of this file
feeds each newly modelled route realistic data and asserts the JSON is exactly
what the handler (or service) built before the model existed.
"""
from __future__ import annotations

import os
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.encoders import jsonable_encoder
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from tests.controllers.test_error_envelope import NON_JSON_RESPONSE_ROUTES

for _key, _value in {
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_DEFAULT_REGION": "us-east-1",
    "AUTH_JWT_SECRET": "x" * 32,
    "NEO4J_URI": "bolt://localhost:7687",
    "NEO4J_PASSWORD": "testing",
}.items():
    os.environ.setdefault(_key, _value)

from app import create_app  # noqa: E402
from src.main.auth.dependencies import get_auth_service, require_auth_principal  # noqa: E402
from src.main.auth.models import AuthPrincipal  # noqa: E402
from src.main.auth.service import AuthService  # noqa: E402
from src.main.controllers.controller_dependencies import (  # noqa: E402
    get_assessment_report_service,
    get_history_store,
    get_instructor_assessment_service,
    get_s3_upload_service,
)
from src.main.controllers.controller_helpers import _require_user_id  # noqa: E402
from src.main.service.AssessmentReportService import (  # noqa: E402
    AssessmentReportService,
    _decimalise,
    _undecimalise,
)
from src.main.service.InstructorAssessmentResultsAggregator import (  # noqa: E402
    InstructorAssessmentResultsAggregator,
)

# JSON routes that still return an undeclared shape. Keep this short: each entry is a
# route whose frontend type is `unknown`.
UNMODELLED_ROUTES = {
    ("GET", "/health"): "liveness probe in app.py; no frontend reads its body",
    ("POST", "/internal/context/upload"): "ai-tutor-frontend context admin; shape is Neo4j upload stats",
    ("DELETE", "/internal/context/delete"): "ai-tutor-frontend context admin; not called by the assessment apps",
    ("POST", "/internal/context/list"): "ai-tutor-frontend context admin; rows come straight from Neo4j",
    ("POST", "/internal/context/uploadFile"): "ai-tutor-frontend context admin; shape is Neo4j upload stats",
}

# Schema fields that are free-form objects on purpose.
FREE_FORM_FIELDS = {
    "AnalyticsEventRequest.properties": "arbitrary analytics event properties",
    "AssistantMessage.edit_block": "code-edit block passed through from the LLM",
    "EditProposalResponse.edit_block": "code-edit block passed through from the LLM",
}


@pytest.fixture(scope="module")
def app():
    return create_app()


def _json_routes(app):
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.status_code == 204:
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            if (method, route.path) not in NON_JSON_RESPONSE_ROUTES:
                yield method, route.path, route


def test_every_json_route_declares_a_response_model(app):
    missing = [
        f"{method} {path}"
        for method, path, route in _json_routes(app)
        if route.response_model is None and (method, path) not in UNMODELLED_ROUTES
    ]
    assert not missing, (
        "These routes have no response_model, so shared/types/api.ts types them as unknown:\n  "
        + "\n  ".join(sorted(missing))
        + "\n\nAdd a Pydantic model in src/main/dtos/, or list the route in UNMODELLED_ROUTES with a reason."
    )
    live = {(method, path) for method, path, _ in _json_routes(app)}
    stale = sorted(f"{m} {p}" for m, p in UNMODELLED_ROUTES if (m, p) not in live)
    assert not stale, "UNMODELLED_ROUTES lists routes that no longer exist:\n  " + "\n  ".join(stale)


def _loose_fields(name, schema, field=None):
    """Yield 'Schema.field' for every bare dict/Any inside a component schema."""
    if not isinstance(schema, dict):
        return
    bare_object = schema.get("type") == "object" and "properties" not in schema and schema.get(
        "additionalProperties", True
    ) in (True, {})
    if schema == {} or bare_object:
        yield f"{name}.{field}"
        return
    for key, sub in schema.get("properties", {}).items():
        yield from _loose_fields(name, sub, key)
    for key in ("items", "additionalProperties"):
        yield from _loose_fields(name, schema.get(key), field)
    for key in ("anyOf", "oneOf", "allOf"):
        for sub in schema.get(key, []):
            yield from _loose_fields(name, sub, field)


def test_no_schema_field_is_a_bare_dict(app):
    schemas = app.openapi()["components"]["schemas"]
    loose = {f for name, schema in schemas.items() for f in _loose_fields(name, schema)}
    unexpected = sorted(loose - set(FREE_FORM_FIELDS))
    assert not unexpected, (
        "These fields are a bare dict/list/Any, so the frontend sees them as unknown:\n  "
        + "\n  ".join(unexpected)
        + "\n\nGive them a Pydantic model, or list them in FREE_FORM_FIELDS with a reason."
    )
    stale = sorted(set(FREE_FORM_FIELDS) - loose)
    assert not stale, "FREE_FORM_FIELDS lists fields that are no longer free-form:\n  " + "\n  ".join(stale)


# ── Old output == new output, on realistic data ────────────────────────────────

_INSTRUCTOR = AuthPrincipal(user_id="i-1", roles=["instructor", "admin"], source="jwt")
_ASSESSMENT = {"id": "a-1", "title": "Quiz 6", "createdBy": "i-1", "gradeCutoffs": {"excellent": Decimal("85")}}
_ROSTER = [
    {"studentId": "z5000001", "name": "Student One", "email": "s1@example.edu"},
    {"studentId": "z5000002", "name": "Student Two", "email": ""},
]


def _client(svc=None, deps=None):
    app = create_app()
    svc = svc or MagicMock()
    svc.get_assessment.return_value = _ASSESSMENT
    svc.get_assessment_students.return_value = list(_ROSTER)
    app.dependency_overrides[require_auth_principal] = lambda: _INSTRUCTOR
    app.dependency_overrides[_require_user_id] = lambda: "user-1"
    app.dependency_overrides[get_instructor_assessment_service] = lambda: svc
    for dep, value in (deps or {}).items():
        # Not `lambda value=value`: FastAPI would treat it as a query param and deep-copy the default.
        app.dependency_overrides[dep] = (lambda v: lambda: v)(value)
    return TestClient(app), svc


def _evaluations():
    """Evaluation items as DynamoDB hands them back: Decimals, a string set, gaps."""
    return {
        "z5000001": [
            {"SK": "EVALUATION#q1", "questionId": "q1", "totalScore": Decimal("7"),
             "correctnessScore": Decimal("4"), "understandingScore": Decimal("3"),
             "needsReview": False, "evaluationMethod": "text",
             "humanTotalScore": Decimal("6"), "humanCorrectnessScore": Decimal("3"),
             "humanUnderstandingScore": Decimal("3")},
            {"SK": "EVALUATION#q2", "totalScore": Decimal("5"),
             "correctnessScore": Decimal("5"), "understandingScore": Decimal("0"),
             "needsReview": True, "reviewReasons": {"structured_output_fallback"},
             "evaluationMethod": "fallback", "humanTotalScore": Decimal("5")},
        ],
        "z5000002": [
            {"SK": "EVALUATION#q1", "questionId": "q1", "needsReview": True,
             "evaluationMethod": None},
        ],
    }


def _aggregator():
    agg = InstructorAssessmentResultsAggregator(table=MagicMock(), get_students=lambda _id: _ROSTER)
    agg._query_all_evaluations = lambda _id: (_ROSTER, _evaluations())
    agg.get_assessment_results = lambda _id: [
        {"percentage": 72.5, "grade": "Competent"},
        {"percentage": 91.0, "grade": "Excellent"},
        {"percentage": 0, "grade": "Not Evaluated"},
    ]
    return agg


def _report_service():
    table = MagicMock()
    table.query.return_value = {"Count": 2}
    llm = MagicMock()
    llm.chat.return_value = "The cohort is tracking around 82%."
    return AssessmentReportService(
        table=table, results_aggregator=_aggregator(), get_assessment=lambda _id: _ASSESSMENT, llm_client=llm
    )


def test_report_routes_return_the_report_unchanged():
    report_svc = _report_service()
    built = []
    real_generate = report_svc.generate_report
    report_svc.generate_report = lambda *a, **k: built.append(real_generate(*a, **k)) or built[-1]
    client, _ = _client(deps={get_assessment_report_service: report_svc})

    generated = client.post("/api/assessment/a-1/report/generate").json()
    stored = report_svc.table.put_item.call_args.kwargs["Item"]
    assert generated == jsonable_encoder({"ok": True, "assessmentId": "a-1", "report": built[0]})
    assert "_cutoffs" in generated["report"]["gradeDistribution"]

    # GET serves the stored item, round-tripped through DynamoDB's Decimals.
    report_svc.table.get_item.return_value = {"Item": _decimalise(stored)}
    old = {k: v for k, v in _undecimalise(stored).items() if k not in ("PK", "SK")}
    served = client.get("/api/assessment/a-1/report").json()
    assert served == jsonable_encoder({"ok": True, "assessmentId": "a-1", "generated": True, "report": old})
    assert generated["report"] == served["report"]


def test_flagged_and_agreement_items_are_unchanged():
    agg = _aggregator()
    svc = MagicMock()
    svc.get_flagged_evaluations.side_effect = agg.get_flagged_evaluations
    svc.get_score_agreement.side_effect = agg.compute_score_agreement
    client, _ = _client(svc=svc)

    flagged = client.get("/api/assessment/a-1/flagged-evaluations").json()
    assert flagged == jsonable_encoder({"ok": True, **agg.get_flagged_evaluations("a-1")})
    assert flagged["flaggedCount"] == 2

    agreement = client.get("/api/assessment/a-1/score-agreement").json()
    assert agreement == jsonable_encoder({"ok": True, **agg.compute_score_agreement("a-1")})
    assert agreement["dualScoredCount"] == 2


def test_progress_and_results_summaries_are_unchanged():
    svc = MagicMock()
    svc.get_assessment_progress.return_value = [
        {"studentId": "z5000001", "name": "Student One", "email": "s1@example.edu", "status": "completed",
         "totalQuestions": 3, "answeredQuestions": 3, "percentage": 100.0},
        {"studentId": "z5000002", "name": "Student Two", "email": "", "status": "not-started",
         "totalQuestions": 3, "answeredQuestions": 0, "percentage": 0.0},
    ]
    svc.get_assessment_results.return_value = [
        {"studentId": "z5000001", "name": "Student One", "email": "s1@example.edu", "totalScore": 25,
         "maxScore": 30, "percentage": 83.33, "grade": "Competent"},
        {"studentId": "z5000002", "name": "Student Two", "email": "", "totalScore": 0,
         "maxScore": 30, "percentage": 0, "grade": "Not Evaluated"},
    ]
    client, _ = _client(svc=svc)

    progress = client.get("/api/assessment/a-1/progress").json()
    assert progress["summary"] == {"total": 2, "notStarted": 1, "inProgress": 0, "completed": 1}

    results = client.get("/api/assessment/a-1/results").json()
    assert results["summary"] == {
        "averageScore": round((83.33 + 0) / 2, 2),
        "gradeDistribution": {"Competent": 1, "Not Evaluated": 1},
    }
    empty_svc = MagicMock()
    empty_svc.get_assessment_results.return_value = []
    empty, _ = _client(svc=empty_svc)
    assert empty.get("/api/assessment/a-1/results").json()["summary"] == {"averageScore": 0, "gradeDistribution": {}}


def test_invite_routes_are_unchanged():
    auth = MagicMock()
    auth.generate_student_invite_token.side_effect = lambda sid, aid: f"tok-{sid}"
    client, svc = _client(deps={get_auth_service: auth})

    resend = client.post("/api/assessment/a-1/students/z5000002/invite", json={"subject": "Hi {{name}}"}).json()
    assert resend == {
        "ok": True,
        "studentId": "z5000002",
        "assessmentId": "a-1",
        "inviteToken": "tok-z5000002",
        "inviteLink": "http://localhost:5176/invite?token=tok-z5000002",
        "emailSent": False,
    }
    # No body at all still works, as it did under Body(default={}).
    assert client.post("/api/assessment/a-1/students/z5000001/invite").json()["emailSent"] is True

    bulk = client.post("/api/assessment/a-1/send-invites", json={"message": "Go", "next": "results"}).json()
    assert bulk == {"ok": True, "assessmentId": "a-1", "sent": 1, "skipped": 1, "total": 2}
    assert auth.send_student_invite_email.call_args.kwargs["invite_link"].endswith("&next=results")
    assert client.post("/api/assessment/a-1/send-invites").json()["total"] == 2


def test_upload_and_ed_import_are_unchanged():
    client, svc = _client()
    uploaded = client.post(
        "/api/assessment/a-1/upload-students",
        json={"students": [{"name": "A", "email": "a@example.edu", "studentId": "z1", "code": "print(1)"}]},
    )
    assert uploaded.status_code == 201
    assert uploaded.json() == {"ok": True, "assessmentId": "a-1", "studentsUploaded": 1}

    ed_students = [
        {"name": "Student One", "email": "s1@example.edu", "studentId": "z5000001", "code": "x = 1", "assignmentFile": "a.py"},
        {"name": None, "email": "", "studentId": "12345", "code": "", "assignmentFile": ""},  # Ed sent name: null
    ]
    with patch("src.main.service.EdStemService.EdStemService") as ed:
        ed.return_value.import_challenge.return_value = ed_students
        imported = client.post("/api/assessment/a-1/import-ed", json={"edToken": "t", "challengeId": 42})
        missing = client.post("/api/assessment/a-1/import-ed", json={"edToken": "t"})
    assert ed.return_value.import_challenge.call_args.args == (42,)
    assert imported.json() == {
        "ok": True,
        "studentsImported": 2,
        "students": [
            {"studentId": "z5000001", "name": "Student One", "hasCode": True},
            {"studentId": "12345", "name": None, "hasCode": False},
        ],
    }
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "missing_fields"


def test_user_admin_routes_are_unchanged():
    table = MagicMock()
    table.scan.side_effect = [
        {"Items": [{"email": "b@example.edu", "roles": ["instructor"], "created_at": "2026-03-01T00:00:00+00:00"}],
         "LastEvaluatedKey": {"email": "b@example.edu"}},
        {"Items": [{"email": "a@example.edu"}]},
    ]
    auth = MagicMock()
    auth.list_users.side_effect = lambda: AuthService.list_users(SimpleNamespace(auth_users_table=table))
    auth.set_user_roles.return_value = ["instructor"]
    client, _ = _client(deps={get_auth_service: auth})

    assert client.get("/api/auth/users").json() == {
        "ok": True,
        "users": [
            {"email": "a@example.edu", "roles": [], "createdAt": ""},
            {"email": "b@example.edu", "roles": ["instructor"], "createdAt": "2026-03-01T00:00:00+00:00"},
        ],
    }
    roles = client.put("/api/auth/users/a@example.edu/roles", json={"roles": ["Instructor", "bogus"]}).json()
    assert roles == {"ok": True, "email": "a@example.edu", "roles": ["instructor"]}
    assert client.post("/api/auth/logout").json() == {"ok": True}


def test_history_deletes_and_upload_url_are_unchanged():
    store = MagicMock()
    store.get_workspace.return_value = {"workspace_id": "ws-1", "user_id": "user-1"}
    store.get_view_session.return_value = {"workspace_id": "ws-1"}
    store.get_program.return_value = {"workspace_id": "ws-1"}
    store.get_code_memory.return_value = {"workspace_id": "ws-1"}
    store.get_thread.return_value = {"code_memory_id": "cm-1"}
    s3 = MagicMock()
    s3.generate_upload_url.return_value = {"uploadUrl": "https://s3/put?sig", "fileUrl": "https://s3/key"}
    client, _ = _client(deps={get_history_store: store, get_s3_upload_service: s3})

    assert client.delete("/internal/history/views/v-1").json() == {"ok": True, "view_session_id": "v-1"}
    assert client.delete("/internal/history/programs/p-1").json() == {"ok": True, "program_id": "p-1"}
    assert client.delete("/internal/history/threads/t-1").json() == {"ok": True, "thread_id": "t-1"}
    assert client.post("/api/s3/upload-url?kind=audio&question_id=q1").json() == s3.generate_upload_url.return_value
