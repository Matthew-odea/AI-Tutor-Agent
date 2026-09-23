# src/main/controllers/

Routers are thin: parse the request, call a service, return its result. Business logic belongs in `src/main/service/`, not here.

## Auth is required, not optional

Every route needs an auth dependency: `Depends(require_auth_principal)`, `Depends(require_user_id)`, or `Depends(require_role("instructor"))` (all in `src/main/auth/dependencies.py`). If a route genuinely has no user data to protect (a liveness probe, a token-issuing endpoint where the token *is* the credential), it still needs an entry in `tests/controllers/test_route_auth.py`'s `PUBLIC_ROUTES` allowlist, with a one-line reason. That test walks every route's dependency tree at import time and fails if a route is neither protected nor allowlisted — it does not call the route, so it holds regardless of request shape.

Don't authorize off the `X-User-Id` header — it's accepted in some request signatures for backward compatibility, but `AuthService.resolve_principal()` ignores its value entirely and requires a valid `Authorization: Bearer <jwt>`.

## Authenticated is not authorized

A route that names a tenant's thing — an assessment, student, question, job, S3 key, workspace — must also check the caller may touch *that* one. `tests/controllers/test_route_ownership.py` is the gate: it finds every route with an id in its path, query or body, calls it across the tenant line with real tokens on moto, and fails if the call is not refused (or the route is not in its `NOT_TENANT_SCOPED` allowlist with a reason). Where the checks live:

- `/api/assessment/{id}/...` — `_require_owned_assessment`, a router-wide dependency in `assessment_router.py`. It covers every route under `{id}`, including new ones: owner or admin only, a `{jobId}` must belong to that assessment, and a missing assessment and someone else's return the same 404 so ids can't be probed.
- `/api/student/{student_id}/...` — `_assert_student_access`: only the invite-exchanged session token for exactly that student and assessment (or an admin). Instructors don't use these routes; a login token whose subject equals a student id is not a student session.
- Media URLs a student sends back (`audio_url`, `video_url`, `chunk_url`) must sit under that student's own upload prefix — `assert_owned_upload` in `S3UploadService.py` — because they are later presigned for download by key.

Take identity from the verified `AuthPrincipal`, never from an id in the body.

## Don't write your own try/except ladder

`api_errors.py` registers global exception handlers for `ApiError`, `RequestValidationError`, `HTTPException`, and bare `Exception`. Every response — success or failure — already comes back as:

```json
{"ok": false, "error": {"code": "auth_error | not_found | validation_error | dependency_failure | internal_error", "message": "..."}}
```

Raise `ApiError(status_code=..., code=..., message=...)` or a plain `HTTPException` and let it propagate. A per-route `try/except` that reformats the same envelope is redundant code, not extra safety.

`tests/controllers/test_error_envelope.py` is the gate for this: it sweeps every route's failure response, and a route that hand-builds a response instead of returning data has to be listed in that file's `NON_JSON_RESPONSE_ROUTES` with a reason. Streams, HTML and PDFs are the only ones there.

## Services come from `controller_dependencies.py`, not from `__init__`

Every service is a `@lru_cache(maxsize=1)`-wrapped singleton provider (`get_chat_service()`, `get_oral_assessment_service()`, etc.) in `controller_dependencies.py`. Inject them with `Depends(get_xyz_service)`. If you add a new service, add its singleton provider there rather than constructing it inline in the router — the DI container is the one place that wires a service's dependencies (settings, other services) together.
