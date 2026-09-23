import pytest
from unittest.mock import MagicMock
from src.main.service.ContextVectorService import ContextVectorService

class DummyDriver:
    def session(self):
        class DummySession:
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def run(self, *a, **kw): return None
        return DummySession()

@pytest.fixture
def service():
    svc = ContextVectorService()
    svc.driver = DummyDriver()  # Patch out Neo4j
    svc.llm = MagicMock()
    svc.preprocessor.preprocess_to_markdown = MagicMock(side_effect=lambda text, **_: text)
    return svc

def test_upload_document_basic(service):
    service.llm.embed.return_value = [[0.1]*1024]
    result = service.upload_document(
        document_name="TestDoc",
        description="A test document",
        text="# Heading\nSome content here.",
        scope="test"
    )
    assert result["document_id"]
    assert len(result["chunks"]) >= 1

def test_embed_shape(service):
    service.llm.embed.return_value = [[0.1]*1024]
    emb = service.embed("hello world")
    assert isinstance(emb, list)
    assert len(emb) == 1024
