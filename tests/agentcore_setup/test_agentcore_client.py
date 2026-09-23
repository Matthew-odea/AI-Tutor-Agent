import pytest
from unittest.mock import MagicMock
from src.main.agentcore_setup.AgentCoreClient import AgentCoreClient

@pytest.fixture
def client():
    c = AgentCoreClient()
    c.bedrock_client = MagicMock()
    return c

def test_chat_nova_payload(client):
    # Nova expects 'messages' payload
    client.bedrock_client.invoke_model.return_value = {
        "body": MagicMock(read=lambda: b'{"output": {"message": {"content": [{"text": "hi"}], "role": "assistant"}}}')
    }
    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    result = client.chat(messages, model_id="amazon.nova-lite-v1:0")
    assert result["text"] == "hi"

def test_embed_cohere_payload(client):
    # Cohere expects 'texts' payload
    client.bedrock_client.invoke_model.return_value = {
        "body": MagicMock(read=lambda: b'{"embeddings": [[0.1, 0.2, 0.3]]}')
    }
    result = client.embed(["hello world"], model_id="cohere.embed-english-v3")
    assert result["vectors"] == [[0.1, 0.2, 0.3]]

def test_chat_error_handling(client):
    client.bedrock_client.invoke_model.side_effect = Exception("Bedrock error")
    with pytest.raises(Exception):
        client.chat([{"role": "user", "content": [{"text": "fail"}]}], model_id="amazon.nova-lite-v1:0")

def test_embed_error_handling(client):
    client.bedrock_client.invoke_model.side_effect = Exception("Bedrock error")
    with pytest.raises(Exception):
        client.embed(["fail"], model_id="cohere.embed-english-v3")



NOVA_RESPONSE = b'{"output": {"message": {"content": [{"text": "hi"}], "role": "assistant"}}}'


@pytest.mark.parametrize("model_id", [
    "amazon.nova-lite-v1:0",
    "us.amazon.nova-lite-v1:0",
    "apac.amazon.nova-pro-v1:0",
    "amazon.nova-micro-v1:0",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0",
])
def test_chat_adapts_messages_for_all_nova_ids(client, model_id):
    """Leading system messages must be folded into the first user turn and the Nova response shape parsed."""
    import json

    client.bedrock_client.invoke_model.return_value = {"body": MagicMock(read=lambda: NOVA_RESPONSE)}
    messages = [
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "hello"},
    ]
    result = client.chat(messages, model_id=model_id)
    assert result["text"] == "hi"

    sent = json.loads(client.bedrock_client.invoke_model.call_args.kwargs["body"])
    assert [m["role"] for m in sent["messages"]] == ["user"]
    assert "Be concise." in sent["messages"][0]["content"][0]["text"]


def test_chat_with_tool_adapts_messages_for_nova_inference_profile(client):
    import json

    client.bedrock_client.invoke_model.return_value = {
        "body": MagicMock(read=lambda: b'{"output": {"message": {"content": [{"toolUse": {"name": "t", "input": {"a": 1}}}]}}, "stopReason": "tool_use"}')
    }
    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "q"}]
    result = client.chat_with_tool(messages, model_id="us.amazon.nova-lite-v1:0", tool_config={"tools": []})
    assert result["tool_use"] == {"a": 1}
    sent = json.loads(client.bedrock_client.invoke_model.call_args.kwargs["body"])
    assert [m["role"] for m in sent["messages"]] == ["user"]


def test_chat_non_nova_model_skips_nova_adaptation(client):
    import json

    client.bedrock_client.invoke_model.return_value = {
        "body": MagicMock(read=lambda: b'{"choices": [{"message": {"content": "ok"}}]}')
    }
    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "q"}]
    assert client.chat(messages, model_id="openai.gpt-oss-120b-1:0")["text"] == "ok"
    sent = json.loads(client.bedrock_client.invoke_model.call_args.kwargs["body"])
    assert sent["messages"][0] == {"role": "system", "content": "sys"}
