from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from src.main.agentcore_setup.config import BEDROCK_MODEL_EVAL
from src.main.service.ScoringConfig import ScoringConfig

logger = logging.getLogger(__name__)

# Each dimension (correctness / understanding) is scored on a 0..5 scale.
DIMENSION_MAX = 5

# A transcript shorter than this (after stripping) is treated as unusable —
# almost always a transcription failure or a non-answer — and flagged for
# instructor review rather than auto-scored. Real spoken answers to a
# programming question are full sentences, so this is deliberately small and
# only catches near-empty output ("uh", "ok", a stray token).
DEFAULT_MIN_TRANSCRIPT_CHARS = 8

# Deepgram per-transcript confidence below this marks the transcript as
# untrustworthy. The answer is still scored (there is text to grade) but is
# flagged for review so the instructor can sanity-check the transcription.
DEFAULT_MIN_TRANSCRIPT_CONFIDENCE = 0.6

# Tool/function schema used to force structured output from the model.
# total_score is intentionally omitted: it is always computed server-side as
# correctness + understanding, which eliminates a whole class of model
# arithmetic errors.
EVALUATION_TOOL_NAME = "record_evaluation"
EVALUATION_TOOL_DESCRIPTION = (
    "Record the evaluation of a student's spoken answer using the rubric. "
    "correctness_score and understanding_score are integers from 0 to 5."
)
EVALUATION_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "correctness_score": {"type": "integer", "minimum": 0, "maximum": 5},
        "understanding_score": {"type": "integer", "minimum": 0, "maximum": 5},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "array", "items": {"type": "string"}},
        "feedback": {"type": "string"},
        "suggested_improvements": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["correctness_score", "understanding_score", "feedback"],
}


class ResponseEvaluationEngineError(Exception):
    pass


class ResponseEvaluationEngine:
    def __init__(
        self,
        agent_client,
        evaluation_prompt: str,
        *,
        min_transcript_chars: int = DEFAULT_MIN_TRANSCRIPT_CHARS,
        min_transcript_confidence: float = DEFAULT_MIN_TRANSCRIPT_CONFIDENCE,
        use_structured_output: bool = True,
    ):
        self.agent_client = agent_client
        self.evaluation_prompt = evaluation_prompt
        self.min_transcript_chars = min_transcript_chars
        self.min_transcript_confidence = min_transcript_confidence
        self.use_structured_output = use_structured_output

    # ──────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────

    def evaluate_qa_pair(self, qa_pair: Dict[str, Any], rubric: str = "", course_context: str = "") -> Dict[str, Any]:
        question = qa_pair["question"]
        answer = qa_pair["answer"]
        meta = {
            "question_id": question["id"],
            "question_number": question.get("questionNumber", 0),
            "question_type": question.get("questionType", ""),
        }
        return self._evaluate(
            transcript=answer.get("transcript"),
            confidence=self._coerce_confidence(answer.get("transcriptConfidence")),
            answer_type=answer.get("answerType", "audio"),
            user_prompt=self._build_qa_pair_prompt(question, answer, rubric, course_context),
            meta=meta,
        )

    def evaluate_single_question(self, response_data: Dict[str, str]) -> Dict[str, Any]:
        meta = {
            "question_number": int(response_data.get("question_number", 0)),
            "question": response_data.get("question", ""),
            "question_type": response_data.get("question_type", ""),
        }
        return self._evaluate(
            transcript=response_data.get("transcript"),
            confidence=self._coerce_confidence(response_data.get("transcript_confidence")),
            answer_type=response_data.get("answer_type", "audio"),
            user_prompt=self.build_evaluation_prompt(response_data),
            meta=meta,
        )

    # ──────────────────────────────────────────────────────────────
    # Core evaluation
    # ──────────────────────────────────────────────────────────────

    def _evaluate(
        self,
        *,
        transcript: Optional[str],
        confidence: Optional[float],
        answer_type: str,
        user_prompt: str,
        meta: Dict[str, Any],
    ) -> Dict[str, Any]:
        text = (transcript or "").strip()

        # Task 4: unusable audio must never be silently auto-scored 0. Empty or
        # too-short transcripts are flagged for review instead. A genuine
        # non-answer can still be zeroed by the instructor.
        if not text:
            return self._needs_review_eval(
                meta,
                ["empty_transcript"],
                feedback="No spoken response was detected for this question. It has been flagged for instructor review.",
            )
        if len(text) < self.min_transcript_chars:
            return self._needs_review_eval(
                meta,
                ["transcript_too_short"],
                feedback="The transcribed response was too short to evaluate reliably. It has been flagged for instructor review.",
            )

        messages = [
            {
                "role": "user",
                "content": [
                    {"text": self.evaluation_prompt},
                    {"text": user_prompt},
                ],
            }
        ]

        # Task 2: structured output first, hardened text-parse fallback, and a
        # flagged-for-review safety net — a malformed model response must never
        # surface a raw error string to the student.
        try:
            raw, method, structured_failed = self._run_model_evaluation(messages)
        except Exception as error:
            logger.error(
                "Evaluation failed for question %s: %s",
                meta.get("question_id") or meta.get("question_number"),
                error,
            )
            return self._needs_review_eval(
                meta,
                ["evaluation_error"],
                feedback="This response could not be evaluated automatically and has been flagged for instructor review.",
            )

        evaluation = self._normalize_evaluation(raw)
        evaluation["evaluation_method"] = method
        evaluation["needs_review"] = False
        evaluation["review_reasons"] = []
        if confidence is not None:
            evaluation["transcript_confidence"] = confidence

        # Task 4: a low-confidence transcript is still scored (there is text to
        # grade) but flagged so the instructor can verify the transcription.
        if (
            confidence is not None
            and answer_type in ("audio", "video")
            and confidence < self.min_transcript_confidence
        ):
            evaluation["needs_review"] = True
            evaluation["review_reasons"].append("low_confidence_transcript")

        # Task 2/5: structured output was attempted but the model fell back to
        # free-text parsing — surface it for a human glance.
        if structured_failed:
            evaluation["needs_review"] = True
            evaluation["review_reasons"].append("structured_output_fallback")

        evaluation.update(meta)
        return evaluation

    def _run_model_evaluation(self, messages: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], str, bool]:
        """
        Return (raw_eval_dict, method, structured_failed).

        Attempts forced structured output first when the client advertises it,
        then falls back to parsing free text. Raises only if the text-parse
        fallback itself fails (handled by the caller as needs_review).
        """
        structured_failed = False

        # `is True` (not truthiness) so a MagicMock test double — whose
        # attributes are auto-created and truthy — does not masquerade as
        # structured-output-capable.
        structured_capable = (
            self.use_structured_output
            and getattr(self.agent_client, "supports_structured_output", False) is True
            and hasattr(self.agent_client, "chat_structured")
        )
        if structured_capable:
            try:
                raw = self.agent_client.chat_structured(
                    messages,
                    tool_name=EVALUATION_TOOL_NAME,
                    description=EVALUATION_TOOL_DESCRIPTION,
                    input_schema=EVALUATION_TOOL_SCHEMA,
                    model_id=BEDROCK_MODEL_EVAL,
                )
                if isinstance(raw, dict) and ("correctness_score" in raw or "understanding_score" in raw):
                    return raw, "structured", False
                structured_failed = True
                logger.warning("Structured evaluation returned an unusable payload; falling back to text parse")
            except Exception as error:
                structured_failed = True
                logger.warning("Structured evaluation failed (%s); falling back to text parse", error)

        result = self.agent_client.chat(messages, model_id=BEDROCK_MODEL_EVAL)
        response_text = result if isinstance(result, str) else result.get("text", "")
        raw = self.parse_evaluation_response(response_text)
        return raw, "text", structured_failed

    # ──────────────────────────────────────────────────────────────
    # Normalization / validation (Task 2)
    # ──────────────────────────────────────────────────────────────

    @staticmethod
    def _clamp_dimension(value: Any) -> int:
        """Coerce to an int in [0, DIMENSION_MAX]; non-numeric becomes 0."""
        try:
            v = int(round(float(value)))
        except (TypeError, ValueError):
            return 0
        return max(0, min(DIMENSION_MAX, v))

    @staticmethod
    def _as_str_list(value: Any) -> List[str]:
        if value is None:
            return []
        if isinstance(value, (list, tuple, set)):
            return [str(v).strip() for v in value if str(v).strip()]
        s = str(value).strip()
        return [s] if s else []

    def _normalize_evaluation(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Clamp scores to range and enforce total = correctness + understanding."""
        correctness = self._clamp_dimension(raw.get("correctness_score"))
        understanding = self._clamp_dimension(raw.get("understanding_score"))
        feedback = str(raw.get("feedback") or "").strip() or "No feedback was provided."
        return {
            "correctness_score": correctness,
            "understanding_score": understanding,
            # Server-enforced — the model's own total_score is never trusted.
            "total_score": correctness + understanding,
            "feedback": feedback,
            "strengths": self._as_str_list(raw.get("strengths"))[:5],
            "weaknesses": self._as_str_list(raw.get("weaknesses"))[:5],
            "suggested_improvements": self._as_str_list(raw.get("suggested_improvements"))[:5],
        }

    def _needs_review_eval(
        self,
        meta: Dict[str, Any],
        reasons: List[str],
        *,
        feedback: str,
        evaluation_method: str = "unscored",
    ) -> Dict[str, Any]:
        """A valid, zero-score evaluation explicitly flagged for instructor review."""
        evaluation = {
            "correctness_score": 0,
            "understanding_score": 0,
            "total_score": 0,
            "feedback": feedback,
            "strengths": [],
            "weaknesses": [],
            "suggested_improvements": [],
            "needs_review": True,
            "review_reasons": list(reasons),
            "evaluation_method": evaluation_method,
        }
        evaluation.update(meta)
        return evaluation

    @staticmethod
    def _coerce_confidence(value: Any) -> Optional[float]:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    # ──────────────────────────────────────────────────────────────
    # Prompt building
    # ──────────────────────────────────────────────────────────────

    def _build_qa_pair_prompt(
        self, question: Dict[str, Any], answer: Dict[str, Any], rubric: str, course_context: str
    ) -> str:
        course_section = f"\n**Course Context:**\n{course_context}\n" if course_context else ""
        rubric_section = f"\n**Custom Rubric:**\n{rubric}\n" if rubric else ""
        return f"""{course_section}
**Question Type:** {question.get('questionType', 'general')}

**Question:**
{question.get('text', '')}

**Code Reference:**
```python
{question.get('codeContext', '')}
```
{rubric_section}
**Student's Answer (Transcribed from audio):**
{answer.get('transcript', 'No transcript available')}

---

Evaluate this response and provide your assessment in JSON format as specified.
"""

    def build_evaluation_prompt(self, response_data: Dict[str, str]) -> str:
        question_type = response_data.get("question_type", "general")
        question = response_data.get("question", "")
        code_ref = response_data.get("code_reference", "")
        transcript = response_data.get("transcript", "")

        prompt = f"""
**Question Type:** {question_type}

**Question:**
{question}
"""

        if code_ref and code_ref.strip():
            prompt += f"""
**Code Reference:**
```python
{code_ref}
```
"""

        prompt += f"""
**Student's Answer (Transcribed):**
{transcript}

---

Evaluate this response and provide your assessment in JSON format as specified.
"""

        return prompt

    def parse_evaluation_response(self, response_text: str) -> Dict[str, Any]:
        if "```json" in response_text:
            start = response_text.find("```json") + 7
            end = response_text.find("```", start)
            json_str = response_text[start:end].strip()
        elif "```" in response_text:
            start = response_text.find("```") + 3
            end = response_text.find("```", start)
            json_str = response_text[start:end].strip()
        else:
            json_str = response_text.strip()

        try:
            evaluation = json.loads(json_str)
        except json.JSONDecodeError as error:
            raise ResponseEvaluationEngineError(
                f"Failed to parse JSON response: {error}\\nResponse: {response_text[:500]}"
            )

        if not isinstance(evaluation, dict):
            raise ResponseEvaluationEngineError("Evaluation response was not a JSON object")

        # total_score is no longer required: it is recomputed server-side from
        # the two dimensions in _normalize_evaluation.
        required_fields = ["correctness_score", "understanding_score", "feedback"]
        for field in required_fields:
            if field not in evaluation:
                raise ResponseEvaluationEngineError(f"Missing required field: {field}")

        return evaluation

    @staticmethod
    def calculate_grade(percentage: float, cutoffs: Optional[Dict[str, Any]] = None) -> str:
        """Map a percentage to a grade label. Defaults reproduce the 90/75/60 scale."""
        return ScoringConfig(cutoffs=cutoffs).grade(percentage)
