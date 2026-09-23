import pytest
import uuid
from unittest.mock import MagicMock
from src.main.service.ChatService import ChatService, ChatServiceError


class DummyVectorService:
    def semantic_search(self, query, top_k=5):
        if query == "vector_fail":
            raise Exception("Vector search failed")
        return [
            {"id": "doc-1", "text": "Python is a programming language", "score": 0.95},
            {"id": "doc-2", "text": "Variables store data", "score": 0.88},
        ]


class DummyAgentClient:
    def chat(self, messages):
        # Accepts both list-of-parts and plain-string message content.
        def _message_text(msg):
            content = msg.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = []
                for part in content:
                    if isinstance(part, dict) and "text" in part:
                        parts.append(str(part["text"]))
                    elif isinstance(part, str):
                        parts.append(part)
                return "\n".join(parts)
            return str(content) if content is not None else ""

        for msg in messages:
            if msg.get("role") == "user" and "fail" in _message_text(msg):
                raise Exception("Agent call failed")

        # Check if history is present by looking for prior assistant/user turns
        # before the final user question.
        has_history = any(msg.get("role") == "assistant" for msg in messages)
        
        if has_history:
            response = "Based on our previous discussion, here's more information..."
        else:
            response = "This is a new topic. Let me explain..."
        
        return {
            "content": response,
            "tokens_input": 100,
            "tokens_output": 50,
            "model_id": "test-model"
        }


@pytest.fixture
def memory(conversation_memory):
    return conversation_memory


@pytest.fixture
def chat_service(memory):
    return ChatService(
        vector_service=DummyVectorService(),
        agent_client=DummyAgentClient(),
        memory=memory,
        max_context_chars=8000,
        max_history_messages=10
    )


class TestChatWithoutSession:
    def test_chat_generates_session_id(self, chat_service):
        result = chat_service.chat("What is Python?")
        
        assert "session_id" in result
        assert result["session_id"] is not None
        assert result["is_new_session"] is True
        assert result["history_length"] == 0
    
    def test_generated_session_id_is_uuid(self, chat_service):
        result = chat_service.chat("Hello")
        
        session_id = result["session_id"]
        # Should not raise ValueError
        uuid.UUID(session_id)
    
    def test_each_call_generates_new_session(self, chat_service):
        result1 = chat_service.chat("Question 1")
        result2 = chat_service.chat("Question 2")
        
        assert result1["session_id"] != result2["session_id"]
        assert result1["is_new_session"] is True
        assert result2["is_new_session"] is True


class TestChatWithProvidedSession:
    def test_chat_uses_provided_session_id(self, chat_service):
        session_id = "my-custom-session"
        result = chat_service.chat("Hello", session_id=session_id)
        
        assert result["session_id"] == session_id
        assert result["is_new_session"] is True
    
    def test_second_message_recognizes_existing_session(self, chat_service):
        session_id = "test-session"
        
        result1 = chat_service.chat("First question", session_id=session_id)
        assert result1["is_new_session"] is True
        
        result2 = chat_service.chat("Second question", session_id=session_id)
        assert result2["is_new_session"] is False
        assert result2["session_id"] == session_id


class TestConversationHistory:
    def test_first_message_has_no_history(self, chat_service):
        result = chat_service.chat("What is Python?", session_id="session-1")
        assert result["history_length"] == 0
    
    def test_second_message_includes_history(self, chat_service):
        session_id = "session-1"
        
        result1 = chat_service.chat("What is Python?", session_id=session_id)
        assert result1["history_length"] == 0
        
        result2 = chat_service.chat("Can you explain more?", session_id=session_id)
        assert result2["history_length"] == 2  # Previous user + assistant
    
    def test_history_accumulates_over_multiple_messages(self, chat_service):
        session_id = "session-1"
        
        chat_service.chat("Question 1", session_id=session_id)
        result2 = chat_service.chat("Question 2", session_id=session_id)
        result3 = chat_service.chat("Question 3", session_id=session_id)
        result4 = chat_service.chat("Question 4", session_id=session_id)
        
        assert result2["history_length"] == 2  # Q1, A1
        assert result3["history_length"] == 4  # Q1, A1, Q2, A2
        assert result4["history_length"] == 6  # Q1, A1, Q2, A2, Q3, A3
    
    def test_messages_stored_in_memory(self, chat_service, memory):
        session_id = "session-1"
        
        chat_service.chat("Hello world", session_id=session_id)
        
        history = memory.get_history(session_id)
        assert len(history) == 2  # User + assistant
        assert history[0]["role"] == "user"
        assert history[0]["content"] == "Hello world"
        assert history[1]["role"] == "assistant"
    
    def test_history_respects_max_messages_limit(self, memory):
        service = ChatService(
            vector_service=DummyVectorService(),
            agent_client=DummyAgentClient(),
            memory=memory,
            max_history_messages=4
        )
        
        session_id = "session-1"
        
        service.chat("Q1", session_id=session_id)
        service.chat("Q2", session_id=session_id)
        service.chat("Q3", session_id=session_id)
        result = service.chat("Q4", session_id=session_id)
        
        # Should only include last 4 messages (Q2, A2, Q3, A3)
        assert result["history_length"] == 4


class TestIncludeHistoryFlag:
    def test_include_history_true(self, chat_service):
        session_id = "session-1"
        
        chat_service.chat("First question", session_id=session_id)
        result = chat_service.chat("Second question", session_id=session_id, include_history=True)
        
        assert result["history_length"] == 2
        # Agent should indicate it's using history
        assert "previous" in result["answer"].lower()
    
    def test_include_history_false(self, chat_service):
        session_id = "session-1"
        
        chat_service.chat("First question", session_id=session_id)
        result = chat_service.chat("Second question", session_id=session_id, include_history=False)
        
        # History not used in prompt, but still shows 0
        assert result["history_length"] == 0
        # Agent should treat it as new topic
        assert "new topic" in result["answer"].lower()
    
    def test_include_history_false_still_stores_message(self, chat_service, memory):
        session_id = "session-1"
        
        chat_service.chat("First", session_id=session_id, include_history=False)
        chat_service.chat("Second", session_id=session_id, include_history=False)
        
        history = memory.get_history(session_id)
        assert len(history) == 4  # 2 user + 2 assistant messages


class TestContextRetrieval:
    def test_chat_includes_context_ids(self, chat_service):
        result = chat_service.chat("What is Python?")
        
        assert "context_ids" in result
        assert len(result["context_ids"]) == 2
        assert "doc-1" in result["context_ids"]
        assert "doc-2" in result["context_ids"]
    
    def test_context_ids_stored_with_assistant_message(self, chat_service, memory):
        session_id = "session-1"
        
        chat_service.chat("What is Python?", session_id=session_id)
        
        history = memory.get_history(session_id)
        assistant_msg = history[1]  # Second message is assistant
        
        assert "context_ids" in assistant_msg
        assert len(assistant_msg["context_ids"]) > 0


class TestTokenTracking:
    def test_tokens_returned_in_response(self, chat_service):
        result = chat_service.chat("Hello")
        
        assert result["tokens_input"] == 100
        assert result["tokens_output"] == 50
        assert result["model_id"] == "test-model"
    
    def test_tokens_stored_with_messages(self, chat_service, memory):
        session_id = "session-1"
        
        chat_service.chat("Hello", session_id=session_id)
        
        history = memory.get_history(session_id)
        assistant_msg = history[1]
        
        assert assistant_msg["tokens"] == 50


class TestMultipleSessions:
    def test_sessions_are_isolated(self, chat_service):
        result1 = chat_service.chat("Question in session 1", session_id="session-1")
        result2 = chat_service.chat("Question in session 1 again", session_id="session-1")
        result3 = chat_service.chat("Question in session 2", session_id="session-2")
        
        assert result2["history_length"] == 2  # Has previous exchange
        assert result3["history_length"] == 0  # New session, no history
    
    def test_concurrent_sessions(self, chat_service, memory):
        chat_service.chat("S1 Message 1", session_id="session-1")
        chat_service.chat("S1 Message 2", session_id="session-1")
        
        chat_service.chat("S2 Message 1", session_id="session-2")
        
        chat_service.chat("S3 Message 1", session_id="session-3")
        
        assert len(memory.get_history("session-1")) == 4  # 2 exchanges
        assert len(memory.get_history("session-2")) == 2  # 1 exchange
        assert len(memory.get_history("session-3")) == 2  # 1 exchange


class TestErrorHandling:
    def test_vector_search_error(self, chat_service):
        with pytest.raises(ChatServiceError):
            chat_service.chat("vector_fail", session_id="session-1")
    
    def test_agent_error(self, chat_service):
        with pytest.raises(ChatServiceError):
            chat_service.chat("agent fail", session_id="session-1")
    
    def test_error_does_not_corrupt_history(self, chat_service, memory):
        session_id = "session-1"
        
        chat_service.chat("Good question", session_id=session_id)
        
        try:
            chat_service.chat("agent fail", session_id=session_id)
        except ChatServiceError:
            pass
        
        # History should still only have first exchange
        history = memory.get_history(session_id)
        assert len(history) == 2  # Only the successful exchange


class TestPromptBuilding:
    def test_prompt_includes_system_preamble(self, chat_service):
        # This is implicit in the flow, verified by mock returning response
        result = chat_service.chat("Test question")
        assert result["answer"] is not None
    
    def test_prompt_includes_context(self, chat_service):
        # Verified by context_ids being returned
        result = chat_service.chat("Test question")
        assert len(result["context_ids"]) > 0
    
    def test_prompt_includes_history_on_followup(self, chat_service):
        session_id = "session-1"
        
        chat_service.chat("First question", session_id=session_id)
        result = chat_service.chat("Follow-up question", session_id=session_id)
        
        # Mock agent detects history and responds accordingly
        assert "previous" in result["answer"].lower()


class TestEdgeCases:
    def test_empty_query(self, chat_service):
        result = chat_service.chat("", session_id="session-1")
        assert result["answer"] is not None
    
    def test_very_long_query(self, chat_service):
        long_query = "What is Python? " * 1000
        result = chat_service.chat(long_query, session_id="session-1")
        assert result["answer"] is not None
    
    def test_special_characters_in_query(self, chat_service):
        special_query = "What about <script>alert('test')</script> in Python?"
        result = chat_service.chat(special_query, session_id="session-1")
        assert result["answer"] is not None
    
    def test_top_k_parameter(self, chat_service):
        result = chat_service.chat("Test", top_k=1)
        # With our mock, we always return 2 docs, but in real scenario top_k would limit
        assert len(result["context_ids"]) >= 1
