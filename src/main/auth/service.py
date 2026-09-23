from __future__ import annotations

import json
import os
import secrets
import importlib
import logging
from datetime import datetime, timedelta, timezone
from hashlib import pbkdf2_hmac
from hmac import compare_digest
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import boto3
import jwt
from botocore.exceptions import ClientError
from fastapi import HTTPException, status

from .models import AuthPrincipal


logger = logging.getLogger(__name__)


class AuthService:
    def __init__(self):
        self.jwt_secret = os.getenv("AUTH_JWT_SECRET", "").strip()
        self.jwt_algorithm = os.getenv("AUTH_JWT_ALGORITHM", "HS256").strip() or "HS256"
        self.google_oauth_client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "").strip()
        self.access_token_minutes = self._parse_positive_int(os.getenv("AUTH_ACCESS_TOKEN_MINUTES"), default=60)
        self.password_hash_iterations = self._parse_positive_int(os.getenv("AUTH_PASSWORD_HASH_ITERATIONS"), default=200_000)
        self.password_reset_token_minutes = self._parse_positive_int(
            os.getenv("AUTH_PASSWORD_RESET_TOKEN_MINUTES"),
            default=30,
        )
        self.password_reset_base_url = os.getenv("AUTH_PASSWORD_RESET_BASE_URL", "").strip()
        self.password_reset_from_email = os.getenv("AUTH_PASSWORD_RESET_FROM_EMAIL", "").strip()
        self.password_reset_ses_region = (
            os.getenv("AUTH_PASSWORD_RESET_SES_REGION", "").strip()
            or os.getenv("AWS_DEFAULT_REGION", "us-east-1").strip()
            or "us-east-1"
        )
        self.signup_default_roles = [
            role.strip()
            for role in os.getenv("AUTH_SIGNUP_DEFAULT_ROLES", "student").split(",")
            if role.strip()
        ]
        self.auth_users_table_name = os.getenv("DYNAMODB_AUTH_USERS_TABLE", "auth_users")
        self.auth_users_region = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        # Whether the users table is reachable, not a configuration choice.
        # _init_auth_users_table clears this if the table is missing, and the
        # service then falls back to the env-configured login users.
        self.persist_users = True
        self.auth_users_table = self._init_auth_users_table()
        self.ses_client = self._init_ses_client()
        self._login_users = self._load_login_users()

    def _init_auth_users_table(self):
        try:
            dynamodb = boto3.resource("dynamodb", region_name=self.auth_users_region)
            table = dynamodb.Table(self.auth_users_table_name)
            table.load()
            return table
        except Exception:
            self.persist_users = False
            return None

    def _init_ses_client(self):
        try:
            return boto3.client("ses", region_name=self.password_reset_ses_region)
        except Exception:
            return None

    @staticmethod
    def _parse_positive_int(raw: Optional[str], default: int) -> int:
        if raw is None:
            return default
        try:
            value = int(raw)
            return value if value > 0 else default
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _normalize_email(email: str) -> str:
        return email.strip().lower()

    @staticmethod
    def _format_datetime(value: datetime) -> str:
        return value.astimezone(timezone.utc).isoformat()

    @staticmethod
    def _parse_datetime(value: Any) -> Optional[datetime]:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            return None

    @staticmethod
    def _is_hashed_password(value: str) -> bool:
        return value.startswith("pbkdf2_sha256$")

    def _hash_password(self, raw_password: str) -> str:
        salt = secrets.token_hex(16)
        digest = pbkdf2_hmac(
            "sha256",
            raw_password.encode("utf-8"),
            salt.encode("utf-8"),
            self.password_hash_iterations,
        ).hex()
        return f"pbkdf2_sha256${self.password_hash_iterations}${salt}${digest}"

    @staticmethod
    def _verify_hashed_password(raw_password: str, stored_password: str) -> bool:
        try:
            _, iterations_raw, salt, expected_digest = stored_password.split("$", 3)
            iterations = int(iterations_raw)
            candidate_digest = pbkdf2_hmac(
                "sha256",
                raw_password.encode("utf-8"),
                salt.encode("utf-8"),
                iterations,
            ).hex()
            return compare_digest(candidate_digest, expected_digest)
        except (TypeError, ValueError):
            return False

    def _load_login_users(self) -> Dict[str, Dict[str, Any]]:
        configured: Dict[str, Dict[str, Any]] = {}

        users_json = os.getenv("AUTH_USERS_JSON", "").strip()
        if users_json:
            try:
                parsed = json.loads(users_json)
                if isinstance(parsed, list):
                    for item in parsed:
                        if not isinstance(item, dict):
                            continue
                        email = item.get("email")
                        if not isinstance(email, str) or not email.strip():
                            continue
                        configured[self._normalize_email(email)] = item
                elif isinstance(parsed, dict):
                    for key, value in parsed.items():
                        if not isinstance(key, str) or not isinstance(value, dict):
                            continue
                        configured[self._normalize_email(key)] = {
                            "email": key,
                            **value,
                        }
            except json.JSONDecodeError:
                pass

        fallback_email = os.getenv("AUTH_LOGIN_EMAIL", "").strip()
        fallback_password = os.getenv("AUTH_LOGIN_PASSWORD", "")
        if fallback_email and fallback_password and self._normalize_email(fallback_email) not in configured:
            fallback_user_id = os.getenv("AUTH_LOGIN_USER_ID", "").strip() or fallback_email
            fallback_roles = [
                role.strip()
                for role in os.getenv("AUTH_LOGIN_ROLES", "instructor").split(",")
                if role.strip()
            ]
            configured[self._normalize_email(fallback_email)] = {
                "email": fallback_email,
                "password": fallback_password,
                "user_id": fallback_user_id,
                "roles": fallback_roles,
            }

        return configured

    @staticmethod
    def _extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
        if not authorization:
            return None
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None
        return token.strip()

    # Purposes a bearer token may carry to authenticate a request. Refresh,
    # password-reset and student-invite tokens are signed with the same key and
    # must never be accepted here.
    BEARER_PURPOSES = frozenset({"access", "student_session"})

    def _decode_jwt(self, token: str) -> Dict[str, Any]:
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )

        try:
            payload = jwt.decode(
                token,
                self.jwt_secret,
                algorithms=[self.jwt_algorithm],
                options={"verify_aud": False},
            )
            if not isinstance(payload, dict):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
            if payload.get("purpose") not in self.BEARER_PURPOSES:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Token is not valid for authentication",
                )
            return payload
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    @staticmethod
    def _extract_roles(payload: Dict[str, Any]) -> List[str]:
        roles_value = payload.get("roles")
        if isinstance(roles_value, list):
            return [str(role) for role in roles_value if str(role).strip()]

        role_value = payload.get("role")
        if isinstance(role_value, str) and role_value.strip():
            return [role_value.strip()]

        return []

    def _principal_from_payload(self, payload: Dict[str, Any]) -> AuthPrincipal:
        user_id = payload.get("sub") or payload.get("user_id")
        if not user_id or not str(user_id).strip():
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing subject")

        email_value = payload.get("email")
        email = str(email_value).strip().lower() if isinstance(email_value, str) else None

        assessment_id_value = payload.get("assessment_id")
        assessment_id = str(assessment_id_value).strip() if assessment_id_value else None

        return AuthPrincipal(
            user_id=str(user_id),
            email=email,
            roles=self._extract_roles(payload),
            source="jwt",
            assessment_id=assessment_id,
        )

    @staticmethod
    def _password_matches(raw_password: str, user_record: Dict[str, Any]) -> bool:
        expected_password = user_record.get("password")
        if isinstance(expected_password, str) and AuthService._is_hashed_password(expected_password):
            return AuthService._verify_hashed_password(raw_password, expected_password)

        return False

    def _load_user_from_store(self, normalized_email: str) -> Optional[Dict[str, Any]]:
        if not self.auth_users_table:
            return None

        try:
            response = self.auth_users_table.get_item(Key={"email": normalized_email})
            item = response.get("Item")
            if not item:
                return None

            roles = item.get("roles")
            normalized_roles = [str(role).strip() for role in roles] if isinstance(roles, list) else []
            return {
                "email": normalized_email,
                "password": str(item.get("password") or ""),
                "user_id": str(item.get("user_id") or normalized_email),
                "roles": [role for role in normalized_roles if role],
                "password_reset_jti": str(item.get("password_reset_jti") or "").strip(),
                "password_reset_expires_at": str(item.get("password_reset_expires_at") or "").strip(),
            }
        except Exception:
            return None

    def _update_user_reset_state(self, normalized_email: str, reset_jti: str, expires_at: datetime) -> None:
        if self.auth_users_table:
            now_raw = self._format_datetime(datetime.now(timezone.utc))
            try:
                self.auth_users_table.update_item(
                    Key={"email": normalized_email},
                    UpdateExpression=(
                        "SET password_reset_jti = :reset_jti, "
                        "password_reset_expires_at = :reset_expires_at, "
                        "password_reset_requested_at = :requested_at, "
                        "updated_at = :updated_at"
                    ),
                    ExpressionAttributeValues={
                        ":reset_jti": reset_jti,
                        ":reset_expires_at": self._format_datetime(expires_at),
                        ":requested_at": now_raw,
                        ":updated_at": now_raw,
                    },
                )
            except Exception:
                logger.exception("Failed to persist password reset state for %s", normalized_email)

        user_record = self._login_users.get(normalized_email)
        if user_record is not None:
            user_record["password_reset_jti"] = reset_jti
            user_record["password_reset_expires_at"] = self._format_datetime(expires_at)

    def _clear_user_reset_state(self, normalized_email: str) -> None:
        if self.auth_users_table:
            now_raw = self._format_datetime(datetime.now(timezone.utc))
            try:
                self.auth_users_table.update_item(
                    Key={"email": normalized_email},
                    UpdateExpression=(
                        "REMOVE password_reset_jti, password_reset_expires_at "
                        "SET password_reset_used_at = :used_at, updated_at = :updated_at"
                    ),
                    ExpressionAttributeValues={
                        ":used_at": now_raw,
                        ":updated_at": now_raw,
                    },
                )
            except Exception:
                logger.exception("Failed to clear password reset state for %s", normalized_email)

        user_record = self._login_users.get(normalized_email)
        if user_record is not None:
            user_record.pop("password_reset_jti", None)
            user_record.pop("password_reset_expires_at", None)

    def _set_user_password(self, normalized_email: str, hashed_password: str) -> None:
        if self.auth_users_table:
            now_raw = self._format_datetime(datetime.now(timezone.utc))
            try:
                self.auth_users_table.update_item(
                    Key={"email": normalized_email},
                    UpdateExpression="SET password = :password, updated_at = :updated_at",
                    ExpressionAttributeValues={
                        ":password": hashed_password,
                        ":updated_at": now_raw,
                    },
                )
            except Exception:
                logger.exception("Failed to update password for %s", normalized_email)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Unable to update password",
                )

        user_record = self._login_users.get(normalized_email)
        if user_record is not None:
            user_record["password"] = hashed_password

    def _build_password_reset_link(self, token: str) -> str:
        if not self.password_reset_base_url:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Password reset is not configured",
            )

        split_result = urlsplit(self.password_reset_base_url)
        query_items = dict(parse_qsl(split_result.query, keep_blank_values=True))
        query_items["token"] = token
        new_query = urlencode(query_items)
        return urlunsplit((split_result.scheme, split_result.netloc, split_result.path, new_query, split_result.fragment))

    def _send_password_reset_email(self, recipient_email: str, reset_link: str) -> None:
        if not self.password_reset_from_email:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Password reset email sender is not configured",
            )

        if self.ses_client is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Password reset email service is unavailable",
            )

        subject = "Reset your Chat9021 password"
        text_body = (
            "We received a request to reset your password.\n\n"
            f"Reset your password: {reset_link}\n\n"
            f"This link expires in {self.password_reset_token_minutes} minutes."
        )
        html_body = (
            "<p>We received a request to reset your password.</p>"
            f"<p><a href=\"{reset_link}\">Reset your password</a></p>"
            f"<p>This link expires in {self.password_reset_token_minutes} minutes.</p>"
        )

        self.ses_client.send_email(
            Source=self.password_reset_from_email,
            Destination={"ToAddresses": [recipient_email]},
            Message={
                "Subject": {"Data": subject},
                "Body": {
                    "Text": {"Data": text_body},
                    "Html": {"Data": html_body},
                },
            },
        )

    def _issue_password_reset_token(self, normalized_email: str) -> tuple[str, str, datetime]:
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )

        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.password_reset_token_minutes)
        reset_jti = secrets.token_urlsafe(16)
        payload: Dict[str, Any] = {
            "sub": normalized_email,
            "purpose": "password_reset",
            "jti": reset_jti,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        token = jwt.encode(payload, self.jwt_secret, algorithm=self.jwt_algorithm)
        return token, reset_jti, expires_at

    def _validate_reset_token_payload(self, token: str) -> Dict[str, Any]:
        try:
            payload = jwt.decode(
                token,
                self.jwt_secret,
                algorithms=[self.jwt_algorithm],
                options={"verify_aud": False},
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reset token has expired")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset token")

        if not isinstance(payload, dict):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset token")
        if payload.get("purpose") != "password_reset":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset token")
        return payload

    def _load_existing_user(self, normalized_email: str) -> Optional[Dict[str, Any]]:
        user_record = self._login_users.get(normalized_email)
        if user_record:
            return user_record

        user_record = self._load_user_from_store(normalized_email)
        if user_record:
            self._login_users[normalized_email] = user_record
        return user_record

    def _save_user_to_store(self, user_record: Dict[str, Any]) -> None:
        if not self.auth_users_table:
            return

        now = datetime.now(timezone.utc).isoformat()
        try:
            self.auth_users_table.put_item(
                Item={
                    "email": user_record["email"],
                    "password": user_record["password"],
                    "user_id": user_record["user_id"],
                    "roles": user_record.get("roles", []),
                    "created_at": now,
                    "updated_at": now,
                },
                ConditionExpression="attribute_not_exists(email)",
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to create user")

    def register_user(self, email: str, password: str) -> AuthPrincipal:
        normalized_email = self._normalize_email(email)
        if not normalized_email or "@" not in normalized_email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid email address")

        if len(password.strip()) < 8:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")

        if normalized_email in self._login_users or self._load_user_from_store(normalized_email):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")

        user_record = {
            "email": normalized_email,
            "password": self._hash_password(password),
            "user_id": normalized_email,
            "roles": list(self.signup_default_roles),
        }
        self._save_user_to_store(user_record)
        self._login_users[normalized_email] = user_record

        return AuthPrincipal(
            user_id=user_record["user_id"],
            email=normalized_email,
            roles=list(self.signup_default_roles),
            source="signup",
        )

    def list_users(self) -> List[Dict[str, Any]]:
        """Scan auth_users table and return all users (email + roles only)."""
        if not self.auth_users_table:
            return []
        try:
            results = []
            last_key = None
            while True:
                args: Dict[str, Any] = {
                    "ProjectionExpression": "email, #r, created_at",
                    "ExpressionAttributeNames": {"#r": "roles"},
                }
                if last_key:
                    args["ExclusiveStartKey"] = last_key
                resp = self.auth_users_table.scan(**args)
                for item in resp.get("Items", []):
                    roles = item.get("roles", [])
                    results.append({
                        "email": item.get("email", ""),
                        "roles": [str(r) for r in roles] if isinstance(roles, list) else [],
                        "createdAt": item.get("created_at", ""),
                    })
                last_key = resp.get("LastEvaluatedKey")
                if not last_key:
                    break
            results.sort(key=lambda u: u["email"])
            return results
        except Exception:
            logger.exception("Failed to list users")
            return []

    def set_user_roles(self, email: str, roles: List[str]) -> List[str]:
        """Overwrite a user's roles list in DynamoDB and in-memory cache.

        Unknown roles are dropped and the rest lower-cased; returns what was saved."""
        normalized = self._normalize_email(email)
        if not normalized:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid email")
        if not self.auth_users_table:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="User store not available")
        valid_roles = {"instructor", "admin", "student"}
        cleaned = [r.strip().lower() for r in roles if r.strip().lower() in valid_roles]
        try:
            self.auth_users_table.update_item(
                Key={"email": normalized},
                UpdateExpression="SET #r = :roles, updated_at = :ua",
                ExpressionAttributeNames={"#r": "roles"},
                ExpressionAttributeValues={
                    ":roles": cleaned,
                    ":ua": datetime.now(timezone.utc).isoformat(),
                },
                ConditionExpression="attribute_exists(email)",
            )
        except ClientError as err:
            if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to update roles")
        # Update in-memory cache if present
        cached = self._login_users.get(normalized)
        if cached:
            cached["roles"] = cleaned
        return cleaned

    def authenticate_credentials(self, email: str, password: str) -> AuthPrincipal:
        normalized_email = self._normalize_email(email)
        user_record = self._load_existing_user(normalized_email)

        # Legacy records stored the password in plaintext. Those logins now fail
        # closed; the account is recovered through the password-reset flow, which
        # writes a PBKDF2 hash.
        if user_record and not self._is_hashed_password(str(user_record.get("password") or "")):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="This account must reset its password before signing in. Use 'Forgot password'.",
            )

        if not user_record or not self._password_matches(password, user_record):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

        user_id = str(user_record.get("user_id") or normalized_email).strip()
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user configuration")

        roles = user_record.get("roles")
        normalized_roles = [str(role).strip() for role in roles] if isinstance(roles, list) else []

        return AuthPrincipal(
            user_id=user_id,
            email=normalized_email,
            roles=[role for role in normalized_roles if role],
            source="password",
        )

    def authenticate_google_id_token(self, id_token_value: str) -> AuthPrincipal:
        if not self.google_oauth_client_id:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Google OAuth is not configured",
            )

        token = id_token_value.strip()
        if not token:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Google ID token")

        try:
            google_requests_module = importlib.import_module("google.auth.transport.requests")
            google_id_token_module = importlib.import_module("google.oauth2.id_token")
            google_request = google_requests_module.Request()
        except ImportError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Google auth dependency is not installed",
            )

        try:
            payload = google_id_token_module.verify_oauth2_token(token, google_request, self.google_oauth_client_id)
        except Exception:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Google ID token")

        email_value = payload.get("email")
        normalized_email = self._normalize_email(str(email_value)) if email_value else ""
        if not normalized_email:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google account email is required")

        if not bool(payload.get("email_verified", False)):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google account email is not verified")

        user_record = self._login_users.get(normalized_email)
        if not user_record:
            user_record = self._load_existing_user(normalized_email)

        google_sub = str(payload.get("sub") or "").strip()
        user_id = str((user_record or {}).get("user_id") or google_sub or normalized_email).strip()
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Google account identity")

        roles_value = (user_record or {}).get("roles")
        roles = [str(role).strip() for role in roles_value] if isinstance(roles_value, list) else []
        roles = [role for role in roles if role]
        if not roles:
            roles = list(self.signup_default_roles)

        if not user_record:
            generated_password = self._hash_password(secrets.token_urlsafe(32))
            new_user = {
                "email": normalized_email,
                "password": generated_password,
                "user_id": user_id,
                "roles": roles,
            }

            if self.auth_users_table:
                try:
                    self._save_user_to_store(new_user)
                except HTTPException as error:
                    if error.status_code != status.HTTP_409_CONFLICT:
                        raise
                    stored_user = self._load_user_from_store(normalized_email)
                    if stored_user:
                        new_user = stored_user

            self._login_users[normalized_email] = new_user
            user_id = str(new_user.get("user_id") or user_id)
            roles = [str(role).strip() for role in new_user.get("roles", []) if str(role).strip()]

        return AuthPrincipal(
            user_id=user_id,
            email=normalized_email,
            roles=roles,
            source="google",
        )

    def request_password_reset(self, email: str) -> str:
        normalized_email = self._normalize_email(email)
        if not normalized_email or "@" not in normalized_email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid email address")

        user_record = self._load_existing_user(normalized_email)
        if not user_record:
            return "If an account exists for this email, a reset link has been sent."

        token, reset_jti, expires_at = self._issue_password_reset_token(normalized_email)
        self._update_user_reset_state(normalized_email, reset_jti, expires_at)

        try:
            reset_link = self._build_password_reset_link(token)
            self._send_password_reset_email(normalized_email, reset_link)
        except HTTPException:
            logger.exception("Password reset email configuration issue")
        except Exception:
            logger.exception("Failed sending password reset email")

        return "If an account exists for this email, a reset link has been sent."

    def validate_password_reset_token(self, token: str) -> bool:
        if not self.jwt_secret:
            return False

        try:
            payload = self._validate_reset_token_payload(token.strip())
        except HTTPException:
            return False

        normalized_email = self._normalize_email(str(payload.get("sub") or ""))
        reset_jti = str(payload.get("jti") or "").strip()
        if not normalized_email or not reset_jti:
            return False

        user_record = self._load_existing_user(normalized_email)
        if not user_record:
            return False

        stored_jti = str(user_record.get("password_reset_jti") or "").strip()
        if not stored_jti or not compare_digest(stored_jti, reset_jti):
            return False

        expires_at = self._parse_datetime(user_record.get("password_reset_expires_at"))
        if not expires_at or expires_at <= datetime.now(timezone.utc):
            return False

        return True

    def reset_password(self, token: str, new_password: str) -> str:
        trimmed_password = new_password.strip()
        if len(trimmed_password) < 8:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")

        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )

        payload = self._validate_reset_token_payload(token.strip())
        normalized_email = self._normalize_email(str(payload.get("sub") or ""))
        reset_jti = str(payload.get("jti") or "").strip()
        if not normalized_email or not reset_jti:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset token")

        user_record = self._load_existing_user(normalized_email)
        if not user_record:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset token")

        stored_jti = str(user_record.get("password_reset_jti") or "").strip()
        if not stored_jti or not compare_digest(stored_jti, reset_jti):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset token")

        expires_at = self._parse_datetime(user_record.get("password_reset_expires_at"))
        if not expires_at or expires_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reset token has expired")

        hashed_password = self._hash_password(trimmed_password)
        self._set_user_password(normalized_email, hashed_password)
        self._clear_user_reset_state(normalized_email)

        return "Password has been reset successfully."

    def issue_access_token(self, principal: AuthPrincipal) -> Dict[str, Any]:
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )

        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.access_token_minutes)
        payload: Dict[str, Any] = {
            "sub": principal.user_id,
            "email": principal.email,
            "roles": principal.roles,
            "purpose": "access",
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        token = jwt.encode(payload, self.jwt_secret, algorithm=self.jwt_algorithm)
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": self.access_token_minutes * 60,
            "user_id": principal.user_id,
            "email": principal.email,
            "roles": principal.roles,
        }

    def resolve_principal(self, authorization: Optional[str], x_user_id: Optional[str] = None) -> AuthPrincipal:
        # x_user_id is accepted and ignored: callers still pass the header through,
        # but an unsigned header is never an identity.
        token = self._extract_bearer_token(authorization)
        if token:
            payload = self._decode_jwt(token)
            return self._principal_from_payload(payload)

        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    # ------------------------------------------------------------------
    # Refresh tokens (EPIC-1-1)
    # ------------------------------------------------------------------

    def issue_refresh_token(self, principal: AuthPrincipal) -> str:
        """Issue a long-lived refresh JWT (7 days). Set as HTTP-only cookie by callers."""
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(days=7)
        payload: Dict[str, Any] = {
            "sub": principal.user_id,
            "email": principal.email,
            "purpose": "refresh",
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        return jwt.encode(payload, self.jwt_secret, algorithm=self.jwt_algorithm)

    def exchange_refresh_token(self, token: str) -> Dict[str, Any]:
        """Validate a refresh token and issue a new access token."""
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )
        try:
            payload = jwt.decode(
                token.strip(),
                self.jwt_secret,
                algorithms=[self.jwt_algorithm],
                options={"verify_aud": False},
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token has expired")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

        if payload.get("purpose") != "refresh":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

        user_id = str(payload.get("sub") or "").strip()
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token claims")

        email_raw = payload.get("email")
        email = str(email_raw).strip().lower() if isinstance(email_raw, str) else None

        # Load fresh roles from the user store so role changes take effect on refresh.
        user_record = self._load_existing_user(email) if email else None
        roles = user_record.get("roles", []) if user_record else []

        principal = AuthPrincipal(user_id=user_id, email=email, roles=roles, source="jwt")
        return self.issue_access_token(principal)

    # ------------------------------------------------------------------
    # Student invite tokens (EPIC-7-4)
    # ------------------------------------------------------------------

    def _get_assessment_table(self):
        """Lazy-load the assessment DynamoDB table for invite token storage."""
        if not hasattr(self, "_assessment_table_cache"):
            try:
                import boto3
                region = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
                table_name = os.getenv("DYNAMODB_ASSESSMENT_TABLE", "oral_assessments")
                dynamodb = boto3.resource("dynamodb", region_name=region)
                table = dynamodb.Table(table_name)
                table.load()
                self._assessment_table_cache = table
            except Exception:
                logger.warning("Assessment table unavailable — invite token jti tracking disabled")
                self._assessment_table_cache = None
        return self._assessment_table_cache

    def assessment_window_end(self, assessment_id: str) -> Optional[datetime]:
        """
        Close time of an assessment, from the same METADATA item the assessment
        service reads: the scheduled window end when the assessment is scheduled,
        otherwise the due date. Returns None when it cannot be determined, in
        which case callers fall back to a fixed expiry.
        """
        table = self._get_assessment_table()
        if not table:
            return None
        try:
            item = table.get_item(
                Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": "METADATA"}
            ).get("Item")
            if not item:
                return None
            raw = None
            if item.get("accessMode", "open") == "scheduled":
                raw = item.get("scheduledWindowEnd")
            raw = raw or item.get("dueDate")
            if not isinstance(raw, str) or not raw.strip():
                return None
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            logger.warning("Could not read assessment window for %s", assessment_id)
            return None

    def generate_student_invite_token(self, student_id: str, assessment_id: str) -> str:
        """
        Generate a signed invite token for a student. It stays exchangeable for a
        session token for as long as the assessment window is open, so a student
        who loses their session can recover it from the same emailed link.
        """
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )
        now = datetime.now(timezone.utc)
        window_end = self.assessment_window_end(assessment_id)
        # One hour past the close so a submission in the final minutes still works.
        expires_at = (window_end + timedelta(hours=1)) if window_end else (now + timedelta(days=7))
        if expires_at <= now:
            expires_at = now + timedelta(hours=1)
        jti = secrets.token_urlsafe(16)

        payload: Dict[str, Any] = {
            "sub": student_id,
            "student_id": student_id,
            "assessment_id": assessment_id,
            "purpose": "student_invite",
            "jti": jti,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        token = jwt.encode(payload, self.jwt_secret, algorithm=self.jwt_algorithm)

        table = self._get_assessment_table()
        if table:
            try:
                table.put_item(Item={
                    "PK": f"INVITE#{jti}",
                    "SK": "METADATA",
                    "student_id": student_id,
                    "assessment_id": assessment_id,
                    "used": False,
                    "created_at": now.isoformat(),
                    # TTL slightly beyond token expiry so the check still works at edge
                    "TTL": int((expires_at + timedelta(hours=1)).timestamp()),
                })
            except Exception:
                logger.exception("Failed to store invite jti for student %s", student_id)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to create invite token",
                )

        return token

    def send_student_invite_email(
        self,
        *,
        student_email: str,
        student_name: str,
        assessment_title: str,
        invite_link: str,
        custom_subject: str = "",
        custom_message: str = "",
    ) -> None:
        """
        Send an invite email to a student.
        Silently returns (logs warning) if SES or from-email is not configured,
        so the invite endpoint never fails due to email delivery.

        custom_subject / custom_message: if provided, override the default
        email content.  Use {{name}}, {{firstName}}, {{title}}, and {{link}} as
        placeholders. {{firstName}} falls back to the full name when the roster
        holds a single-word name.
        """
        if not self.password_reset_from_email:
            logger.warning("Student invite email skipped — AUTH_PASSWORD_RESET_FROM_EMAIL not configured")
            return

        if self.ses_client is None:
            logger.warning("Student invite email skipped — SES client unavailable")
            return

        first_name = (student_name or "").strip().split(" ")[0] or student_name

        def _render(template: str) -> str:
            return (
                template
                .replace("{{firstName}}", first_name)
                .replace("{{name}}", student_name)
                .replace("{{title}}", assessment_title)
                .replace("{{link}}", invite_link)
            )

        if custom_subject:
            subject = _render(custom_subject)
        else:
            subject = f"Your assessment invitation: {assessment_title}"

        if custom_message:
            text_body = _render(custom_message)
            # Auto-generate HTML from text: paragraphs + clickable link
            html_body = "".join(
                f"<p>{line}</p>" if invite_link not in line
                else f'<p><a href="{invite_link}">{invite_link}</a></p>'
                for line in text_body.split("\n\n") if line.strip()
            )
        else:
            text_body = (
                f"Hi {student_name},\n\n"
                f"You have been invited to complete an assessment: {assessment_title}.\n\n"
                f"Click the link below to start:\n{invite_link}\n\n"
                "Keep this link — you can use it again to get back into your\n"
                "assessment until it closes.\n\n"
                "Good luck!"
            )
            html_body = (
                f"<p>Hi {student_name},</p>"
                f"<p>You have been invited to complete an assessment: <strong>{assessment_title}</strong>.</p>"
                f'<p><a href="{invite_link}">Click here to start your assessment</a></p>'
                "<p>Keep this link — you can use it again to get back into your assessment until it closes.</p>"
                "<p>Good luck!</p>"
            )

        try:
            self.ses_client.send_email(
                Source=self.password_reset_from_email,
                Destination={"ToAddresses": [student_email]},
                Message={
                    "Subject": {"Data": subject},
                    "Body": {
                        "Text": {"Data": text_body},
                        "Html": {"Data": html_body},
                    },
                },
            )
            logger.info("Invite email sent to %s for assessment %s", student_email, assessment_title)
        except Exception as exc:
            logger.warning("Failed to send invite email to %s: %s", student_email, exc)

    def exchange_student_invite_token(self, token: str) -> Dict[str, Any]:
        """
        Exchange an invite token for a short-lived student session token.
        Re-usable while the assessment window is open — losing a session must not
        lock a student out of their own assessment — and refused once it closes.
        The jti record in DynamoDB remains the revocation point.
        """
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )
        try:
            payload = jwt.decode(
                token.strip(),
                self.jwt_secret,
                algorithms=[self.jwt_algorithm],
                options={"verify_aud": False},
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invite token has expired")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid invite token")

        if payload.get("purpose") != "student_invite":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid invite token")

        student_id = str(payload.get("student_id") or payload.get("sub") or "").strip()
        assessment_id = str(payload.get("assessment_id") or "").strip()
        jti = str(payload.get("jti") or "").strip()

        if not student_id or not assessment_id or not jti:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid invite token claims")

        now = datetime.now(timezone.utc)
        window_end = self.assessment_window_end(assessment_id)
        if window_end and now > window_end + timedelta(hours=1):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="This assessment has closed.",
            )

        # The jti record must still exist — deleting it revokes the invite.
        table = self._get_assessment_table()
        if table:
            try:
                table.update_item(
                    Key={"PK": f"INVITE#{jti}", "SK": "METADATA"},
                    UpdateExpression="SET #u = :true, last_used_at = :now",
                    ConditionExpression="attribute_exists(PK)",
                    ExpressionAttributeNames={"#u": "used"},
                    ExpressionAttributeValues={":true": True, ":now": now.isoformat()},
                )
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "")
                if code == "ConditionalCheckFailedException":
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="This invite link is no longer valid.",
                    )
                logger.exception("DynamoDB error checking invite jti %s", jti)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to validate invite token",
                )

        return self.issue_student_session_token(student_id, assessment_id, window_end=window_end)

    def issue_student_session_token(
        self,
        student_id: str,
        assessment_id: str,
        window_end: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Issue a short-lived (12-hour) session JWT for a student, never outliving
        the assessment window when that is known.
        The JWT has sub=student_id and roles=["student"] so the existing
        _assert_student_access() check in student_router.py works unchanged.
        """
        if not self.jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT authentication is not configured",
            )
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(hours=12)
        if window_end:
            expires_at = min(expires_at, window_end + timedelta(hours=1))
        if expires_at <= now:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="This assessment has closed.")
        payload: Dict[str, Any] = {
            "sub": student_id,
            "student_id": student_id,
            "assessment_id": assessment_id,
            "roles": ["student"],
            "purpose": "student_session",
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        token = jwt.encode(payload, self.jwt_secret, algorithm=self.jwt_algorithm)
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": int((expires_at - now).total_seconds()),
            "student_id": student_id,
            "assessment_id": assessment_id,
        }
