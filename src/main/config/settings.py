from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import List


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: str | None, default: int) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _as_list(value: str | None, default: List[str]) -> List[str]:
    if not value:
        return default
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class AppSettings:
    app_title: str
    app_version: str
    docs_url: str
    redoc_url: str
    openapi_url: str
    allow_origins_raw: str

    host: str
    port: int
    reload: bool

    dynamodb_table_name: str
    dynamodb_region: str

    aws_default_region: str
    s3_assessment_bucket: str

    @property
    def allow_origins(self) -> List[str]:
        """Origins allowed by CORS. Unset means none — set ALLOW_ORIGINS explicitly,
        including for local development (see .env.example)."""
        return _as_list(self.allow_origins_raw, default=[])


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    return AppSettings(
        app_title=os.getenv("AI_TUTOR", "Context API"),
        app_version=os.getenv("APP_VERSION", "0.1.0"),
        docs_url=os.getenv("DOCS_URL", "/docs"),
        redoc_url=os.getenv("REDOC_URL", "/redoc"),
        openapi_url=os.getenv("OPENAPI_URL", "/openapi.json"),
        allow_origins_raw=os.getenv("ALLOW_ORIGINS", ""),
        host=os.getenv("HOST", "0.0.0.0"),
        port=_as_int(os.getenv("PORT"), 8000),
        reload=_as_bool(os.getenv("RELOAD"), True),
        dynamodb_table_name=os.getenv("DYNAMODB_TABLE_NAME", "chat_sessions"),
        dynamodb_region=os.getenv("DYNAMODB_REGION", "us-east-1"),
        aws_default_region=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
        s3_assessment_bucket=os.getenv("S3_ASSESSMENT_BUCKET", "c9-oral-assessments"),
    )
