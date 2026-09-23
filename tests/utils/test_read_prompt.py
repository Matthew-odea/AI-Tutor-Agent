import pytest
from src.main.utils.ReadPrompt import read_prompt
from pathlib import Path

def test_read_prompt(tmp_path):
    prompt_file = tmp_path / "prompt.md"
    prompt_file.write_text("Hello world!")
    result = read_prompt(prompt_path=prompt_file)
    assert result == "Hello world!"

