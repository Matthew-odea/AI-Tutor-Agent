from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends

from src.main.controllers.api_errors import ApiError
from src.main.controllers.controller_dependencies import get_chat_service, get_history_store
from src.main.controllers.controller_helpers import (
    _assert_code_memory_owner,
    _assert_program_owner,
    _assert_thread_owner,
    _assert_view_owner,
    _assert_workspace_owner,
    _require_user_id,
    _resolve_pedagogy_mode,
)
from src.main.dtos.ChatRequest import ChatRequest
from src.main.dtos.ChatResponse import ChatResponse
from src.main.dtos.EditProposalDTOs import EditProposalRequest, EditProposalResponse
from src.main.dtos.HistoryModels import (
    AssistantHistoryResponse,
    AssistantThreadCreateRequest,
    AssistantThreadListResponse,
    AssistantThreadResponse,
    CodeMemoryCreateRequest,
    CodeMemoryResponse,
    CodeMemoryUpdateRequest,
    ProgramCreateRequest,
    ProgramListResponse,
    ProgramResponse,
    ProgramUpdateRequest,
    ViewCreateRequest,
    ViewHistoryResponse,
    ViewSessionListResponse,
    ViewSessionResponse,
    WorkspaceCreateRequest,
    WorkspaceResponse,
)
from src.main.service.ChatService import ChatService, ChatServiceError

logger = logging.getLogger(__name__)


history_router = APIRouter(prefix="/internal/history", tags=["history"])


@history_router.post("/workspaces", response_model=WorkspaceResponse)
def create_workspace_endpoint(
    request: WorkspaceCreateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    workspace = store.create_workspace(request.title or "New Workspace", user_id)
    return WorkspaceResponse(
        workspace_id=workspace["workspace_id"],
        title=workspace.get("title", "New Workspace"),
        created_at=workspace["created_at"],
        last_accessed=workspace["last_accessed"],
        user_id=workspace.get("user_id"),
    )


@history_router.post("/views", response_model=ViewSessionResponse)
def create_view_session_endpoint(
    request: ViewCreateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_workspace_owner(store, request.workspace_id, user_id)
    default_mode = "explanatory" if request.view_type == "chat" else None
    resolved_mode = _resolve_pedagogy_mode(request.pedagogy_mode, default_mode)
    view = store.create_view_session(request.workspace_id, request.view_type, resolved_mode)
    return ViewSessionResponse(
        view_session_id=view["view_session_id"],
        workspace_id=view["workspace_id"],
        view_type=view["view_type"],
        title=view.get("title"),
        created_at=view["created_at"],
        last_accessed=view["last_accessed"],
        message_count=view.get("message_count", 0),
        total_tokens=view.get("total_tokens", 0),
        pedagogy_mode=view.get("pedagogy_mode"),
    )


@history_router.get("/workspaces/{workspace_id}/views", response_model=ViewSessionListResponse)
def list_view_sessions_endpoint(
    workspace_id: str,
    view_type: Optional[str] = None,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_workspace_owner(store, workspace_id, user_id)
    views = store.list_view_sessions(workspace_id, view_type)
    return ViewSessionListResponse(
        workspace_id=workspace_id,
        view_type=view_type,
        views=views,
    )


@history_router.get("/views/{view_session_id}/history", response_model=ViewHistoryResponse)
def get_view_history_endpoint(
    view_session_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    view = _assert_view_owner(store, view_session_id, user_id)
    messages = store.get_view_history(view_session_id)
    return ViewHistoryResponse(
        view_session_id=view_session_id,
        messages=messages,
        message_count=view.get("message_count", len(messages)),
        created_at=view.get("created_at", ""),
        last_accessed=view.get("last_accessed", ""),
        total_tokens=view.get("total_tokens", 0),
        view_type=view.get("view_type", "chat"),
    )


@history_router.delete("/views/{view_session_id}")
def delete_view_session_endpoint(
    view_session_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_view_owner(store, view_session_id, user_id)
    store.delete_view_session(view_session_id)
    return {"ok": True, "view_session_id": view_session_id}


@history_router.post("/views/{view_session_id}/message", response_model=ChatResponse)
def post_view_message_endpoint(
    view_session_id: str,
    request: ChatRequest = Body(...),
    store=Depends(get_history_store),
    svc: ChatService = Depends(get_chat_service),
    user_id: str = Depends(_require_user_id),
):
    view = _assert_view_owner(store, view_session_id, user_id)
    existing_history = store.get_view_history(view_session_id)
    initial_message_count = view.get("message_count", 0)

    try:
        result = svc.chat(
            query=request.query,
            top_k=request.top_k or 5,
            session_id=view_session_id,
            include_history=request.include_history,
            pedagogy_mode=_resolve_pedagogy_mode(request.pedagogy_mode, "explanatory"),
            editor_code=request.editor_code,
            editor_selection=request.editor_selection,
            last_stdout=request.last_stdout,
            last_error=request.last_error,
            language=request.language,
            history_override=existing_history,
            persist_history=False,
        )
    except ChatServiceError as error:
        raise ApiError(status_code=500, code="history_chat_failed", message=str(error))

    store.add_view_message(view_session_id, "user", request.query, tokens=result.get("tokens_input"))
    store.add_view_message(
        view_session_id,
        "assistant",
        result.get("answer", ""),
        tokens=result.get("tokens_output"),
        context_ids=result.get("context_ids"),
    )

    if initial_message_count == 0 and view.get("title") in {None, "", "New Chat", "New Session"}:
        try:
            title = svc._generate_session_title(request.query)
            store.update_view_title(view_session_id, title)
        except Exception as error:
            logger.warning(f"Failed to generate view title: {error}")

    return ChatResponse(**result)


@history_router.post("/codememory", response_model=CodeMemoryResponse)
def create_code_memory_endpoint(
    request: CodeMemoryCreateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_workspace_owner(store, request.workspace_id, user_id)
    memory = store.create_code_memory(request.workspace_id, request.language, request.current_code)
    return CodeMemoryResponse(**memory)


@history_router.patch("/codememory/{code_memory_id}", response_model=CodeMemoryResponse)
def update_code_memory_endpoint(
    code_memory_id: str,
    request: CodeMemoryUpdateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_code_memory_owner(store, code_memory_id, user_id)
    memory = store.update_code_memory(code_memory_id, request.current_code, request.last_output, request.last_error)
    return CodeMemoryResponse(**memory)


@history_router.get("/codememory/{code_memory_id}", response_model=CodeMemoryResponse)
def get_code_memory_endpoint(
    code_memory_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    memory = _assert_code_memory_owner(store, code_memory_id, user_id)
    return CodeMemoryResponse(**memory)


@history_router.post("/programs", response_model=ProgramResponse)
def create_program_endpoint(
    request: ProgramCreateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_workspace_owner(store, request.workspace_id, user_id)
    title = request.title or "Untitled Program"
    memory = store.create_code_memory(request.workspace_id, request.language, request.current_code)
    program = store.create_program(
        request.workspace_id,
        memory["code_memory_id"],
        request.language,
        title,
        request.current_code,
    )
    return ProgramResponse(**program)


@history_router.get("/workspaces/{workspace_id}/programs", response_model=ProgramListResponse)
def list_programs_endpoint(
    workspace_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_workspace_owner(store, workspace_id, user_id)
    programs = store.list_programs(workspace_id)
    return ProgramListResponse(
        workspace_id=workspace_id,
        programs=[ProgramResponse(**program) for program in programs],
    )


@history_router.get("/programs/{program_id}", response_model=ProgramResponse)
def get_program_endpoint(
    program_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    program = _assert_program_owner(store, program_id, user_id)
    return ProgramResponse(**program)


@history_router.patch("/programs/{program_id}", response_model=ProgramResponse)
def update_program_endpoint(
    program_id: str,
    request: ProgramUpdateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    program = _assert_program_owner(store, program_id, user_id)
    updated = store.update_program(program_id, request.title, request.current_code, request.last_output, request.last_error)
    if request.current_code is not None or request.last_output is not None or request.last_error is not None:
        store.update_code_memory(program["code_memory_id"], request.current_code, request.last_output, request.last_error)
    return ProgramResponse(**updated)


@history_router.delete("/programs/{program_id}")
def delete_program_endpoint(
    program_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_program_owner(store, program_id, user_id)
    store.delete_program(program_id)
    return {"ok": True, "program_id": program_id}


@history_router.post("/codememory/{code_memory_id}/threads", response_model=AssistantThreadResponse)
def create_thread_endpoint(
    code_memory_id: str,
    request: AssistantThreadCreateRequest = Body(...),
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_code_memory_owner(store, code_memory_id, user_id)
    thread = store.create_thread(code_memory_id, request.title or "New Assistant Thread")
    return AssistantThreadResponse(
        thread_id=thread["thread_id"],
        code_memory_id=thread["code_memory_id"],
        title=thread.get("title", "New Assistant Thread"),
        created_at=thread["created_at"],
        last_accessed=thread["last_accessed"],
    )


@history_router.get("/codememory/{code_memory_id}/threads", response_model=AssistantThreadListResponse)
def list_threads_endpoint(
    code_memory_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_code_memory_owner(store, code_memory_id, user_id)
    threads = store.list_threads(code_memory_id)
    return AssistantThreadListResponse(
        code_memory_id=code_memory_id,
        threads=[
            AssistantThreadResponse(
                thread_id=t["thread_id"],
                code_memory_id=t["code_memory_id"],
                title=t.get("title", "New Assistant Thread"),
                created_at=t.get("created_at", ""),
                last_accessed=t.get("last_accessed", ""),
            )
            for t in threads
        ],
    )


@history_router.get("/threads/{thread_id}/history", response_model=AssistantHistoryResponse)
def get_thread_history_endpoint(
    thread_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    thread = _assert_thread_owner(store, thread_id, user_id)
    messages = store.get_thread_history(thread_id)
    return AssistantHistoryResponse(
        thread_id=thread_id,
        messages=messages,
        message_count=thread.get("message_count", len(messages)),
        created_at=thread.get("created_at", ""),
        last_accessed=thread.get("last_accessed", ""),
        code_memory_id=thread.get("code_memory_id", ""),
    )


@history_router.delete("/threads/{thread_id}")
def delete_thread_endpoint(
    thread_id: str,
    store=Depends(get_history_store),
    user_id: str = Depends(_require_user_id),
):
    _assert_thread_owner(store, thread_id, user_id)
    store.delete_thread(thread_id)
    return {"ok": True, "thread_id": thread_id}


@history_router.post("/threads/{thread_id}/message", response_model=ChatResponse)
def post_thread_message_endpoint(
    thread_id: str,
    request: ChatRequest = Body(...),
    store=Depends(get_history_store),
    svc: ChatService = Depends(get_chat_service),
    user_id: str = Depends(_require_user_id),
):
    thread = _assert_thread_owner(store, thread_id, user_id)
    existing_history = store.get_thread_history(thread_id)
    initial_message_count = thread.get("message_count", 0)

    try:
        result = svc.chat(
            query=request.query,
            top_k=request.top_k or 5,
            session_id=thread_id,
            include_history=request.include_history,
            pedagogy_mode=_resolve_pedagogy_mode(request.pedagogy_mode, "concise"),
            editor_code=request.editor_code,
            editor_selection=request.editor_selection,
            last_stdout=request.last_stdout,
            last_error=request.last_error,
            language=request.language,
            history_override=existing_history,
            persist_history=False,
        )
    except ChatServiceError as error:
        raise ApiError(status_code=500, code="history_chat_failed", message=str(error))

    store.add_thread_message(thread_id, "user", request.query, tokens=result.get("tokens_input"))
    store.add_thread_message(
        thread_id,
        "assistant",
        result.get("answer", ""),
        tokens=result.get("tokens_output"),
        context_ids=result.get("context_ids"),
    )

    if initial_message_count == 0 and thread.get("title") in {"New Assistant Thread", "New Thread"}:
        try:
            title = svc._generate_session_title(request.query)
            store.update_thread_title(thread_id, title)
        except Exception as error:
            logger.warning(f"Failed to generate thread title: {error}")

    return ChatResponse(**result)


@history_router.post("/edit-proposal", response_model=EditProposalResponse)
def create_edit_proposal(
    request: EditProposalRequest = Body(...),
    store=Depends(get_history_store),
    svc: ChatService = Depends(get_chat_service),
    user_id: str = Depends(_require_user_id),
):
    thread = None
    existing_history = []
    initial_message_count = 0
    if request.thread_id:
        thread = _assert_thread_owner(store, request.thread_id, user_id)
        existing_history = store.get_thread_history(request.thread_id)
        initial_message_count = thread.get("message_count", 0)

    try:
        result = svc.chat(
            query=request.query,
            top_k=5,
            session_id=request.thread_id,
            include_history=request.include_history,
            pedagogy_mode=_resolve_pedagogy_mode(request.pedagogy_mode, "concise"),
            editor_code=request.editor_code,
            editor_selection=request.editor_selection,
            last_stdout=request.last_stdout,
            last_error=request.last_error,
            language=request.language,
            history_override=existing_history,
            persist_history=False,
            intent_override="strong",
        )
    except ChatServiceError as error:
        raise ApiError(status_code=500, code="history_edit_proposal_failed", message=str(error))

    answer = result.get("answer", "")
    edit_block = _extract_edit_block(answer)

    if thread:
        store.add_thread_message(request.thread_id, "user", request.query, tokens=result.get("tokens_input"))
        store.add_thread_message(
            request.thread_id,
            "assistant",
            answer,
            tokens=result.get("tokens_output"),
            context_ids=result.get("context_ids"),
        )
        if initial_message_count == 0 and thread.get("title") in {"New Assistant Thread", "New Thread"}:
            try:
                title = svc._generate_session_title(request.query)
                store.update_thread_title(request.thread_id, title)
            except Exception as error:
                logger.warning(f"Failed to generate thread title: {error}")

    return EditProposalResponse(answer=answer, edit_block=edit_block, buffer_hash=request.buffer_hash)


def _extract_edit_block(answer: str):
    if not answer:
        return None
    import json
    import re

    match = re.search(r"```edit\s*([\s\S]*?)```", answer, re.IGNORECASE)
    if not match:
        return None
    payload = match.group(1).strip()
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    if not _is_valid_edit_block(parsed):
        logger.warning("Invalid edit block payload received")
        return None
    return parsed


def _is_valid_edit_block(payload: dict) -> bool:
    version = payload.get("version")
    if version != "1":
        return False
    scope = payload.get("scope")
    replacement = payload.get("replacement")
    if scope not in {"selection", "file"}:
        return False
    if replacement is None:
        return False
    if scope == "selection":
        return bool(payload.get("target"))
    return True
