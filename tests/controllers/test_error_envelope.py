"""
Every failure must come back in the global error envelope.

`api_errors.py` promises that a failed request answers with

    {"ok": false, "error": {"code": "...", "message": "..."}}

and every frontend error handler in this repo reads `error.code` / `error.message`.
A route that raises its own shape, hand-builds a JSONResponse, or swallows a
failure into a 200 breaks those handlers silently — nothing in the app crashes,
the user just sees a blank or wrong error. This repo has no code review, so this
test is the gate: it sweeps every route and asserts the envelope on the failure
paths a frontend actually meets.

Same shape as `test_route_auth.py`: the sweep covers everything, and anything
deliberately outside the contract is named in an allowlist with a reason.
"""
from __future__ import annotations

import inspect
import os
import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def app():
    # create_app() reads settings at call time; give it inert values so the test
    # never depends on a developer's local .env, and never reaches AWS.
    for key, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_DEFAULT_REGION": "us-east-1",
        "AUTH_JWT_SECRET": "x" * 32,
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_PASSWORD": "testing",
        # Without this the SQS dispatcher singleton calls GetQueueUrl while
        # resolving dependencies, so the sweep would need the network.
        "SQS_JOBS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/000000000000/test-jobs",
    }.items():
        os.environ.setdefault(key, value)

    from app import create_app

    return create_app()


@pytest.fixture(scope="module")
def client(app):
    # raise_server_exceptions=False so an unhandled exception produces the 500
    # response a real client would get, instead of re-raising into the test.
    # Not used as a context manager: that would run the lifespan, which starts
    # the SQS consumer.
    return TestClient(app, raise_server_exceptions=False)


# Routes that answer with something other than a JSON body — a server-sent-event
# stream, HTML, or a PDF. Once the response has started they cannot switch to the
# envelope, so their in-band failures use their own format. Each still answers
# pre-stream failures (auth, ownership, not-found) with the envelope, which the
# sweep below checks like any other route.
#
# Adding a route here means its error path is invisible to every frontend error
# handler — say why, and make sure the frontend that consumes it knows.
NON_JSON_RESPONSE_ROUTES = {
    ("GET", "/api/assessment/{id}/students/{studentId}/evaluation-progress"):
        "SSE progress stream; mid-stream errors are data: frames, not the envelope",
    ("GET", "/api/assessment/{id}/evaluation-status-stream/{jobId}"):
        "SSE job stream; emits `event: error` frames once streaming has begun",
    ("GET", "/api/assessment/{id}/report.html"):
        "renders the instructor report as HTML for printing",
    ("GET", "/api/assessment/{id}/report.pdf"):
        "returns application/pdf bytes",
    ("GET", "/api/student/{student_id}/assessment/{assessment_id}/results/pdf"):
        "returns application/pdf bytes",
}

# Routes that answer 2xx to the sweep because they have nothing to fail at:
# no credentials to check and no body to validate. Listing one here removes it
# from the envelope check entirely, so it must genuinely have no failure path.
NO_FAILURE_RESPONSE = {
    ("GET", "/health"):
        "liveness probe: a broken SQS consumer reports sqsConsumer=unknown, never 500",
    ("POST", "/api/auth/logout"):
        "deletes the refresh cookie; nothing to authenticate and nothing to validate",
}

# Requests the sweep cannot make meaningfully: the body is multipart, so an empty
# JSON body tells us nothing the other routes don't already.
SWEEP_SKIP = {
    ("POST", "/internal/context/uploadFile"): "multipart upload, no JSON body to send",
}


def _api_routes(app):
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            yield method, route.path, route


def _assert_envelope(body, where: str):
    assert isinstance(body, dict), f"{where}: failure body is not a JSON object: {body!r}"
    assert body.get("ok") is False, f"{where}: failure body has no `ok: false`: {body!r}"
    error = body.get("error")
    assert isinstance(error, dict), f"{where}: failure body has no `error` object: {body!r}"
    assert isinstance(error.get("code"), str) and error["code"], f"{where}: `error.code` missing: {body!r}"
    assert isinstance(error.get("message"), str), f"{where}: `error.message` missing: {body!r}"


def test_every_route_answers_failures_in_the_envelope(client, app):
    """Sweep every route with no credentials and a body that does not validate.

    This is the failure every frontend meets most often — an expired token — plus
    a validation failure on the routes that are public by design. Both must come
    back in the envelope.
    """
    statuses = []
    for method, path, _route in _api_routes(app):
        if (method, path) in SWEEP_SKIP:
            continue
        url = re.sub(r"\{[^}]+\}", "envelope-probe", path)
        response = client.request(method, url, json={})
        statuses.append(response.status_code)
        if response.status_code < 400:
            assert (method, path) in NO_FAILURE_RESPONSE, (
                f"{method} {path} answered {response.status_code} to an unauthenticated, "
                "unvalidatable request. Either it is not failing when it should, or it "
                f"swallowed the failure. Add it to NO_FAILURE_RESPONSE with a reason if "
                "it genuinely has no failure path."
            )
            continue
        _assert_envelope(response.json(), f"{method} {path}")

    # Guard against a vacuous pass: if a refactor made every route answer 200,
    # the loop above would assert nothing about the envelope.
    assert 401 in statuses, "sweep saw no 401 — it is no longer exercising the auth failure path"
    assert 422 in statuses, "sweep saw no 422 — it is no longer exercising the validation failure path"


def test_unmatched_path_and_wrong_method_answer_in_the_envelope(client):
    """Starlette raises these itself, not the routers — they still reach the frontend.

    A typo'd URL or a stale method in a frontend call lands here, and used to
    answer `{"detail": "Not Found"}`, which no error handler in this repo reads.
    """
    missing = client.get("/no/such/path")
    assert missing.status_code == 404
    _assert_envelope(missing.json(), "GET /no/such/path")

    wrong_method = client.delete("/health")
    assert wrong_method.status_code == 405
    _assert_envelope(wrong_method.json(), "DELETE /health")


def test_unhandled_exception_answers_in_the_envelope(app, client):
    """A service that blows up in a way no route anticipated still owes the envelope."""
    from src.main.controllers.controller_dependencies import get_history_store
    from src.main.controllers.controller_helpers import _require_user_id

    class _Exploding:
        def __getattr__(self, name):
            def _boom(*args, **kwargs):
                raise RuntimeError("history store is down")
            return _boom

    app.dependency_overrides[_require_user_id] = lambda: "envelope-probe-user"
    app.dependency_overrides[get_history_store] = _Exploding
    try:
        response = client.post("/internal/history/workspaces", json={"title": "t"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 500
    _assert_envelope(response.json(), "POST /internal/history/workspaces (service raised)")


# A router that builds a response object itself is the one way to bypass the
# handlers in api_errors.py entirely. Catching it by source is crude, but it is
# the only thing that sees the paths the HTTP sweep cannot drive without AWS.
_BUILDS_RESPONSE = re.compile(
    r"StreamingResponse|HTMLResponse|PlainTextResponse|FileResponse|JSONResponse|[^:\w]Response\("
)


def test_routes_that_build_their_own_response_are_allowlisted(app):
    """Every hand-built response is either a known non-JSON route or a new violation."""
    unlisted = []
    for method, path, route in _api_routes(app):
        if (method, path) in NON_JSON_RESPONSE_ROUTES:
            continue
        try:
            source = inspect.getsource(route.endpoint)
        except OSError:  # pragma: no cover - source always available in this repo
            continue
        if _BUILDS_RESPONSE.search(source):
            unlisted.append(f"{method} {path}")

    assert not unlisted, (
        "These routes build a response object instead of returning data and letting "
        "api_errors.py shape failures:\n  "
        + "\n  ".join(sorted(unlisted))
        + "\n\nReturn a DTO and raise ApiError on failure, or — if the route genuinely "
        "answers with a stream, HTML or a binary — add it to NON_JSON_RESPONSE_ROUTES "
        "with a reason."
    )


def test_allowlists_have_no_stale_entries(app):
    """A deleted route must not leave its exemption behind for a future route to inherit."""
    live = {(method, path) for method, path, _ in _api_routes(app)}
    stale = [
        f"{method} {path}"
        for allowlist in (NON_JSON_RESPONSE_ROUTES, NO_FAILURE_RESPONSE, SWEEP_SKIP)
        for method, path in allowlist
        if (method, path) not in live
    ]
    assert not stale, "These allowlists name routes that no longer exist:\n  " + "\n  ".join(sorted(stale))
