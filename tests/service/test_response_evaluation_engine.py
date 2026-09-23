import pytest

from src.main.service.ResponseEvaluationEngine import ResponseEvaluationEngine, ResponseEvaluationEngineError


# A long-enough, substantive transcript so the too-short guard does not trip.
GOOD_TRANSCRIPT = "I used a for loop because it goes through each item in the list one at a time."


class DummyAgent:
    """Text-only agent (no structured-output capability)."""

    def chat(self, messages, model_id=None):
        return {
            "text": '{"correctness_score": 4, "understanding_score": 5, "total_score": 9, "feedback": "Good"}'
        }


class TextOnlyAgent:
    """Configurable text-only agent."""

    def __init__(self, text):
        self._text = text
        self.chat_calls = 0

    def chat(self, messages, model_id=None):
        self.chat_calls += 1
        return {"text": self._text}


class StructuredAgent:
    """Real (non-Mock) agent that advertises forced structured output."""

    supports_structured_output = True

    def __init__(self, structured=None, text=None, structured_error=None):
        self._structured = structured
        self._text = text or '{"correctness_score": 1, "understanding_score": 1, "total_score": 2, "feedback": "fallback"}'
        self._structured_error = structured_error
        self.chat_calls = 0
        self.structured_calls = 0
        self.model_ids = []

    def chat(self, messages, model_id=None):
        self.chat_calls += 1
        self.model_ids.append(model_id)
        return {"text": self._text}

    def chat_structured(self, messages, *, tool_name, description, input_schema, model_id=None):
        self.structured_calls += 1
        self.model_ids.append(model_id)
        if self._structured_error is not None:
            raise self._structured_error
        return self._structured


def _qa_pair(transcript=GOOD_TRANSCRIPT, confidence=None, answer_type="audio"):
    answer = {"transcript": transcript, "answerType": answer_type}
    if confidence is not None:
        answer["transcriptConfidence"] = confidence
    return {
        "question": {
            "id": "q1",
            "questionNumber": 1,
            "questionType": "specific",
            "text": "Explain your loop.",
            "codeContext": "for i in x: pass",
        },
        "answer": answer,
    }


def _engine(agent):
    return ResponseEvaluationEngine(agent_client=agent, evaluation_prompt="prompt")


_REQUIRED_KEYS = (
    "correctness_score",
    "understanding_score",
    "total_score",
    "feedback",
    "strengths",
    "weaknesses",
    "suggested_improvements",
)


# ── parsing (existing behaviour, total_score now optional) ──────────────────

def test_parse_evaluation_response_from_json_fence():
    engine = _engine(DummyAgent())
    response_text = "```json\n{\"correctness_score\": 5, \"understanding_score\": 4, \"total_score\": 9, \"feedback\": \"Nice\"}\n```"
    parsed = engine.parse_evaluation_response(response_text)
    assert parsed["correctness_score"] == 5
    assert parsed["total_score"] == 9


def test_parse_evaluation_response_missing_required_field_raises():
    engine = _engine(DummyAgent())
    with pytest.raises(ResponseEvaluationEngineError):
        engine.parse_evaluation_response('{"correctness_score": 5}')


def test_parse_evaluation_response_total_score_no_longer_required():
    engine = _engine(DummyAgent())
    parsed = engine.parse_evaluation_response('{"correctness_score": 3, "understanding_score": 2, "feedback": "f"}')
    assert parsed["correctness_score"] == 3
    assert "total_score" not in parsed  # supplied later by normalization


# ── grade boundaries / configurable cutoffs (Task 6) ────────────────────────

def test_calculate_grade_boundaries():
    assert ResponseEvaluationEngine.calculate_grade(90) == "Excellent"
    assert ResponseEvaluationEngine.calculate_grade(75) == "Competent"
    assert ResponseEvaluationEngine.calculate_grade(60) == "Developing"
    assert ResponseEvaluationEngine.calculate_grade(59.9) == "Unsatisfactory"


def test_calculate_grade_with_custom_cutoffs():
    cutoffs = {"excellent": 80, "competent": 60, "developing": 40}
    assert ResponseEvaluationEngine.calculate_grade(80, cutoffs) == "Excellent"
    assert ResponseEvaluationEngine.calculate_grade(70, cutoffs) == "Competent"
    assert ResponseEvaluationEngine.calculate_grade(39, cutoffs) == "Unsatisfactory"


# ── Task 2: structured output, fallback, clamping, total enforcement ────────

def test_structured_output_used_when_supported():
    agent = StructuredAgent(structured={
        "correctness_score": 4, "understanding_score": 3,
        "feedback": "ok", "strengths": ["clear"], "weaknesses": [], "suggested_improvements": ["add tests"],
    })
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert agent.structured_calls == 1
    assert agent.chat_calls == 0  # text path not touched
    assert ev["evaluation_method"] == "structured"
    assert ev["correctness_score"] == 4
    assert ev["understanding_score"] == 3
    assert ev["total_score"] == 7  # server-enforced sum
    assert ev["needs_review"] is False
    assert ev["review_reasons"] == []


def test_scores_clamped_to_range():
    agent = StructuredAgent(structured={
        "correctness_score": 9, "understanding_score": -2, "feedback": "x",
    })
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["correctness_score"] == 5  # clamped from 9
    assert ev["understanding_score"] == 0  # clamped from -2
    assert ev["total_score"] == 5


def test_total_score_recomputed_ignoring_model_total():
    # Model returns a wildly wrong total; engine must ignore it.
    agent = TextOnlyAgent('{"correctness_score": 3, "understanding_score": 2, "total_score": 99, "feedback": "f"}')
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["total_score"] == 5  # 3 + 2, not 99


def test_structured_failure_falls_back_to_text_and_flags_review():
    agent = StructuredAgent(
        structured_error=RuntimeError("structured boom"),
        text='{"correctness_score": 3, "understanding_score": 2, "total_score": 5, "feedback": "f"}',
    )
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert agent.structured_calls == 1
    assert agent.chat_calls == 1  # fell back to text
    assert ev["evaluation_method"] == "text"
    assert ev["needs_review"] is True
    assert "structured_output_fallback" in ev["review_reasons"]
    assert ev["total_score"] == 5


def test_text_only_agent_not_flagged_as_fallback():
    # A deployment with no structured-output support is the configured mode,
    # not a fallback, so it must not be spuriously flagged.
    agent = TextOnlyAgent('{"correctness_score": 4, "understanding_score": 4, "total_score": 8, "feedback": "f"}')
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["evaluation_method"] == "text"
    assert ev["needs_review"] is False
    assert ev["total_score"] == 8


def test_malformed_text_output_yields_needs_review_not_raw_error():
    agent = TextOnlyAgent("I'm sorry, I can't help with that. (no JSON here)")
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["needs_review"] is True
    assert "evaluation_error" in ev["review_reasons"]
    assert ev["total_score"] == 0
    assert ev["correctness_score"] == 0
    assert "Evaluation failed" not in ev["feedback"]  # raw error never surfaced
    for key in _REQUIRED_KEYS:
        assert key in ev  # always a valid, complete evaluation


def test_structured_and_text_both_fail_yields_needs_review():
    agent = StructuredAgent(structured_error=RuntimeError("boom"), text="still not json")
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["needs_review"] is True
    assert "evaluation_error" in ev["review_reasons"]
    assert ev["evaluation_method"] == "unscored"


def test_structured_returns_empty_payload_falls_back():
    agent = StructuredAgent(
        structured={},  # unusable
        text='{"correctness_score": 2, "understanding_score": 2, "feedback": "f"}',
    )
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["evaluation_method"] == "text"
    assert ev["needs_review"] is True
    assert "structured_output_fallback" in ev["review_reasons"]
    assert ev["total_score"] == 4


# ── Task 4: unusable audio → needs_review, never silent zero ────────────────

def test_empty_transcript_is_flagged_not_silently_zeroed():
    agent = StructuredAgent(structured={"correctness_score": 5, "understanding_score": 5, "feedback": "x"})
    ev = _engine(agent).evaluate_qa_pair(_qa_pair(transcript=""))
    assert agent.structured_calls == 0  # model never called
    assert agent.chat_calls == 0
    assert ev["needs_review"] is True
    assert "empty_transcript" in ev["review_reasons"]
    assert ev["total_score"] == 0
    assert "No response was provided" not in ev["feedback"]  # old silent-zero copy is gone


def test_whitespace_only_transcript_is_flagged():
    ev = _engine(TextOnlyAgent("{}")).evaluate_qa_pair(_qa_pair(transcript="   \n  "))
    assert ev["needs_review"] is True
    assert "empty_transcript" in ev["review_reasons"]


def test_too_short_transcript_is_flagged():
    agent = StructuredAgent(structured={"correctness_score": 5, "understanding_score": 5, "feedback": "x"})
    ev = _engine(agent).evaluate_qa_pair(_qa_pair(transcript="ok"))
    assert agent.structured_calls == 0
    assert ev["needs_review"] is True
    assert "transcript_too_short" in ev["review_reasons"]
    assert ev["total_score"] == 0


def test_low_confidence_transcript_is_scored_but_flagged():
    agent = StructuredAgent(structured={"correctness_score": 4, "understanding_score": 4, "feedback": "f"})
    ev = _engine(agent).evaluate_qa_pair(_qa_pair(confidence=0.3, answer_type="audio"))
    assert ev["needs_review"] is True
    assert "low_confidence_transcript" in ev["review_reasons"]
    assert ev["total_score"] == 8  # still scored — there is text to grade
    assert ev["transcript_confidence"] == 0.3


def test_high_confidence_normal_answer_not_flagged():
    agent = StructuredAgent(structured={"correctness_score": 4, "understanding_score": 4, "feedback": "f"})
    ev = _engine(agent).evaluate_qa_pair(_qa_pair(confidence=0.95, answer_type="audio"))
    assert ev["needs_review"] is False
    assert ev["review_reasons"] == []


def test_text_answer_without_confidence_not_flagged_low_confidence():
    agent = StructuredAgent(structured={"correctness_score": 3, "understanding_score": 3, "feedback": "f"})
    ev = _engine(agent).evaluate_qa_pair(_qa_pair(answer_type="text", confidence=None))
    assert ev["needs_review"] is False


def test_evaluate_single_question_empty_transcript_flagged():
    ev = _engine(TextOnlyAgent("{}")).evaluate_single_question({
        "question_number": 2, "question": "Q", "question_type": "general", "transcript": "",
    })
    assert ev["needs_review"] is True
    assert "empty_transcript" in ev["review_reasons"]
    assert ev["question_number"] == 2


def test_question_metadata_attached():
    agent = StructuredAgent(structured={"correctness_score": 3, "understanding_score": 2, "feedback": "f"})
    ev = _engine(agent).evaluate_qa_pair(_qa_pair())
    assert ev["question_id"] == "q1"
    assert ev["question_number"] == 1
    assert ev["question_type"] == "specific"


def test_evaluation_uses_pinned_eval_model_on_both_paths(monkeypatch):
    # Marking must use BEDROCK_MODEL_EVAL, not the chat model, on the structured call and the text fallback.
    import src.main.service.ResponseEvaluationEngine as engine_module

    monkeypatch.setattr(engine_module, "BEDROCK_MODEL_EVAL", "eval-model")
    agent = StructuredAgent(structured_error=RuntimeError("structured boom"))
    engine = ResponseEvaluationEngine(agent_client=agent, evaluation_prompt="p")
    engine.evaluate_qa_pair(_qa_pair())
    assert agent.model_ids == ["eval-model", "eval-model"]
