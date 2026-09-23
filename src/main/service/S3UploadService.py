from __future__ import annotations

import logging
import re
import time
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError


logger = logging.getLogger(__name__)


# Media types clients are allowed to upload, mapped to the file extension used in
# the S3 key. The extension never comes from the request.
ALLOWED_CONTENT_TYPES = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/mp4": "mp4",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
}

# Ids that end up inside an S3 key. Deliberately excludes "/" so a caller cannot
# escape their own prefix.
_SAFE_ID = re.compile(r"[A-Za-z0-9._@-]{1,128}")

_MAX_CHUNK_INDEX = 999_999


class S3UploadServiceError(Exception):
    pass


def _safe_id(label: str, value: str | None) -> str:
    if not value or not _SAFE_ID.fullmatch(value) or ".." in value:
        raise S3UploadServiceError(f"Invalid {label}")
    return value


def _extension_for(content_type: str) -> str:
    """Resolve the key extension from the declared media type, via an allowlist."""
    if not content_type or len(content_type) > 128:
        raise S3UploadServiceError("Invalid content type")
    media_type = content_type.split(";", 1)[0].strip().lower()
    extension = ALLOWED_CONTENT_TYPES.get(media_type)
    if not extension:
        raise S3UploadServiceError(f"Unsupported content type: {media_type}")
    return extension


def build_upload_key(
    *,
    kind: str,
    user_id: str,
    content_type: str,
    question_id: str | None = None,
    assessment_id: str | None = None,
    chunk_index: int | None = None,
) -> str:
    """Build the S3 key server-side.

    `user_id` comes from the authenticated principal, never from the request, so a
    caller can only ever write under their own prefix. The `audio/` and
    `proctoring/` prefixes are load-bearing — S3 lifecycle rules key off them.
    """
    extension = _extension_for(content_type)
    owner = _safe_id("user id", user_id)

    if kind == "audio":
        question = _safe_id("question id", question_id)
        return f"audio/{owner}/{question}_{int(time.time() * 1000)}.{extension}"

    if kind == "proctoring":
        assessment = _safe_id("assessment id", assessment_id)
        if chunk_index is None or chunk_index < 0 or chunk_index > _MAX_CHUNK_INDEX:
            raise S3UploadServiceError("Invalid chunk index")
        return f"proctoring/{assessment}/{owner}/chunk_{chunk_index:06d}.{extension}"

    raise S3UploadServiceError(f"Unsupported upload kind: {kind}")


def assert_owned_upload(url: str, prefix: str, label: str) -> None:
    """Refuse a media URL that does not point under `prefix`.

    Students hand back the fileUrl they uploaded to, and it is stored and later
    presigned for GET by key alone (host ignored) — for the instructor, and for the
    student on their results page. Without this a student could store another
    student's key, e.g. the guessable proctoring/{assessment}/{student}/chunk_000000,
    and be handed a download link for it. The key is parsed the same way the
    presigners parse it.
    """
    key = urlparse(url or "").path.lstrip("/")
    if not key.startswith(prefix) or ".." in key:
        raise ValueError(f"{label} is not an upload belonging to this student")


class S3UploadService:
    def __init__(self, bucket_name: str, region: str):
        self.bucket_name = bucket_name
        self.region = region
        self.client = boto3.client("s3", region_name=region)

    def generate_upload_url(self, key: str, content_type: str = "audio/webm") -> dict:
        try:
            presigned_url = self.client.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": self.bucket_name,
                    "Key": key,
                    # Signed into the URL: the client's PUT must send this exact Content-Type.
                    "ContentType": content_type,
                },
                ExpiresIn=3600,
            )
            file_url = f"https://{self.bucket_name}.s3.{self.region}.amazonaws.com/{key}"
            logger.info("Generated presigned URL for: %s", key)
            return {
                "uploadUrl": presigned_url,
                "fileUrl": file_url,
            }
        except ClientError as error:
            error_message = error.response.get("Error", {}).get("Message", "Unknown S3 error")
            logger.error("S3 presign failed: %s", error_message)
            raise S3UploadServiceError(error_message) from error
