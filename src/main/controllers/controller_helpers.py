from __future__ import annotations

from typing import Optional

from fastapi import Header, HTTPException

from src.main.auth.dependencies import resolve_user_id_from_headers
from src.main.auth.models import AuthPrincipal
from src.main.controllers.api_errors import ApiError


def _assessment_not_found() -> ApiError:
    return ApiError(status_code=404, code="assessment_not_found", message="Assessment not found")


def _require_user_id(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
) -> str:
    return resolve_user_id_from_headers(authorization=authorization, x_user_id=x_user_id)


def _assert_workspace_owner(store, workspace_id: str, user_id: str) -> dict:
    workspace = store.get_workspace(workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if workspace.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Workspace access denied")
    return workspace


def _assert_code_memory_owner(store, code_memory_id: str, user_id: str) -> dict:
    memory = store.get_code_memory(code_memory_id)
    if not memory:
        raise HTTPException(status_code=404, detail="Code memory not found")
    _assert_workspace_owner(store, memory["workspace_id"], user_id)
    return memory


def _assert_program_owner(store, program_id: str, user_id: str) -> dict:
    program = store.get_program(program_id)
    if not program:
        raise HTTPException(status_code=404, detail="Program not found")
    _assert_workspace_owner(store, program["workspace_id"], user_id)
    return program


def _assert_view_owner(store, view_session_id: str, user_id: str) -> dict:
    view = store.get_view_session(view_session_id)
    if not view:
        raise HTTPException(status_code=404, detail="View session not found")
    _assert_workspace_owner(store, view["workspace_id"], user_id)
    return view


def _assert_thread_owner(store, thread_id: str, user_id: str) -> dict:
    thread = store.get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    _assert_code_memory_owner(store, thread["code_memory_id"], user_id)
    return thread


def _resolve_pedagogy_mode(requested_mode: Optional[str], default_mode: str) -> str:
    if requested_mode is None or requested_mode == "":
        return default_mode
    return requested_mode


def _has_role(principal: AuthPrincipal, roles: set[str]) -> bool:
    principal_roles = {role.lower() for role in principal.roles}
    return not roles.isdisjoint(principal_roles)


def _assert_instructor_access(principal: AuthPrincipal) -> None:
    if _has_role(principal, {"instructor", "admin"}):
        return

    raise HTTPException(status_code=403, detail="Instructor access required")


def _assert_student_access(principal: AuthPrincipal, student_id: str, assessment_id: str) -> None:
    """Only an admin or a session token scoped to exactly this (student, assessment) pair passes.

    Deliberately refused: instructors (their student views go through /api/assessment/{id}/...,
    which checks ownership), and unscoped login tokens whose subject equals the student id
    (signup is open, so anyone could sign up as an email used as a student id).
    """
    if _has_role(principal, {"admin"}):
        return
    if principal.user_id != student_id:
        raise HTTPException(status_code=403, detail="Student access denied")
    if not principal.assessment_id or principal.assessment_id != assessment_id:
        raise HTTPException(status_code=403, detail="Token not valid for this assessment")


def _assert_assessment_owner(principal: AuthPrincipal, assessment: dict | None) -> None:
    """Creator or admin only. Answers as a missing assessment would, so ids can't be probed; no createdBy means no owner."""
    if _has_role(principal, {"admin"}):
        return
    created_by = (assessment or {}).get("createdBy")
    if created_by and principal.user_id == created_by:
        return
    raise _assessment_not_found()
