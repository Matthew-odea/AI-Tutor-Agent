"""Focused legacy ChatService coverage not duplicated by history suite."""

from src.main.service.ChatService import ChatService


class DummyAgentClient:
    def chat(self, messages):
        return {
            "content": "answer text",
            "tokens_input": 10,
            "tokens_output": 5,
            "model_id": "test-model",
        }


def test_context_truncation(conversation_memory):
    class LongVector:
        def semantic_search(self, query, top_k=5):
            return [{"id": "c1", "text": "x"*9000, "score": 1.0}]
    svc = ChatService(LongVector(), DummyAgentClient(), conversation_memory, max_context_chars=8000)
    result = svc.chat("hello")
    assert len(result["answer"]) > 0

