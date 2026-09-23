from __future__ import annotations

from typing import Any, Dict, List, Optional

from boto3.dynamodb.conditions import Key


class InstructorAssessmentCatalog:
    def __init__(self, *, table):
        self.table = table

    @staticmethod
    def to_assessment_view(item: Dict[str, Any]) -> Dict[str, Any]:
        # This is the only read path for assessment config used by the instructor
        # API, the auto-evaluation trigger and the cohort report service. Any
        # stored attribute omitted here is silently invisible to all three — a
        # missing autoEvaluate is what stopped auto-marking from ever firing.
        # Defaults below reproduce pre-flag behaviour for items written before
        # the flag existed.
        answer_mode = item.get("answerMode", "oral")
        cutoffs = item.get("gradeCutoffs")

        return {
            "id": item["id"],
            "createdBy": item.get("createdBy"),
            "title": item["title"],
            "course": item["course"],
            "description": item.get("description", ""),
            "dueDate": item["dueDate"],
            "totalQuestions": int(item["totalQuestions"]),
            # timeLimit is stored in seconds; convert back to minutes for instructor display
            "timeLimit": int(int(item["timeLimit"]) / 60) if item.get("timeLimit") else None,
            "status": item.get("status", "draft"),
            "createdAt": item["createdAt"],
            "updatedAt": item.get("updatedAt", item["createdAt"]),
            "accessMode": item.get("accessMode", "open"),
            "scheduledWindowStart": item.get("scheduledWindowStart"),
            "scheduledWindowEnd": item.get("scheduledWindowEnd"),
            "assignmentBrief": item.get("assignmentBrief"),
            "activeGenerationJobId": item.get("activeGenerationJobId"),
            "answerMode": answer_mode,
            "preparationTime": item.get("preparationTime"),
            "rubric": item.get("rubric"),
            "autoEvaluate": bool(item.get("autoEvaluate", False)),
            "autoReport": bool(item.get("autoReport", True)),
            "autoReportThreshold": (
                int(item["autoReportThreshold"])
                if item.get("autoReportThreshold") is not None
                else None
            ),
            "proctored": bool(item.get("proctored", answer_mode == "oral")),
            "allowReview": bool(item.get("allowReview", False)),
            "feedbackRelease": item.get("feedbackRelease", "manual"),
            "maxScorePerQuestion": (
                int(item["maxScorePerQuestion"])
                if item.get("maxScorePerQuestion") is not None
                else None
            ),
            # Stored as Decimal by DynamoDB; the API contract is float.
            "gradeCutoffs": {k: float(v) for k, v in cutoffs.items()} if cutoffs else None,
            "resultsReleased": bool(item.get("resultsReleased", False)),
        }

    def list_assessments(self, owner_user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        response = self.table.query(
            IndexName="InstructorAssessmentsIndex",
            KeyConditionExpression=Key("GSI1PK").eq("ASSESSMENT"),
            ScanIndexForward=False,
        )

        assessments: List[Dict[str, Any]] = []
        for item in response.get("Items", []):
            created_by = item.get("createdBy")
            # No createdBy means no owner, not every owner: every other route
            # already refuses such an assessment, so the list must not show it.
            if owner_user_id and created_by != owner_user_id:
                continue
            assessments.append(self.to_assessment_view(item))
        return assessments

    def get_assessment(self, assessment_id: str) -> Dict[str, Any]:
        response = self.table.get_item(
            Key={
                "PK": f"ASSESSMENT#{assessment_id}",
                "SK": "METADATA",
            }
        )
        if "Item" not in response:
            raise ValueError(f"Assessment {assessment_id} not found")
        return self.to_assessment_view(response["Item"])
