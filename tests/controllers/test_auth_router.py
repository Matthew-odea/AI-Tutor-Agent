"""
TestClient tests for auth_router endpoints.

Covers: login, signup, refresh, logout, student invite exchange,
forgot-password, reset-password validate, reset-password.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import get_auth_service, require_auth_principal
from src.main.auth.models import AuthPrincipal


def _mock_auth_service():
    svc = MagicMock()
    # Default: successful auth returns a principal
    _principal = AuthPrincipal(user_id="u-1", email="u@test.com", roles=["student"], source="password")
    svc.authenticate_credentials.return_value = _principal
    svc.register_user.return_value = _principal
    svc.issue_access_token.return_value = {
        "access_token": "tok", "token_type": "bearer",
        "expires_in": 3600, "user_id": "u-1", "email": "u@test.com", "roles": ["student"],
    }
    svc.issue_refresh_token.return_value = "refresh-tok"
    svc.exchange_refresh_token.return_value = {
        "access_token": "new-tok", "token_type": "bearer",
        "expires_in": 3600, "user_id": "u-1", "email": "u@test.com", "roles": ["student"],
    }
    svc.exchange_student_invite_token.return_value = {
        "access_token": "student-tok", "token_type": "bearer",
        "expires_in": 43200, "student_id": "s-1", "assessment_id": "a-1",
    }
    svc.request_password_reset.return_value = "If an account exists, a reset link has been sent."
    svc.validate_password_reset_token.return_value = True
    svc.reset_password.return_value = "Password has been reset successfully."
    return svc


def _client(auth_svc=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_auth_service] = lambda: auth_svc or _mock_auth_service()
    return TestClient(app)


class TestLogin:
    def test_login_success(self):
        client = _client()
        resp = client.post("/api/auth/login", json={"email": "u@test.com", "password": "pass"})
        assert resp.status_code == 200
        assert resp.json()["access_token"] == "tok"
        assert "refresh_token" in resp.cookies

    def test_login_bad_credentials(self):
        svc = _mock_auth_service()
        svc.authenticate_credentials.side_effect = HTTPException(status_code=401, detail="Invalid email or password")
        client = _client(svc)
        resp = client.post("/api/auth/login", json={"email": "u@test.com", "password": "wrong"})
        assert resp.status_code == 401


class TestSignup:
    def test_signup_success(self):
        client = _client()
        resp = client.post("/api/auth/signup", json={"email": "new@test.com", "password": "secure123"})
        assert resp.status_code == 201
        assert resp.json()["access_token"] == "tok"

    def test_signup_duplicate(self):
        svc = _mock_auth_service()
        svc.register_user.side_effect = HTTPException(status_code=409, detail="Email already exists")
        client = _client(svc)
        resp = client.post("/api/auth/signup", json={"email": "dup@test.com", "password": "secure123"})
        assert resp.status_code == 409


class TestRefresh:
    def test_refresh_with_cookie(self):
        svc = _mock_auth_service()
        client = _client(svc)
        # First login to get the refresh cookie set by the server
        login_resp = client.post("/api/auth/login", json={"email": "u@test.com", "password": "pass"})
        assert login_resp.status_code == 200
        # The refresh cookie should now be set; use it
        resp = client.post("/api/auth/refresh")
        assert resp.status_code == 200
        assert resp.json()["access_token"] == "new-tok"

    def test_refresh_without_cookie(self):
        client = _client()
        resp = client.post("/api/auth/refresh")
        assert resp.status_code == 401


class TestLogout:
    def test_logout_clears_cookie(self):
        client = _client()
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


class TestStudentInviteExchange:
    def test_exchange_success(self):
        client = _client()
        # invite_token needs min_length=20
        resp = client.post("/api/auth/student/exchange", json={"invite_token": "a" * 30})
        assert resp.status_code == 200
        assert resp.json()["student_id"] == "s-1"


class TestForgotPassword:
    def test_forgot_password(self):
        client = _client()
        resp = client.post("/api/auth/forgot-password", json={"email": "u@test.com"})
        assert resp.status_code == 200
        assert "reset link" in resp.json()["message"].lower()


class TestResetPassword:
    def test_validate_token(self):
        client = _client()
        # token needs min_length=20
        resp = client.post("/api/auth/reset-password/validate", json={"token": "t" * 25})
        assert resp.status_code == 200
        assert resp.json()["valid"] is True

    def test_reset_password(self):
        client = _client()
        # token min_length=20, new_password min_length=8
        resp = client.post("/api/auth/reset-password", json={"token": "t" * 25, "new_password": "newpass123"})
        assert resp.status_code == 200
        assert "reset successfully" in resp.json()["message"].lower()


class TestSetUserRoles:
    """Role assignment is admin-only — an instructor must not be able to self-promote."""

    def _client_as(self, roles):
        svc = _mock_auth_service()
        app = create_app()
        app.dependency_overrides[get_auth_service] = lambda: svc
        app.dependency_overrides[require_auth_principal] = lambda: AuthPrincipal(
            user_id="u-1", email="u@test.com", roles=roles, source="jwt"
        )
        return TestClient(app), svc

    def test_instructor_cannot_grant_admin(self):
        client, svc = self._client_as(["instructor"])
        resp = client.put("/api/auth/users/u@test.com/roles", json={"roles": ["instructor", "admin"]})
        assert resp.status_code == 403
        svc.set_user_roles.assert_not_called()

    def test_admin_can_set_roles(self):
        client, svc = self._client_as(["admin"])
        resp = client.put("/api/auth/users/other@test.com/roles", json={"roles": ["instructor"]})
        assert resp.status_code == 200
        svc.set_user_roles.assert_called_once_with("other@test.com", ["instructor"])
