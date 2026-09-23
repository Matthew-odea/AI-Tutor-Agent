import { useEffect, useState, useCallback } from "react";
import { useAssistantChat } from "../../hooks/useAssistantChat";
import { useChatStore } from "../../store/chatStore";
import { deleteAssistantThread } from "../../api/history";
import type { AssistantThreadResponse } from "../../api/history";
import { AiAssistHeader, AiAssistInput, AiAssistMessageList } from "./index";

export const AiAssistPanel = () => {
  const {
    messages,
    isLoading,
    sendMessage,
    loadHistory,
    loadThreads,
    createNewThread,
  } = useAssistantChat();
  const {
    assistantThreadId,
    setAssistantThreadId,
    setAssistantMessages,
    codeMemoryId,
  } = useChatStore();
  const [input, setInput] = useState("");
  const [threads, setThreads] = useState<AssistantThreadResponse[]>([]);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input);
    setInput("");
  };

  const refreshThreads = useCallback(async () => {
    if (!codeMemoryId) return;
    setIsLoadingThreads(true);
    try {
      const result = await loadThreads();
      setThreads(result);
    } finally {
      setIsLoadingThreads(false);
    }
  }, [codeMemoryId, loadThreads]);

  const handleNewChat = async () => {
    const threadId = await createNewThread();
    setAssistantThreadId(threadId);
    await loadHistory(threadId);
    await refreshThreads();
  };

  const handleSelectThread = async (selectedThreadId: string) => {
    if (!selectedThreadId || selectedThreadId === assistantThreadId) return;
    setAssistantThreadId(selectedThreadId);
    await loadHistory(selectedThreadId);
  };

  const handleDeleteThread = async (threadIdToDelete: string) => {
    try {
      await deleteAssistantThread(threadIdToDelete);
      setThreads((prev) =>
        prev.filter((t) => t.thread_id !== threadIdToDelete),
      );
      if (threadIdToDelete === assistantThreadId) {
        setAssistantThreadId(null);
        setAssistantMessages([]);
      }
    } catch (err) {
      console.error("Failed to delete thread:", err);
    }
  };

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads, assistantThreadId]);

  return (
    <aside className="w-full bg-slate-100 flex flex-col h-full">
      <AiAssistHeader
        threads={threads}
        threadId={assistantThreadId}
        isLoadingThreads={isLoadingThreads}
        onNewChat={handleNewChat}
        onSelectThread={handleSelectThread}
        onDeleteThread={handleDeleteThread}
      />

      <AiAssistMessageList messages={messages} isLoading={isLoading} />

      <AiAssistInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        disabled={isLoading}
      />
    </aside>
  );
};
