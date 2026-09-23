"""
Unit tests for QuestionGenerationService with mocked LLM.

Covers:
- Prompt construction
- JSON response parsing (plain, markdown-fenced, malformed)
- generate_questions end-to-end with mocked LLM and DynamoDB
"""
from __future__ import annotations

import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from src.main.service.QuestionGenerationService import (
    QuestionGenerationService,
    QuestionGenerationError,
)

TABLE_NAME = "test_oral_assessments"

SAMPLE_QUESTIONS = [
    {
        "question_number": 1,
        "question_type": "specific",
        "question": "Explain your for loop on line 5.",
        "rationale": "Tests loop understanding",
        "code_reference": "for i in range(10):",
    },
    {
        "question_number": 2,
        "question_type": "general",
        "question": "What is a list comprehension?",
        "rationale": "Tests Python knowledge",
        "code_reference": "",
    },
]


@pytest.fixture()
def mock_llm():
    """Return a MagicMock LLM client that returns sample questions."""
    client = MagicMock()
    client.chat.return_value = {"text": json.dumps(SAMPLE_QUESTIONS)}
    return client


@pytest.fixture()
def temp_output_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d


@pytest.fixture()
def dynamo_env(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_ASSESSMENT_TABLE", TABLE_NAME)

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        table = dynamodb.create_table(
            TableName=TABLE_NAME,
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
        table.meta.client.get_waiter("table_exists").wait(TableName=TABLE_NAME)
        yield table


# ─────────────────────────────────────────────────────────────
# JSON parsing
# ─────────────────────────────────────────────────────────────

class TestParseJsonResponse:
    def _make_svc(self, mock_llm, temp_output_dir):
        return QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)

    def test_parse_plain_json(self, mock_llm, temp_output_dir):
        svc = self._make_svc(mock_llm, temp_output_dir)
        result = svc._parse_json_response(json.dumps(SAMPLE_QUESTIONS))
        assert len(result) == 2
        assert result[0]["question_type"] == "specific"

    def test_parse_json_in_markdown_fence(self, mock_llm, temp_output_dir):
        svc = self._make_svc(mock_llm, temp_output_dir)
        fenced = f"```json\n{json.dumps(SAMPLE_QUESTIONS)}\n```"
        result = svc._parse_json_response(fenced)
        assert len(result) == 2

    def test_parse_json_in_bare_fence(self, mock_llm, temp_output_dir):
        svc = self._make_svc(mock_llm, temp_output_dir)
        fenced = f"```\n{json.dumps(SAMPLE_QUESTIONS)}\n```"
        result = svc._parse_json_response(fenced)
        assert len(result) == 2

    def test_parse_invalid_json_raises(self, mock_llm, temp_output_dir):
        svc = self._make_svc(mock_llm, temp_output_dir)
        with pytest.raises(QuestionGenerationError, match="Failed to parse"):
            svc._parse_json_response("this is not json")

    def test_parse_non_array_raises(self, mock_llm, temp_output_dir):
        svc = self._make_svc(mock_llm, temp_output_dir)
        with pytest.raises(QuestionGenerationError, match="Expected JSON array"):
            svc._parse_json_response('{"key": "value"}')


# ─────────────────────────────────────────────────────────────
# Prompt construction
# ─────────────────────────────────────────────────────────────

class TestPromptConstruction:
    def test_system_prompt_includes_template(self, mock_llm, temp_output_dir):
        svc = QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)
        prompt = svc._build_system_prompt()
        assert "JSON" in prompt
        assert "question_number" in prompt

    def test_user_prompt_includes_brief_and_code(self, mock_llm, temp_output_dir):
        svc = QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)
        prompt = svc._build_user_prompt("Build a BST", "class BST:\n    pass")
        assert "Build a BST" in prompt
        assert "class BST:" in prompt


# ─────────────────────────────────────────────────────────────
# End-to-end generation
# ─────────────────────────────────────────────────────────────

class TestGenerateQuestions:
    def test_generate_returns_questions_and_files(self, mock_llm, temp_output_dir):
        svc = QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)

        result = svc.generate_questions(
            assignment_brief="Implement a binary search tree",
            student_code="class BST:\n    pass",
            student_name="alice",
        )

        assert result["questions_count"] == 2
        assert os.path.exists(result["json_file_path"])
        assert os.path.exists(result["csv_file_path"])

        with open(result["json_file_path"]) as f:
            saved = json.load(f)
        assert len(saved) == 2

    def test_generate_stores_in_dynamodb_when_ids_provided(self, mock_llm, dynamo_env, temp_output_dir):
        svc = QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)
        svc.table = dynamo_env

        result = svc.generate_questions(
            assignment_brief="Build a queue",
            student_code="class Queue:\n    pass",
            student_name="bob",
            student_id="s-bob",
            assessment_id="a-1",
        )

        assert result["dynamodb_stored"] is True

    def test_generate_is_idempotent_per_student(self, mock_llm, dynamo_env, temp_output_dir):
        """A redelivered message or a re-run batch must not append a second set of
        questions (they are stored under fresh uuids) or pay for another LLM call."""
        svc = QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)
        svc.table = dynamo_env
        kwargs = dict(assignment_brief="Brief", student_code="x = 1", student_name="bob",
                      student_id="s-bob", assessment_id="a-1")

        def stored_questions():
            return [i for i in dynamo_env.scan()["Items"] if i["SK"].startswith("QUESTION#")]

        svc.generate_questions(**kwargs)
        first_set = len(stored_questions())
        result = svc.generate_questions(**kwargs)

        assert first_set > 0
        assert result["skipped_existing"] is True
        assert mock_llm.chat.call_count == 1
        assert len(stored_questions()) == first_set

    def test_generate_store_failure_raises(self, mock_llm, dynamo_env, temp_output_dir):
        """A failed write must reach the SQS consumer as a failure so it is retried."""
        svc = QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)
        svc.table = dynamo_env
        svc._store_questions_in_dynamodb = MagicMock(side_effect=RuntimeError("throttled"))

        with pytest.raises(QuestionGenerationError, match="Failed to store"):
            svc.generate_questions(assignment_brief="Brief", student_code="x = 1", student_name="bob",
                                   student_id="s-bob", assessment_id="a-1")

    def test_generate_llm_error_raises(self, temp_output_dir):
        llm = MagicMock()
        llm.chat.side_effect = RuntimeError("LLM down")
        svc = QuestionGenerationService(agent_client=llm, output_dir=temp_output_dir)

        with pytest.raises(QuestionGenerationError, match="LLM call failed"):
            svc.generate_questions(
                assignment_brief="Brief",
                student_code="code",
                student_name="test",
            )


# ─────────────────────────────────────────────────────────────
# Task 7: validation — dedupe + count-mismatch warning
# ─────────────────────────────────────────────────────────────

class TestValidateQuestions:
    def _svc(self, mock_llm, temp_output_dir):
        return QuestionGenerationService(agent_client=mock_llm, output_dir=temp_output_dir)

    def test_dedupes_questions_within_set(self, mock_llm, temp_output_dir):
        svc = self._svc(mock_llm, temp_output_dir)
        questions = [
            {"question_number": 1, "question_type": "specific", "question": "Explain your loop."},
            {"question_number": 2, "question_type": "specific", "question": "  explain   YOUR loop. "},  # dup
            {"question_number": 3, "question_type": "general", "question": "What is a list?"},
        ]
        valid = svc._validate_questions(questions)
        assert len(valid) == 2
        texts = [q["question"] for q in valid]
        assert "Explain your loop." in texts
        assert "What is a list?" in texts

    def test_exact_duplicate_dropped(self, mock_llm, temp_output_dir):
        svc = self._svc(mock_llm, temp_output_dir)
        questions = [
            {"question_number": 1, "question_type": "general", "question": "Same question?"},
            {"question_number": 2, "question_type": "general", "question": "Same question?"},
        ]
        assert len(svc._validate_questions(questions)) == 1

    def test_count_mismatch_warns_but_does_not_fail(self, mock_llm, temp_output_dir, caplog):
        import logging
        svc = self._svc(mock_llm, temp_output_dir)
        questions = [
            {"question_number": 1, "question_type": "specific", "question": "Q1"},
            {"question_number": 2, "question_type": "general", "question": "Q2"},
        ]
        with caplog.at_level(logging.WARNING):
            valid = svc._validate_questions(questions)
        assert len(valid) == 2  # batch not failed
        messages = " ".join(r.getMessage().lower() for r in caplog.records)
        assert "count mismatch" in messages

    def test_correct_counts_no_mismatch_warning(self, mock_llm, temp_output_dir, caplog):
        import logging
        svc = self._svc(mock_llm, temp_output_dir)
        questions = (
            [{"question_number": i, "question_type": "specific", "question": f"Specific {i}"} for i in range(1, 6)]
            + [{"question_number": i, "question_type": "general", "question": f"General {i}"} for i in range(6, 9)]
        )
        with caplog.at_level(logging.WARNING):
            valid = svc._validate_questions(questions)
        assert len(valid) == 8
        assert "count mismatch" not in " ".join(r.getMessage().lower() for r in caplog.records)

    def test_missing_question_field_dropped(self, mock_llm, temp_output_dir):
        svc = self._svc(mock_llm, temp_output_dir)
        questions = [
            {"question_number": 1, "question_type": "specific", "question": ""},
            {"question_number": 2, "question_type": "general", "question": "Valid?"},
        ]
        valid = svc._validate_questions(questions)
        assert len(valid) == 1
        assert valid[0]["question"] == "Valid?"
