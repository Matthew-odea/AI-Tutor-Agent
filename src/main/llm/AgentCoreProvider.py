"""LLM provider facade over AgentCoreClient; normalises failures to Llm* exceptions."""
from typing import Any, Dict, List
from src.main.agentcore_setup.bootstrap import get_runtime
from src.main.agentcore_setup.config import BEDROCK_MODEL_CHAT, BEDROCK_MODEL_EMBED, EMBEDDING_DIM
import logging


class LlmError(Exception): pass
class LlmRateLimit(Exception): pass
class LlmTimeout(Exception): pass
class LlmStructuredOutputError(LlmError):
    """Raised when forced structured output could not be obtained from the model."""
    pass


class AgentCoreProvider:
    # Consumers check `is True` so a MagicMock double is not mistaken for structured-output capable
    supports_structured_output = True

    def __init__(self):
        self.client = get_runtime()
        self.logger = logging.getLogger("AgentCoreProvider")

    def chat(self, messages: List[Dict], model_id: str = None, **kwargs) -> str:
        """model_id overrides the default chat model (the cohort report uses a stronger one)."""
        model_id = model_id or BEDROCK_MODEL_CHAT
        try:
            result = self.client.chat(messages=messages, model_id=model_id, **kwargs)
            self.logger.info(f"chat: model={model_id}, messages={len(messages)}")
            return result['text']
        except Exception as e:
            self.logger.error(f"chat error: {e}")
            raise LlmError(str(e))

    def chat_structured(
        self,
        messages: List[Dict],
        *,
        tool_name: str,
        description: str,
        input_schema: Dict[str, Any],
        model_id: str = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Force a single tool call and return its input dict (always the default chat model).

        Raises LlmStructuredOutputError on any failure so callers can fall back to text parsing.
        """
        model_id = model_id or BEDROCK_MODEL_CHAT
        tool_config = {
            "tools": [
                {
                    "toolSpec": {
                        "name": tool_name,
                        "description": description,
                        "inputSchema": {"json": input_schema},
                    }
                }
            ],
            "toolChoice": {"tool": {"name": tool_name}},
        }
        try:
            result = self.client.chat_with_tool(
                messages=messages,
                model_id=model_id,
                tool_config=tool_config,
                **kwargs,
            )
        except Exception as e:
            self.logger.warning(f"chat_structured transport error: {e}")
            raise LlmStructuredOutputError(str(e))

        tool_input = result.get("tool_use") if isinstance(result, dict) else None
        if not isinstance(tool_input, dict) or not tool_input:
            raise LlmStructuredOutputError("model did not return a usable tool_use block")
        self.logger.info(f"chat_structured: model={model_id}, tool={tool_name}")
        return tool_input

    def embed(self, texts: List[str]) -> List[List[float]]:
        model_id = BEDROCK_MODEL_EMBED
        try:
            result = self.client.embed(texts=texts, model_id=model_id)
            vectors = result['vectors']
            for v in vectors:
                if len(v) != EMBEDDING_DIM:
                    raise LlmError(f"Embedding dim mismatch: expected {EMBEDDING_DIM}, got {len(v)}")
            self.logger.info(f"embed: model={model_id}, texts={len(texts)}")
            return vectors
        except Exception as e:
            self.logger.error(f"embed error: {e}")
            raise LlmError(str(e))
