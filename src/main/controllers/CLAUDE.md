# src/main/controllers/

Routers are thin: parse the request, call a service, return its result. Business logic belongs in `src/main/service/`, not here.

## Auth is required, not optional

Every route needs an auth dependency: `Depends(require_auth_principal)`, `Depends(require_user_id)`, or `Depends(require_role("instructor"))` (all in `src/main/auth/dependencies.py`). If a route genuinely has no user data to protect (a liveness probe, a token-issuing endpoint where the token *is* the credential), it still needs an entry in `tests/controllers/test_route_auth.py`'s `PUBLIC_ROUTES` allowlist, with a one-line reason. That test walks every route's dependency tree at import time and fails if a route is neither protected nor allowlisted — it does not call the route, so it holds regardless of request shape.

Don't authorize off the `X-User-Id` header — it's accepted in some request signatures for backward compatibility, but `AuthService.resolve_principal()` ignores its value entirely and requires a valid `Authorization: Bearer <jwt>`.

## Don't write your own try/except ladder

`api_errors.py` registers global exception handlers for `ApiError`, `RequestValidationError`, `HTTPException`, and bare `Exception`. Every response — success or failure — already comes back as:

```json
{"ok": false, "error": {"code": "auth_error | not_found | validation_error | dependency_failure | internal_error", "message": "..."}}
```

Raise `ApiError(status_code=..., code=..., message=...)` or a plain `HTTPException` and let it propagate. A per-route `try/except` that reformats the same envelope is redundant code, not extra safety.

## Services come from `controller_dependencies.py`, not from `__init__`

Every service is a `@lru_cache(maxsize=1)`-wrapped singleton provider (`get_chat_service()`, `get_oral_assessment_service()`, etc.) in `controller_dependencies.py`. Inject them with `Depends(get_xyz_service)`. If you add a new service, add its singleton provider there rather than constructing it inline in the router — the DI container is the one place that wires a service's dependencies (settings, other services) together.
