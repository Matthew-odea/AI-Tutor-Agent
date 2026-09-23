import pytest
from unittest.mock import MagicMock
from src.main.llm.AgentCoreProvider import AgentCoreProvider

@pytest.fixture
def provider():
    p = AgentCoreProvider()
    p.client = MagicMock()
    return p

def test_chat_success(provider):
    provider.client.chat.return_value = {"text": "hello"}
    result = provider.chat([{"role": "user", "content": [{"text": "hi"}]}])
    assert result == "hello"

def test_chat_error(provider):
    provider.client.chat.side_effect = Exception("fail")
    with pytest.raises(Exception):
        provider.chat([{"role": "user", "content": [{"text": "fail"}]}])

def test_embed_success(provider):
    provider.client.embed.return_value = {"vectors": [[0.1]*1024]}
    result = provider.embed(["text"])
    assert isinstance(result, list)
    assert len(result[0]) == 1024
    assert all(x == 0.1 for x in result[0])

def test_embed_error(provider):
    provider.client.embed.side_effect = Exception("fail")
    with pytest.raises(Exception):
        provider.embed(["fail"])
