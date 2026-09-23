"""Integration tests for DynamoDBConversationMemory using moto."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from src.main.agentcore_setup.dynamodb_memory import DynamoDBConversationMemory

TABLE = "test_chat_sessions"


@pytest.fixture()
def memory(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        dynamodb.create_table(
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
        yield DynamoDBConversationMemory(table_name=TABLE, region="us-east-1", ttl_days=30)


class TestAddAndGet:
    def test_add_and_get_history(self, memory):
        memory.add_message("s-1", "user", "Hello", tokens=5)
        memory.add_message("s-1", "assistant", "Hi there!", tokens=10, context_ids=["d1"])

        history = memory.get_history("s-1")
        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[1]["context_ids"] == ["d1"]

    def test_get_history_empty_session(self, memory):
        assert memory.get_history("nonexistent") == []

    def test_get_history_with_limit(self, memory):
        for i in range(5):
            memory.add_message("s-2", "user", f"msg {i}")

        history = memory.get_history("s-2", max_messages=3)
        assert len(history) == 3
        # Should be the 3 most recent
        assert history[0]["content"] == "msg 2"

    def test_get_formatted_history(self, memory):
        memory.add_message("s-3", "user", "What is a list?")
        memory.add_message("s-3", "assistant", "A list is a collection.")

        formatted = memory.get_formatted_history("s-3")
        assert "Student: What is a list?" in formatted
        assert "Tutor: A list is a collection." in formatted

    def test_get_formatted_history_empty(self, memory):
        assert memory.get_formatted_history("empty") == ""


class TestSessionMetadata:
    def test_session_exists(self, memory):
        assert memory.session_exists("new") is False
        memory.add_message("new", "user", "hi")
        assert memory.session_exists("new") is True

    def test_get_session_info(self, memory):
        memory.add_message("s-4", "user", "hello", tokens=5)
        memory.add_message("s-4", "assistant", "hi", tokens=10)

        info = memory.get_session_info("s-4")
        assert info["session_id"] == "s-4"
        assert info["message_count"] == 2
        assert info["total_tokens"] == 15
        assert info["pedagogy_mode"] == "explanatory"

    def test_get_session_info_nonexistent(self, memory):
        assert memory.get_session_info("nope") is None

    def test_get_session_stats_alias(self, memory):
        assert memory.get_session_stats("nope") == {}
        memory.add_message("s-5", "user", "test")
        stats = memory.get_session_stats("s-5")
        assert stats["message_count"] == 1


class _PagedTable:
    """Real moto table, but every query is capped at `page` items so LastEvaluatedKey paging kicks in."""

    def __init__(self, table, page: int):
        self._table = table
        self._page = page

    def query(self, **kwargs):
        return self._table.query(Limit=self._page, **kwargs)

    def __getattr__(self, name):
        return getattr(self._table, name)


class TestPagination:
    def test_get_history_follows_last_evaluated_key(self, memory):
        for i in range(5):
            memory.add_message("s-pg", "user", f"msg-{i}")
        memory.table = _PagedTable(memory.table, page=2)

        history = memory.get_history("s-pg")
        assert [m["content"] for m in history] == [f"msg-{i}" for i in range(5)]


class TestPedagogyMode:
    def test_set_and_get(self, memory):
        memory.add_message("s-p", "user", "test")
        memory.set_pedagogy_mode("s-p", "concise")
        assert memory.get_pedagogy_mode("s-p") == "concise"

    def test_get_default(self, memory):
        assert memory.get_pedagogy_mode("no-such-session") == "explanatory"

    def test_set_creates_session_if_needed(self, memory):
        memory.set_pedagogy_mode("brand-new", "concise")
        assert memory.session_exists("brand-new") is True
        assert memory.get_pedagogy_mode("brand-new") == "concise"


class TestLegacy:
    def test_get_state(self, memory):
        memory.add_message("s-leg", "user", "hi")
        state = memory.get_state("s-leg")
        assert state["message_count"] == 1

    def test_set_state_creates_session(self, memory):
        memory.set_state("new-leg", {})
        assert memory.session_exists("new-leg") is True

    def test_update_session_title(self, memory):
        memory.add_message("s-title", "user", "hi")
        memory.update_session_title("s-title", "My Chat")
        info = memory.get_session_info("s-title")
        assert info["title"] == "My Chat"
