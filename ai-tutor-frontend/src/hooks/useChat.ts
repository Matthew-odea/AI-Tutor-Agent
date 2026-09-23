import { useCallback } from "react";
import { useChatStore } from "../store/chatStore";
import {
  createWorkspace,
  createViewSession,
  postViewMessage,
} from "../api/history";
import type { Message, ChatEditorContext } from "../types";
import {
  trackChatResponse,
  trackMessageSent,
  trackSessionCreated,
} from "../utils/analytics";

/** Chat-mode send flow. Lazily creates the workspace and view session on the first message. */
export const useChat = () => {
  const {
    messages,
    sessionId,
    workspaceId,
    appMode,
    isLoading,
    error,
    addMessage,
    setSessionId,
    setWorkspaceId,
    setLoading,
    setError,
  } = useChatStore();

  const ensureWorkspace = useCallback(async () => {
    if (workspaceId) return workspaceId;
    const workspace = await createWorkspace("AI Assistant");
    setWorkspaceId(workspace.workspace_id);
    return workspace.workspace_id;
  }, [workspaceId, setWorkspaceId]);

  const sendMessage = useCallback(
    async (content: string, editorContext?: ChatEditorContext) => {
      if (!content.trim() || isLoading) return;
      const messageStart = performance.now();
      const normalized = content.trim();

      trackMessageSent(
        appMode || "chat",
        normalized.length,
        Boolean(editorContext),
      );

      const userMessage: Message = {
        role: "user",
        content: normalized,
        timestamp: new Date().toISOString(),
      };
      addMessage(userMessage);
      setError(null);
      setLoading(true);

      try {
        const activeWorkspaceId = await ensureWorkspace();
        let viewSessionId = sessionId;
        if (!viewSessionId) {
          const view = await createViewSession(activeWorkspaceId, "chat");
          viewSessionId = view.view_session_id;
          setSessionId(viewSessionId);
          trackSessionCreated();
        }

        const response = await postViewMessage(viewSessionId, {
          query: normalized,
          session_id: viewSessionId,
          include_history: true,
          top_k: 5,
          ...editorContext,
        });

        const assistantMessage: Message = {
          role: "assistant",
          content: response.answer,
          timestamp: new Date().toISOString(),
          tokens: response.tokens_output || undefined,
          context_ids: response.context_ids,
        };
        addMessage(assistantMessage);
        trackChatResponse(
          performance.now() - messageStart,
          false,
          response.tokens_output ?? undefined,
        );
      } catch (err) {
        console.error("Failed to send message:", err);

        let userFriendlyMessage =
          "I'm sorry, I can't handle that right now. Please try again in a moment.";

        if (err instanceof Error) {
          if (
            err.message.includes("Network Error") ||
            err.message.includes("fetch")
          ) {
            userFriendlyMessage =
              "I'm having trouble connecting right now. Please check your connection and try again.";
          } else if (err.message.includes("timeout")) {
            userFriendlyMessage =
              "The request took too long. Please try again with a shorter message.";
          } else if (
            err.message.includes("500") ||
            err.message.includes("503")
          ) {
            userFriendlyMessage =
              "I'm experiencing technical difficulties right now. Please try again in a moment.";
          } else if (
            err.message.includes("ValidationException") ||
            err.message.includes("model")
          ) {
            userFriendlyMessage =
              "I'm having trouble processing your request right now. Our team has been notified.";
          }
        }

        setError(userFriendlyMessage);

        const errorMsg: Message = {
          role: "assistant",
          content: userFriendlyMessage,
          timestamp: new Date().toISOString(),
          isError: true,
        };
        addMessage(errorMsg);
        trackChatResponse(performance.now() - messageStart, true);
      } finally {
        setLoading(false);
      }
    },
    [
      sessionId,
      isLoading,
      addMessage,
      setSessionId,
      setLoading,
      setError,
      ensureWorkspace,
      appMode,
    ],
  );

  return {
    messages,
    sessionId,
    isLoading,
    error,
    sendMessage,
  };
};
