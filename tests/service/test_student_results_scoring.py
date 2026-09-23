"""
What the student's percentage is computed from.

Two rules this pins down, because getting either wrong misreports a real grade:
  - `instructorScore` is the grade override and beats the AI score. (`humanTotalScore`
    is the dual-scoring validity harness and deliberately does not affect the grade —
    see ResponseEvaluationRepository.record_human_score.)
  - An evaluation flagged `needsReview` is unscored, not zero-scored, so it is out of
    both numerator and denominator until a human settles it.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.main.service.OralAssessmentResultsAggregator import OralAssessmentResultsAggregator

PK = "STUDENT#s-1#ASSESSMENT#a-1"


def _table(evaluations):
    """A released assessment with two questions and the given evaluation items."""
    table = MagicMock()
    table.get_item.side_effect = lambda Key, **kwargs: {
        "Item": (
            {"name": "Test Student", "status": "submitted"}
            if Key["SK"].startswith("STUDENT#")
            else {"title": "Test", "resultsReleased": True}
        )
    }
    table.query.side_effect = [
        {"Items": [{"PK": PK, "SK": "QUESTION#q-1", "text": "Q1"},
                   {"PK": PK, "SK": "QUESTION#q-2", "text": "Q2"}]},
        {"Items": []},
        {"Items": evaluations},
    ]
    return table


def _results(evaluations):
    agg = OralAssessmentResultsAggregator(table=_table(evaluations))
    return agg.get_student_results(student_id="s-1", assessment_id="a-1")


def test_flagged_question_is_excluded_from_the_denominator():
    """A question the AI could not evaluate must not score like a wrong answer."""
    results = _results([
        {"PK": PK, "SK": "EVALUATION#q-1", "totalScore": 8, "maxScore": 10},
        {"PK": PK, "SK": "EVALUATION#q-2", "totalScore": 0, "maxScore": 10, "needsReview": True},
    ])
    assert results["totalScore"] == 8
    assert results["maxScore"] == 10  # not 20
    assert results["percentage"] == 80.0  # not 40.0
    assert results["questionsAwaitingReview"] == 1


def test_instructor_override_is_what_the_student_sees():
    """The instructor view honours instructorScore; the student view must agree with it."""
    results = _results([
        {"PK": PK, "SK": "EVALUATION#q-1", "totalScore": 4, "instructorScore": 9, "maxScore": 10},
        {"PK": PK, "SK": "EVALUATION#q-2", "totalScore": 7, "maxScore": 10},
    ])
    assert results["totalScore"] == 16
    assert results["percentage"] == 80.0


def test_override_on_a_flagged_question_brings_it_back_into_the_grade():
    """Once a human has scored it, it is no longer awaiting review."""
    results = _results([
        {"PK": PK, "SK": "EVALUATION#q-1", "totalScore": 8, "maxScore": 10},
        {"PK": PK, "SK": "EVALUATION#q-2", "totalScore": 0, "maxScore": 10,
         "needsReview": True, "instructorScore": 6},
    ])
    assert results["totalScore"] == 14
    assert results["maxScore"] == 20
    assert results["percentage"] == 70.0
    assert results["questionsAwaitingReview"] == 0


def test_human_reference_score_does_not_change_the_grade():
    """humanTotalScore is the validity harness, not a grade override."""
    results = _results([
        {"PK": PK, "SK": "EVALUATION#q-1", "totalScore": 4, "humanTotalScore": 10, "maxScore": 10},
    ])
    assert results["totalScore"] == 4
