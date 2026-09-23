import pytest
from fastapi.testclient import TestClient
from unittest.mock import MagicMock

from app import create_app
from src.main.controllers import controller_helpers
from src.main.controllers import controller_dependencies


@pytest.fixture
def mock_chat_service():
    mock = MagicMock()
    mock.chat.return_value = {
        "answer": "Test answer",
        "session_id": "view-123",
        "is_new_session": False,
        "history_length": 2,
        "context_ids": ["doc-1"],
        "tokens_input": 25,
        "tokens_output": 40,
        "model_id": "test-model",
    }
    mock._generate_session_title.return_value = "Generated Title"
    return mock


@pytest.fixture
def mock_history_store():
    mock = MagicMock()

    mock.create_workspace.return_value = {
        "workspace_id": "ws-123",
        "title": "AI Assistant",
        "user_id": "user-1",
        "created_at": "2026-02-17T00:00:00Z",
        "last_accessed": "2026-02-17T00:00:00Z",
    }
    mock.get_workspace.return_value = mock.create_workspace.return_value

    mock.create_view_session.return_value = {
        "view_session_id": "view-123",
        "workspace_id": "ws-123",
        "view_type": "chat",
        "title": "New Chat",
        "created_at": "2026-02-17T00:01:00Z",
        "last_accessed": "2026-02-17T00:01:00Z",
        "message_count": 0,
        "total_tokens": 0,
        "pedagogy_mode": "explanatory",
    }
    mock.get_view_session.return_value = mock.create_view_session.return_value
    mock.list_view_sessions.return_value = [mock.create_view_session.return_value]

    mock.get_view_history.return_value = [
        {
            "role": "user",
            "content": "First question",
            "timestamp": "2026-02-17T00:02:00Z",
        },
        {
            "role": "assistant",
            "content": "First answer",
            "timestamp": "2026-02-17T00:02:02Z",
            "tokens": 40,
            "context_ids": ["doc-1"],
        },
    ]

    mock.create_code_memory.return_value = {
        "code_memory_id": "cm-123",
        "workspace_id": "ws-123",
        "language": "python",
        "current_code": "print('hello')",
        "last_output": None,
        "last_error": None,
        "created_at": "2026-02-17T00:01:00Z",
        "last_accessed": "2026-02-17T00:01:00Z",
    }
    mock.get_code_memory.return_value = mock.create_code_memory.return_value

    mock.create_thread.return_value = {
        "thread_id": "thread-123",
        "code_memory_id": "cm-123",
        "title": "New Thread",
        "created_at": "2026-02-17T00:03:00Z",
        "last_accessed": "2026-02-17T00:03:00Z",
        "message_count": 0,
    }
    mock.get_thread.return_value = mock.create_thread.return_value
    mock.get_thread_history.return_value = []
    mock.list_threads.return_value = [mock.create_thread.return_value]

    return mock


@pytest.fixture
def client(mock_chat_service, mock_history_store):
    app = create_app()
    app.dependency_overrides[controller_dependencies.get_chat_service] = lambda: mock_chat_service
    app.dependency_overrides[controller_dependencies.get_history_store] = lambda: mock_history_store
    app.dependency_overrides[controller_helpers._require_user_id] = lambda: "user-1"
    return TestClient(app), mock_chat_service, mock_history_store


def _headers():
    return {"X-User-Id": "user-1"}


class TestHistoryWorkspaceAndViews:
    def test_create_workspace(self, client):
        test_client, _, _ = client
        response = test_client.post(
            "/internal/history/workspaces",
            json={"title": "AI Assistant", "user_id": "user-1"},
            headers=_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["workspace_id"] == "ws-123"
        assert data["title"] == "AI Assistant"

    def test_create_view_session(self, client):
        test_client, _, mock_store = client
        response = test_client.post(
            "/internal/history/views",
            json={"workspace_id": "ws-123", "view_type": "chat", "pedagogy_mode": "explanatory"},
            headers=_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["view_session_id"] == "view-123"
        assert data["title"] == "New Chat"
        mock_store.create_view_session.assert_called_once_with("ws-123", "chat", "explanatory")

    def test_list_view_sessions(self, client):
        test_client, _, _ = client
        response = test_client.get(
            "/internal/history/workspaces/ws-123/views?view_type=chat",
            headers=_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["workspace_id"] == "ws-123"
        assert len(data["views"]) == 1
        assert data["views"][0]["view_session_id"] == "view-123"

    def test_get_view_history(self, client):
        test_client, _, _ = client
        response = test_client.get(
            "/internal/history/views/view-123/history",
            headers=_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["view_session_id"] == "view-123"
        assert data["message_count"] >= 0


class TestHistoryMessaging:
    def test_post_view_message_uses_history_override(self, client):
        test_client, mock_chat, mock_store = client

        response = test_client.post(
            "/internal/history/views/view-123/message",
            json={"query": "What is Python?", "include_history": True},
            headers=_headers(),
        )

        assert response.status_code == 200
        call_kwargs = mock_chat.chat.call_args.kwargs
        assert call_kwargs["session_id"] == "view-123"
        assert call_kwargs["persist_history"] is False
        assert call_kwargs["history_override"] == mock_store.get_view_history.return_value
        assert call_kwargs["pedagogy_mode"] == "explanatory"

    def test_post_thread_message_uses_history_override(self, client):
        test_client, mock_chat, mock_store = client

        response = test_client.post(
            "/internal/history/threads/thread-123/message",
            json={"query": "Help me debug this", "include_history": True},
            headers=_headers(),
        )

        assert response.status_code == 200
        call_kwargs = mock_chat.chat.call_args.kwargs
        assert call_kwargs["session_id"] == "thread-123"
        assert call_kwargs["persist_history"] is False
        assert call_kwargs["history_override"] == mock_store.get_thread_history.return_value
        assert call_kwargs["pedagogy_mode"] == "concise"


class TestHealth:
    def test_health_endpoint(self, client):
        test_client, _, _ = client
        response = test_client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
