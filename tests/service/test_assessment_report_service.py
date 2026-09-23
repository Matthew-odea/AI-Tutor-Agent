"""
Tests for AssessmentReportService — the count-based auto-report trigger and the
cohort summary it produces.

The trigger tests are the important ones: the whole feature exists because the
old "all enrolled have submitted" gate never fired, and the replacement must
fire exactly once per milestone even under concurrent submissions.
"""
from __future__ import annotations

import threading
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from src.main.service.AssessmentReportService import (
    DEFAULT_REPORT_THRESHOLD,
    AssessmentReportService,
)

TABLE = "test_oral_assessments"
ASSESSMENT_ID = "a-1"


class FakeAggregator:
    """Stands in for InstructorAssessmentResultsAggregator."""

    def __init__(self, results=None, evaluations_map=None):
        self._results = results or []
        self._evaluations_map = evaluations_map or {}

    def get_assessment_results(self, assessment_id):
        return self._results

    def _query_all_evaluations(self, assessment_id):
        return [], self._evaluations_map


@pytest.fixture()
def table(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        t = dynamodb.create_table(
            TableName=TABLE,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield t


def make_service(table, *, assessment=None, results=None, evaluations_map=None, llm_client=None):
    assessment = assessment if assessment is not None else {"title": "Quiz 1", "course": "COMP9021"}
    return AssessmentReportService(
        table=table,
        results_aggregator=FakeAggregator(results, evaluations_map),
        get_assessment=lambda _id: assessment,
        llm_client=llm_client,
    )


def seed_students(table, submitted: int, not_submitted: int = 0, assessment_id=ASSESSMENT_ID):
    """Enrollment items; only the submitted ones carry submittedAt."""
    for i in range(submitted):
        table.put_item(Item={
            "PK": f"ASSESSMENT#{assessment_id}",
            "SK": f"STUDENT#s{i}",
            "status": "submitted",
            "submittedAt": "2026-08-01T00:00:00Z",
        })
    for i in range(not_submitted):
        table.put_item(Item={
            "PK": f"ASSESSMENT#{assessment_id}",
            "SK": f"STUDENT#n{i}",
            "status": "enrolled",
        })


class _WriteBarrierTable:
    """Table wrapper that forces the lost-update interleaving.

    Every write waits at a barrier until `parties` callers have arrived, so all of
    them have completed their reads before any write lands. Writes are then applied
    one at a time — moto is not thread-safe, and the race under test is in our code,
    not in the mock.
    """

    def __init__(self, inner, parties: int):
        self._inner = inner
        self._barrier = threading.Barrier(parties, timeout=10)
        self._write_lock = threading.Lock()

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _write(self, method, kwargs):
        self._barrier.wait()
        with self._write_lock:
            return method(**kwargs)

    def update_item(self, **kwargs):
        return self._write(self._inner.update_item, kwargs)

    def put_item(self, **kwargs):
        return self._write(self._inner.put_item, kwargs)


class TestCountSubmitted:
    def test_counts_only_submitted(self, table):
        seed_students(table, submitted=7, not_submitted=12)
        svc = make_service(table)
        assert svc.count_submitted(ASSESSMENT_ID) == 7

    def test_zero_when_none_submitted(self, table):
        seed_students(table, submitted=0, not_submitted=5)
        svc = make_service(table)
        assert svc.count_submitted(ASSESSMENT_ID) == 0

    def test_ignores_other_assessments(self, table):
        seed_students(table, submitted=3, assessment_id="a-1")
        seed_students(table, submitted=9, assessment_id="a-2")
        svc = make_service(table)
        assert svc.count_submitted("a-1") == 3


class TestResolveThreshold:
    def test_defaults_to_ten(self, table):
        assert AssessmentReportService.resolve_threshold({}) == DEFAULT_REPORT_THRESHOLD

    def test_honours_override(self, table):
        assert AssessmentReportService.resolve_threshold({"autoReportThreshold": 25}) == 25

    def test_falls_back_on_garbage(self, table):
        assert AssessmentReportService.resolve_threshold(
            {"autoReportThreshold": "not-a-number"}
        ) == DEFAULT_REPORT_THRESHOLD


class TestClaimMilestone:
    def test_first_claim_wins(self, table):
        svc = make_service(table)
        assert svc.claim_milestone(ASSESSMENT_ID, 1) is True

    def test_second_claim_of_same_milestone_is_refused(self, table):
        svc = make_service(table)
        assert svc.claim_milestone(ASSESSMENT_ID, 1) is True
        assert svc.claim_milestone(ASSESSMENT_ID, 1) is False

    def test_higher_milestone_claims_again(self, table):
        svc = make_service(table)
        assert svc.claim_milestone(ASSESSMENT_ID, 1) is True
        assert svc.claim_milestone(ASSESSMENT_ID, 2) is True

    def test_lower_milestone_is_refused(self, table):
        """A late-arriving stale count must not re-fire an already-passed milestone."""
        svc = make_service(table)
        assert svc.claim_milestone(ASSESSMENT_ID, 3) is True
        assert svc.claim_milestone(ASSESSMENT_ID, 2) is False


class TestShouldGenerateOnSubmit:
    def test_below_threshold_does_not_fire(self, table):
        seed_students(table, submitted=9)
        svc = make_service(table)
        assert svc.should_generate_on_submit(ASSESSMENT_ID) is None

    def test_fires_exactly_at_threshold(self, table):
        seed_students(table, submitted=10)
        svc = make_service(table)
        decision = svc.should_generate_on_submit(ASSESSMENT_ID)
        assert decision == {"milestone": 1, "threshold": 10, "submittedCount": 10}

    def test_does_not_refire_within_same_milestone(self, table):
        """The bug the feature note warns about: firing on every later submission."""
        seed_students(table, submitted=10)
        svc = make_service(table)
        assert svc.should_generate_on_submit(ASSESSMENT_ID) is not None

        # 11th … 19th submissions all sit inside milestone 1.
        for i in range(9):
            table.put_item(Item={
                "PK": f"ASSESSMENT#{ASSESSMENT_ID}",
                "SK": f"STUDENT#extra{i}",
                "submittedAt": "2026-08-01T00:00:00Z",
            })
            assert svc.should_generate_on_submit(ASSESSMENT_ID) is None

    def test_fires_again_at_next_multiple(self, table):
        seed_students(table, submitted=10)
        svc = make_service(table)
        assert svc.should_generate_on_submit(ASSESSMENT_ID)["milestone"] == 1

        seed_students(table, submitted=0)
        for i in range(10):
            table.put_item(Item={
                "PK": f"ASSESSMENT#{ASSESSMENT_ID}",
                "SK": f"STUDENT#second{i}",
                "submittedAt": "2026-08-01T00:00:00Z",
            })
        decision = svc.should_generate_on_submit(ASSESSMENT_ID)
        assert decision["milestone"] == 2
        assert decision["submittedCount"] == 20

    def test_concurrent_submissions_produce_one_decision(self, table):
        """Ten threads crossing the same milestone must yield exactly one report."""
        from concurrent.futures import ThreadPoolExecutor

        seed_students(table, submitted=10)
        svc = make_service(table)
        with ThreadPoolExecutor(max_workers=10) as pool:
            decisions = list(pool.map(lambda _: svc.should_generate_on_submit(ASSESSMENT_ID), range(10)))
        assert sum(1 for d in decisions if d is not None) == 1

    def test_lost_update_interleaving_still_yields_one_decision(self, table):
        """The race itself, forced rather than hoped for.

        `_WriteBarrierTable` holds every writer until all of them have finished
        reading, which is exactly the interleaving that loses an increment: both
        submissions decide from the same pre-write state. A read-modify-write
        counter claims milestone 1 twice here and generates two reports. Only a
        conditional write survives it, so this fails if the atomic claim is
        replaced by a read-then-write.
        """
        from concurrent.futures import ThreadPoolExecutor

        seed_students(table, submitted=10)
        svc = make_service(_WriteBarrierTable(table, parties=2))

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(svc.should_generate_on_submit, ASSESSMENT_ID) for _ in range(2)]
            decisions = [f.result(timeout=10) for f in futures]

        assert sum(1 for d in decisions if d is not None) == 1

    def test_auto_report_disabled_never_fires(self, table):
        seed_students(table, submitted=50)
        svc = make_service(table, assessment={"autoReport": False})
        assert svc.should_generate_on_submit(ASSESSMENT_ID) is None

    def test_custom_threshold_fires_earlier(self, table):
        seed_students(table, submitted=3)
        svc = make_service(table, assessment={"autoReportThreshold": 3})
        decision = svc.should_generate_on_submit(ASSESSMENT_ID)
        assert decision["milestone"] == 1
        assert decision["threshold"] == 3

    def test_non_positive_threshold_disables(self, table):
        seed_students(table, submitted=50)
        svc = make_service(table, assessment={"autoReportThreshold": 0})
        assert svc.should_generate_on_submit(ASSESSMENT_ID) is None


def _results(*percentages, not_evaluated=0):
    out = [
        {
            "studentId": f"s{i}",
            "name": f"Student {i}",
            "email": f"s{i}@example.com",
            "percentage": p,
            "grade": "Excellent" if p >= 90 else "Competent" if p >= 75 else "Developing" if p >= 60 else "Needs Improvement",
            "totalScore": p,
            "maxScore": 100,
        }
        for i, p in enumerate(percentages)
    ]
    for i in range(not_evaluated):
        out.append({
            "studentId": f"ne{i}", "name": f"NE {i}", "email": f"ne{i}@example.com",
            "percentage": 0, "grade": "Not Evaluated", "totalScore": 0, "maxScore": 0,
        })
    return out


class TestGenerateReport:
    def test_score_statistics(self, table):
        seed_students(table, submitted=4)
        svc = make_service(table, results=_results(50.0, 60.0, 70.0, 80.0))
        report = svc.generate_report(ASSESSMENT_ID)
        assert report["scores"]["average"] == 65.0
        assert report["scores"]["median"] == 65.0
        assert report["scores"]["min"] == 50.0
        assert report["scores"]["max"] == 80.0

    def test_not_evaluated_excluded_from_averages(self, table):
        """A pending student's placeholder 0% must not drag the class average down."""
        seed_students(table, submitted=2)
        svc = make_service(table, results=_results(80.0, 90.0, not_evaluated=3))
        report = svc.generate_report(ASSESSMENT_ID)
        assert report["scores"]["average"] == 85.0
        assert report["counts"]["evaluated"] == 2
        assert report["counts"]["notEvaluated"] == 3
        assert report["counts"]["enrolled"] == 5

    def test_single_student_has_zero_spread(self, table):
        seed_students(table, submitted=1)
        svc = make_service(table, results=_results(75.0))
        assert svc.generate_report(ASSESSMENT_ID)["scores"]["stdDev"] == 0.0

    def test_empty_cohort_yields_null_stats(self, table):
        svc = make_service(table, results=[])
        report = svc.generate_report(ASSESSMENT_ID)
        assert report["scores"]["average"] is None
        assert report["counts"]["evaluated"] == 0

    def test_grade_distribution_seeds_all_bands(self, table):
        seed_students(table, submitted=2)
        svc = make_service(table, results=_results(95.0, 95.0))
        dist = svc.generate_report(ASSESSMENT_ID)["gradeDistribution"]
        assert dist["Excellent"] == 2
        assert dist["Competent"] == 0
        assert dist["Developing"] == 0

    def test_histogram_buckets_scores(self, table):
        seed_students(table, submitted=3)
        svc = make_service(table, results=_results(5.0, 55.0, 95.0))
        buckets = {b["bucket"]: b["count"] for b in svc.generate_report(ASSESSMENT_ID)["histogram"]}
        assert buckets["0-9"] == 1
        assert buckets["50-59"] == 1
        assert buckets["90-100"] == 1

    def test_hundred_percent_lands_in_top_bucket(self, table):
        """100 is inclusive at the top — an off-by-one here silently loses a student."""
        seed_students(table, submitted=1)
        svc = make_service(table, results=_results(100.0))
        buckets = {b["bucket"]: b["count"] for b in svc.generate_report(ASSESSMENT_ID)["histogram"]}
        assert buckets["90-100"] == 1
        assert sum(b["count"] for b in svc.generate_report(ASSESSMENT_ID)["histogram"]) == 1

    def test_dimension_averages(self, table):
        seed_students(table, submitted=1)
        evaluations = {"s0": [
            {"correctnessScore": 4, "understandingScore": 3, "needsReview": False},
            {"correctnessScore": 2, "understandingScore": 1, "needsReview": True},
        ]}
        svc = make_service(table, results=_results(60.0), evaluations_map=evaluations)
        dims = svc.generate_report(ASSESSMENT_ID)["dimensions"]
        assert dims["answersEvaluated"] == 2
        assert dims["averageCorrectness"] == 3.0
        assert dims["averageUnderstanding"] == 2.0
        assert dims["needsReviewCount"] == 1

    def test_report_carries_no_student_identifiers(self, table):
        """Reports are shareable aggregates — no names, emails, or student IDs."""
        seed_students(table, submitted=2)
        svc = make_service(table, results=_results(80.0, 90.0))
        blob = repr(svc.generate_report(ASSESSMENT_ID))
        assert "Student 0" not in blob
        assert "@example.com" not in blob
        assert "studentId" not in blob

    def test_records_trigger_metadata(self, table):
        seed_students(table, submitted=10)
        svc = make_service(table, results=_results(80.0))
        report = svc.generate_report(ASSESSMENT_ID, triggered_by="auto_threshold", milestone=1)
        assert report["triggeredBy"] == "auto_threshold"
        assert report["milestone"] == 1
        assert report["counts"]["submitted"] == 10


class TestNarrative:
    """The prose layer is optional and must never take the numbers down with it."""

    def test_absent_when_no_llm_client(self, table):
        seed_students(table, submitted=1)
        svc = make_service(table, results=_results(70.0))
        assert svc.generate_report(ASSESSMENT_ID)["narrative"] is None

    def test_generated_when_llm_client_present(self, table):
        seed_students(table, submitted=1)
        llm = MagicMock()
        llm.chat.return_value = "  The cohort is tracking well.  "
        svc = make_service(table, results=_results(70.0), llm_client=llm)
        assert svc.generate_report(ASSESSMENT_ID)["narrative"] == "The cohort is tracking well."

    def test_uses_the_report_model_not_the_chat_model(self, table, monkeypatch):
        monkeypatch.setenv("BEDROCK_MODEL_REPORT", "some.stronger-model-v1:0")
        import importlib
        from src.main.agentcore_setup import config as agent_config
        importlib.reload(agent_config)

        seed_students(table, submitted=1)
        llm = MagicMock()
        llm.chat.return_value = "Summary."
        svc = make_service(table, results=_results(70.0), llm_client=llm)
        svc.generate_report(ASSESSMENT_ID)

        assert llm.chat.call_args.kwargs["model_id"] == "some.stronger-model-v1:0"
        importlib.reload(agent_config)

    def test_llm_failure_still_saves_the_report(self, table):
        seed_students(table, submitted=2)
        llm = MagicMock()
        llm.chat.side_effect = RuntimeError("bedrock throttled")
        svc = make_service(table, results=_results(80.0, 90.0), llm_client=llm)

        report = svc.generate_report(ASSESSMENT_ID)

        assert report["narrative"] is None
        assert report["scores"]["average"] == 85.0
        assert svc.get_report(ASSESSMENT_ID)["scores"]["average"] == 85.0

    def test_empty_response_becomes_none(self, table):
        seed_students(table, submitted=1)
        llm = MagicMock()
        llm.chat.return_value = "   "
        svc = make_service(table, results=_results(70.0), llm_client=llm)
        assert svc.generate_report(ASSESSMENT_ID)["narrative"] is None

    def test_skipped_when_nothing_evaluated(self, table):
        """No prose about a cohort with no marks in it."""
        llm = MagicMock()
        svc = make_service(table, results=_results(not_evaluated=4), llm_client=llm)
        assert svc.generate_report(ASSESSMENT_ID)["narrative"] is None
        llm.chat.assert_not_called()

    def test_prompt_carries_stats_but_no_student_identifiers(self, table):
        seed_students(table, submitted=2)
        llm = MagicMock()
        llm.chat.return_value = "Summary."
        svc = make_service(table, results=_results(80.0, 90.0), llm_client=llm)
        svc.generate_report(ASSESSMENT_ID)

        prompt = llm.chat.call_args.args[0][0]["content"]
        assert "85.0" in prompt          # the average made it in
        assert "Quiz 1" in prompt
        assert "Student 0" not in prompt  # no names leave the building
        assert "@example.com" not in prompt

    def test_prompt_forbids_inventing_numbers(self, table):
        seed_students(table, submitted=1)
        llm = MagicMock()
        llm.chat.return_value = "Summary."
        svc = make_service(table, results=_results(70.0), llm_client=llm)
        svc.generate_report(ASSESSMENT_ID)

        prompt = llm.chat.call_args.args[0][0]["content"]
        assert "Never invent" in prompt

    def test_narrative_persists(self, table):
        seed_students(table, submitted=1)
        llm = MagicMock()
        llm.chat.return_value = "Cohort summary text."
        svc = make_service(table, results=_results(70.0), llm_client=llm)
        svc.generate_report(ASSESSMENT_ID)
        assert svc.get_report(ASSESSMENT_ID)["narrative"] == "Cohort summary text."


class TestReportPersistence:
    def test_round_trip(self, table):
        seed_students(table, submitted=2)
        svc = make_service(table, results=_results(70.0, 90.0))
        generated = svc.generate_report(ASSESSMENT_ID)
        stored = svc.get_report(ASSESSMENT_ID)
        assert stored["scores"]["average"] == generated["scores"]["average"]
        assert stored["assessmentTitle"] == "Quiz 1"

    def test_get_report_before_any_generation(self, table):
        svc = make_service(table)
        assert svc.get_report(ASSESSMENT_ID) is None

    def test_stored_report_has_no_dynamodb_keys(self, table):
        seed_students(table, submitted=1)
        svc = make_service(table, results=_results(70.0))
        svc.generate_report(ASSESSMENT_ID)
        stored = svc.get_report(ASSESSMENT_ID)
        assert "PK" not in stored and "SK" not in stored

    def test_regeneration_overwrites(self, table):
        seed_students(table, submitted=1)
        svc = make_service(table, results=_results(50.0))
        svc.generate_report(ASSESSMENT_ID, milestone=1)
        svc2 = make_service(table, results=_results(50.0, 100.0))
        svc2.generate_report(ASSESSMENT_ID, milestone=2)
        stored = svc2.get_report(ASSESSMENT_ID)
        assert stored["milestone"] == 2
        assert stored["scores"]["average"] == 75.0
