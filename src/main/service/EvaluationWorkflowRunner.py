"""
EvaluationWorkflowRunner: Runs the DynamoDB-backed evaluation workflow.

For each student, reads questions + answers from DynamoDB, evaluates each via LLM,
and stores evaluation results back in DynamoDB.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from src.main.service.ScoringConfig import ScoringConfig

logger = logging.getLogger(__name__)


class EvaluationWorkflowRunner:
    def __init__(
        self,
        *,
        engine,
        repository,
        transcription_service: Optional[Any] = None,
    ):
        self.engine = engine
        self.repository = repository
        self.transcription_service = transcription_service

    def evaluate_from_dynamodb(self, job_id: str, student_id: str, assessment_id: str) -> None:
        try:
            logger.info("[Job %s] Starting DynamoDB evaluation for student %s", job_id, student_id)

            # Pre-pass: transcribe audio/video answers that don't yet have a transcript
            if self.transcription_service is not None:
                try:
                    n = self.transcription_service.transcribe_pending_answers(student_id, assessment_id)
                    if n:
                        logger.info("[Job %s] Transcribed %d answer(s) for student %s", job_id, n, student_id)
                except Exception as e:
                    logger.warning(
                        "[Job %s] Transcription pre-pass failed for student %s (continuing): %s",
                        job_id, student_id, e,
                    )

            questions_data = self.repository.read_questions(student_id, assessment_id)
            answers_data = self.repository.read_answers(student_id, assessment_id)
            # For text answers, populate 'transcript' from 'textContent' so the
            # engine doesn't receive an empty transcript.
            for ans in answers_data:
                if ans.get("answerType") == "text" and not ans.get("transcript"):
                    ans["transcript"] = ans.get("textContent", "")
            qa_pairs = self.match_questions_and_answers(questions_data, answers_data)
            total_questions = len(qa_pairs)

            # Read assessment metadata once for rubric, course context, and the
            # configurable scoring (max score per question / grade cutoffs).
            metadata = self._read_assessment_metadata(assessment_id)
            rubric = metadata.get("rubric") or ""
            course_context = self._course_context_from_metadata(metadata)
            scoring = ScoringConfig.from_metadata(metadata)
            max_per_question = scoring.max_score_per_question

            evaluations = []
            total_score = 0.0

            self._set_progress(job_id, student_id, assessment_id, 0, total_questions, "evaluating")

            for index, qa_pair in enumerate(qa_pairs):
                question_id = qa_pair["question"]["id"]
                answer_type = (qa_pair.get("answer") or {}).get("answerType")
                try:
                    logger.info("[Job %s] Evaluating question %d/%d", job_id, index + 1, total_questions)
                    if answer_type == "skipped":
                        # A skipped question is a deterministic zero — it is never
                        # sent to the LLM. Store a valid 0-score evaluation so the
                        # student's results show it as answered-with-zero rather
                        # than pending or flagged for review.
                        evaluation = {
                            "question_id": question_id,
                            "correctness_score": 0,
                            "understanding_score": 0,
                            "total_score": 0,
                            "feedback": "This question was skipped.",
                            "strengths": [],
                            "weaknesses": [],
                            "suggested_improvements": [],
                            "needs_review": False,
                            "evaluation_method": "skipped",
                        }
                    else:
                        try:
                            evaluation = self.engine.evaluate_qa_pair(qa_pair, rubric=rubric, course_context=course_context)
                        except Exception as first_error:
                            logger.warning("[Job %s] First attempt failed for question %d, retrying: %s", job_id, index + 1, first_error)
                            evaluation = self.engine.evaluate_qa_pair(qa_pair, rubric=rubric, course_context=course_context)
                    evaluation["max_score"] = max_per_question
                    evaluations.append(evaluation)
                    total_score += evaluation.get("total_score", 0)

                    self.repository.store_evaluation(student_id, assessment_id, question_id, evaluation)
                    self._set_progress(job_id, student_id, assessment_id, index + 1, total_questions, "evaluating")
                except Exception as error:
                    # Never surface a raw error to the student: store a valid,
                    # zero-score evaluation explicitly flagged for instructor review.
                    logger.error("[Job %s] Error evaluating question %d: %s", job_id, index + 1, error)
                    flagged = {
                        "question_id": question_id,
                        "correctness_score": 0,
                        "understanding_score": 0,
                        "total_score": 0,
                        "max_score": max_per_question,
                        "feedback": "This response could not be evaluated automatically and has been flagged for instructor review.",
                        "strengths": [],
                        "weaknesses": [],
                        "suggested_improvements": [],
                        "needs_review": True,
                        "review_reasons": ["evaluation_error"],
                        "evaluation_method": "unscored",
                    }
                    evaluations.append(flagged)
                    try:
                        self.repository.store_evaluation(student_id, assessment_id, question_id, flagged)
                    except Exception as store_error:
                        logger.error("[Job %s] Failed to store flagged evaluation for question %d: %s", job_id, index + 1, store_error)

            # Only scored evaluations count. A needs_review item contributed 0 to
            # total_score because the AI could not judge it — counting it in the
            # denominator too would score a system failure as a wrong answer.
            scored = [e for e in evaluations if not e.get("needs_review")]
            max_score = len(scored) * max_per_question
            percentage = (total_score / max_score * 100) if max_score > 0 else 0

            self._set_progress(job_id, student_id, assessment_id, total_questions, total_questions, "completed")

            logger.info(
                "[Job %s] DynamoDB evaluation completed. Score: %.1f/%d (%.1f%%)",
                job_id, total_score, max_score, percentage,
            )
        except Exception as error:
            logger.error("[Job %s] DynamoDB evaluation failed: %s", job_id, error)
            self._set_progress(job_id, student_id, assessment_id, 0, 0, "failed")
            # Re-raised so the SQS consumer retries the student (bounded, then the
            # DLQ) instead of deleting the message and leaving them unmarked.
            raise

    def _set_progress(self, job_id: str, student_id: str, assessment_id: str, done: int, total: int, status: str) -> None:
        """Best-effort progress marker. It only drives the instructor's progress bar,
        so a failed write must neither abort the run nor, inside the per-question
        loop, replace an evaluation that was already stored with a flagged zero."""
        try:
            self.repository.set_evaluation_progress(student_id, assessment_id, done, total, status)
        except Exception as e:
            logger.warning("[Job %s] Could not write evaluation progress for student %s: %s", job_id, student_id, e)

    @staticmethod
    def match_questions_and_answers(
        questions: List[Dict[str, Any]],
        answers: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        answer_map = {answer["questionId"]: answer for answer in answers}
        qa_pairs = []
        for question in questions:
            question_id = question["id"]
            answer = answer_map.get(question_id)
            if answer:
                qa_pairs.append({"question": question, "answer": answer})
        return qa_pairs

    def _read_assessment_metadata(self, assessment_id: str) -> Dict[str, Any]:
        """Read the assessment METADATA item, or {} if not available."""
        try:
            resp = self.repository.table.get_item(
                Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": "METADATA"}
            )
            return resp.get("Item") or {}
        except Exception as e:
            logger.warning("Could not read metadata for assessment %s: %s", assessment_id, e)
            return {}

    @staticmethod
    def _course_context_from_metadata(metadata: Dict[str, Any]) -> str:
        """Build the course-context string (course name + description) from metadata."""
        course_name = metadata.get("courseName") or ""
        description = metadata.get("description") or ""
        parts = [p for p in [course_name, description] if p]
        return " — ".join(parts) if parts else ""
