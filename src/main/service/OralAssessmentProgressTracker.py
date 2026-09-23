from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from boto3.dynamodb.conditions import Key

from src.main.service.OralAssessmentQuestionAccess import OralAssessmentQuestionAccess


class OralAssessmentProgressTracker:
    def __init__(self, *, table, question_access: OralAssessmentQuestionAccess | None = None):
        self.table = table
        self.question_access = question_access or OralAssessmentQuestionAccess(table=table)

    def update_progress(self, student_id: str, assessment_id: str) -> None:
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"

        # Must match get_student_progress: submit_assessment gates on this total.
        total_questions = self.question_access.count_served_questions(student_id, assessment_id)

        answers_response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("ANSWER#")
        )
        answered_questions = len(answers_response.get("Items", []))

        percentage = round((answered_questions / total_questions * 100), 1) if total_questions > 0 else 0

        if answered_questions == 0:
            status = "not-started"
        elif answered_questions < total_questions:
            status = "in-progress"
        else:
            status = "completed"

        self.table.put_item(
            Item={
                "PK": pk,
                "SK": "PROGRESS",
                "totalQuestions": total_questions,
                "answeredQuestions": answered_questions,
                "percentage": Decimal(str(percentage)),
                "status": status,
                "lastUpdated": datetime.now(timezone.utc).isoformat(),
            }
        )
