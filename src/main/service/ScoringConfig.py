"""Single source of truth for per-question max score and grade cutoffs.

Resolved from the assessment METADATA item. Items without overrides must keep getting
the defaults (10 per question, 90/75/60), since existing assessments rely on them.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_MAX_SCORE_PER_QUESTION = 10
DEFAULT_GRADE_CUTOFFS = {"excellent": 90, "competent": 75, "developing": 60}


def _to_number(value: Any, fallback: float) -> float:
    if value is None:
        return float(fallback)
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


class ScoringConfig:
    def __init__(
        self,
        max_score_per_question: Any = DEFAULT_MAX_SCORE_PER_QUESTION,
        cutoffs: Optional[Dict[str, Any]] = None,
    ):
        mspq = _to_number(max_score_per_question, DEFAULT_MAX_SCORE_PER_QUESTION)
        self.max_score_per_question = int(mspq) if mspq and mspq > 0 else DEFAULT_MAX_SCORE_PER_QUESTION

        cutoffs = cutoffs or {}
        excellent = _to_number(cutoffs.get("excellent"), DEFAULT_GRADE_CUTOFFS["excellent"])
        competent = _to_number(cutoffs.get("competent"), DEFAULT_GRADE_CUTOFFS["competent"])
        developing = _to_number(cutoffs.get("developing"), DEFAULT_GRADE_CUTOFFS["developing"])

        # Out-of-range or mis-ordered cutoffs fall back to defaults rather than mis-grade real students.
        if 0 <= developing <= competent <= excellent <= 100:
            self.excellent, self.competent, self.developing = excellent, competent, developing
        else:
            logger.warning(
                "Invalid grade cutoffs (developing=%s, competent=%s, excellent=%s); "
                "falling back to defaults %s",
                developing, competent, excellent, DEFAULT_GRADE_CUTOFFS,
            )
            self.excellent = float(DEFAULT_GRADE_CUTOFFS["excellent"])
            self.competent = float(DEFAULT_GRADE_CUTOFFS["competent"])
            self.developing = float(DEFAULT_GRADE_CUTOFFS["developing"])

    def grade(self, percentage: float) -> str:
        if percentage >= self.excellent:
            return "Excellent"
        if percentage >= self.competent:
            return "Competent"
        if percentage >= self.developing:
            return "Developing"
        return "Unsatisfactory"

    @classmethod
    def from_metadata(cls, metadata: Optional[Dict[str, Any]]) -> "ScoringConfig":
        """Optional overrides: maxScorePerQuestion, gradeCutoffs {excellent, competent, developing}."""
        metadata = metadata or {}
        return cls(
            max_score_per_question=metadata.get("maxScorePerQuestion", DEFAULT_MAX_SCORE_PER_QUESTION),
            cutoffs=metadata.get("gradeCutoffs"),
        )
