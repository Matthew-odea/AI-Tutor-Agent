from __future__ import annotations

import re
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from src.main.auth.service import AuthService


def _build_service(monkeypatch) -> AuthService:
    monkeypatch.setenv("AUTH_JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_JSON", '[{"email":"student@example.com","password":"old-password","user_id":"student@example.com","roles":["student"]}]')
    monkeypatch.setenv("AUTH_PASSWORD_RESET_BASE_URL", "http://localhost:5173/?reset=1")
    monkeypatch.setenv("AUTH_PASSWORD_RESET_FROM_EMAIL", "noreply@example.com")
    monkeypatch.setenv("AUTH_PASSWORD_RESET_TOKEN_MINUTES", "30")
    ses_client = MagicMock()
    monkeypatch.setattr("src.main.auth.service.boto3.client", lambda *args, **kwargs: ses_client)
    # No DynamoDB here: these tests cover the env-configured user path, and this
    # also keeps the constructor from reaching for a real table.
    monkeypatch.setattr(
        "src.main.auth.service.boto3.resource",
        MagicMock(side_effect=RuntimeError("no DynamoDB in this test")),
    )

    service = AuthService()
    assert service.auth_users_table is None and service.persist_users is False
    return service


def test_password_reset_request_and_complete_flow(monkeypatch):
    service = _build_service(monkeypatch)

    message = service.request_password_reset("student@example.com")
    assert "If an account exists" in message

    send_kwargs = service.ses_client.send_email.call_args.kwargs
    text_body = send_kwargs["Message"]["Body"]["Text"]["Data"]
    token_match = re.search(r"token=([^\s]+)", text_body)
    assert token_match is not None
    token = token_match.group(1)

    assert service.validate_password_reset_token(token) is True

    reset_message = service.reset_password(token, "new-password-123")
    assert reset_message == "Password has been reset successfully."
    assert service.validate_password_reset_token(token) is False

    with pytest.raises(HTTPException) as old_password_error:
        service.authenticate_credentials("student@example.com", "old-password")
    assert old_password_error.value.status_code == 401

    principal = service.authenticate_credentials("student@example.com", "new-password-123")
    assert principal.email == "student@example.com"


def test_password_reset_unknown_email_returns_generic_message(monkeypatch):
    service = _build_service(monkeypatch)

    message = service.request_password_reset("does-not-exist@example.com")

    assert "If an account exists" in message
    service.ses_client.send_email.assert_not_called()
