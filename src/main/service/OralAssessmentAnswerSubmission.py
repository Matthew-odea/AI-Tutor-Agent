from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional


class OralAssessmentAnswerSubmission:
    def __init__(self, *, table, progress_updater: Callable[[str, str], None]):
        self.table = table
        self.progress_updater = progress_updater

    def submit_answer(
        self,
        *,
        student_id: str,
        question_id: str,
        assessment_id: str,
        answer_type: str = "audio",
        audio_url: Optional[str] = None,
        duration: Optional[int] = None,
        text_content: Optional[str] = None,
        video_url: Optional[str] = None,
        allow_review: bool = False,
    ) -> Dict[str, Any]:
        if answer_type == "text" and not (text_content and text_content.strip()):
            raise ValueError("Text answer cannot be empty")
        if answer_type == "audio" and not audio_url:
            raise ValueError("Audio URL is required for audio answers")

        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        submitted_at = datetime.now(timezone.utc).isoformat()

        dynamo_item: Dict[str, Any] = {
            "PK": pk,
            "SK": f"ANSWER#{question_id}",
            "questionId": question_id,
            "answerType": answer_type,
            "submittedAt": submitted_at,
            "status": "submitted",
        }
        if answer_type == "text":
            dynamo_item["textContent"] = text_content or ""
        elif answer_type == "video":
            dynamo_item["videoUrl"] = video_url or ""
            dynamo_item["duration"] = duration or 0
        elif answer_type == "skipped":
            # Zero-credit skip, no content. EvaluationWorkflowRunner scores it 0 without
            # the LLM; it still counts as answered so the student can submit.
            pass
        else:  # audio
            dynamo_item["audioUrl"] = audio_url or ""
            dynamo_item["duration"] = duration or 0

        from boto3.dynamodb.conditions import Attr
        if allow_review:
            # Upsert so the student can revise; overwriting doesn't change the ANSWER# count.
            self.table.put_item(Item=dynamo_item)
        else:
            # Atomic check-and-store blocks duplicate submissions.
            self.table.put_item(
                Item=dynamo_item,
                ConditionExpression=Attr("SK").not_exists(),
            )

        self.progress_updater(student_id, assessment_id)

        return {
            "ok": True,
            "studentId": student_id,
            "questionId": question_id,
            "answerType": answer_type,
            "audioUrl": audio_url,
            "duration": duration,
            "textContent": text_content,
            "videoUrl": video_url,
            "submittedAt": submitted_at,
            "assessmentId": assessment_id,
        }

    def submit_proctor_chunk(
        self,
        *,
        student_id: str,
        assessment_id: str,
        chunk_url: str,
        chunk_index: int,
        timestamp: Optional[str] = None,
    ) -> Dict[str, Any]:
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        recorded_at = timestamp or datetime.now(timezone.utc).isoformat()

        self.table.put_item(Item={
            "PK": pk,
            "SK": f"PROCTORING#CHUNK#{chunk_index:06d}",
            "chunkIndex": chunk_index,
            "chunkUrl": chunk_url,
            "recordedAt": recorded_at,
        })

        return {
            "ok": True,
            "studentId": student_id,
            "assessmentId": assessment_id,
            "chunkIndex": chunk_index,
        }
