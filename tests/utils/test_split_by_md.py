import pytest
from src.main.utils.SplitByMd import split_by_markdown_heading

def test_split_basic():
    text = "## Section\nContent\n## Next\nMore"
    chunks = split_by_markdown_heading(text)
    assert len(chunks) == 2
    assert chunks[0]["title"] == "Section"
    assert "Content" in chunks[0]["content"]

