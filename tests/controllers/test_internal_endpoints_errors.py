from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import create_app
from src.main.auth.dependencies import require_auth_principal
from src.main.auth.models import AuthPrincipal
from src.main.controllers.controller_dependencies import get_context_service, get_s3_upload_service
from src.main.service.S3UploadService import S3UploadServiceError


def _build_client(context_service=None, s3_service=None, principal=None) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_context_service] = lambda: context_service or MagicMock()
    app.dependency_overrides[get_s3_upload_service] = lambda: s3_service or MagicMock()
    app.dependency_overrides[require_auth_principal] = lambda: principal or AuthPrincipal(
        user_id="inst-1", roles=["instructor"], source="jwt"
    )
    return TestClient(app)


def test_context_upload_maps_error_code():
    svc = MagicMock()
    svc.upload_document.side_effect = RuntimeError("boom")
    client = _build_client(context_service=svc)

    response = client.post(
        "/internal/context/upload",
        json={
            "DocumentName": "doc-1",
            "Description": "desc",
            "Text": "hello",
            "Scope": "default",
        },
    )

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "context_upload_failed"


def test_context_upload_file_maps_error_code(monkeypatch):
    svc = MagicMock()
    svc.upload_document.side_effect = RuntimeError("boom")
    client = _build_client(context_service=svc)

    monkeypatch.setattr(
        "src.main.controllers.InternalEndpoints.FileToTextService.extract_text_from_uploadfile",
        lambda self, upload: "hello",
    )

    response = client.post(
        "/internal/context/uploadFile",
        data={"DocumentName": "Doc", "Description": "D", "Scope": "default"},
        files={"File": ("test.pdf", b"fake", "application/pdf")},
    )

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "context_file_upload_failed"


def test_s3_upload_url_maps_service_error():
    s3 = MagicMock()
    s3.generate_upload_url.side_effect = S3UploadServiceError("denied")
    client = _build_client(s3_service=s3)

    response = client.post("/api/s3/upload-url?kind=audio&question_id=q1&content_type=audio/webm")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "s3_upload_url_failed"


def test_s3_upload_url_allowed_for_students():
    """Students need upload URLs for audio answer submissions."""
    s3 = MagicMock()
    s3.generate_upload_url.return_value = {"uploadUrl": "https://s3.example.com/put", "fileUrl": "https://s3.example.com/a.webm"}
    client = _build_client(
        s3_service=s3,
        principal=AuthPrincipal(user_id="s-1", roles=["student"], source="jwt"),
    )

    response = client.post("/api/s3/upload-url?kind=audio&question_id=q1")

    assert response.status_code == 200
    assert s3.generate_upload_url.call_args.kwargs["key"].startswith("audio/s-1/q1_")


def test_s3_upload_url_key_is_confined_to_the_callers_own_prefix():
    """A caller cannot name the key, so it cannot reach another student's recording."""
    s3 = MagicMock()
    s3.generate_upload_url.return_value = {"uploadUrl": "u", "fileUrl": "f"}
    client = _build_client(
        s3_service=s3,
        principal=AuthPrincipal(user_id="s-1", roles=["student"], source="jwt"),
    )

    # The old `filename` parameter is gone; a key supplied by the caller is ignored.
    response = client.post(
        "/api/s3/upload-url?kind=audio&question_id=q1&filename=audio/s-2/steal.webm"
    )

    assert response.status_code == 200
    assert s3.generate_upload_url.call_args.kwargs["key"].startswith("audio/s-1/")

    # And an id crafted to climb out of the prefix is rejected outright.
    traversal = client.post("/api/s3/upload-url?kind=audio&question_id=../../s-2/steal")

    assert traversal.status_code == 400
    assert traversal.json()["error"]["code"] == "invalid_upload_request"


def test_s3_upload_url_proctoring_rejects_other_assessment_for_scoped_token():
    s3 = MagicMock()
    s3.generate_upload_url.return_value = {"uploadUrl": "u", "fileUrl": "f"}
    client = _build_client(
        s3_service=s3,
        principal=AuthPrincipal(
            user_id="s-1", roles=["student"], source="jwt", assessment_id="a1"
        ),
    )

    response = client.post(
        "/api/s3/upload-url?kind=proctoring&assessment_id=a2&chunk_index=0&content_type=video/webm"
    )

    assert response.status_code == 403
    s3.generate_upload_url.assert_not_called()


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("post", "/internal/context/upload", {"json": {"DocumentName": "d", "Description": "desc", "Text": "t", "Scope": "default"}}),
        ("delete", "/internal/context/delete", {"json": {"document_id": "d1"}}),
        ("post", "/internal/context/list", {"json": {"Offset": 0, "Limit": 10, "Scope": "default"}}),
        ("post", "/internal/context/uploadFile", {"data": {"DocumentName": "D"}, "files": {"File": ("t.pdf", b"x", "application/pdf")}}),
    ],
)
def test_context_routes_reject_unauthenticated_callers(method, path, kwargs):
    """The course corpus is not world-writable — every /internal/context route needs auth."""
    app = create_app()
    app.dependency_overrides[get_context_service] = lambda: MagicMock()
    client = TestClient(app)

    response = client.request(method.upper(), path, **kwargs)

    assert response.status_code == 401


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("post", "/internal/context/upload", {"json": {"DocumentName": "d", "Description": "desc", "Text": "t", "Scope": "default"}}),
        ("delete", "/internal/context/delete", {"json": {"document_id": "d1"}}),
        ("post", "/internal/context/list", {"json": {"Offset": 0, "Limit": 10, "Scope": "default"}}),
        ("post", "/internal/context/uploadFile", {"data": {"DocumentName": "D"}, "files": {"File": ("t.pdf", b"x", "application/pdf")}}),
    ],
)
def test_context_routes_reject_students(method, path, kwargs):
    svc = MagicMock()
    client = _build_client(
        context_service=svc,
        principal=AuthPrincipal(user_id="s-1", roles=["student"], source="jwt"),
    )

    response = client.request(method.upper(), path, **kwargs)

    assert response.status_code == 403
