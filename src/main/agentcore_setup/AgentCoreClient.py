"""Thin Bedrock invoke_model wrapper used by AgentCoreProvider. Only chat, chat_with_tool and embed are implemented."""
from bedrock_agentcore.runtime import BedrockAgentCoreApp
import boto3
import json
import logging
import os


def _is_nova_model(model_id) -> bool:
    """Matches any Nova model: bare IDs, cross-region inference profiles (us./apac./global.) and ARNs."""
    return isinstance(model_id, str) and "amazon.nova-" in model_id


class AgentCoreClient:
    def __init__(self):
        self.app = BedrockAgentCoreApp()
        bedrock_region = os.getenv("BEDROCK_REGION", "us-east-1")
        self.bedrock_client = boto3.client("bedrock-runtime", region_name=bedrock_region)
        self.logger = logging.getLogger("AgentCoreClient")
        if not self.logger.hasHandlers():
            logging.basicConfig(level=logging.INFO)

    def generate(self, prompt, model_id, **kwargs):
        raise NotImplementedError("BedrockAgentCoreApp does not expose 'generate' directly. Implement model call here.")

    def chat(self, messages, model_id, **kwargs):
        self.logger.debug(f"chat called with model_id={model_id}")
        self.logger.debug(f"messages={messages}")
        
        if _is_nova_model(model_id):
            messages = self._adapt_messages_for_nova(messages)
            # Nova rejects string content; it must be a list of blocks
            for msg in messages:
                c = msg.get("content")
                if isinstance(c, str):
                    msg["content"] = [{"text": c}]
            if not messages or not isinstance(messages, list):
                self.logger.error("Nova chat: 'messages' must be a non-empty list.")
                raise ValueError("Nova chat: 'messages' must be a non-empty list.")
            if messages[0].get("role") != "user":
                self.logger.error("Nova chat: First message must have role 'user'.")
                raise ValueError("Nova chat: First message must have role 'user'.")
            payload = json.dumps({"messages": messages})
            self.logger.debug(f"Nova payload={payload}")
            try:
                response = self.bedrock_client.invoke_model(
                    modelId=model_id,
                    body=payload,
                    contentType="application/json",
                    accept="application/json"
                )
                body = json.loads(response["body"].read())
                self.logger.debug(f"Nova response={body}")
            except Exception as e:
                self.logger.error(f"Nova Bedrock error: {e}")
                raise
            # Current Nova shape: {"output": {"message": {"content": [{"text": ...}]}}}
            if "output" in body and "message" in body["output"]:
                msg = body["output"]["message"]
                if "content" in msg and isinstance(msg["content"], list) and msg["content"]:
                    return {"text": msg["content"][0]["text"]}
            elif "outputs" in body and body["outputs"]:
                return {"text": body["outputs"][0]["text"]}
            elif "content" in body and isinstance(body["content"], list):
                return {"text": body["content"][0]["text"]}
            else:
                self.logger.error(f"Unexpected Nova chat response: {body}")
                raise ValueError(f"Unexpected Nova chat response: {body}")
        
        # GPT-OSS-120B and other non-Nova models
        if not messages or not isinstance(messages, list):
            self.logger.error("Bedrock chat: 'messages' must be a non-empty list.")
            raise ValueError("Bedrock chat: 'messages' must be a non-empty list.")
        
        payload = json.dumps({"messages": messages})
        self.logger.debug(f"Bedrock payload for {model_id}={payload}")
        try:
            response = self.bedrock_client.invoke_model(
                modelId=model_id,
                body=payload,
                contentType="application/json",
                accept="application/json"
            )
            body = json.loads(response["body"].read())
            self.logger.debug(f"Bedrock response for {model_id}={body}")
        except Exception as e:
            self.logger.error(f"Bedrock error for {model_id}: {e}")
            raise
        
        # OpenAI-compatible shape (GPT-OSS-120B)
        if "choices" in body and isinstance(body["choices"], list) and body["choices"]:
            choice = body["choices"][0]
            if "message" in choice and "content" in choice["message"]:
                content = choice["message"]["content"]
                tokens_input = body.get("usage", {}).get("prompt_tokens")
                tokens_output = body.get("usage", {}).get("completion_tokens")
                return {
                    "text": content,
                    "tokens_input": tokens_input,
                    "tokens_output": tokens_output,
                    "model_id": body.get("model")
                }
        elif "content" in body and isinstance(body["content"], list):
            return {"text": body["content"][0]["text"]}
        elif "completions" in body and isinstance(body["completions"], list):
            return {"text": body["completions"][0]["data"]["text"]}
        elif "completion" in body:
            return {"text": body["completion"]}
        else:
            self.logger.error(f"Unexpected chat response: {body}")
            raise ValueError(f"Unexpected chat response: {body}")

    def chat_with_tool(self, messages, model_id, tool_config, system=None, **kwargs):
        """Force a Nova-native tool call and return {"tool_use", "tool_name", "stop_reason"}.

        Raises on transport errors; no toolUse block gives tool_use=None so the caller can fall back to text parsing.
        """
        self.logger.debug(f"chat_with_tool called with model_id={model_id}")

        norm = self._adapt_messages_for_nova(messages) if _is_nova_model(model_id) else list(messages)
        for msg in norm:
            c = msg.get("content")
            if isinstance(c, str):
                msg["content"] = [{"text": c}]

        if not norm or not isinstance(norm, list):
            raise ValueError("chat_with_tool: 'messages' must be a non-empty list.")

        body = {"messages": norm, "toolConfig": tool_config}
        if system:
            body["system"] = system if isinstance(system, list) else [{"text": system}]

        payload = json.dumps(body)
        self.logger.debug(f"chat_with_tool payload for {model_id}={payload}")
        try:
            response = self.bedrock_client.invoke_model(
                modelId=model_id,
                body=payload,
                contentType="application/json",
                accept="application/json",
            )
            resp_body = json.loads(response["body"].read())
            self.logger.debug(f"chat_with_tool response for {model_id}={resp_body}")
        except Exception as e:
            self.logger.error(f"chat_with_tool Bedrock error for {model_id}: {e}")
            raise

        # Expected: {"output": {"message": {"content": [{"toolUse": {...}} | {"text": ...}]}}, "stopReason": ...}
        content_blocks = []
        output = resp_body.get("output") if isinstance(resp_body, dict) else None
        if isinstance(output, dict):
            message = output.get("message") or {}
            content_blocks = message.get("content") or []
        # Some response shapes nest the message at the top level.
        if not content_blocks and isinstance(resp_body, dict):
            message = resp_body.get("message") or {}
            content_blocks = message.get("content") or []

        for block in content_blocks:
            if isinstance(block, dict) and "toolUse" in block:
                tool_use = block["toolUse"] or {}
                return {
                    "tool_use": tool_use.get("input"),
                    "tool_name": tool_use.get("name"),
                    "stop_reason": resp_body.get("stopReason"),
                }

        self.logger.warning(f"chat_with_tool: no toolUse block (stopReason={resp_body.get('stopReason')})")
        return {"tool_use": None, "tool_name": None, "stop_reason": resp_body.get("stopReason")}

    def _adapt_messages_for_nova(self, messages):
        """Nova requires the first message to be 'user', so leading system messages are folded into it."""
        if not isinstance(messages, list) or not messages:
            return messages

        leading_system = []
        index = 0
        for msg in messages:
            if msg.get("role") == "system":
                text = msg.get("content", "")
                leading_system.append(text if isinstance(text, str) else str(text))
                index += 1
                continue
            break

        if not leading_system:
            return messages

        remainder = messages[index:]
        system_block = "\n\n".join(part for part in leading_system if part)

        if remainder and remainder[0].get("role") == "user":
            current = remainder[0].get("content", "")
            if isinstance(current, list):
                current_text = " ".join(c.get("text", "") for c in current if isinstance(c, dict))
            else:
                current_text = str(current)
            merged = f"System instructions:\n{system_block}\n\n{current_text}".strip()
            remainder[0] = {
                **remainder[0],
                "content": [{"text": merged}],
            }
            return remainder

        injected_user = {
            "role": "user",
            "content": [{"text": f"System instructions:\n{system_block}".strip()}],
        }
        return [injected_user, *remainder]

    def embed(self, texts, model_id):
        # Cohere takes a batch; Titan (below) takes one text per request
        if model_id == "cohere.embed-english-v3":
            if not texts or not isinstance(texts, list):
                self.logger.error("Cohere embed: 'texts' must be a non-empty list.")
                raise ValueError("Cohere embed: 'texts' must be a non-empty list.")
            payload = json.dumps({"texts": texts,
                                  "input_type": "search_document"})
            self.logger.debug(f"Cohere embed payload={payload}")
            try:
                response = self.bedrock_client.invoke_model(
                    modelId=model_id,
                    body=payload,
                    contentType="application/json",
                    accept="application/json"
                )
                body = json.loads(response["body"].read())
                self.logger.debug(f"Cohere embed response={body}")
            except Exception as e:
                self.logger.error(f"Cohere embed Bedrock error: {e}")
                raise
            if "embeddings" in body and body["embeddings"]:
                return {"vectors": body["embeddings"]}
            else:
                self.logger.error(f"Unexpected Cohere embed response: {body}")
                raise ValueError(f"Unexpected Cohere embed response: {body}")
        vectors = []
        for text in texts:
            payload = json.dumps({"inputText": text})
            response = self.bedrock_client.invoke_model(
                modelId=model_id,
                body=payload,
                contentType="application/json",
                accept="application/json"
            )
            body = json.loads(response["body"].read())
            if "embedding" in body:
                vectors.append(body["embedding"])
            elif "embeddings" in body:
                vectors.append(body["embeddings"][0])
            else:
                raise ValueError(f"Unexpected embedding response: {body}")
        return {"vectors": vectors}

    def generate_stream(self, prompt, model_id, **kwargs):
        raise NotImplementedError("Streaming not implemented.")

    def chat_stream(self, messages, model_id, **kwargs):
        raise NotImplementedError("Streaming not implemented.")
