/**
 * Session management API methods
 */
import { listViewSessions, getViewHistory, deleteViewSession } from "./history";
import type { SessionListResponse, ChatHistoryResponse } from "../types";
import { getUserSession } from "../utils/userSession";

/**
 * Get list of all chat sessions
 */
export const listSessions = async (
  workspaceId: string | null,
): Promise<SessionListResponse> => {
  const session = getUserSession();
  if (!session?.user_id || !workspaceId) {
    return { sessions: [], total: 0 };
  }
  const response = await listViewSessions(workspaceId, "chat");
  const sessions = response.views.map((view) => ({
    session_id: view.view_session_id,
    message_count: view.message_count,
    created_at: view.created_at,
    last_accessed: view.last_accessed,
    total_tokens: view.total_tokens,
    pedagogy_mode: view.pedagogy_mode || undefined,
    title: view.title || undefined,
  }));

  sessions.sort((left, right) => {
    const leftTime = Date.parse(left.last_accessed || left.created_at || "");
    const rightTime = Date.parse(right.last_accessed || right.created_at || "");

    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;

    return rightTime - leftTime;
  });

  return { sessions, total: sessions.length };
};

/**
 * Get chat history for a specific session
 */
export const getSessionHistory = async (
  sessionId: string,
): Promise<ChatHistoryResponse> => {
  const response = await getViewHistory(sessionId);
  return {
    session_id: response.view_session_id,
    messages: response.messages,
    total_messages: response.message_count,
    created_at: response.created_at,
    last_accessed: response.last_accessed,
    total_tokens: response.total_tokens,
  };
};

/**
 * Delete a session
 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  await deleteViewSession(sessionId);
};
