"""
config.py
Centralises model IDs, modes, and validation logic for AgentCore.
"""
import os

BEDROCK_MODEL_CHAT = os.getenv('BEDROCK_MODEL_CHAT', 'amazon.nova-lite-v1:0')
BEDROCK_MODEL_EMBED = os.getenv('BEDROCK_MODEL_EMBED', 'amazon.titan-embed-text-v2:0')
EMBEDDING_DIM = int(os.getenv('BEDROCK_EMBED_DIM', '1024'))

# Cohort report narrative. Runs once per report (roughly once per 10
# submissions) rather than once per answer, so the cost ceiling is far higher
# than for evaluation — a stronger model is affordable here. Defaults to the
# chat model so nothing changes unless BEDROCK_MODEL_REPORT is explicitly set.
BEDROCK_MODEL_REPORT = os.getenv('BEDROCK_MODEL_REPORT', BEDROCK_MODEL_CHAT)

# Per-answer marking. Pinned separately so upgrading the chat model doesn't
# silently change how answers are scored (AI scores feed the validity analysis).
BEDROCK_MODEL_EVAL = os.getenv('BEDROCK_MODEL_EVAL', BEDROCK_MODEL_CHAT)

MODEL_REGISTRY = {
    'chat': BEDROCK_MODEL_CHAT,
    'embed': BEDROCK_MODEL_EMBED,
    'report': BEDROCK_MODEL_REPORT,
    'eval': BEDROCK_MODEL_EVAL,
}

MODEL_CAPS = {
    # Chat Models
    'amazon.nova-lite-v1:0': {'mode': 'chat', 'tool_use': True, 'json_mode': True},
    'us.amazon.nova-2-lite-v1:0': {'mode': 'chat', 'tool_use': True, 'json_mode': True},
    'openai.gpt-oss-120b-1:0': {'mode': 'chat', 'tool_use': True, 'json_mode': True},
    # Embedding Models
    'amazon.titan-embed-text-v2:0': {'mode': 'embed', 'dim': EMBEDDING_DIM},
    'cohere.embed-english-v3': {'mode': 'embed', 'dim': EMBEDDING_DIM},
    # Add more models as needed
}

def get_model_config():
    return MODEL_REGISTRY

def validate_model_cap(model_id: str, cap: str):
    caps = MODEL_CAPS.get(model_id, {})
    if cap not in caps:
        raise ValueError(f"Model {model_id} does not support capability: {cap}")
    return caps[cap]

