from pydantic import BaseModel
from typing import List, Optional


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    timestamp: str
    tokens: Optional[int] = None
    context_ids: List[str] = []


class ChatHistoryResponse(BaseModel):
    session_id: str
    messages: List[ChatMessage]
    total_messages: int
    created_at: str
    last_accessed: str
    total_tokens: int
