import pytest
from fastapi import HTTPException

from src.main.auth.models import AuthPrincipal
from src.main.controllers.api_errors import ApiError
from src.main.controllers import controller_helpers as helpers


class DummyStore:
    def __init__(self, *, workspace=None, code_memory=None, program=None, view=None, thread=None):
        self._workspace = workspace
        self._code_memory = code_memory
        self._program = program
        self._view = view
        self._thread = thread

    def get_workspace(self, _workspace_id):
        return self._workspace

    def get_code_memory(self, _code_memory_id):
        return self._code_memory

    def get_program(self, _program_id):
        return self._program

    def get_view_session(self, _view_session_id):
        return self._view

    def get_thread(self, _thread_id):
        return self._thread


def test_assert_instructor_access_allows_instructor_and_admin():
    helpers._assert_instructor_access(AuthPrincipal(user_id="u1", roles=["instructor"], source="jwt"))
    helpers._assert_instructor_access(AuthPrincipal(user_id="u2", roles=["admin"], source="jwt"))


def test_assert_instructor_access_denies_roleless_x_user_id_principal():
    """The X-User-Id header no longer grants instructor rights."""
    with pytest.raises(HTTPException) as error:
        helpers._assert_instructor_access(AuthPrincipal(user_id="u2", roles=[], source="x-user-id"))

    assert error.value.status_code == 403


def test_assert_assessment_owner_denies_x_user_id_principal_without_owner_metadata():
    with pytest.raises(ApiError) as error:
        helpers._assert_assessment_owner(AuthPrincipal(user_id="u2", roles=[], source="x-user-id"), {})

    assert error.value.status_code == 404


def test_assert_instructor_access_denies_student():
    with pytest.raises(HTTPException) as error:
        helpers._assert_instructor_access(AuthPrincipal(user_id="s1", roles=["student"], source="jwt"))

    assert error.value.status_code == 403


def test_assert_student_access_allows_own_session_token_or_admin():
    session = AuthPrincipal(user_id="s1", roles=["student"], source="jwt", assessment_id="a1")
    helpers._assert_student_access(session, "s1", "a1")
    helpers._assert_student_access(AuthPrincipal(user_id="admin", roles=["admin"], source="jwt"), "s1", "a1")


@pytest.mark.parametrize("principal", [
    AuthPrincipal(user_id="s2", roles=["student"], source="jwt", assessment_id="a1"),  # another student
    AuthPrincipal(user_id="s1", roles=["student"], source="jwt", assessment_id="a2"),  # token for another assessment
    AuthPrincipal(user_id="s1", roles=["student"], source="jwt"),  # login token whose subject equals the student id
    AuthPrincipal(user_id="i1", roles=["instructor"], source="jwt"),  # instructors use /api/assessment/{id}/...
])
def test_assert_student_access_denies_everyone_else(principal):
    with pytest.raises(HTTPException) as error:
        helpers._assert_student_access(principal, "s1", "a1")

    assert error.value.status_code == 403


def test_assert_workspace_owner_and_program_owner_checks():
    store = DummyStore(
        workspace={"workspace_id": "w1", "user_id": "u1"},
        program={"program_id": "p1", "workspace_id": "w1"},
    )

    workspace = helpers._assert_workspace_owner(store, "w1", "u1")
    assert workspace["workspace_id"] == "w1"

    program = helpers._assert_program_owner(store, "p1", "u1")
    assert program["program_id"] == "p1"


def test_assert_assessment_owner_denies_non_owner():
    principal = AuthPrincipal(user_id="u2", roles=["instructor"], source="jwt")
    assessment = {"createdBy": "u1"}

    with pytest.raises(ApiError) as error:
        helpers._assert_assessment_owner(principal, assessment)

    assert error.value.status_code == 404
