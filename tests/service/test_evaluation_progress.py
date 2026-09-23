"""
Per-question evaluation progress.

The progress markers are what drive the instructor's live "Evaluating… 4/8
questions" bar. They were previously written through a job store that silently
no-op'd, so the sequencing here is worth pinning down explicitly: an off-by-one
or a missing terminal write leaves the UI stuck mid-evaluation forever.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.main.service.EvaluationWorkflowRunner import EvaluationWorkflowRunner


def _evaluation(score=8):
    return {
        "correctness_score": score // 2,
        "understanding_score": score - score // 2,
        "total_score": score,
        "feedback": "ok",
        "strengths": [],
        "weaknesses": [],
        "suggested_improvements": [],
    }


def _repository(question_ids=("q-1", "q-2", "q-3")):
    repo = MagicMock()
    repo.read_questions.return_value = [{"id": q} for q in question_ids]
    repo.read_answers.return_value = [
        {"questionId": q, "answerType": "text", "textContent": f"answer to {q}"}
        for q in question_ids
    ]
    repo.table.get_item.return_value = {"Item": {}}
    return repo


def _progress_calls(repo):
    """(questions_evaluated, total, status) tuples in call order."""
    return [
        (c.args[2], c.args[3], c.args[4] if len(c.args) > 4 else c.kwargs.get("status"))
        for c in repo.set_evaluation_progress.call_args_list
    ]


class TestProgressSequence:
    def test_emits_a_marker_per_question_plus_start_and_finish(self):
        repo = _repository()
        engine = MagicMock()
        engine.evaluate_qa_pair.return_value = _evaluation()
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert _progress_calls(repo) == [
            (0, 3, "evaluating"),
            (1, 3, "evaluating"),
            (2, 3, "evaluating"),
            (3, 3, "evaluating"),
            (3, 3, "completed"),
        ]

    def test_opens_at_zero_before_any_llm_call(self):
        """The bar must appear at 0% immediately, not after the first question."""
        repo = _repository()
        engine = MagicMock()
        order = []
        repo.set_evaluation_progress.side_effect = lambda *a, **k: order.append(("progress", a[2]))
        engine.evaluate_qa_pair.side_effect = lambda *a, **k: (order.append(("evaluate", None)), _evaluation())[1]
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert order[0] == ("progress", 0)
        assert order[1][0] == "evaluate"

    def test_terminal_marker_is_completed(self):
        repo = _repository()
        engine = MagicMock()
        engine.evaluate_qa_pair.return_value = _evaluation()
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert _progress_calls(repo)[-1] == (3, 3, "completed")

    def test_no_questions_still_reaches_completed(self):
        """An empty question set must not leave the UI stuck at 'evaluating'."""
        repo = _repository(question_ids=())
        engine = MagicMock()
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert _progress_calls(repo) == [(0, 0, "evaluating"), (0, 0, "completed")]
        engine.evaluate_qa_pair.assert_not_called()


class TestProgressUnderFailure:
    def test_failed_question_still_advances_the_counter(self):
        """A flagged question is stored and counted; the bar must not stall on it."""
        repo = _repository()
        engine = MagicMock()
        engine.evaluate_qa_pair.side_effect = [
            _evaluation(),
            RuntimeError("llm down"), RuntimeError("llm down again"),  # both attempts fail
            _evaluation(),
        ]
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        calls = _progress_calls(repo)
        assert calls[-1] == (3, 3, "completed")
        # q-2 failed, so no mid-loop marker was written for it: 0,1,(skip),3,completed
        assert (2, 3, "evaluating") not in calls

    def test_retry_success_records_progress(self):
        repo = _repository(question_ids=("q-1",))
        engine = MagicMock()
        engine.evaluate_qa_pair.side_effect = [RuntimeError("transient"), _evaluation()]
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert _progress_calls(repo) == [
            (0, 1, "evaluating"), (1, 1, "evaluating"), (1, 1, "completed"),
        ]

    def test_catastrophic_failure_marks_failed_and_raises_for_retry(self):
        """A whole-student failure is marked, then raised so the SQS consumer retries
        it; swallowing it deleted the message and left the student unmarked."""
        repo = _repository()
        repo.read_questions.side_effect = RuntimeError("dynamo down")
        runner = EvaluationWorkflowRunner(engine=MagicMock(), repository=repo)

        with pytest.raises(RuntimeError, match="dynamo down"):
            runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert _progress_calls(repo) == [(0, 0, "failed")]

    def test_progress_write_failure_does_not_abort_evaluation(self):
        """Progress is telemetry — losing it must not cost a student their grades."""
        repo = _repository()
        repo.set_evaluation_progress.side_effect = RuntimeError("throttled")
        engine = MagicMock()
        engine.evaluate_qa_pair.return_value = _evaluation()
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        # Every question is evaluated and stored as scored. A progress write that
        # failed inside the per-question try used to replace the evaluation just
        # stored with a flagged zero.
        stored = [c.args[3] for c in repo.store_evaluation.call_args_list]
        assert len(stored) == 3
        assert not any(e.get("needs_review") for e in stored)


class TestSkippedQuestions:
    def test_skipped_question_counts_toward_progress(self):
        repo = _repository()
        repo.read_answers.return_value = [
            {"questionId": "q-1", "answerType": "text", "textContent": "a"},
            {"questionId": "q-2", "answerType": "skipped"},
            {"questionId": "q-3", "answerType": "text", "textContent": "c"},
        ]
        engine = MagicMock()
        engine.evaluate_qa_pair.return_value = _evaluation()
        runner = EvaluationWorkflowRunner(engine=engine, repository=repo)

        runner.evaluate_from_dynamodb("job-1", "s-1", "a-1")

        assert _progress_calls(repo)[-1] == (3, 3, "completed")
        # The skipped question is a deterministic zero — never sent to the LLM.
        assert engine.evaluate_qa_pair.call_count == 2


class TestProgressPercentage:
    """The repository owns the percentage the UI renders."""

    @pytest.mark.parametrize("evaluated,total,expected", [
        (0, 8, "0.0"),
        (4, 8, "50.0"),
        (8, 8, "100.0"),
        (1, 3, "33.3"),
        (0, 0, "0.0"),  # guard against division by zero
    ])
    def test_percentage(self, evaluated, total, expected, mock_dynamodb, monkeypatch):
        from src.main.service.ResponseEvaluationRepository import ResponseEvaluationRepository

        repo = ResponseEvaluationRepository(table_name=mock_dynamodb.table_name, region="us-east-1")
        repo.set_evaluation_progress("s-1", "a-1", evaluated, total)
        item = repo.get_evaluation_progress("s-1", "a-1")
        assert item["percentage"] == expected
