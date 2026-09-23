"""
Cohort summary reports, auto-generated once `threshold` students have submitted
(replacing the old all-enrolled-submitted gate, which large cohorts never reach).

Reports are aggregate only: never names, emails or IDs, so a stored report can be
exported or shared without carrying student identities.

Regenerates at each multiple of the threshold (10, 20, 30, ...). Exactly-once per
milestone is enforced by a conditional write on ASSESSMENT#{id} / REPORT_TRIGGER,
not read-then-write, so concurrent submissions crossing a milestone yield one job.
"""

from __future__ import annotations

import logging
import statistics
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional

from boto3.dynamodb.conditions import Key

from src.main.service.ScoringConfig import ScoringConfig

logger = logging.getLogger(__name__)

DEFAULT_REPORT_THRESHOLD = 10

# Fixed deciles keep reports comparable across regenerations and assessments; 101 so 100% lands in the last bucket
_HISTOGRAM_BUCKETS = [
    (0, 10), (10, 20), (20, 30), (30, 40), (40, 50),
    (50, 60), (60, 70), (70, 80), (80, 90), (90, 101),
]


class AssessmentReportServiceError(Exception):
    pass


def _to_float(value: Any, fallback: float = 0.0) -> float:
    if value is None:
        return fallback
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _decimalise(value: Any) -> Any:
    """boto3 rejects Python floats, so convert them recursively."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _decimalise(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decimalise(v) for v in value]
    return value


def _undecimalise(value: Any) -> Any:
    """Inverse of _decimalise, for serving a stored report over JSON."""
    if isinstance(value, Decimal):
        f = float(value)
        return int(f) if f.is_integer() else f
    if isinstance(value, dict):
        return {k: _undecimalise(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_undecimalise(v) for v in value]
    return value


class AssessmentReportService:
    def __init__(
        self,
        *,
        table,
        results_aggregator,
        get_assessment: Callable[[str], Dict[str, Any]],
        llm_client: Optional[Any] = None,
    ):
        self.table = table
        self.results_aggregator = results_aggregator
        self.get_assessment = get_assessment
        self.llm_client = llm_client

    def count_submitted(self, assessment_id: str) -> int:
        total = 0
        kwargs: Dict[str, Any] = {
            "KeyConditionExpression": (
                Key("PK").eq(f"ASSESSMENT#{assessment_id}") & Key("SK").begins_with("STUDENT#")
            ),
            "FilterExpression": "attribute_exists(submittedAt)",
            "Select": "COUNT",
        }
        while True:
            resp = self.table.query(**kwargs)
            total += resp.get("Count", 0)
            last_key = resp.get("LastEvaluatedKey")
            if not last_key:
                return total
            kwargs["ExclusiveStartKey"] = last_key

    @staticmethod
    def resolve_threshold(assessment: Dict[str, Any]) -> int:
        """Per-assessment threshold, defaulting to 10. Non-positive disables."""
        raw = assessment.get("autoReportThreshold")
        if raw is None:
            return DEFAULT_REPORT_THRESHOLD
        try:
            return int(raw)
        except (TypeError, ValueError):
            return DEFAULT_REPORT_THRESHOLD

    def claim_milestone(self, assessment_id: str, milestone: int) -> bool:
        """True for exactly one caller per milestone (whoever wins the conditional write)."""
        try:
            self.table.update_item(
                Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": "REPORT_TRIGGER"},
                UpdateExpression="SET lastMilestone = :m, updatedAt = :ua",
                ConditionExpression="attribute_not_exists(lastMilestone) OR lastMilestone < :m",
                ExpressionAttributeValues={
                    ":m": milestone,
                    ":ua": datetime.now(timezone.utc).isoformat(),
                },
            )
            return True
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return False

    def should_generate_on_submit(self, assessment_id: str) -> Optional[Dict[str, Any]]:
        """Returns {milestone, threshold, submittedCount} if this caller should generate now, else None. Call on every submit."""
        assessment = self.get_assessment(assessment_id)
        if assessment.get("autoReport") is False:
            return None

        threshold = self.resolve_threshold(assessment)
        if threshold <= 0:
            return None

        submitted = self.count_submitted(assessment_id)
        milestone = submitted // threshold
        if milestone < 1:
            return None

        if not self.claim_milestone(assessment_id, milestone):
            return None

        return {"milestone": milestone, "threshold": threshold, "submittedCount": submitted}

    def generate_report(
        self,
        assessment_id: str,
        *,
        triggered_by: str = "manual",
        milestone: Optional[int] = None,
    ) -> Dict[str, Any]:
        try:
            assessment = self.get_assessment(assessment_id)
            results = self.results_aggregator.get_assessment_results(assessment_id)
            submitted_count = self.count_submitted(assessment_id)

            # "Not Evaluated" rows carry a placeholder 0%, so score stats use evaluated students only
            evaluated = [r for r in results if r.get("grade") != "Not Evaluated"]
            percentages = [_to_float(r.get("percentage")) for r in evaluated]

            report = {
                "assessmentId": assessment_id,
                "assessmentTitle": assessment.get("title", ""),
                "course": assessment.get("course", ""),
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "triggeredBy": triggered_by,
                "milestone": milestone,
                "counts": {
                    "enrolled": len(results),
                    "submitted": submitted_count,
                    "evaluated": len(evaluated),
                    "notEvaluated": len(results) - len(evaluated),
                },
                "scores": self._score_stats(percentages),
                "gradeDistribution": self._grade_distribution(evaluated, assessment),
                "histogram": self._histogram(percentages),
                "dimensions": self._dimension_averages(assessment_id),
            }

            # Generated last and failure-tolerant: an LLM outage must not lose the statistics
            report["narrative"] = self._generate_narrative(report)

            self._store_report(assessment_id, report)
            logger.info(
                "Generated report for assessment %s (trigger=%s, milestone=%s, evaluated=%d/%d)",
                assessment_id, triggered_by, milestone, len(evaluated), len(results),
            )
            return report
        except Exception as e:
            logger.error("Failed to generate report for assessment %s: %s", assessment_id, e)
            raise AssessmentReportServiceError(f"Failed to generate report: {e}")

    @staticmethod
    def _score_stats(percentages: List[float]) -> Dict[str, Optional[float]]:
        if not percentages:
            return {"average": None, "median": None, "min": None, "max": None, "stdDev": None}
        return {
            "average": round(statistics.fmean(percentages), 2),
            "median": round(statistics.median(percentages), 2),
            "min": round(min(percentages), 2),
            "max": round(max(percentages), 2),
            # statistics.stdev raises for n < 2
            "stdDev": round(statistics.stdev(percentages), 2) if len(percentages) > 1 else 0.0,
        }

    @staticmethod
    def _grade_distribution(
        evaluated: List[Dict[str, Any]],
        assessment: Dict[str, Any],
    ) -> Dict[str, int]:
        """Grade counts, seeded with every band so absent bands report 0, not missing."""
        scoring = ScoringConfig.from_metadata(assessment)
        counts: Dict[str, int] = {}
        for band in ("Excellent", "Competent", "Developing", "Needs Improvement"):
            counts[band] = 0
        for r in evaluated:
            grade = r.get("grade", "Unknown")
            counts[grade] = counts.get(grade, 0) + 1
        counts["_cutoffs"] = {  # type: ignore[assignment]
            "excellent": scoring.excellent,
            "competent": scoring.competent,
            "developing": scoring.developing,
        }
        return counts

    @staticmethod
    def _histogram(percentages: List[float]) -> List[Dict[str, Any]]:
        buckets = []
        for low, high in _HISTOGRAM_BUCKETS:
            count = sum(1 for p in percentages if low <= p < high)
            label = f"{low}-{high - 1}" if high <= 100 else f"{low}-100"
            buckets.append({"bucket": label, "count": count})
        return buckets

    def _dimension_averages(self, assessment_id: str) -> Dict[str, Any]:
        """Per-dimension averages: questions are generated per student, so dimensions are the only comparable breakdown."""
        try:
            _, evaluations_map = self.results_aggregator._query_all_evaluations(assessment_id)
        except Exception as e:
            logger.warning("Could not compute dimension averages for %s: %s", assessment_id, e)
            return {"answersEvaluated": 0, "averageCorrectness": None,
                    "averageUnderstanding": None, "needsReviewCount": 0}

        correctness: List[float] = []
        understanding: List[float] = []
        needs_review = 0
        for evals in evaluations_map.values():
            for e in evals:
                correctness.append(_to_float(e.get("correctnessScore")))
                understanding.append(_to_float(e.get("understandingScore")))
                if e.get("needsReview"):
                    needs_review += 1

        return {
            "answersEvaluated": len(correctness),
            "averageCorrectness": round(statistics.fmean(correctness), 2) if correctness else None,
            "averageUnderstanding": round(statistics.fmean(understanding), 2) if understanding else None,
            "needsReviewCount": needs_review,
        }

    _NARRATIVE_SYSTEM = (
        "You are summarising cohort results for the instructor who set the assessment. "
        "Write 2-4 sentences of plain prose, then at most three short bullet points of "
        "concrete teaching follow-up.\n\n"
        "Rules:\n"
        "- Use ONLY the figures given. Never invent, estimate, or extrapolate a number.\n"
        "- Every number you state must appear verbatim in the data.\n"
        "- These are aggregates over a partial cohort; do not describe individual students.\n"
        "- If the evaluated count is small, say the sample is preliminary.\n"
        "- No preamble, no headings, no restating the whole table back."
    )

    def _narrative_prompt(self, report: Dict[str, Any]) -> str:
        scores = report["scores"]
        counts = report["counts"]
        dims = report["dimensions"]
        grades = {k: v for k, v in report["gradeDistribution"].items() if k != "_cutoffs"}
        histogram = ", ".join(f"{b['bucket']}%: {b['count']}" for b in report["histogram"] if b["count"])

        return (
            f"Assessment: {report['assessmentTitle']} ({report['course']})\n"
            f"Submitted: {counts['submitted']}; evaluated: {counts['evaluated']}; "
            f"awaiting evaluation: {counts['notEvaluated']}\n"
            f"Score percentages — average {scores['average']}, median {scores['median']}, "
            f"min {scores['min']}, max {scores['max']}, std dev {scores['stdDev']}\n"
            f"Grade distribution: {grades}\n"
            f"Score histogram (non-empty buckets): {histogram or 'none'}\n"
            f"Marks per answer — average correctness {dims['averageCorrectness']}, "
            f"average understanding {dims['averageUnderstanding']}, "
            f"across {dims['answersEvaluated']} answers; "
            f"{dims['needsReviewCount']} flagged for human review."
        )

    def _generate_narrative(self, report: Dict[str, Any]) -> Optional[str]:
        if self.llm_client is None:
            return None
        if not report["counts"]["evaluated"]:
            return None
        try:
            from src.main.agentcore_setup.config import BEDROCK_MODEL_REPORT

            text = self.llm_client.chat(
                [
                    {"role": "user", "content": (
                        f"{self._NARRATIVE_SYSTEM}\n\n---\n\n{self._narrative_prompt(report)}"
                    )},
                ],
                model_id=BEDROCK_MODEL_REPORT,
            )
            return (text or "").strip() or None
        except Exception as e:
            logger.warning("Report narrative generation failed (report still saved): %s", e)
            return None

    def _store_report(self, assessment_id: str, report: Dict[str, Any]) -> None:
        item = {
            "PK": f"ASSESSMENT#{assessment_id}",
            "SK": "REPORT#LATEST",
            **_decimalise(report),
        }
        self.table.put_item(Item=item)

    def get_report(self, assessment_id: str) -> Optional[Dict[str, Any]]:
        resp = self.table.get_item(
            Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": "REPORT#LATEST"}
        )
        item = resp.get("Item")
        if not item:
            return None
        item = {k: v for k, v in item.items() if k not in ("PK", "SK")}
        return _undecimalise(item)
