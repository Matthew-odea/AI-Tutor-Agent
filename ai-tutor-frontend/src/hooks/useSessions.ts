import { useCallback } from "react";
import { useChatStore } from "../store/chatStore";
import {
  listSessions,
  getSessionHistory,
  deleteSession,
} from "../api/sessions";
import { createWorkspace } from "../api/history";
import { getUserSession } from "../utils/userSession";
import type { Message } from "../types";

export const useSessions = () => {
  const {
    sessions,
    sessionId: currentSessionId,
    isLoadingSessions,
    workspaceId,
    setWorkspaceId,
    setSessions,
    loadSession,
    deleteSessionFromStore,
    setLoadingSessions,
    clearSession,
  } = useChatStore();

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const session = getUserSession();
      const userId = session?.user_id;
      let resolvedWorkspaceId = workspaceId;
      if (!resolvedWorkspaceId) {
        const workspace = await createWorkspace("AI Assistant");
        resolvedWorkspaceId = workspace.workspace_id;
        setWorkspaceId(resolvedWorkspaceId, userId ?? undefined);
      }
      try {
        const data = await listSessions(resolvedWorkspaceId);
        setSessions(data.sessions);
      } catch (err: unknown) {
        // 403: the persisted workspace belongs to a different user, so start a fresh one.
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        if (status === 403) {
          console.warn("Workspace ownership mismatch, creating new workspace");
          const workspace = await createWorkspace("AI Assistant");
          resolvedWorkspaceId = workspace.workspace_id;
          setWorkspaceId(resolvedWorkspaceId, userId ?? undefined);
          const data = await listSessions(resolvedWorkspaceId);
          setSessions(data.sessions);
        } else {
          throw err;
        }
      }
    } catch (error) {
      console.error("Failed to load sessions:", error);
    } finally {
      setLoadingSessions(false);
    }
  }, [setSessions, setLoadingSessions, setWorkspaceId, workspaceId]);

  const loadSessionHistory = useCallback(
    async (sessionId: string) => {
      try {
        const data = await getSessionHistory(sessionId);

        const messages: Message[] = data.messages.map((msg) => ({
          role: msg.role as "user" | "assistant",
          content: msg.content,
          timestamp: msg.timestamp,
          tokens: msg.tokens,
          context_ids: msg.context_ids,
        }));

        loadSession(sessionId, messages);
      } catch (error) {
        console.error("Failed to load session history:", error);
        throw error;
      }
    },
    [loadSession],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await deleteSession(sessionId);
        deleteSessionFromStore(sessionId);

        if (sessionId === currentSessionId) {
          clearSession();
        }
      } catch (error) {
        console.error("Failed to delete session:", error);
        throw error;
      }
    },
    [currentSessionId, deleteSessionFromStore, clearSession],
  );

  const createNewChatSession = useCallback(async () => {
    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId) {
      const workspace = await createWorkspace("AI Assistant");
      resolvedWorkspaceId = workspace.workspace_id;
      const session = getUserSession();
      setWorkspaceId(resolvedWorkspaceId, session?.user_id ?? undefined);
    }
    const newSession = await import("../api/history").then((m) =>
      m.createViewSession(resolvedWorkspaceId, "chat"),
    );
    loadSession(newSession.view_session_id, []);
    await fetchSessions();
  }, [workspaceId, setWorkspaceId, fetchSessions, loadSession]);

  return {
    sessions,
    isLoadingSessions,
    fetchSessions,
    loadSessionHistory,
    handleDeleteSession,
    createNewChatSession,
  };
};
