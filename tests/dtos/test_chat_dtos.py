import pytest
from pydantic import ValidationError
from src.main.dtos.ChatRequest import ChatRequest
from src.main.dtos.ChatResponse import ChatResponse
from src.main.dtos.ChatHistoryResponse import ChatHistoryResponse, ChatMessage
from src.main.dtos.SessionListResponse import SessionListResponse, SessionInfo


class TestChatRequest:
    def test_valid_minimal_request(self):
        req = ChatRequest(query="What is Python?")
        assert req.query == "What is Python?"
        assert req.top_k == 5
        assert req.session_id is None
        assert req.include_history is True
    
    def test_valid_full_request(self):
        req = ChatRequest(
            query="Explain inheritance",
            top_k=10,
            session_id="my-session-123",
            include_history=False
        )
        assert req.query == "Explain inheritance"
        assert req.top_k == 10
        assert req.session_id == "my-session-123"
        assert req.include_history is False
    
    def test_empty_query(self):
        """Empty query is allowed; the service handles it."""
        req = ChatRequest(query="")
        assert req.query == ""
    
    def test_missing_query_raises_error(self):
        with pytest.raises(ValidationError):
            ChatRequest()
    
    def test_invalid_top_k_type(self):
        with pytest.raises(ValidationError):
            ChatRequest(query="Test", top_k="invalid")
    
    def test_session_id_optional(self):
        req = ChatRequest(query="Test")
        assert req.session_id is None


class TestChatResponse:
    def test_valid_minimal_response(self):
        resp = ChatResponse(
            answer="Python is a programming language",
            session_id="session-123",
            is_new_session=True,
            history_length=0
        )
        assert resp.answer == "Python is a programming language"
        assert resp.session_id == "session-123"
        assert resp.is_new_session is True
        assert resp.history_length == 0
        assert resp.context_ids == []
    
    def test_valid_full_response(self):
        resp = ChatResponse(
            answer="Here's the explanation...",
            session_id="session-456",
            is_new_session=False,
            history_length=4,
            context_ids=["doc-1", "doc-2", "doc-3"],
            tokens_input=150,
            tokens_output=200,
            model_id="anthropic.claude-v2"
        )
        assert resp.answer == "Here's the explanation..."
        assert resp.session_id == "session-456"
        assert resp.is_new_session is False
        assert resp.history_length == 4
        assert len(resp.context_ids) == 3
        assert resp.tokens_input == 150
        assert resp.tokens_output == 200
        assert resp.model_id == "anthropic.claude-v2"
    
    def test_missing_required_fields(self):
        """answer and session_id are optional so error responses can carry only `error`."""
        resp = ChatResponse(error="Test error")
        assert resp.error == "Test error"
        assert resp.answer is None
        assert resp.session_id is None
    
    def test_empty_answer_allowed(self):
        resp = ChatResponse(
            answer="",
            session_id="session-123",
            is_new_session=True,
            history_length=0
        )
        assert resp.answer == ""
    
    def test_optional_fields_can_be_none(self):
        resp = ChatResponse(
            answer="Test answer",
            session_id="session-123",
            is_new_session=True,
            history_length=0,
            tokens_input=None,
            tokens_output=None,
            model_id=None
        )
        assert resp.tokens_input is None
        assert resp.tokens_output is None
        assert resp.model_id is None


class TestChatMessage:
    def test_valid_user_message(self):
        msg = ChatMessage(
            role="user",
            content="What is Python?",
            timestamp="2025-11-13T10:30:15.123456"
        )
        assert msg.role == "user"
        assert msg.content == "What is Python?"
        assert msg.timestamp == "2025-11-13T10:30:15.123456"
        assert msg.tokens is None
        assert msg.context_ids == []
    
    def test_valid_assistant_message(self):
        msg = ChatMessage(
            role="assistant",
            content="Python is a programming language",
            timestamp="2025-11-13T10:30:17.456789",
            tokens=150,
            context_ids=["doc-1", "doc-2"]
        )
        assert msg.role == "assistant"
        assert msg.tokens == 150
        assert len(msg.context_ids) == 2
    
    def test_missing_required_fields(self):
        with pytest.raises(ValidationError):
            ChatMessage(role="user")  # Missing content and timestamp


class TestChatHistoryResponse:
    def test_valid_empty_history(self):
        resp = ChatHistoryResponse(
            session_id="session-123",
            messages=[],
            total_messages=0,
            created_at="2025-11-13T10:30:00.000000",
            last_accessed="2025-11-13T10:30:00.000000",
            total_tokens=0
        )
        assert resp.session_id == "session-123"
        assert len(resp.messages) == 0
        assert resp.total_messages == 0
        assert resp.total_tokens == 0
    
    def test_valid_history_with_messages(self):
        messages = [
            ChatMessage(
                role="user",
                content="Question 1",
                timestamp="2025-11-13T10:30:00.000000"
            ),
            ChatMessage(
                role="assistant",
                content="Answer 1",
                timestamp="2025-11-13T10:30:02.000000",
                tokens=100,
                context_ids=["doc-1"]
            ),
            ChatMessage(
                role="user",
                content="Question 2",
                timestamp="2025-11-13T10:31:00.000000"
            ),
            ChatMessage(
                role="assistant",
                content="Answer 2",
                timestamp="2025-11-13T10:31:03.000000",
                tokens=120,
                context_ids=["doc-2"]
            )
        ]
        
        resp = ChatHistoryResponse(
            session_id="session-456",
            messages=messages,
            total_messages=4,
            created_at="2025-11-13T10:30:00.000000",
            last_accessed="2025-11-13T10:31:03.000000",
            total_tokens=220
        )
        
        assert resp.session_id == "session-456"
        assert len(resp.messages) == 4
        assert resp.total_messages == 4
        assert resp.total_tokens == 220
        assert resp.messages[0].role == "user"
        assert resp.messages[1].role == "assistant"
    
    def test_missing_required_fields(self):
        with pytest.raises(ValidationError):
            ChatHistoryResponse(session_id="test")  # Missing other fields


class TestSessionInfo:
    def test_valid_session_info(self):
        info = SessionInfo(
            session_id="session-123",
            message_count=6,
            created_at="2025-11-13T10:00:00.000000",
            last_accessed="2025-11-13T10:30:00.000000",
            total_tokens=500
        )
        assert info.session_id == "session-123"
        assert info.message_count == 6
        assert info.created_at == "2025-11-13T10:00:00.000000"
        assert info.last_accessed == "2025-11-13T10:30:00.000000"
        assert info.total_tokens == 500
    
    def test_zero_message_count(self):
        info = SessionInfo(
            session_id="session-empty",
            message_count=0,
            created_at="2025-11-13T10:00:00.000000",
            last_accessed="2025-11-13T10:00:00.000000",
            total_tokens=0
        )
        assert info.message_count == 0
        assert info.total_tokens == 0


class TestSessionListResponse:
    def test_valid_empty_list(self):
        resp = SessionListResponse(
            sessions=[],
            total=0
        )
        assert len(resp.sessions) == 0
        assert resp.total == 0
    
    def test_valid_list_with_sessions(self):
        sessions = [
            SessionInfo(
                session_id="session-1",
                message_count=4,
                created_at="2025-11-13T10:00:00.000000",
                last_accessed="2025-11-13T10:15:00.000000",
                total_tokens=300
            ),
            SessionInfo(
                session_id="session-2",
                message_count=2,
                created_at="2025-11-13T10:20:00.000000",
                last_accessed="2025-11-13T10:25:00.000000",
                total_tokens=150
            ),
            SessionInfo(
                session_id="session-3",
                message_count=8,
                created_at="2025-11-13T09:00:00.000000",
                last_accessed="2025-11-13T10:30:00.000000",
                total_tokens=600
            )
        ]
        
        resp = SessionListResponse(
            sessions=sessions,
            total=3
        )
        
        assert len(resp.sessions) == 3
        assert resp.total == 3
        assert resp.sessions[0].session_id == "session-1"
        assert resp.sessions[1].session_id == "session-2"
        assert resp.sessions[2].session_id == "session-3"
    
    def test_total_matches_session_count(self):
        sessions = [
            SessionInfo(
                session_id=f"session-{i}",
                message_count=2,
                created_at="2025-11-13T10:00:00.000000",
                last_accessed="2025-11-13T10:00:00.000000",
                total_tokens=100
            )
            for i in range(5)
        ]
        
        resp = SessionListResponse(
            sessions=sessions,
            total=5
        )
        
        assert len(resp.sessions) == resp.total
    
    def test_missing_required_fields(self):
        with pytest.raises(ValidationError):
            SessionListResponse(sessions=[])  # Missing total


class TestDTOSerialization:
    def test_chat_request_to_dict(self):
        req = ChatRequest(
            query="Test",
            top_k=10,
            session_id="session-123",
            include_history=False
        )
        data = req.model_dump()
        
        assert data["query"] == "Test"
        assert data["top_k"] == 10
        assert data["session_id"] == "session-123"
        assert data["include_history"] is False
    
    def test_chat_response_to_dict(self):
        resp = ChatResponse(
            answer="Test answer",
            session_id="session-123",
            is_new_session=True,
            history_length=0,
            context_ids=["doc-1"],
            tokens_input=100,
            tokens_output=50,
            model_id="test-model"
        )
        data = resp.model_dump()
        
        assert data["answer"] == "Test answer"
        assert data["session_id"] == "session-123"
        assert data["is_new_session"] is True
        assert data["history_length"] == 0
        assert data["context_ids"] == ["doc-1"]
    
    def test_chat_history_to_dict(self):
        messages = [
            ChatMessage(
                role="user",
                content="Test",
                timestamp="2025-11-13T10:00:00.000000"
            )
        ]
        
        resp = ChatHistoryResponse(
            session_id="session-123",
            messages=messages,
            total_messages=1,
            created_at="2025-11-13T10:00:00.000000",
            last_accessed="2025-11-13T10:00:00.000000",
            total_tokens=0
        )
        
        data = resp.model_dump()
        assert data["session_id"] == "session-123"
        assert len(data["messages"]) == 1
        assert data["messages"][0]["role"] == "user"
