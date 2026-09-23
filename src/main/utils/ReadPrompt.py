from pathlib import Path

def read_prompt(prompt_path) -> str:
    """prompt_path is a Path; if missing, falls back to prompts/<name> under cwd, then under the repo root."""
    if not prompt_path.is_file():
        candidates = [
            prompt_path,
            Path.cwd() / "prompts" / prompt_path.name,
            Path(__file__).resolve().parents[3] / "prompts" / prompt_path.name,
        ]
        for c in candidates:
            if c.is_file():
                prompt_path = c
                break

    if not prompt_path.is_file():
        raise FileNotFoundError(
            f"Prompt file not found. Looked at: {prompt_path}"
        )

    return prompt_path.read_text(encoding="utf-8")
