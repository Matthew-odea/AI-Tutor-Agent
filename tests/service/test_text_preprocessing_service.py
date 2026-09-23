import pytest
from unittest.mock import MagicMock
from src.main.service.TextPreprocessingService import TextPreprocessingService

@pytest.fixture
def service():
    svc = TextPreprocessingService()
    svc.llm = MagicMock()
    return svc

def test_preprocess_to_markdown_string(service):
    service.llm.chat.return_value = "# Heading\nContent"
    result = service.preprocess_to_markdown("Some text")
    assert result.startswith("# Heading")

def test_preprocess_to_markdown_generator(service):
    service.llm.chat.return_value = iter(["# Heading", "\nContent"])
    result = service.preprocess_to_markdown("Some text")
    assert result.startswith("# Heading")

def test_preprocess_to_markdown_error(service):
    service.llm.chat.return_value = 123
    with pytest.raises(TypeError):
        service.preprocess_to_markdown("Some text")


class TestSplitTextIntoChunks:
    def test_single_chunk_short_text(self, service):
        chunks = service._split_text_into_chunks("Header\n", "Short text", max_chars=500)
        assert len(chunks) == 1
        assert chunks[0] == "Short text"

    def test_splits_long_text(self, service):
        words = ["word"] * 200
        text = " ".join(words)
        chunks = service._split_text_into_chunks("H\n", text, max_chars=200)
        assert len(chunks) > 1
        reconstructed = " ".join(chunks)
        assert reconstructed.count("word") == 200

    def test_respects_header_size(self, service):
        big_header = "X" * 300 + "\n"
        text = " ".join(["word"] * 50)
        chunks = service._split_text_into_chunks(big_header, text, max_chars=400)
        assert len(chunks) >= 1


class TestMultiChunkPreprocessing:
    def test_multi_chunk_concatenates(self, service, monkeypatch):
        monkeypatch.setenv("BEDROCK_MAX_INPUT_CHARS", "50")
        service.llm.chat.side_effect = ["Chunk 1 output", "Chunk 2 output"]
        long_text = " ".join(["word"] * 100)
        result = service.preprocess_to_markdown(long_text)
        assert "Chunk 1 output" in result
        assert "Chunk 2 output" in result

    def test_multi_chunk_llm_error_raises(self, service, monkeypatch):
        monkeypatch.setenv("BEDROCK_MAX_INPUT_CHARS", "50")
        service.llm.chat.side_effect = RuntimeError("LLM down")
        long_text = " ".join(["word"] * 100)
        with pytest.raises(RuntimeError, match="LLM chat failed on chunk"):
            service.preprocess_to_markdown(long_text)

