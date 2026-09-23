from pydantic import BaseModel
from typing import Optional

class ChatRequest(BaseModel):
    query: str
    top_k: Optional[int] = 5
    session_id: Optional[str] = None
    include_history: bool = True
    pedagogy_mode: Optional[str] = None  # None: explanatory for views, concise for threads (history_router)
    editor_code: Optional[str] = None
    editor_selection: Optional[str] = None
    last_stdout: Optional[str] = None
    last_error: Optional[str] = None
    language: Optional[str] = None
    context_scope: Optional[str] = None
