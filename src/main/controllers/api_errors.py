from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
# Starlette's HTTPException, not FastAPI's: FastAPI's subclasses it, so this one
# key catches both, and it is the only one that catches the HTTPExceptions
# Starlette itself raises for an unmatched path (404) and a wrong method (405).
# Registering FastAPI's class instead leaves those two answering {"detail": ...}.
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


logger = logging.getLogger(__name__)


@dataclass
class ApiError(Exception):
    status_code: int
    code: str
    message: str
    details: dict[str, Any] | None = None

    def to_response(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": False,
            "error": {
                "code": self.code,
                "message": self.message,
            },
        }
        if self.details:
            payload["error"]["details"] = self.details
        return payload


def register_exception_handlers(app: FastAPI) -> None:
    def _http_error_code(status_code: int) -> str:
        if status_code in (401, 403):
            return "auth_error"
        if status_code == 404:
            return "not_found"
        if status_code in (400, 422):
            return "validation_error"
        if status_code in (502, 503, 504):
            return "dependency_failure"
        return "http_error"

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        logger.warning("API error on %s %s: %s", request.method, request.url.path, exc.message)
        return JSONResponse(status_code=exc.status_code, content=exc.to_response())

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(request: Request, exc: RequestValidationError):
        payload = {
            "ok": False,
            "error": {
                "code": "validation_error",
                "message": "Request validation failed",
                "details": {
                    "errors": exc.errors(),
                },
            },
        }
        return JSONResponse(status_code=422, content=payload)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
        payload = {
            "ok": False,
            "error": {
                "code": _http_error_code(exc.status_code),
                "message": detail,
            },
        }
        return JSONResponse(status_code=exc.status_code, content=payload)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        payload: dict[str, Any] = {
            "ok": False,
            "error": {
                "code": "internal_error",
                "message": str(exc),
            },
        }
        if logger.isEnabledFor(logging.DEBUG):
            payload["error"]["trace"] = traceback.format_exc()
        return JSONResponse(status_code=500, content=payload)
