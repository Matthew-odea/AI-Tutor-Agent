from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

import boto3
from boto3.dynamodb.conditions import Key


class ResponseEvaluationRepository:
    def __init__(self, table_name: Optional[str] = None, region: Optional[str] = None):
        self.table_name = table_name or os.getenv("DYNAMODB_ASSESSMENT_TABLE", "oral_assessments")
        self.region = region or os.getenv("AWS_REGION", "us-east-1")
        self.dynamodb = boto3.resource("dynamodb", region_name=self.region)
        self.table = self.dynamodb.Table(self.table_name)

    def count_answers(self, student_id: str, assessment_id: str) -> int:
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("ANSWER#")
        )
        return len(response.get("Items", []))

    def read_questions(self, student_id: str, assessment_id: str) -> List[Dict[str, Any]]:
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("QUESTION#")
        )
        return response.get("Items", [])

    def read_answers(self, student_id: str, assessment_id: str) -> List[Dict[str, Any]]:
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("ANSWER#")
        )
        return response.get("Items", [])

    def set_evaluation_progress(
        self,
        student_id: str,
        assessment_id: str,
        questions_evaluated: int,
        total_questions: int,
        status: str = "evaluating",
    ) -> None:
        """Write (or overwrite) the EVAL_PROGRESS marker for a student's evaluation run."""
        percentage = round(questions_evaluated / total_questions * 100, 1) if total_questions > 0 else 0.0
        self.table.put_item(Item={
            "PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
            "SK": "EVAL_PROGRESS",
            "studentId": student_id,
            "assessmentId": assessment_id,
            "questionsEvaluated": questions_evaluated,
            "totalQuestions": total_questions,
            "percentage": str(percentage),
            "status": status,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        })

    def get_evaluation_progress(
        self,
        student_id: str,
        assessment_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Read the EVAL_PROGRESS item, or None if not present."""
        resp = self.table.get_item(
            Key={
                "PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
                "SK": "EVAL_PROGRESS",
            }
        )
        return resp.get("Item")

    def store_evaluation(
        self,
        student_id: str,
        assessment_id: str,
        question_id: str,
        evaluation: Dict[str, Any],
    ) -> None:
        """Write the AI evaluation for one question.

        An update that sets only the AI-owned attributes, never a read-then-put:
        the instructor override (instructorScore / instructorComment) and the
        human reference scores are written by their own update paths, and a
        re-evaluation must not be able to wipe them — neither when the read
        fails nor when an override lands between the read and the write.
        """
        fields: Dict[str, Any] = {
            "questionId": question_id,
            "assessmentId": assessment_id,
            "studentId": student_id,
            "correctnessScore": Decimal(str(evaluation.get("correctness_score", 0))),
            "understandingScore": Decimal(str(evaluation.get("understanding_score", 0))),
            "totalScore": Decimal(str(evaluation.get("total_score", 0))),
            "maxScore": Decimal(str(evaluation.get("max_score", 10))),
            "feedback": evaluation.get("feedback", ""),
            "strengths": evaluation.get("strengths", []),
            "weaknesses": evaluation.get("weaknesses", []),
            "suggestedImprovements": evaluation.get("suggested_improvements", []),
            "evaluatedAt": datetime.now(timezone.utc).isoformat() + "Z",
            # Review / confidence flags (Tasks 2, 4, 5). Always written so the
            # instructor and release gate can reason about evaluation quality.
            "needsReview": bool(evaluation.get("needs_review", False)),
            "reviewReasons": list(evaluation.get("review_reasons", []) or []),
            "evaluationMethod": evaluation.get("evaluation_method", "text"),
        }
        confidence = evaluation.get("transcript_confidence")
        if confidence is not None:
            fields["transcriptConfidence"] = Decimal(str(confidence))

        expression = "SET " + ", ".join(f"#{k} = :{k}" for k in fields)
        names = {f"#{k}": k for k in fields}
        if confidence is None:
            # A re-evaluation without a transcript confidence must not keep a stale one.
            expression += " REMOVE #transcriptConfidence"
            names["#transcriptConfidence"] = "transcriptConfidence"

        self.table.update_item(
            Key={
                "PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
                "SK": f"EVALUATION#{question_id}",
            },
            UpdateExpression=expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={f":{k}": v for k, v in fields.items()},
        )

    def record_human_score(
        self,
        student_id: str,
        assessment_id: str,
        question_id: str,
        *,
        human_correctness_score: int,
        human_understanding_score: int,
        scored_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Record (or update) a HUMAN reference score for the dual-scoring validity
        harness. This is deliberately SEPARATE from ``instructorScore`` (the grade
        override): the human reference score is captured for every dual-scored item
        — including those where the human agrees with the AI — so AI-vs-human
        agreement is measured on an unbiased sample and does not change the
        student's grade.
        """
        human_total = int(human_correctness_score) + int(human_understanding_score)
        scored_at = datetime.now(timezone.utc).isoformat() + "Z"
        self.table.update_item(
            Key={
                "PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
                "SK": f"EVALUATION#{question_id}",
            },
            UpdateExpression=(
                "SET humanCorrectnessScore = :hc, humanUnderstandingScore = :hu, "
                "humanTotalScore = :ht, humanScoredBy = :hb, humanScoredAt = :ha"
            ),
            ExpressionAttributeValues={
                ":hc": Decimal(str(int(human_correctness_score))),
                ":hu": Decimal(str(int(human_understanding_score))),
                ":ht": Decimal(str(human_total)),
                ":hb": scored_by or "",
                ":ha": scored_at,
            },
        )
        return {
            "studentId": student_id,
            "assessmentId": assessment_id,
            "questionId": question_id,
            "humanCorrectnessScore": int(human_correctness_score),
            "humanUnderstandingScore": int(human_understanding_score),
            "humanTotalScore": human_total,
            "humanScoredBy": scored_by or "",
            "humanScoredAt": scored_at,
        }
