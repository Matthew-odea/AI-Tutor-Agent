import pytest
from src.main.service.FileToTextService import FileToTextService
from PyPDF2 import PdfWriter
import os

def create_pdf_with_text(path, text):
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    # PyPDF2 can't write text, so tests write a blank page and patch extract_text.
    writer.write(open(path, "wb"))
    return path

@pytest.fixture
def service():
    return FileToTextService()

def test_file_to_text_success(tmp_path, service, monkeypatch):
    pdf_path = tmp_path / "test.pdf"
    create_pdf_with_text(pdf_path, "Hello PDF!")
    monkeypatch.setattr("PyPDF2._page.PageObject.extract_text", lambda self: "Hello PDF!")
    result = service.file_to_text(str(pdf_path))
    assert result == "Hello PDF!"

def test_file_to_text_not_found(service):
    with pytest.raises(FileNotFoundError):
        service.file_to_text("/nonexistent/file.pdf")

def test_file_to_text_unreadable(tmp_path, service, monkeypatch):
    pdf_path = tmp_path / "bad.pdf"
    pdf_path.write_bytes(b"not a real pdf")
    result = service.file_to_text(str(pdf_path))
    assert result == ""
