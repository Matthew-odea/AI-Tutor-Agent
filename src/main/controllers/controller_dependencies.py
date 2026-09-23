from __future__ import annotations

import logging
from functools import lru_cache

from src.main.agentcore_setup.dynamodb_history import DynamoDBHistoryStore
from src.main.agentcore_setup.dynamodb_memory import DynamoDBConversationMemory
from src.main.config import get_settings
from src.main.llm.AgentCoreProvider import AgentCoreProvider
from src.main.service.ChatService import ChatService
from src.main.service.ContextVectorService import ContextVectorService
from src.main.service.AnalyticsService import AnalyticsService
from src.main.service.AssessmentReportService import AssessmentReportService
from src.main.service.InstructorAssessmentService import InstructorAssessmentService
from src.main.service.OralAssessmentService import OralAssessmentService
from src.main.service.SQSJobDispatcher import SQSJobDispatcher, resolve_queue_url
from src.main.service.QuestionGenerationService import QuestionGenerationService
from src.main.service.ResponseEvaluationService import ResponseEvaluationService
from src.main.service.S3UploadService import S3UploadService
from src.main.service.TranscriptionService import TranscriptionService


logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _service_singleton() -> ContextVectorService:
    return ContextVectorService()


def get_context_service() -> ContextVectorService:
    return _service_singleton()


@lru_cache(maxsize=1)
def _memory_singleton():
    settings = get_settings()
    return DynamoDBConversationMemory(
        table_name=settings.dynamodb_table_name,
        region=settings.dynamodb_region,
        ttl_days=30,
    )


def get_memory_service():
    return _memory_singleton()


@lru_cache(maxsize=1)
def _history_singleton():
    settings = get_settings()
    return DynamoDBHistoryStore(
        table_name=settings.dynamodb_table_name,
        region=settings.dynamodb_region,
    )


def get_history_store():
    return _history_singleton()


@lru_cache(maxsize=1)
def _analytics_service_singleton() -> AnalyticsService:
    settings = get_settings()
    return AnalyticsService(
        use_dynamodb=True,
        table_name=settings.dynamodb_table_name,
        region=settings.dynamodb_region,
    )


def get_analytics_service() -> AnalyticsService:
    return _analytics_service_singleton()


@lru_cache(maxsize=1)
def _chat_service_singleton() -> ChatService:
    vector_service = _service_singleton()
    agent_client = AgentCoreProvider()
    memory = _memory_singleton()
    return ChatService(vector_service, agent_client, memory)


def get_chat_service() -> ChatService:
    return _chat_service_singleton()


@lru_cache(maxsize=1)
def _question_service_singleton() -> QuestionGenerationService:
    return QuestionGenerationService()


def get_question_service() -> QuestionGenerationService:
    return _question_service_singleton()


@lru_cache(maxsize=1)
def _transcription_service_singleton() -> TranscriptionService:
    settings = get_settings()
    oral_svc = _oral_assessment_service_singleton()
    return TranscriptionService(
        table=oral_svc.table,
        region=settings.aws_default_region,
    )


def get_transcription_service() -> TranscriptionService:
    return _transcription_service_singleton()


@lru_cache(maxsize=1)
def _evaluation_service_singleton() -> ResponseEvaluationService:
    return ResponseEvaluationService(
        transcription_service=_transcription_service_singleton(),
    )


def get_evaluation_service() -> ResponseEvaluationService:
    return _evaluation_service_singleton()


@lru_cache(maxsize=1)
def _oral_assessment_service_singleton() -> OralAssessmentService:
    return OralAssessmentService()


def get_oral_assessment_service() -> OralAssessmentService:
    return _oral_assessment_service_singleton()


@lru_cache(maxsize=1)
def _instructor_assessment_service_singleton() -> InstructorAssessmentService:
    return InstructorAssessmentService()


def get_instructor_assessment_service() -> InstructorAssessmentService:
    return _instructor_assessment_service_singleton()


@lru_cache(maxsize=1)
def _assessment_report_service_singleton() -> AssessmentReportService:
    instructor_svc = _instructor_assessment_service_singleton()
    return AssessmentReportService(
        table=instructor_svc.table,
        results_aggregator=instructor_svc.results_aggregator,
        get_assessment=instructor_svc.get_assessment,
        llm_client=AgentCoreProvider(),
    )


def get_assessment_report_service() -> AssessmentReportService:
    return _assessment_report_service_singleton()


def _extract_sqs_region(queue_url: str, fallback: str) -> str:
    # SQS lives in us-east-1 while AWS_DEFAULT_REGION may be ap-southeast-2; trust the URL's region.
    import re
    match = re.search(r"sqs\.([a-z0-9-]+)\.amazonaws\.com", queue_url)
    return match.group(1) if match else fallback


@lru_cache(maxsize=1)
def _sqs_job_dispatcher_singleton() -> SQSJobDispatcher:
    settings = get_settings()
    instructor_svc = _instructor_assessment_service_singleton()
    queue_url = resolve_queue_url(region=settings.aws_default_region)
    sqs_region = _extract_sqs_region(queue_url, settings.aws_default_region)
    return SQSJobDispatcher(
        queue_url=queue_url,
        region=sqs_region,
        table=instructor_svc.table,
    )


def get_sqs_job_dispatcher() -> SQSJobDispatcher:
    return _sqs_job_dispatcher_singleton()


@lru_cache(maxsize=1)
def _s3_upload_service_singleton() -> S3UploadService:
    settings = get_settings()
    return S3UploadService(
        bucket_name=settings.s3_assessment_bucket,
        region=settings.aws_default_region,
    )


def get_s3_upload_service() -> S3UploadService:
    return _s3_upload_service_singleton()
