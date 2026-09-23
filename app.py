from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv(filename=".env", usecwd=True), override=False)

from src.main.utils.structured_logger import configure_logging
configure_logging()

logger = logging.getLogger(__name__)

from src.main.config import get_settings
from src.main.controllers.api_errors import register_exception_handlers
from src.main.controllers.InternalEndpoints import router as context_router, s3_router
from src.main.controllers.analytics_router import analytics_router
from src.main.controllers.auth_router import auth_router
from src.main.controllers.history_router import history_router
from src.main.controllers.student_router import student_router
from src.main.controllers.assessment_router import assessment_router
from src.main.controllers.controller_dependencies import (
    get_assessment_report_service,
    get_evaluation_service,
    get_sqs_job_dispatcher,
    get_question_service,
)
from src.main.middleware.logging_middleware import RequestLoggingMiddleware


@asynccontextmanager
async def _lifespan(app: FastAPI):
    try:
        dispatcher = get_sqs_job_dispatcher()
        if dispatcher.queue_url:
            question_svc = get_question_service()
            evaluation_runner = get_evaluation_service().workflow_runner
            dispatcher.start_consumer(
                question_svc,
                evaluation_workflow_runner=evaluation_runner,
                report_service=get_assessment_report_service(),
            )
            logger.info("SQS job consumer started")
        else:
            logger.warning("SQS consumer not started — no queue URL available (set SQS_JOBS_QUEUE_URL)")
    except Exception as e:
        logger.error("Failed to start SQS consumer: %s", e)

    yield

    try:
        dispatcher = get_sqs_job_dispatcher()
        dispatcher.stop_consumer()
        logger.info("SQS job consumer stopped")
    except Exception:
        pass


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_title,
        version=settings.app_version,
        docs_url=settings.docs_url,
        redoc_url=settings.redoc_url,
        openapi_url=settings.openapi_url,
        lifespan=_lifespan,
    )

    # "http://localhost:*" is a dev sentinel that settings maps to ["*"]; an empty value adds no CORS at all.
    origins_env = settings.allow_origins_raw
    
    if origins_env == "http://localhost:*":
        origins: List[str] = settings.allow_origins
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    elif origins_env:
        origins: List[str] = settings.allow_origins
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.get("/health", tags=["meta"])
    def health():
        try:
            dispatcher = get_sqs_job_dispatcher()
            sqs_consumer = "running" if dispatcher.is_running() else (
                "idle" if not dispatcher.queue_url else "stopped"
            )
        except Exception:
            sqs_consumer = "unknown"
        return {"status": "ok", "sqsConsumer": sqs_consumer}

    app.add_middleware(RequestLoggingMiddleware)

    register_exception_handlers(app)

    app.include_router(context_router)
    app.include_router(analytics_router)
    app.include_router(history_router)
    app.include_router(student_router)
    app.include_router(assessment_router)
    app.include_router(s3_router)
    app.include_router(auth_router)

    return app

app = create_app()

if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    host = settings.host
    port = settings.port
    reload = settings.reload
    uvicorn.run("app:app", host=host, port=port, reload=reload)
