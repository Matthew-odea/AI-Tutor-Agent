from pydantic import BaseModel
from typing import Optional

class ChatResponse(BaseModel):
    answer: Optional[str] = None
    session_id: Optional[str] = None
    is_new_session: bool = False
    history_length: int = 0
    pedagogy_mode: Optional[str] = None
    context_ids: list[str] = []
    tokens_input: int | None = None
    tokens_output: int | None = None
    model_id: str | None = None
    error: Optional[str] = None

