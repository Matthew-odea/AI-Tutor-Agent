"""
Every route must require authentication unless it is listed in PUBLIC_ROUTES.

This repo has no code review — changes merge directly. This test is the gate that
stops an unauthenticated endpoint reaching production: adding one requires a
one-line diff to the allowlist below, with a reason, which is greppable and
obvious in a diff.

It walks each route's dependency tree rather than calling the route, so it holds
regardless of request shape.
"""
from __future__ import annotations

import os

import pytest
from fastapi.routing import APIRoute


@pytest.fixture(scope="module")
def app():
    # create_app() reads settings at call time; give it inert values so the test
    # never depends on a developer's local .env.
    for key, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_DEFAULT_REGION": "us-east-1",
        "AUTH_JWT_SECRET": "x" * 32,
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_PASSWORD": "testing",
    }.items():
        os.environ.setdefault(key, value)

    from app import create_app

    return create_app()


# Dependencies that establish an authenticated principal. A route is considered
# protected if any of these appears anywhere in its dependency tree.
#
# Adding to this set widens what counts as "authenticated" for every route at
# once — only add a dependency that actually rejects an unauthenticated caller.
def _auth_dependencies():
    from src.main.auth.dependencies import require_auth_principal, require_user_id
    from src.main.controllers.controller_helpers import _require_user_id

    return {require_auth_principal, require_user_id, _require_user_id}


# (METHOD, path) pairs reachable without credentials, each with the reason it
# has to be. Anything not listed here must require auth.
PUBLIC_ROUTES = {
    ("GET", "/health"): "liveness probe, returns no user data",
    # Credential exchange — these are how a caller obtains a token, so they
    # cannot themselves require one. They are the application's trust boundary.
    ("POST", "/api/auth/login"): "issues tokens from username and password",
    ("POST", "/api/auth/signup"): "account creation",
    ("POST", "/api/auth/google"): "OAuth code exchange",
    ("POST", "/api/auth/refresh"): "refresh token is the credential",
    ("POST", "/api/auth/logout"): "clears client state, nothing to protect",
    ("POST", "/api/auth/forgot-password"): "reset token is emailed, not returned",
    ("POST", "/api/auth/reset-password"): "reset token in body is the credential",
    ("POST", "/api/auth/reset-password/validate"): "checks a reset token's validity",
    ("POST", "/api/auth/student/exchange"): "invite token in body is the credential",
}


def _api_routes(app):
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            yield method, route.path, route


def _dependency_calls(dependant):
    yield dependant.call
    for sub in dependant.dependencies:
        yield from _dependency_calls(sub)


def test_every_route_requires_auth_or_is_explicitly_public(app):
    auth_deps = _auth_dependencies()
    unprotected = [
        f"{method} {path}"
        for method, path, route in _api_routes(app)
        if (method, path) not in PUBLIC_ROUTES
        and not any(call in auth_deps for call in _dependency_calls(route.dependant))
    ]
    assert not unprotected, (
        "These routes are reachable without authentication:\n  "
        + "\n  ".join(sorted(unprotected))
        + "\n\nAdd an auth dependency, or add the route to PUBLIC_ROUTES with a reason."
    )


def test_public_route_allowlist_has_no_stale_entries(app):
    """A deleted route must not leave its exemption behind for a future route to inherit."""
    live = {(method, path) for method, path, _ in _api_routes(app)}
    stale = [f"{method} {path}" for method, path in PUBLIC_ROUTES if (method, path) not in live]
    assert not stale, "PUBLIC_ROUTES lists routes that no longer exist:\n  " + "\n  ".join(sorted(stale))
