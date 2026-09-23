from pydantic import BaseModel
from typing import List


class SessionInfo(BaseModel):
    session_id: str
    message_count: int
    created_at: str
    last_accessed: str
    total_tokens: int
    title: str = "New Chat"


class SessionListResponse(BaseModel):
    sessions: List[SessionInfo]
    total: int
