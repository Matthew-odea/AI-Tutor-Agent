import pytest

from src.main.agentcore_setup.AgentCoreClient import _is_nova_model


@pytest.mark.parametrize("model_id", [
    "amazon.nova-lite-v1:0",
    "us.amazon.nova-2-lite-v1:0",
    "global.amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:us-east-1:123:inference-profile/us.amazon.nova-2-lite-v1:0",
])
def test_nova_ids_get_nova_request_shape(model_id):
    assert _is_nova_model(model_id)


@pytest.mark.parametrize("model_id", ["openai.gpt-oss-120b-1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0", None])
def test_non_nova_ids(model_id):
    assert not _is_nova_model(model_id)
