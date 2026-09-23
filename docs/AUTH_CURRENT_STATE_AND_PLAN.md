# Auth: Current State and Plan

## Current State

### Backend

- Authentication dependency: `require_auth_principal` (`src/main/auth/dependencies.py`), backed by `AuthService.resolve_principal()`.
- Login/signup endpoints:
  - `POST /api/auth/login`
  - `POST /api/auth/signup`
- Principal model (`AuthPrincipal`) includes `user_id`, `email`, `roles`, `source`, `assessment_id`.
- Protected routers use principal-based authorization checks (`controller_helpers.py`: `_assert_instructor_access`, `_assert_student_access`, `_assert_assessment_owner`).

### X-User-Id is not an identity source

Routers still accept an `X-User-Id` header parameter (for backward-compatible request shapes), but `AuthService.resolve_principal()` ignores its value entirely — comment in `src/main/auth/service.py`: "an unsigned header is never an identity." A request without a valid `Authorization: Bearer <jwt>` gets a 401 regardless of what `X-User-Id` says. There is no remaining authorization bypass keyed off it.

The four `/internal/context/*` routes (`InternalEndpoints.py`: `upload`, `delete`, `list`, `uploadFile`) now require `Depends(require_auth_principal)`.

### Frontends

- Main frontend (`ai-tutor-frontend`) uses backend-issued JWT and sends `Authorization: Bearer ...`.
- Unauthorized responses (`401/403`) trigger local session clear behavior.
- `oral-assessment-instructor` sends a Bearer token from `localStorage.authToken`.
- `oral-assessment-student` uses a session JWT obtained by exchanging an invite token via `POST /api/auth/student/exchange`, stored in `sessionStorage`.

### Error Semantics

Central HTTP/status mapping is implemented in `api_errors.py`:

- `401/403` -> `auth_error`
- `404` -> `not_found`
- `400/422` -> `validation_error`
- `502/503/504` -> `dependency_failure`

## Required Auth Environment Variables

- `AUTH_JWT_SECRET`
- `AUTH_JWT_ALGORITHM` (default `HS256`)
- `AUTH_ACCESS_TOKEN_MINUTES`

Optional local credential bootstrap:

- `AUTH_LOGIN_EMAIL`
- `AUTH_LOGIN_PASSWORD`
- `AUTH_LOGIN_USER_ID`
- `AUTH_LOGIN_ROLES`
- `AUTH_USERS_JSON`

Optional persisted auth users:

- `AUTH_PERSIST_USERS`
- `DYNAMODB_AUTH_USERS_TABLE`

## Maintenance Checklist

When adding/changing protected endpoints:

1. Require `AuthPrincipal` dependency (`Depends(require_auth_principal)`), or the narrower `require_user_id` / `require_role(...)`.
2. Enforce role/ownership checks server-side — do not trust IDs in the URL path alone.
3. Return typed `ApiError` codes for expected failures.
4. Add route-level tests for:
   - unauthorized (401/403)
   - forbidden ownership/role cases
   - success path
5. `tests/controllers/test_route_auth.py` enforces that every route either has an auth dependency or is listed in that file's `PUBLIC_ROUTES` allowlist with a reason. A new unauthenticated route without an allowlist entry fails CI.

## Remaining Hardening

- Tighten CORS defaults per environment (currently permissive by default; see `ALLOW_ORIGINS`).
- Add explicit auth audit logging and rate-limiting policy for sensitive routes.
