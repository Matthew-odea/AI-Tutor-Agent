"""Integration tests for DynamoDBHistoryStore using moto."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from src.main.agentcore_setup.dynamodb_history import DynamoDBHistoryStore

TABLE = "test_chat_sessions"


@pytest.fixture()
def store(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("DYNAMODB_TABLE_NAME", TABLE)

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
        yield DynamoDBHistoryStore(table_name=TABLE, region="us-east-1")


class TestWorkspace:
    def test_create_and_get(self, store):
        ws = store.create_workspace("My Workspace", user_id="u-1")
        assert ws["title"] == "My Workspace"
        fetched = store.get_workspace(ws["workspace_id"])
        assert fetched["user_id"] == "u-1"

    def test_get_nonexistent(self, store):
        assert store.get_workspace("nope") is None


class TestViewSessions:
    def test_create_and_list(self, store):
        ws = store.create_workspace("W1")
        v1 = store.create_view_session(ws["workspace_id"], "chat", "explanatory")
        v2 = store.create_view_session(ws["workspace_id"], "chat", "concise")

        sessions = store.list_view_sessions(ws["workspace_id"])
        assert len(sessions) == 2

    def test_list_filtered_by_type(self, store):
        ws = store.create_workspace("W1")
        store.create_view_session(ws["workspace_id"], "chat", None)
        store.create_view_session(ws["workspace_id"], "assistant", None)

        chat_only = store.list_view_sessions(ws["workspace_id"], view_type="chat")
        assert len(chat_only) == 1

    def test_get_view_session(self, store):
        ws = store.create_workspace("W1")
        view = store.create_view_session(ws["workspace_id"], "chat", "explanatory")
        fetched = store.get_view_session(view["view_session_id"])
        assert fetched["pedagogy_mode"] == "explanatory"

    def test_update_title(self, store):
        ws = store.create_workspace("W1")
        view = store.create_view_session(ws["workspace_id"], "chat", None)
        updated = store.update_view_title(view["view_session_id"], "Renamed")
        assert updated["title"] == "Renamed"

    def test_delete_view_session(self, store):
        ws = store.create_workspace("W1")
        view = store.create_view_session(ws["workspace_id"], "chat", None)
        store.add_view_message(view["view_session_id"], "user", "hi")

        store.delete_view_session(view["view_session_id"])
        assert store.get_view_session(view["view_session_id"]) is None
        assert store.get_view_history(view["view_session_id"]) == []


class TestViewMessages:
    def test_add_and_get_history(self, store):
        ws = store.create_workspace("W1")
        view = store.create_view_session(ws["workspace_id"], "chat", None)

        store.add_view_message(view["view_session_id"], "user", "Hello", tokens=5)
        store.add_view_message(view["view_session_id"], "assistant", "Hi!", tokens=3, context_ids=["doc-1"])

        history = store.get_view_history(view["view_session_id"])
        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[1]["context_ids"] == ["doc-1"]

    def test_message_updates_metadata(self, store):
        ws = store.create_workspace("W1")
        view = store.create_view_session(ws["workspace_id"], "chat", None)
        store.add_view_message(view["view_session_id"], "user", "msg1", tokens=10)
        store.add_view_message(view["view_session_id"], "assistant", "msg2", tokens=20)

        meta = store.get_view_session(view["view_session_id"])
        assert int(meta["message_count"]) == 2
        assert int(meta["total_tokens"]) == 30


class TestCodeMemory:
    def test_create_and_get(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "x = 1")
        fetched = store.get_code_memory(cm["code_memory_id"])
        assert fetched["current_code"] == "x = 1"

    def test_update_code_memory(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "x = 1")
        updated = store.update_code_memory(cm["code_memory_id"], current_code="x = 2", last_output="2", last_error=None)
        assert updated["current_code"] == "x = 2"
        assert updated["last_output"] == "2"


class TestPrograms:
    def test_create_and_list(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        p1 = store.create_program(ws["workspace_id"], cm["code_memory_id"], "python", "Prog1", "print(1)")
        p2 = store.create_program(ws["workspace_id"], cm["code_memory_id"], "python", "Prog2", "print(2)")

        programs = store.list_programs(ws["workspace_id"])
        assert len(programs) == 2

    def test_get_program(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        p = store.create_program(ws["workspace_id"], cm["code_memory_id"], "python", "Test", "code")
        fetched = store.get_program(p["program_id"])
        assert fetched["title"] == "Test"

    def test_update_program(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        p = store.create_program(ws["workspace_id"], cm["code_memory_id"], "python", "P1", "old")
        updated = store.update_program(p["program_id"], title="Renamed", current_code="new", last_output=None, last_error=None)
        assert updated["title"] == "Renamed"
        assert updated["current_code"] == "new"

    def test_delete_program(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        p = store.create_program(ws["workspace_id"], cm["code_memory_id"], "python", "P1", "code")
        store.delete_program(p["program_id"])
        assert store.get_program(p["program_id"]) is None


class TestThreads:
    def test_create_and_list(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        t1 = store.create_thread(cm["code_memory_id"], "Thread 1")
        t2 = store.create_thread(cm["code_memory_id"], "Thread 2")

        threads = store.list_threads(cm["code_memory_id"])
        assert len(threads) == 2

    def test_add_thread_message_and_history(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        t = store.create_thread(cm["code_memory_id"], "T1")

        store.add_thread_message(t["thread_id"], "user", "Fix my code", tokens=10)
        store.add_thread_message(t["thread_id"], "assistant", "Here's the fix", tokens=20, edit_block={"diff": "+x"})

        history = store.get_thread_history(t["thread_id"])
        assert len(history) == 2
        assert history[1]["edit_block"] == {"diff": "+x"}

    def test_update_thread_title(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        t = store.create_thread(cm["code_memory_id"], "Old Title")
        updated = store.update_thread_title(t["thread_id"], "New Title")
        assert updated["title"] == "New Title"

    def test_get_thread(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        t = store.create_thread(cm["code_memory_id"], "T1")
        fetched = store.get_thread(t["thread_id"])
        assert fetched["title"] == "T1"


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
    def test_view_history_and_delete_follow_last_evaluated_key(self, store):
        ws = store.create_workspace("W1")
        view = store.create_view_session(ws["workspace_id"], "chat", None)
        for i in range(5):
            store.add_view_message(view["view_session_id"], "user", f"msg-{i}")
        raw_table = store.table
        store.table = _PagedTable(raw_table, page=2)

        history = store.get_view_history(view["view_session_id"])
        assert [m["content"] for m in history] == [f"msg-{i}" for i in range(5)]

        store.delete_view_session(view["view_session_id"])
        leftover = raw_table.query(
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": f"VIEW#{view['view_session_id']}"},
        )["Items"]
        assert leftover == []

    def test_thread_history_and_delete_follow_last_evaluated_key(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        thread = store.create_thread(cm["code_memory_id"], "T")
        for i in range(5):
            store.add_thread_message(thread["thread_id"], "user", f"msg-{i}")
        raw_table = store.table
        store.table = _PagedTable(raw_table, page=2)

        assert len(store.get_thread_history(thread["thread_id"])) == 5

        store.delete_thread(thread["thread_id"])
        leftover = raw_table.query(
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": f"THREAD#{thread['thread_id']}"},
        )["Items"]
        assert leftover == []

    def test_list_queries_follow_last_evaluated_key(self, store):
        ws = store.create_workspace("W1")
        cm = store.create_code_memory(ws["workspace_id"], "python", "")
        for i in range(3):
            store.create_view_session(ws["workspace_id"], "chat", None)
            store.create_program(ws["workspace_id"], cm["code_memory_id"], "python", f"P{i}", "")
            store.create_thread(cm["code_memory_id"], f"T{i}")
        store.table = _PagedTable(store.table, page=1)

        assert len(store.list_view_sessions(ws["workspace_id"])) == 3
        assert len(store.list_programs(ws["workspace_id"])) == 3
        assert len(store.list_threads(cm["code_memory_id"])) == 3
