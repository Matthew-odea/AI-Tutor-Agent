import os
from PyPDF2 import PdfReader
from fastapi import UploadFile
import tempfile

class FileToTextService:
    def file_to_text(self, pdf_path: str) -> str:
        """Returns "" if the PDF can't be parsed; raises FileNotFoundError if missing."""
        if not os.path.isfile(pdf_path):
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")
        try:
            reader = PdfReader(pdf_path)
            text = ""
            for page in reader.pages:
                text += page.extract_text() or ""
            return text
        except Exception as e:
            # Encrypted and image-only PDFs land here silently
            return ""

    def extract_text_from_uploadfile(self, file: UploadFile) -> str:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(file.file.read())
            tmp_path = tmp.name
        try:
            text = self.file_to_text(tmp_path)
        finally:
            os.unlink(tmp_path)
        return text
