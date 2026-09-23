from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

from src.main.service.ScoringConfig import ScoringConfig

logger = logging.getLogger(__name__)


class OralAssessmentResultsAggregator:
    def __init__(self, *, table, s3_bucket: Optional[str] = None, s3_region: Optional[str] = None):
        self.table = table
        self._s3_bucket = s3_bucket
        self._s3_region = s3_region
        self._s3_client: Optional[Any] = None

    def _get_s3_client(self):
        if self._s3_client is None and self._s3_bucket:
            self._s3_client = boto3.client("s3", region_name=self._s3_region or "us-east-1")
        return self._s3_client

    def _presign_audio_url(self, raw_url: Optional[str]) -> Optional[str]:
        """Convert a raw S3 URL to a presigned GET URL (1 hour expiry)."""
        if not raw_url or not self._s3_bucket:
            return raw_url
        # Extract the S3 key from the URL
        parsed = urlparse(raw_url)
        key = parsed.path.lstrip("/")
        if not key:
            return raw_url
        client = self._get_s3_client()
        if not client:
            return raw_url
        try:
            return client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._s3_bucket, "Key": key},
                ExpiresIn=3600,
            )
        except ClientError:
            logger.warning("Failed to presign audio URL: %s", raw_url)
            return raw_url

    def get_student_results(self, *, student_id: str, assessment_id: str) -> Dict[str, Any]:
        enrollment_response = self.table.get_item(
            Key={
                "PK": f"ASSESSMENT#{assessment_id}",
                "SK": f"STUDENT#{student_id}",
            }
        )

        if "Item" not in enrollment_response:
            raise ValueError(f"Student {student_id} not enrolled in assessment {assessment_id}")

        enrollment = enrollment_response["Item"]

        assessment_response = self.table.get_item(
            Key={
                "PK": f"ASSESSMENT#{assessment_id}",
                "SK": "METADATA",
            }
        )
        assessment = assessment_response.get("Item", {})

        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"

        questions_response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("QUESTION#")
        )
        answers_response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("ANSWER#")
        )
        evaluations_response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("EVALUATION#")
        )

        questions_map = {
            item["SK"].replace("QUESTION#", ""): item for item in questions_response.get("Items", [])
        }
        answers_map = {
            item["SK"].replace("ANSWER#", ""): item for item in answers_response.get("Items", [])
        }
        evaluations_map = {
            item["SK"].replace("EVALUATION#", ""): item for item in evaluations_response.get("Items", [])
        }

        # feedbackRelease == 'immediate' bypasses the manual instructor release gate
        # (formative flows); 'manual' (default / legacy) still requires resultsReleased.
        if assessment.get("feedbackRelease") != "immediate" and not assessment.get("resultsReleased"):
            raise ValueError(f"Results not released yet for student {student_id}")

        if not evaluations_map:
            raise ValueError(f"Results not available yet for student {student_id}")

        scoring = ScoringConfig.from_metadata(assessment)

        question_results = []
        total_score = 0
        max_score = 0

        for q_num, (question_id, question) in enumerate(questions_map.items(), start=1):
            answer = answers_map.get(question_id, {})
            evaluation = evaluations_map.get(question_id, {})

            # instructorScore is the grade override and wins over the AI score.
            # humanTotalScore is the dual-scoring validity harness and deliberately
            # does NOT affect the grade — see ResponseEvaluationRepository.record_human_score.
            override = evaluation.get("instructorScore")
            if override is not None:
                score = int(override)
            elif evaluation.get("totalScore") is not None:
                score = int(evaluation.get("totalScore", 0))
            else:
                score = None
            q_max_score = int(evaluation.get("maxScore", scoring.max_score_per_question)) if evaluation.get("maxScore") is not None else scoring.max_score_per_question
            correctness = int(evaluation.get("correctnessScore", 0)) if evaluation.get("correctnessScore") is not None else 0
            understanding = int(evaluation.get("understandingScore", 0)) if evaluation.get("understandingScore") is not None else 0

            # Ensure strengths/weaknesses/improvements are lists
            raw_strengths = evaluation.get("strengths", [])
            strengths = list(raw_strengths) if isinstance(raw_strengths, (list, set)) else ([raw_strengths] if raw_strengths else [])
            raw_weaknesses = evaluation.get("weaknesses", [])
            weaknesses = list(raw_weaknesses) if isinstance(raw_weaknesses, (list, set)) else ([raw_weaknesses] if raw_weaknesses else [])
            raw_improvements = evaluation.get("suggestedImprovements", [])
            suggested_improvements = list(raw_improvements) if isinstance(raw_improvements, (list, set)) else ([raw_improvements] if raw_improvements else [])

            # An evaluation flagged for review is unscored, not zero-scored: the AI
            # could not judge it, so it is waiting on a human. Leaving it in the
            # denominator makes a system failure indistinguishable from a wrong
            # answer. An instructor override settles it, so it counts again.
            awaiting_review = bool(evaluation.get("needsReview")) and override is None

            if score is not None and not awaiting_review:
                total_score += score
                max_score += q_max_score

            question_results.append(
                {
                    "questionId": question_id,
                    "questionNumber": q_num,
                    "questionText": question.get("text", ""),
                    "questionType": question.get("questionType"),
                    "audioUrl": self._presign_audio_url(answer.get("audioUrl")),
                    "transcript": answer.get("transcript"),
                    "duration": int(answer.get("duration", 0)) if answer.get("duration") else None,
                    "totalScore": score,
                    "correctnessScore": correctness,
                    "understandingScore": understanding,
                    "maxScore": q_max_score,
                    "feedback": evaluation.get("feedback"),
                    "strengths": strengths,
                    "weaknesses": weaknesses,
                    "suggestedImprovements": suggested_improvements,
                    "evaluatedAt": evaluation.get("evaluatedAt"),
                    "awaitingReview": awaiting_review,
                }
            )

        awaiting_review_count = sum(1 for q in question_results if q["awaitingReview"])
        percentage = round((total_score / max_score * 100), 1) if max_score > 0 else 0
        grade = scoring.grade(percentage)

        return {
            "studentId": student_id,
            "studentName": enrollment.get("name", ""),
            "studentEmail": enrollment.get("email", ""),
            "assessmentId": assessment_id,
            "assessmentTitle": assessment.get("title", "Unknown Assessment"),
            "status": enrollment.get("status", "unknown"),
            "totalScore": total_score,
            "maxScore": max_score,
            "percentage": percentage,
            # Non-zero means the percentage is over a partial denominator: that many
            # questions are excluded pending instructor review.
            "questionsAwaitingReview": awaiting_review_count,
            "grade": grade,
            "submittedAt": enrollment.get("submittedAt"),
            "evaluatedQuestions": len(evaluations_map),
            "totalQuestions": len(questions_map),
            "questions": question_results,
        }
