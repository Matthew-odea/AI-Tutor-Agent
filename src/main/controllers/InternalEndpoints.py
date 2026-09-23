from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, UploadFile, File, Form, HTTPException

from ..dtos.UploadRequest import UploadRequest
from ..dtos.DeleteRequest import DeleteRequest
from ..dtos.ListDocumentsRequest import ListDocumentsRequest
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.api_errors import ApiError
from src.main.controllers.controller_dependencies import get_context_service, get_s3_upload_service
from src.main.controllers.controller_helpers import _assert_instructor_access
from src.main.service.ContextVectorService import ContextVectorService
from src.main.service.FileToTextService import FileToTextService
from src.main.service.S3UploadService import (
    S3UploadService,
    S3UploadServiceError,
    build_upload_key,
)


router = APIRouter(prefix="/internal/context", tags=["context"])
s3_router = APIRouter(prefix="/api/s3", tags=["s3"])


# --- Endpoints -----------------------------------------------------------------

@router.post("/upload", status_code=201)
def upload_context(
    dto: UploadRequest = Body(...),
    principal: AuthPrincipal = Depends(require_auth_principal),
    svc: ContextVectorService = Depends(get_context_service),
):
    _assert_instructor_access(principal)
    try:
        result = svc.upload_document(
            document_name=dto.DocumentName,
            description=dto.Description,
            text=dto.Text,
            scope=dto.Scope,
            artifact_type=dto.ArtifactType,
            source_path=dto.SourcePath,
            course_code=dto.CourseCode,
            course_term=dto.CourseTerm,
            course_year=dto.CourseYear,
        )
        return {"ok": True, **result}
    except ApiError:
        raise
    except Exception as error:
        raise ApiError(status_code=500, code="context_upload_failed", message=str(error))

@router.delete("/delete")
def delete_context(
    dto: DeleteRequest = Body(...),
    principal: AuthPrincipal = Depends(require_auth_principal),
    svc: ContextVectorService = Depends(get_context_service),
):
    _assert_instructor_access(principal)
    try:
        result = svc.delete_document(document_id=dto.document_id)
        return {"ok": True, **result}
    except ApiError:
        raise
    except Exception as error:
        raise ApiError(status_code=500, code="context_delete_failed", message=str(error))

@router.post("/list")
def list_documents(
    body: ListDocumentsRequest = Body(...),
    principal: AuthPrincipal = Depends(require_auth_principal),
    svc: ContextVectorService = Depends(get_context_service),
):
    _assert_instructor_access(principal)
    try:
        docs = svc.list_documents(
            offset=body.Offset,
            limit=body.Limit,
            scope=body.Scope
        )
        return {"documents": docs}
    except ApiError:
        raise
    except Exception as error:
        raise ApiError(status_code=500, code="context_list_failed", message=str(error))

@router.post("/uploadFile", status_code=201)
def upload_file_context(
    File: UploadFile = File(...),
    DocumentName: str = Form(...),
    Description: str = Form(""),
    Scope: str = Form("default"),
    principal: AuthPrincipal = Depends(require_auth_principal),
    svc: ContextVectorService = Depends(get_context_service),
):
    """
    Upload a PDF file, extract its text using FileToTextService, and process as a document upload.
    """
    _assert_instructor_access(principal)
    try:
        text = FileToTextService().extract_text_from_uploadfile(File)
        upload_dto = UploadRequest(
            DocumentName=DocumentName,
            Description=Description,
            Text=text,
            Scope=Scope
        )
        result = svc.upload_document(
            document_name=upload_dto.DocumentName,
            description=upload_dto.Description,
            text=upload_dto.Text,
            scope=upload_dto.Scope,
            artifact_type="pdf",
            source_path=File.filename,
        )
        return {"ok": True, **result}
    except ApiError:
        raise
    except Exception as error:
        raise ApiError(status_code=500, code="context_file_upload_failed", message=str(error))


# =============================================================================
# S3 Upload Endpoints
# =============================================================================

@s3_router.post("/upload-url")
async def get_upload_url(
    kind: Literal["audio", "proctoring"] = "audio",
    content_type: str = "audio/webm",
    question_id: Optional[str] = None,
    assessment_id: Optional[str] = None,
    chunk_index: Optional[int] = None,
    principal: AuthPrincipal = Depends(require_auth_principal),
    s3_service: S3UploadService = Depends(get_s3_upload_service),
):
    """
    Generate a presigned URL for uploading media to S3.

    The S3 key is built on the server from the authenticated principal plus the
    parameters below — the caller never supplies the key, so it can only ever
    write under its own prefix:

    - kind=audio        -> audio/{user_id}/{question_id}_{server_timestamp}.{ext}
    - kind=proctoring   -> proctoring/{assessment_id}/{user_id}/chunk_{index}.{ext}

    Parameters:
    - kind: "audio" (answer recording) or "proctoring" (session chunk)
    - content_type: MIME type of the file; checked against an allowlist, and the
      key extension is derived from it
    - question_id: required when kind=audio
    - assessment_id, chunk_index: required when kind=proctoring

    Returns:
    - uploadUrl: Presigned URL for PUT request (valid for 1 hour)
    - fileUrl: Public URL to access the file after upload
    """
    # Both instructors and students need upload URLs (students for audio answers).
    # An assessment-scoped student token may only write into its own assessment.
    if assessment_id and principal.assessment_id and principal.assessment_id != assessment_id:
        raise HTTPException(status_code=403, detail="Token not valid for this assessment")

    try:
        key = build_upload_key(
            kind=kind,
            user_id=principal.user_id,
            content_type=content_type,
            question_id=question_id,
            assessment_id=assessment_id,
            chunk_index=chunk_index,
        )
    except S3UploadServiceError as error:
        raise ApiError(status_code=400, code="invalid_upload_request", message=str(error))

    try:
        return s3_service.generate_upload_url(key=key, content_type=content_type)
    except S3UploadServiceError as error:
        raise ApiError(status_code=500, code="s3_upload_url_failed", message=str(error))
