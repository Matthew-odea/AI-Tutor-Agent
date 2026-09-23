from typing import Optional

from pydantic import BaseModel, Field

class UploadRequest(BaseModel):
    """Body for /internal/context/upload."""
    DocumentName: str = Field(..., min_length=1, description="Stable identifier for the document (e.g. slug)")
    Description: str = Field(..., min_length=1, description="Human-readable title")
    Text: str = Field(..., min_length=1, description="Raw text/content to ingest")
    Scope: str = Field(..., min_length=1, description="Scope or context for the document")
    ArtifactType: Optional[str] = Field(None, description="Optional artifact type (code, notebook, markdown, pdf, text, quiz, assignment)")
    SourcePath: Optional[str] = Field(None, description="Optional source path or filename for provenance")
    CourseCode: Optional[str] = Field(None, description="Optional course code override, e.g. COMP9021")
    CourseTerm: Optional[str] = Field(None, description="Optional teaching term override, e.g. T3")
    CourseYear: Optional[int] = Field(None, description="Optional teaching year override, e.g. 2025")
