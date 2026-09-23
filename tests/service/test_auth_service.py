"""Tests for AuthService."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import jwt as pyjwt
import pytest
from fastapi import HTTPException

from src.main.auth.models import AuthPrincipal
from src.main.auth.service import AuthService


def _build_service(monkeypatch, **overrides) -> AuthService:
    """Create an AuthService with sensible test defaults (no real AWS calls)."""
    monkeypatch.setenv("AUTH_JWT_SECRET", overrides.get("jwt_secret", "test-secret-key"))
    monkeypatch.setenv("AUTH_JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_MINUTES", "60")
    monkeypatch.setenv("AUTH_SIGNUP_DEFAULT_ROLES", "student")
    monkeypatch.setenv("AUTH_USERS_JSON", overrides.get("users_json", "[]"))
    monkeypatch.setenv("AUTH_PASSWORD_RESET_BASE_URL", "http://localhost:5173/?reset=1")
    monkeypatch.setenv("AUTH_PASSWORD_RESET_FROM_EMAIL", "noreply@test.com")

    ses_mock = MagicMock()
    monkeypatch.setattr("src.main.auth.service.boto3.client", lambda *a, **kw: ses_mock)
    # No DynamoDB here: these tests cover the env-configured user path, and this
    # also keeps the constructor from reaching for a real table.
    monkeypatch.setattr(
        "src.main.auth.service.boto3.resource",
        MagicMock(side_effect=RuntimeError("no DynamoDB in this test")),
    )

    svc = AuthService()
    assert svc.auth_users_table is None and svc.persist_users is False
    return svc


class TestRegistration:
    def test_register_returns_principal(self, monkeypatch):
        svc = _build_service(monkeypatch)
        principal = svc.register_user("New@Example.COM", "securepassword123")

        assert isinstance(principal, AuthPrincipal)
        assert principal.email == "new@example.com"
        assert principal.source == "signup"
        assert "student" in principal.roles

    def test_register_rejects_short_password(self, monkeypatch):
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc.register_user("user@example.com", "short")
        assert exc_info.value.status_code == 400

    def test_register_rejects_invalid_email(self, monkeypatch):
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc.register_user("notanemail", "securepassword123")
        assert exc_info.value.status_code == 400

    def test_register_rejects_duplicate_email(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.register_user("dupe@example.com", "securepassword123")
        with pytest.raises(HTTPException) as exc_info:
            svc.register_user("dupe@example.com", "anotherpassword123")
        assert exc_info.value.status_code == 409


class TestEmailPasswordAuth:
    def test_login_success(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.register_user("alice@example.com", "correctpassword")

        principal = svc.authenticate_credentials("alice@example.com", "correctpassword")
        assert principal.email == "alice@example.com"
        assert principal.source == "password"

    def test_login_wrong_password(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.register_user("bob@example.com", "correctpassword")

        with pytest.raises(HTTPException) as exc_info:
            svc.authenticate_credentials("bob@example.com", "wrongpassword")
        assert exc_info.value.status_code == 401

    def test_login_nonexistent_user(self, monkeypatch):
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc.authenticate_credentials("nobody@example.com", "anything")
        assert exc_info.value.status_code == 401

    def test_login_with_env_configured_user(self, monkeypatch):
        # Env-configured users must carry a PBKDF2 hash, not a plaintext password.
        hashed = _build_service(monkeypatch)._hash_password("admin123")
        users_json = json.dumps([
            {"email": "admin@test.com", "password": hashed, "user_id": "admin-1", "roles": ["instructor"]}
        ])
        svc = _build_service(monkeypatch, users_json=users_json)

        principal = svc.authenticate_credentials("admin@test.com", "admin123")
        assert principal.user_id == "admin-1"
        assert "instructor" in principal.roles

    def test_login_with_plaintext_stored_password_is_refused(self, monkeypatch):
        """A legacy plaintext record fails closed and is pointed at password reset."""
        users_json = '[{"email":"legacy@test.com","password":"admin123","user_id":"legacy-1","roles":["instructor"]}]'
        svc = _build_service(monkeypatch, users_json=users_json)

        with pytest.raises(HTTPException) as exc_info:
            svc.authenticate_credentials("legacy@test.com", "admin123")
        assert exc_info.value.status_code == 401
        assert "reset" in exc_info.value.detail.lower()


class TestPasswordHashing:
    def test_hash_and_verify(self, monkeypatch):
        svc = _build_service(monkeypatch)
        hashed = svc._hash_password("my_secret")

        assert hashed.startswith("pbkdf2_sha256$")
        assert svc._verify_hashed_password("my_secret", hashed) is True
        assert svc._verify_hashed_password("wrong", hashed) is False

    def test_hashed_password_detection(self):
        assert AuthService._is_hashed_password("pbkdf2_sha256$200000$abc$def") is True
        assert AuthService._is_hashed_password("plaintext") is False


class TestAccessTokens:
    def test_issue_and_decode(self, monkeypatch):
        svc = _build_service(monkeypatch)
        principal = AuthPrincipal(user_id="u-1", email="u@test.com", roles=["student"], source="test")

        token_data = svc.issue_access_token(principal)
        assert "access_token" in token_data
        assert token_data["token_type"] == "bearer"
        assert token_data["user_id"] == "u-1"

        payload = svc._decode_jwt(token_data["access_token"])
        assert payload["sub"] == "u-1"
        assert payload["email"] == "u@test.com"
        assert payload["roles"] == ["student"]

    def test_decode_expired_token_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        payload = {
            "sub": "u-1",
            "iat": int(time.time()) - 7200,
            "exp": int(time.time()) - 3600,
        }
        token = pyjwt.encode(payload, "test-secret-key", algorithm="HS256")

        with pytest.raises(HTTPException) as exc_info:
            svc._decode_jwt(token)
        assert exc_info.value.status_code == 401
        assert "expired" in exc_info.value.detail.lower()

    def test_decode_invalid_token_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc._decode_jwt("garbage.token.value")
        assert exc_info.value.status_code == 401

    def test_issue_token_without_secret_raises(self, monkeypatch):
        svc = _build_service(monkeypatch, jwt_secret="")
        principal = AuthPrincipal(user_id="u-1", source="test")
        with pytest.raises(HTTPException) as exc_info:
            svc.issue_access_token(principal)
        assert exc_info.value.status_code == 503


class TestRefreshTokens:
    def test_issue_and_exchange(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.register_user("refresh@test.com", "securepassword")
        principal = AuthPrincipal(user_id="refresh@test.com", email="refresh@test.com", roles=["student"], source="test")

        refresh_token = svc.issue_refresh_token(principal)
        assert isinstance(refresh_token, str)

        new_access = svc.exchange_refresh_token(refresh_token)
        assert "access_token" in new_access
        assert new_access["user_id"] == "refresh@test.com"

    def test_exchange_expired_refresh_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        payload = {
            "sub": "u-1",
            "purpose": "refresh",
            "iat": int(time.time()) - 700000,
            "exp": int(time.time()) - 3600,
        }
        token = pyjwt.encode(payload, "test-secret-key", algorithm="HS256")

        with pytest.raises(HTTPException) as exc_info:
            svc.exchange_refresh_token(token)
        assert exc_info.value.status_code == 401

    def test_exchange_non_refresh_token_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        payload = {
            "sub": "u-1",
            "purpose": "access",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
        }
        token = pyjwt.encode(payload, "test-secret-key", algorithm="HS256")

        with pytest.raises(HTTPException) as exc_info:
            svc.exchange_refresh_token(token)
        assert exc_info.value.status_code == 401


class TestStudentInviteTokens:
    def test_generate_invite_token(self, monkeypatch, mock_dynamodb):
        svc = _build_service(monkeypatch)
        svc._assessment_table_cache = mock_dynamodb

        token = svc.generate_student_invite_token("s-1", "a-1")
        assert isinstance(token, str)

        payload = pyjwt.decode(token, "test-secret-key", algorithms=["HS256"])
        assert payload["student_id"] == "s-1"
        assert payload["assessment_id"] == "a-1"
        assert payload["purpose"] == "student_invite"
        record = mock_dynamodb.get_item(Key={"PK": f"INVITE#{payload['jti']}", "SK": "METADATA"})["Item"]
        assert record["used"] is False

    def test_exchange_invite_token(self, monkeypatch, mock_dynamodb):
        svc = _build_service(monkeypatch)
        svc._assessment_table_cache = mock_dynamodb

        token = svc.generate_student_invite_token("s-1", "a-1")
        result = svc.exchange_student_invite_token(token)

        assert result["student_id"] == "s-1"
        assert result["assessment_id"] == "a-1"
        assert "access_token" in result

    def test_invite_is_reusable_until_revoked(self, monkeypatch, mock_dynamodb):
        # Invites are deliberately reusable until the assessment closes; deleting the jti revokes them.
        svc = _build_service(monkeypatch)
        svc._assessment_table_cache = mock_dynamodb

        token = svc.generate_student_invite_token("s-1", "a-1")
        svc.exchange_student_invite_token(token)
        svc.exchange_student_invite_token(token)

        jti = pyjwt.decode(token, "test-secret-key", algorithms=["HS256"])["jti"]
        mock_dynamodb.delete_item(Key={"PK": f"INVITE#{jti}", "SK": "METADATA"})
        with pytest.raises(HTTPException) as exc_info:
            svc.exchange_student_invite_token(token)
        assert exc_info.value.status_code == 401

    def test_invite_fails_closed_when_table_unreachable(self, monkeypatch):
        """Previously the table was cached as None and every exchange skipped the jti check (replayable)."""
        svc = _build_service(monkeypatch)
        broken = MagicMock()
        broken.Table.return_value.load.side_effect = Exception("network down")
        monkeypatch.setattr("src.main.auth.service.boto3.resource", lambda *a, **kw: broken)

        with pytest.raises(HTTPException) as gen_exc:
            svc.generate_student_invite_token("s-1", "a-1")
        assert gen_exc.value.status_code == 503

        token = pyjwt.encode(
            {
                "sub": "s-1", "student_id": "s-1", "assessment_id": "a-1",
                "purpose": "student_invite", "jti": "abc",
                "iat": int(time.time()), "exp": int(time.time()) + 3600,
            },
            "test-secret-key",
            algorithm="HS256",
        )
        for _ in range(2):
            with pytest.raises(HTTPException) as exc_info:
                svc.exchange_student_invite_token(token)
            assert exc_info.value.status_code == 503

    def test_table_unavailability_is_not_cached(self, monkeypatch, mock_dynamodb):
        real_resource = __import__("boto3").resource  # before _build_service patches it
        svc = _build_service(monkeypatch)
        calls = {"n": 0}

        def flaky_resource(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise Exception("transient")
            return real_resource(*a, **kw)

        monkeypatch.setattr("src.main.auth.service.boto3.resource", flaky_resource)
        with pytest.raises(HTTPException):
            svc.generate_student_invite_token("s-1", "a-1")
        token = svc.generate_student_invite_token("s-1", "a-1")
        assert svc.exchange_student_invite_token(token)["student_id"] == "s-1"

    def test_issue_student_session_token(self, monkeypatch):
        svc = _build_service(monkeypatch)
        result = svc.issue_student_session_token("s-1", "a-1")

        assert result["student_id"] == "s-1"
        assert result["expires_in"] == 12 * 3600

        payload = pyjwt.decode(result["access_token"], "test-secret-key", algorithms=["HS256"])
        assert payload["roles"] == ["student"]
        assert payload["purpose"] == "student_session"


class TestStudentInviteReuse:
    """An invite stays usable while the assessment is open — and only until then."""

    @staticmethod
    def _table_with_due_date(due_date_iso: str) -> MagicMock:
        table = MagicMock()
        table.get_item.return_value = {"Item": {"dueDate": due_date_iso}}
        return table

    def test_exchange_twice_inside_window(self, monkeypatch):
        svc = _build_service(monkeypatch)
        closes = datetime.now(timezone.utc) + timedelta(hours=2)
        svc._assessment_table_cache = self._table_with_due_date(closes.isoformat())

        token = svc.generate_student_invite_token("s-1", "a-1")
        first = svc.exchange_student_invite_token(token)
        second = svc.exchange_student_invite_token(token)

        assert first["student_id"] == second["student_id"] == "s-1"
        assert first["access_token"] and second["access_token"]
        # Session never outlives the window (2h left, not the 12h default).
        assert second["expires_in"] <= 3 * 3600

    def test_exchange_refused_after_window_closes(self, monkeypatch):
        svc = _build_service(monkeypatch)
        open_table = self._table_with_due_date(
            (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        )
        svc._assessment_table_cache = open_table
        token = svc.generate_student_invite_token("s-1", "a-1")

        # The assessment closed a day ago.
        open_table.get_item.return_value = {
            "Item": {"dueDate": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()}
        }
        with pytest.raises(HTTPException) as exc_info:
            svc.exchange_student_invite_token(token)
        assert exc_info.value.status_code == 401
        assert "closed" in exc_info.value.detail.lower()


class TestStudentInviteEmail:
    """send_student_invite_email — custom copy (used by bulk send + per-student resend)."""

    def test_custom_copy_renders_placeholders(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.send_student_invite_email(
            student_email="alice@example.com",
            student_name="Alice",
            assessment_title="Quiz 1",
            invite_link="https://student.example/invite?token=abc",
            custom_subject="{{title}} for {{name}}",
            custom_message="Hi {{name}},\n\nStart here: {{link}}\n\nThanks",
        )
        svc.ses_client.send_email.assert_called_once()
        message = svc.ses_client.send_email.call_args.kwargs["Message"]
        assert message["Subject"]["Data"] == "Quiz 1 for Alice"
        text = message["Body"]["Text"]["Data"]
        assert "Hi Alice," in text
        assert "https://student.example/invite?token=abc" in text
        assert "{{" not in text  # every placeholder substituted

    def test_default_copy_used_when_no_custom(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.send_student_invite_email(
            student_email="bob@example.com",
            student_name="Bob",
            assessment_title="Quiz 2",
            invite_link="https://student.example/invite?token=xyz",
        )
        svc.ses_client.send_email.assert_called_once()
        message = svc.ses_client.send_email.call_args.kwargs["Message"]
        assert message["Subject"]["Data"] == "Your assessment invitation: Quiz 2"
        assert "use it again" in message["Body"]["Text"]["Data"]


class TestPrincipalResolution:
    def test_resolve_from_bearer_token(self, monkeypatch):
        svc = _build_service(monkeypatch)
        principal = AuthPrincipal(user_id="u-1", email="u@test.com", roles=["student"], source="test")
        token_data = svc.issue_access_token(principal)

        resolved = svc.resolve_principal(f"Bearer {token_data['access_token']}", None)
        assert resolved.user_id == "u-1"
        assert resolved.source == "jwt"

    def test_resolve_rejects_x_user_id(self, monkeypatch):
        """The X-User-Id header is never an identity, whatever the environment says."""
        monkeypatch.setenv("AUTH_ALLOW_HEADER_FALLBACK", "true")
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc.resolve_principal(None, "fallback-user")
        assert exc_info.value.status_code == 401

    def test_resolve_rejects_tokens_of_another_purpose(self, monkeypatch, mock_dynamodb):
        """Reset, refresh and invite tokens share the signing key — none is a credential."""
        svc = _build_service(monkeypatch)
        svc._assessment_table_cache = mock_dynamodb

        reset_token, _jti, _expires = svc._issue_password_reset_token("u@test.com")
        refresh_token = svc.issue_refresh_token(AuthPrincipal(user_id="u-1", email="u@test.com"))
        invite_token = svc.generate_student_invite_token("s-1", "a-1")

        for token in (reset_token, refresh_token, invite_token):
            with pytest.raises(HTTPException) as exc_info:
                svc.resolve_principal(f"Bearer {token}", None)
            assert exc_info.value.status_code == 401

    def test_resolve_no_auth_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc.resolve_principal(None, None)
        assert exc_info.value.status_code == 401

    def test_resolve_malformed_bearer_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        with pytest.raises(HTTPException) as exc_info:
            svc.resolve_principal("Basic dXNlcjpwYXNz", None)
        assert exc_info.value.status_code == 401


class TestGoogleOAuth:
    def test_google_auth_not_configured_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.google_oauth_client_id = ""

        with pytest.raises(HTTPException) as exc_info:
            svc.authenticate_google_id_token("some-id-token")
        assert exc_info.value.status_code == 503

    def test_google_auth_empty_token_raises(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.google_oauth_client_id = "test-client-id"

        with pytest.raises(HTTPException) as exc_info:
            svc.authenticate_google_id_token("  ")
        assert exc_info.value.status_code == 400

    def test_google_auth_success(self, monkeypatch):
        svc = _build_service(monkeypatch)
        svc.google_oauth_client_id = "test-client-id"

        mock_payload = {
            "email": "google@example.com",
            "email_verified": True,
            "sub": "google-sub-123",
        }
        mock_request_class = MagicMock()
        mock_verify = MagicMock(return_value=mock_payload)

        with patch.dict("sys.modules", {
            "google.auth.transport.requests": MagicMock(Request=mock_request_class),
            "google.oauth2.id_token": MagicMock(verify_oauth2_token=mock_verify),
        }):
            principal = svc.authenticate_google_id_token("valid-token")

        assert principal.email == "google@example.com"
        assert principal.source == "google"
        assert principal.user_id == "google-sub-123"


class TestEdgeCases:
    def test_extract_bearer_token(self):
        assert AuthService._extract_bearer_token("Bearer abc123") == "abc123"
        assert AuthService._extract_bearer_token("bearer  xyz ") == "xyz"
        assert AuthService._extract_bearer_token("Basic abc123") is None
        assert AuthService._extract_bearer_token("") is None
        assert AuthService._extract_bearer_token(None) is None

    def test_extract_roles_from_payload(self):
        assert AuthService._extract_roles({"roles": ["a", "b"]}) == ["a", "b"]
        assert AuthService._extract_roles({"role": "admin"}) == ["admin"]
        assert AuthService._extract_roles({}) == []

    def test_normalize_email(self):
        assert AuthService._normalize_email("  Alice@Example.COM  ") == "alice@example.com"

    def test_parse_positive_int(self):
        assert AuthService._parse_positive_int("42", default=10) == 42
        assert AuthService._parse_positive_int("-1", default=10) == 10
        assert AuthService._parse_positive_int("abc", default=10) == 10
        assert AuthService._parse_positive_int(None, default=10) == 10
