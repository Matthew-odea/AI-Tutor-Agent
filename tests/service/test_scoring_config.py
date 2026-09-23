"""Unit tests for ScoringConfig."""
from __future__ import annotations

from decimal import Decimal

from src.main.service.ScoringConfig import (
    DEFAULT_MAX_SCORE_PER_QUESTION,
    ScoringConfig,
)


class TestDefaults:
    def test_default_max_score(self):
        assert ScoringConfig().max_score_per_question == DEFAULT_MAX_SCORE_PER_QUESTION == 10

    def test_default_grade_boundaries(self):
        cfg = ScoringConfig()
        assert cfg.grade(90) == "Excellent"
        assert cfg.grade(89.9) == "Competent"
        assert cfg.grade(75) == "Competent"
        assert cfg.grade(60) == "Developing"
        assert cfg.grade(59.9) == "Unsatisfactory"


class TestFromMetadata:
    def test_empty_metadata_uses_defaults(self):
        cfg = ScoringConfig.from_metadata({})
        assert cfg.max_score_per_question == 10
        assert cfg.grade(60) == "Developing"

    def test_none_metadata_uses_defaults(self):
        cfg = ScoringConfig.from_metadata(None)
        assert cfg.max_score_per_question == 10

    def test_metadata_override_max_score(self):
        cfg = ScoringConfig.from_metadata({"maxScorePerQuestion": Decimal("20")})
        assert cfg.max_score_per_question == 20

    def test_metadata_override_cutoffs(self):
        cfg = ScoringConfig.from_metadata({
            "gradeCutoffs": {"excellent": Decimal("50"), "competent": Decimal("30"), "developing": Decimal("10")}
        })
        assert cfg.grade(60) == "Excellent"
        assert cfg.grade(35) == "Competent"
        assert cfg.grade(15) == "Developing"
        assert cfg.grade(5) == "Unsatisfactory"

    def test_partial_cutoffs_fall_back_per_field(self):
        # Only 'excellent' overridden; others keep defaults.
        cfg = ScoringConfig.from_metadata({"gradeCutoffs": {"excellent": Decimal("95")}})
        assert cfg.grade(92) == "Competent"  # below overridden 95, above default 75
        assert cfg.grade(96) == "Excellent"

    def test_invalid_max_score_falls_back_to_default(self):
        assert ScoringConfig(max_score_per_question=0).max_score_per_question == 10
        assert ScoringConfig(max_score_per_question="not-a-number").max_score_per_question == 10


class TestInvalidCutoffsRejected:
    """Nonsensical cutoffs must fall back to defaults, never produce wrong grades."""

    def test_negative_cutoff_falls_back_to_defaults(self):
        cfg = ScoringConfig(cutoffs={"developing": -50})
        # 0% must be Unsatisfactory, NOT 'Developing'
        assert cfg.grade(0) == "Unsatisfactory"
        assert cfg.developing == 60  # reverted to default

    def test_out_of_range_cutoff_falls_back(self):
        cfg = ScoringConfig(cutoffs={"excellent": 9999})
        assert cfg.excellent == 90
        assert cfg.grade(95) == "Excellent"

    def test_misordered_cutoffs_fall_back(self):
        # excellent < competent is nonsensical
        cfg = ScoringConfig(cutoffs={"excellent": 50, "competent": 80, "developing": 60})
        assert cfg.excellent == 90
        assert cfg.competent == 75
        assert cfg.developing == 60

    def test_valid_lenient_cutoffs_preserved(self):
        cfg = ScoringConfig(cutoffs={"excellent": 50, "competent": 30, "developing": 10})
        assert cfg.grade(60) == "Excellent"
        assert cfg.excellent == 50
