from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Body, Cookie, Depends, Response

from src.main.auth.dependencies import get_auth_service, require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.auth.service import AuthService
from src.main.controllers.api_errors import ApiError
from src.main.dtos.AuthDTOs import (
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    GoogleLoginRequest,
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    RefreshTokenResponse,
    ResetPasswordRequest,
    ResetPasswordValidateRequest,
    ResetPasswordValidateResponse,
    SetUserRolesRequest,
    SetUserRolesResponse,
    SignupRequest,
    StudentInviteExchangeRequest,
    StudentInviteExchangeResponse,
    UserListResponse,
)

_REFRESH_COOKIE = "refresh_token"
_REFRESH_MAX_AGE = 7 * 24 * 3600  # 7 days in seconds
# Use secure=True in production (HTTPS). Controlled by env so local dev works over HTTP.
_COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=token,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
        max_age=_REFRESH_MAX_AGE,
        path="/api/auth",
    )


auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


@auth_router.post("/login", response_model=LoginResponse)
def login_with_email_password(
    request: LoginRequest = Body(...),
    response: Response = None,
    auth_service: AuthService = Depends(get_auth_service),
):
    principal = auth_service.authenticate_credentials(request.email, request.password)
    token_payload = auth_service.issue_access_token(principal)
    _set_refresh_cookie(response, auth_service.issue_refresh_token(principal))
    return LoginResponse(**token_payload)


@auth_router.post("/signup", response_model=LoginResponse, status_code=201)
def signup_with_email_password(
    request: SignupRequest = Body(...),
    response: Response = None,
    auth_service: AuthService = Depends(get_auth_service),
):
    principal = auth_service.register_user(request.email, request.password)
    token_payload = auth_service.issue_access_token(principal)
    _set_refresh_cookie(response, auth_service.issue_refresh_token(principal))
    return LoginResponse(**token_payload)


@auth_router.post("/google", response_model=LoginResponse)
def login_with_google(
    request: GoogleLoginRequest = Body(...),
    response: Response = None,
    auth_service: AuthService = Depends(get_auth_service),
):
    principal = auth_service.authenticate_google_id_token(request.id_token)
    token_payload = auth_service.issue_access_token(principal)
    _set_refresh_cookie(response, auth_service.issue_refresh_token(principal))
    return LoginResponse(**token_payload)


@auth_router.post("/refresh", response_model=RefreshTokenResponse)
def refresh_access_token(
    refresh_token: Optional[str] = Cookie(None, alias=_REFRESH_COOKIE),
    auth_service: AuthService = Depends(get_auth_service),
):
    """Exchange the HTTP-only refresh cookie for a new access token."""
    if not refresh_token:
        raise ApiError(status_code=401, code="no_refresh_token", message="No refresh token cookie present")
    token_payload = auth_service.exchange_refresh_token(refresh_token)
    return RefreshTokenResponse(**token_payload)


@auth_router.post("/logout", response_model=LogoutResponse)
def logout(response: Response):
    """Clear the refresh token cookie."""
    response.delete_cookie(key=_REFRESH_COOKIE, path="/api/auth")
    return {"ok": True}


@auth_router.post("/student/exchange", response_model=StudentInviteExchangeResponse)
def exchange_student_invite(
    request: StudentInviteExchangeRequest = Body(...),
    auth_service: AuthService = Depends(get_auth_service),
):
    """
    Exchange a single-use student invite token for a 12-hour session JWT.
    The invite token is invalidated after use (jti marked used in DynamoDB).
    """
    result = auth_service.exchange_student_invite_token(request.invite_token)
    return StudentInviteExchangeResponse(**result)


@auth_router.post("/forgot-password", response_model=ForgotPasswordResponse)
def forgot_password(
    request: ForgotPasswordRequest = Body(...),
    auth_service: AuthService = Depends(get_auth_service),
):
    message = auth_service.request_password_reset(request.email)
    return ForgotPasswordResponse(message=message)


@auth_router.post("/reset-password/validate", response_model=ResetPasswordValidateResponse)
def validate_reset_password_token(
    request: ResetPasswordValidateRequest = Body(...),
    auth_service: AuthService = Depends(get_auth_service),
):
    is_valid = auth_service.validate_password_reset_token(request.token)
    return ResetPasswordValidateResponse(valid=is_valid)


@auth_router.post("/reset-password", response_model=ForgotPasswordResponse)
def reset_password(
    request: ResetPasswordRequest = Body(...),
    auth_service: AuthService = Depends(get_auth_service),
):
    message = auth_service.reset_password(request.token, request.new_password)
    return ForgotPasswordResponse(message=message)


@auth_router.get("/users", response_model=UserListResponse)
def list_users(
    auth_service: AuthService = Depends(get_auth_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """List all registered users with their roles. Instructor-only."""
    if "instructor" not in _principal.roles and "admin" not in _principal.roles:
        raise ApiError(status_code=403, code="forbidden", message="Instructor access required")
    return {"ok": True, "users": auth_service.list_users()}


@auth_router.put("/users/{email}/roles", response_model=SetUserRolesResponse)
def set_user_roles(
    email: str,
    request: SetUserRolesRequest = Body(...),
    auth_service: AuthService = Depends(get_auth_service),
    _principal: AuthPrincipal = Depends(require_auth_principal),
):
    """Set roles for a user. Admin-only — an instructor cannot grant themselves admin."""
    if "admin" not in _principal.roles:
        raise ApiError(status_code=403, code="forbidden", message="Admin access required")
    roles = request.roles
    auth_service.set_user_roles(email, roles)
    return {"ok": True, "email": email, "roles": roles}
