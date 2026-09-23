"""
DTOs for History (workspaces, views, code memory, assistant threads).
"""
from pydantic import BaseModel
from typing import List, Optional


class WorkspaceCreateRequest(BaseModel):
    title: Optional[str] = "New Workspace"
    user_id: Optional[str] = None


class WorkspaceResponse(BaseModel):
    workspace_id: str
    title: str
    created_at: str
    last_accessed: str
    user_id: Optional[str] = None


class ViewCreateRequest(BaseModel):
    workspace_id: str
    view_type: str  # chat | code | questions
    pedagogy_mode: Optional[str] = None
    user_id: Optional[str] = None


class ViewSessionResponse(BaseModel):
    view_session_id: str
    workspace_id: str
    view_type: str
    title: Optional[str] = None
    created_at: str
    last_accessed: str
    message_count: int
    total_tokens: int
    pedagogy_mode: Optional[str] = None


class ViewMessage(BaseModel):
    role: str
    content: str
    timestamp: str
    tokens: Optional[int] = None
    context_ids: Optional[List[str]] = None


class ViewHistoryResponse(BaseModel):
    view_session_id: str
    messages: List[ViewMessage]
    message_count: int
    created_at: str
    last_accessed: str
    total_tokens: int
    view_type: str


class ViewSessionListResponse(BaseModel):
    workspace_id: str
    view_type: Optional[str] = None
    views: List[ViewSessionResponse]


class CodeMemoryCreateRequest(BaseModel):
    workspace_id: str
    language: str = "python"
    current_code: str = ""
    user_id: Optional[str] = None


class CodeMemoryUpdateRequest(BaseModel):
    current_code: Optional[str] = None
    last_output: Optional[str] = None
    last_error: Optional[str] = None


class CodeMemoryResponse(BaseModel):
    code_memory_id: str
    workspace_id: str
    language: str
    current_code: str
    last_output: Optional[str] = None
    last_error: Optional[str] = None
    created_at: str
    last_accessed: str


class ProgramCreateRequest(BaseModel):
    workspace_id: str
    language: str = "python"
    title: Optional[str] = None
    current_code: str = ""
    user_id: Optional[str] = None


class ProgramUpdateRequest(BaseModel):
    title: Optional[str] = None
    current_code: Optional[str] = None
    last_output: Optional[str] = None
    last_error: Optional[str] = None


class ProgramResponse(BaseModel):
    program_id: str
    workspace_id: str
    code_memory_id: str
    title: str
    language: str
    current_code: str
    last_output: Optional[str] = None
    last_error: Optional[str] = None
    created_at: str
    last_accessed: str


class ProgramListResponse(BaseModel):
    workspace_id: str
    programs: List[ProgramResponse]


class AssistantThreadCreateRequest(BaseModel):
    title: Optional[str] = "New Assistant Thread"


class AssistantThreadResponse(BaseModel):
    thread_id: str
    code_memory_id: str
    title: str
    created_at: str
    last_accessed: str


class AssistantThreadListResponse(BaseModel):
    code_memory_id: str
    threads: List[AssistantThreadResponse]


class AssistantMessage(BaseModel):
    role: str
    content: str
    timestamp: str
    tokens: Optional[int] = None
    context_ids: Optional[List[str]] = None
    edit_block: Optional[dict] = None


class AssistantHistoryResponse(BaseModel):
    thread_id: str
    messages: List[AssistantMessage]
    message_count: int
    created_at: str
    last_accessed: str
    code_memory_id: str


class DeleteViewSessionResponse(BaseModel):
    ok: bool = True
    view_session_id: str


class DeleteProgramResponse(BaseModel):
    ok: bool = True
    program_id: str


class DeleteThreadResponse(BaseModel):
    ok: bool = True
    thread_id: str
