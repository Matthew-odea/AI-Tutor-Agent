from __future__ import annotations

import json
import os
from pathlib import Path

from src.main.llm.AgentCoreProvider import AgentCoreProvider

from ..utils.ReadPrompt import read_prompt

class TextPreprocessingService:
    def __init__(
        self,
        region: str | None = None,
        model_id: str | None = None,
        prompt_path: str | None = None,
    ) -> None:
        self.region = region or os.getenv("AWS_REGION", "ap-southeast-2")
        self.model_id = model_id or os.getenv("CHAT_MODEL", "amazon.nova-lite-v1:0")
        self.prompt_path = Path(prompt_path or os.getenv("PROMPT_MD", "prompts/vector_store_prompt.md")).resolve()
        self.llm = AgentCoreProvider()

    def _split_text_into_chunks(self, header: str, text: str, max_chars: int) -> list[str]:
        """Greedy word split so header + chunk fits in max_chars."""
        tail_reserved = 64  # buffer, e.g. for the "[Chunk i/n]" marker
        available = max_chars - len(header) - tail_reserved
        if available <= 100:
            # Header alone nearly fills the budget; accept overshooting max_chars rather than tiny chunks.
            available = max(256, max_chars - 200)

        words = text.split()
        chunks: list[str] = []
        cur_words: list[str] = []
        cur_len = 0
        for w in words:
            wlen = len(w) + 1
            if cur_len + wlen > available and cur_words:
                chunks.append(" ".join(cur_words))
                cur_words = [w]
                cur_len = wlen
            else:
                cur_words.append(w)
                cur_len += wlen
        if cur_words:
            chunks.append(" ".join(cur_words))
        return chunks

    def preprocess_to_markdown(self, text: str, **kwargs) -> str:
        """Rewrite text as markdown using the prompt at prompt_path.

        Input over BEDROCK_MAX_INPUT_CHARS (default 2048) is split into chunks, one LLM call each,
        joined with "---" separators. The region/model_id args are unused; AgentCoreProvider picks the model.
        """
        instructions = read_prompt(prompt_path=self.prompt_path)
        header = f"{instructions.strip()}\n\n"

        try:
            max_input_chars = int(os.getenv("BEDROCK_MAX_INPUT_CHARS", "2048"))
        except Exception:
            max_input_chars = 2048

        assembled = header + text
        if len(assembled) <= max_input_chars:
            prompt = assembled
            result = self.llm.chat([
                {"role": "user", "content": [{"text": prompt}]}
            ], **kwargs)
            if isinstance(result, str):
                return result
            elif hasattr(result, '__iter__') and not isinstance(result, str):
                return "".join(chunk for chunk in result)
            else:
                raise TypeError(f"Unexpected chat return type: {type(result)}")

        chunks = self._split_text_into_chunks(header, text, max_input_chars)
        outputs: list[str] = []
        total = len(chunks)
        for idx, chunk_body in enumerate(chunks, start=1):
            chunk_prompt = header + f"[Chunk {idx}/{total}]\n" + chunk_body
            try:
                resp = self.llm.chat([
                    {"role": "user", "content": [{"text": chunk_prompt}]}
                ], **kwargs)
            except Exception as e:
                raise RuntimeError(f"LLM chat failed on chunk {idx}/{total}: {e}") from e

            if isinstance(resp, str):
                outputs.append(resp)
            elif hasattr(resp, '__iter__') and not isinstance(resp, str):
                outputs.append("".join(chunk for chunk in resp))
            else:
                raise TypeError(f"Unexpected chat return type on chunk {idx}: {type(resp)}")

        joined = "\n\n---\n\n".join(outputs)
        return joined

