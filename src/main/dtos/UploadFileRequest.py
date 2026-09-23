from fastapi import UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional

class UploadFileRequest(BaseModel):
    DocumentName: str
    Description: Optional[str] = ""
    Scope: Optional[str] = "default"

