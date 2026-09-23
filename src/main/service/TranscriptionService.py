"""Downloads audio/video answers from S3, transcribes via Deepgram, writes transcript back to the ANSWER# item.

Runs as a pre-pass in EvaluationWorkflowRunner.evaluate_from_dynamodb so the evaluator sees a transcript.
Up to 3 attempts with 1s/2s backoff; an unparseable URL or missing S3 key is not retried.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from decimal import Decimal
from typing import Optional
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

from src.main.service.SpeechToTextService import DeepgramTranscribeService

logger = logging.getLogger(__name__)

_RETRYABLE_ATTEMPTS = 3
_RETRY_BASE_DELAY = 1  # seconds


class TranscriptionService:
    def __init__(
        self,
        *,
        table,
        s3_client=None,
        deepgram_service: Optional[DeepgramTranscribeService] = None,
        region: str = "us-east-1",
    ):
        self.table = table
        self.s3 = s3_client or boto3.client("s3", region_name=region)
        self.deepgram = deepgram_service or DeepgramTranscribeService()

    def transcribe_pending_answers(self, student_id: str, assessment_id: str) -> int:
        """Transcribe audio/video answers that lack a transcript. Returns the number transcribed."""
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        from boto3.dynamodb.conditions import Key
        response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("ANSWER#")
        )
        answers = response.get("Items", [])

        transcribed = 0
        for answer in answers:
            answer_type = answer.get("answerType", "audio")
            if answer_type not in ("audio", "video"):
                continue
            if answer.get("transcript"):
                continue

            question_id = answer.get("questionId", answer.get("SK", "").replace("ANSWER#", ""))
            media_url = answer.get("audioUrl") or answer.get("videoUrl") or ""
            if not media_url:
                logger.warning(
                    "[Transcription] No media URL for student=%s assessment=%s question=%s",
                    student_id, assessment_id, question_id,
                )
                self._write_transcript_status(pk, question_id, "", "missing_url")
                continue

            result = self._transcribe_url_with_retry(media_url, student_id, question_id)
            if result is not None:
                self._write_transcript_status(
                    pk, question_id, result["transcript"], "completed",
                    confidence=result.get("confidence"),
                )
                transcribed += 1
            else:
                self._write_transcript_status(pk, question_id, "", "failed")

        return transcribed

    def _transcribe_url_with_retry(
        self, url: str, student_id: str, question_id: str
    ) -> Optional[dict]:
        """Return {"transcript", "confidence"}, or None if the media is missing or all attempts fail."""
        bucket, key = _parse_s3_url(url)
        if not bucket or not key:
            logger.error(
                "[Transcription] Cannot parse S3 URL for student=%s question=%s: %s",
                student_id, question_id, url,
            )
            return None

        ext = os.path.splitext(key)[-1] or ".webm"

        for attempt in range(1, _RETRYABLE_ATTEMPTS + 1):
            try:
                with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                    tmp_path = tmp.name

                try:
                    self.s3.download_file(bucket, key, tmp_path)
                except ClientError as e:
                    code = e.response["Error"]["Code"]
                    if code in ("NoSuchKey", "404"):
                        logger.error(
                            "[Transcription] S3 key not found (student=%s question=%s): %s/%s",
                            student_id, question_id, bucket, key,
                        )
                        return None  # not retryable
                    raise

                if hasattr(self.deepgram, "transcribe_with_metadata"):
                    meta = self.deepgram.transcribe_with_metadata(tmp_path)
                    transcript = (meta.get("transcript") or "") if isinstance(meta, dict) else (meta or "")
                    confidence = meta.get("confidence") if isinstance(meta, dict) else None
                else:
                    transcript = self.deepgram.transcribe(tmp_path) or ""
                    confidence = None
                logger.info(
                    "[Transcription] Transcribed student=%s question=%s (%d chars, confidence=%s)",
                    student_id, question_id, len(transcript), confidence,
                )
                return {"transcript": transcript, "confidence": confidence}

            except Exception as e:
                if attempt < _RETRYABLE_ATTEMPTS:
                    delay = _RETRY_BASE_DELAY * (2 ** (attempt - 1))
                    logger.warning(
                        "[Transcription] Attempt %d/%d failed for student=%s question=%s, retrying in %ds: %s",
                        attempt, _RETRYABLE_ATTEMPTS, student_id, question_id, delay, e,
                    )
                    time.sleep(delay)
                else:
                    logger.error(
                        "[Transcription] All %d attempts failed for student=%s question=%s: %s",
                        _RETRYABLE_ATTEMPTS, student_id, question_id, e,
                    )
            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

        return None

    def _write_transcript_status(
        self,
        pk: str,
        question_id: str,
        transcript: str,
        status: str,
        confidence: Optional[float] = None,
    ) -> None:
        """transcriptConfidence is read by the evaluation engine to flag low-confidence transcripts."""
        update_expr = "SET transcript = :t, transcript_status = :s"
        values = {":t": transcript, ":s": status}
        if confidence is not None:
            update_expr += ", transcriptConfidence = :c"
            values[":c"] = Decimal(str(confidence))
        try:
            self.table.update_item(
                Key={"PK": pk, "SK": f"ANSWER#{question_id}"},
                UpdateExpression=update_expr,
                ExpressionAttributeValues=values,
            )
        except ClientError as e:
            logger.error(
                "[Transcription] Failed to write transcript for pk=%s question=%s: %s",
                pk, question_id, e,
            )


def _parse_s3_url(url: str) -> tuple[str, str]:
    """(bucket, key) from s3://, virtual-hosted or path-style S3 URLs; ("", "") if unparseable."""
    if not url:
        return "", ""

    try:
        parsed = urlparse(url)

        if parsed.scheme == "s3":
            return parsed.netloc, parsed.path.lstrip("/")

        host = parsed.hostname or ""
        # <bucket>.s3[.<region>].amazonaws.com
        if host.endswith(".amazonaws.com") and ".s3" in host:
            bucket = host.split(".s3")[0]
            key = parsed.path.lstrip("/")
            return bucket, key

        # Legacy path-style: s3[.<region>].amazonaws.com/<bucket>/<key>
        if host in ("s3.amazonaws.com",) or host.startswith("s3.") and host.endswith(".amazonaws.com"):
            parts = parsed.path.lstrip("/").split("/", 1)
            if len(parts) == 2:
                return parts[0], parts[1]

    except Exception:
        pass

    return "", ""
