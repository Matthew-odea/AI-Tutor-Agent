from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from src.main.service.S3UploadService import (
    S3UploadService,
    S3UploadServiceError,
    build_upload_key,
)


def test_generate_upload_url_success(monkeypatch):
    mock_client = MagicMock()
    mock_client.generate_presigned_url.return_value = "https://signed.example/upload"
    monkeypatch.setattr("src.main.service.S3UploadService.boto3.client", lambda *a, **k: mock_client)

    service = S3UploadService(bucket_name="bucket-a", region="us-east-1")
    result = service.generate_upload_url(key="audio/test.webm", content_type="audio/webm")

    assert result["uploadUrl"] == "https://signed.example/upload"
    assert result["fileUrl"] == "https://bucket-a.s3.us-east-1.amazonaws.com/audio/test.webm"


def test_generate_upload_url_client_error_raises_service_error(monkeypatch):
    mock_client = MagicMock()
    mock_client.generate_presigned_url.side_effect = ClientError(
        {"Error": {"Message": "denied", "Code": "AccessDenied"}},
        "PutObject",
    )
    monkeypatch.setattr("src.main.service.S3UploadService.boto3.client", lambda *a, **k: mock_client)

    service = S3UploadService(bucket_name="bucket-a", region="us-east-1")

    with pytest.raises(S3UploadServiceError) as error:
        service.generate_upload_url(key="audio/test.webm")

    assert "denied" in str(error.value)


class TestBuildUploadKey:
    """The key is built from the authenticated principal — a caller cannot name it."""

    def test_audio_key_uses_principal_and_server_timestamp(self):
        key = build_upload_key(
            kind="audio", user_id="z1", content_type="audio/webm;codecs=opus", question_id="q1"
        )

        assert key.startswith("audio/z1/q1_")
        assert key.endswith(".webm")

    def test_proctoring_key_keeps_prefix_and_chunk_ordering(self):
        key = build_upload_key(
            kind="proctoring",
            user_id="z1",
            content_type="video/webm",
            assessment_id="a1",
            chunk_index=7,
        )

        assert key == "proctoring/a1/z1/chunk_000007.webm"

    @pytest.mark.parametrize(
        "question_id",
        ["../../other/key", "z2/q1", "", None],
    )
    def test_rejects_ids_that_would_escape_the_prefix(self, question_id):
        with pytest.raises(S3UploadServiceError):
            build_upload_key(
                kind="audio", user_id="z1", content_type="audio/webm", question_id=question_id
            )

    def test_rejects_content_type_outside_allowlist(self):
        with pytest.raises(S3UploadServiceError):
            build_upload_key(
                kind="audio", user_id="z1", content_type="text/html", question_id="q1"
            )

    def test_proctoring_requires_a_valid_chunk_index(self):
        with pytest.raises(S3UploadServiceError):
            build_upload_key(
                kind="proctoring",
                user_id="z1",
                content_type="video/webm",
                assessment_id="a1",
                chunk_index=None,
            )
