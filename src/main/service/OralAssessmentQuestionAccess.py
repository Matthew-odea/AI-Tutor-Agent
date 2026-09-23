from __future__ import annotations

from typing import Any, Dict, List, Optional

from boto3.dynamodb.conditions import Key


class OralAssessmentQuestionAccess:
    def __init__(self, *, table):
        self.table = table

    def ensure_student_enrollment(self, student_id: str, assessment_id: str) -> None:
        enrollment = self.table.get_item(
            Key={
                "PK": f"STUDENT#{student_id}",
                "SK": f"ASSESSMENT#{assessment_id}",
            }
        )
        if "Item" not in enrollment:
            raise ValueError(f"Student {student_id} not enrolled in assessment {assessment_id}")

    def get_student_questions(self, student_id: str, assessment_id: str) -> List[Dict[str, Any]]:
        pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"
        response = self.table.query(
            KeyConditionExpression=Key("PK").eq(pk) & Key("SK").begins_with("QUESTION#")
        )
        return response.get("Items", [])

    def count_served_questions(self, student_id: str, assessment_id: str) -> int:
        """Size of the student's own QUESTION# set; progress totals and submit gating use this."""
        return len(self.get_student_questions(student_id, assessment_id))

    def to_student_question_view(
        self,
        student_items: List[Dict[str, Any]],
        *,
        student_id: str,
        assessment_id: str,
        assessment_time_limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Project DynamoDB items into the student view, numbered sequentially.

        Item attribute names are the camelCase ones QuestionGenerationService writes.
        """

        def _to_view(item: Dict[str, Any], question_number: int) -> Dict[str, Any]:
            raw_id = item.get("id", item["SK"].replace("QUESTION#", ""))
            per_question_limit = item.get("timeLimit")
            effective_limit = per_question_limit if per_question_limit is not None else assessment_time_limit
            return {
                "id": raw_id,
                "questionNumber": question_number,
                "type": item.get("questionType", "general"),
                "text": item.get("text", ""),
                "difficulty": item.get("difficulty", "medium"),
                "topic": item.get("topic", ""),
                "codeContext": item.get("codeContext") or item.get("code_reference"),
                "rationale": item.get("rationale", ""),
                "timeLimit": effective_limit,
                "assessmentId": assessment_id,
                "studentId": student_id,
                "createdAt": item.get("createdAt", ""),
            }

        student_items_sorted = sorted(
            student_items, key=lambda q: q.get("questionNumber", 999)
        )

        questions: List[Dict[str, Any]] = []
        for idx, item in enumerate(student_items_sorted, start=1):
            questions.append(_to_view(item, idx))

        return questions

    @staticmethod
    def gate_question_content(
        questions: List[Dict[str, Any]],
        current_question_idx: int,
    ) -> List[Dict[str, Any]]:
        """Strip content from questions after current_question_idx so students cannot read ahead."""
        gated: List[Dict[str, Any]] = []
        # Clamp so a corrupted index can't ungate everything.
        safe_idx = min(current_question_idx, len(questions) - 1) if questions else -1
        for idx, q in enumerate(questions):
            if idx <= safe_idx:
                gated.append(q)
            else:
                gated.append({
                    "id": q["id"],
                    "questionNumber": q.get("questionNumber"),
                    "assessmentId": q.get("assessmentId"),
                    "studentId": q.get("studentId"),
                    "createdAt": q.get("createdAt", ""),
                })
        return gated
