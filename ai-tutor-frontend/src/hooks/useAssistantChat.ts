import { useCallback } from "react";
import { useChatStore } from "../store/chatStore";
import {
  createWorkspace,
  createCodeMemory,
  createAssistantThread,
  createEditProposal,
  postAssistantMessage,
  updateCodeMemory,
  getAssistantHistory,
  listAssistantThreads,
} from "../api/history";
import type { Message } from "../types";
import { hashString } from "../utils/hash";
import { STORAGE_KEYS } from "../config/constants";

type EditIntent = "strong" | "weak" | "none";

const classifyEditIntent = (
  query: string,
  recentMessages?: Array<{ role: string; content: string }>,
): EditIntent => {
  if (!query) return "none";
  const lowered = query.toLowerCase();

  const strongVerbs = [
    "edit",
    "change",
    "update",
    "modify",
    "refactor",
    "fix",
    "add",
    "remove",
    "rewrite",
    "replace",
    "optimize",
    "rename",
    "make",
    "convert",
    "transform",
    "move",
    "extract",
    "inline",
    "merge",
    "split",
    "wrap",
    "unwrap",
    "simplify",
    "clean",
    "cleanup",
    "restructure",
    "reorganize",
    "rearrange",
    "swap",
    "switch",
    "toggle",
    "enable",
    "disable",
    "insert",
    "append",
    "prepend",
    "delete",
    "drop",
    "strip",
    "trim",
    "pad",
    "format",
    "indent",
    "dedent",
    "sort",
    "reverse",
    "flatten",
    "nest",
    "abstract",
    "generalize",
    "specialize",
    "parametrize",
    "parameterize",
    "type",
    "annotate",
    "document",
    "comment",
    "uncomment",
    "debug",
    "patch",
    "hotfix",
    "correct",
    "adjust",
    "tweak",
    "improve",
    "enhance",
    "upgrade",
    "downgrade",
    "migrate",
    "port",
    "translate",
    "decompose",
    "compose",
    "combine",
    "separate",
    "decouple",
    "encapsulate",
    "expose",
    "hide",
    "protect",
    "validate",
    "sanitize",
    "escape",
    "handle",
    "catch",
    "throw",
    "raise",
    "log",
    "print",
    "return",
    "yield",
    "await",
    "async",
    "sync",
    "cache",
    "memoize",
    "lazy",
    "eager",
    "batch",
    "throttle",
    "debounce",
    "retry",
    "recover",
    "fallback",
    "default",
    "initialize",
    "reset",
    "clear",
    "populate",
    "seed",
    "mock",
    "stub",
    "shorten",
    "lengthen",
    "expand",
    "collapse",
    "minify",
    "prettify",
    "beautify",
    "lint",
    "auto-fix",
    "autofix",
  ];
  const constructVerbs = [
    "implement",
    "write",
    "create",
    "generate",
    "build",
    "scaffold",
    "bootstrap",
    "setup",
    "wire",
    "hook",
    "connect",
    "define",
    "declare",
    "construct",
    "design",
    "draft",
    "prototype",
    "sketch",
  ];
  const codeTargets = [
    "code",
    "program",
    "script",
    "function",
    "class",
    "module",
    "file",
    "tests",
    "test",
    "component",
    "api",
    "endpoint",
    "ui",
    "frontend",
    "backend",
    "service",
    "controller",
    "model",
    "schema",
    "prompt",
  ];
  const infoPhrases = [
    "explain",
    "describe",
    "summarize",
    "what is",
    "why",
    "how do i",
    "help me understand",
    "teach me",
    "example of",
  ];
  const assignmentSignals = [
    "problem statement",
    "question:",
    "write a function",
    "implement a function",
    "given an integer",
    "given a list",
    "given an array",
    "input:",
    "output:",
    "constraints",
    "sample input",
    "sample output",
  ];
  // Continuation phrases that imply "keep editing" in multi-turn context
  const continuationPhrases = [
    "now ",
    "also ",
    "then ",
    "next ",
    "and also",
    "can you also",
    "do the same",
    "same thing",
    "apply that",
    "keep going",
    "continue",
    "make it",
    "try again",
    "do it",
    "yes",
    "ok do it",
    "go ahead",
    "that too",
    "what about",
  ];

  const verbMatch = (verb: string) =>
    lowered.includes(`${verb} `) ||
    lowered === verb ||
    lowered.endsWith(` ${verb}`);
  const hasStrongVerb = strongVerbs.some(verbMatch);
  const hasConstructVerb = constructVerbs.some(verbMatch);
  const hasCodeTarget = codeTargets.some((target) => lowered.includes(target));
  const hasAssignmentSignal = assignmentSignals.some((signal) =>
    lowered.includes(signal),
  );
  const hasFileHint =
    lowered.includes("this file") ||
    lowered.includes("the file") ||
    lowered.includes("this code") ||
    lowered.includes("the code") ||
    /```/.test(lowered) ||
    /\b[\w./-]+\.(py|ts|tsx|js|jsx|json|md|txt|css|html|yml|yaml)\b/i.test(
      query,
    );
  const hasInfoPhrase = infoPhrases.some((phrase) => lowered.includes(phrase));

  const looksLikeProblemPaste =
    hasAssignmentSignal ||
    (/\n/.test(query) && query.length > 180 && hasCodeTarget);

  // Info phrases take priority — "explain this code" should NOT trigger an edit
  if (hasInfoPhrase && !hasStrongVerb && !looksLikeProblemPaste) return "none";

  if (hasStrongVerb || hasFileHint || looksLikeProblemPaste) return "strong";
  if (hasConstructVerb) return "strong";

  // Multi-turn: if the last assistant message contained an edit block, short follow-ups
  // like "now add error handling" or "also make it recursive" are likely edit continuations
  if (recentMessages && recentMessages.length >= 1) {
    const lastAssistant = [...recentMessages]
      .reverse()
      .find((m) => m.role === "assistant");
    const lastWasEdit = lastAssistant?.content?.includes("```edit");
    if (lastWasEdit) {
      const hasContinuation = continuationPhrases.some(
        (phrase) => lowered.startsWith(phrase) || lowered.includes(phrase),
      );
      if (hasContinuation) return "strong";
      // Short messages after an edit are likely edit follow-ups
      if (query.trim().length < 80 && !hasInfoPhrase) return "weak";
    }
  }

  if (hasInfoPhrase) return "none";
  return "none";
};

export const useAssistantChat = () => {
  const {
    assistantMessages,
    assistantThreadId,
    workspaceId,
    codeMemoryId,
    codeEditor,
    addAssistantMessage,
    setAssistantMessages,
    setAssistantThreadId,
    setWorkspaceId,
    setCodeMemoryId,
    setLoading,
    setError,
    isLoading,
  } = useChatStore();

  const loadThreadMap = () => {
    const raw = localStorage.getItem(STORAGE_KEYS.ASSISTANT_THREAD_MAP);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const persistThreadId = useCallback(
    (codeMemoryIdValue: string, threadIdValue: string) => {
      const map = loadThreadMap();
      map[codeMemoryIdValue] = threadIdValue;
      localStorage.setItem(
        STORAGE_KEYS.ASSISTANT_THREAD_MAP,
        JSON.stringify(map),
      );
    },
    [],
  );

  const ensureWorkspaceAndMemory = useCallback(async () => {
    let currentWorkspaceId = workspaceId;
    if (!currentWorkspaceId) {
      const workspace = await createWorkspace("AI Assistant");
      currentWorkspaceId = workspace.workspace_id;
      setWorkspaceId(currentWorkspaceId);
    }

    let currentCodeMemoryId = codeMemoryId;
    if (!currentCodeMemoryId) {
      const memory = await createCodeMemory(
        currentWorkspaceId,
        codeEditor.code,
        "python",
      );
      currentCodeMemoryId = memory.code_memory_id;
      setCodeMemoryId(currentCodeMemoryId);
    }

    return {
      workspaceId: currentWorkspaceId,
      codeMemoryId: currentCodeMemoryId,
    };
  }, [
    workspaceId,
    codeMemoryId,
    codeEditor.code,
    setWorkspaceId,
    setCodeMemoryId,
  ]);

  const loadHistory = useCallback(
    async (threadId?: string) => {
      const activeThreadId = threadId || assistantThreadId;
      if (!activeThreadId) return;
      const history = await getAssistantHistory(activeThreadId);
      const messages: Message[] = history.messages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
        timestamp: msg.timestamp,
        tokens: msg.tokens,
        context_ids: msg.context_ids,
      }));
      setAssistantMessages(messages);
    },
    [assistantThreadId, setAssistantMessages],
  );

  const loadThreads = useCallback(async () => {
    if (!codeMemoryId) return [];
    const result = await listAssistantThreads(codeMemoryId);
    return result.threads;
  }, [codeMemoryId]);

  const createNewThread = useCallback(async () => {
    const { codeMemoryId: resolvedCodeMemoryId } =
      await ensureWorkspaceAndMemory();
    await updateCodeMemory(
      resolvedCodeMemoryId,
      codeEditor.code,
      codeEditor.lastOutput,
      codeEditor.lastError,
    );
    const thread = await createAssistantThread(
      resolvedCodeMemoryId,
      "New Thread",
    );
    setAssistantThreadId(thread.thread_id);
    persistThreadId(resolvedCodeMemoryId, thread.thread_id);
    setAssistantMessages([]);
    return thread.thread_id;
  }, [
    codeEditor.code,
    codeEditor.lastError,
    codeEditor.lastOutput,
    ensureWorkspaceAndMemory,
    persistThreadId,
    setAssistantMessages,
    setAssistantThreadId,
  ]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      const userMessage: Message = {
        role: "user",
        content: content.trim(),
        timestamp: new Date().toISOString(),
      };
      addAssistantMessage(userMessage);
      setError(null);
      setLoading(true);

      try {
        const { codeMemoryId: resolvedCodeMemoryId } =
          await ensureWorkspaceAndMemory();
        let threadId = assistantThreadId;
        if (!threadId) {
          const storedMap = loadThreadMap();
          const storedThreadId = storedMap[resolvedCodeMemoryId];
          if (storedThreadId) {
            threadId = storedThreadId;
            setAssistantThreadId(threadId);
          }
        }

        if (!threadId) {
          const existingThreads =
            await listAssistantThreads(resolvedCodeMemoryId);
          const latestThread = existingThreads.threads?.[0];
          if (latestThread?.thread_id) {
            threadId = latestThread.thread_id;
            setAssistantThreadId(threadId);
            persistThreadId(resolvedCodeMemoryId, threadId);
          } else {
            const trimmed = content.trim();
            const firstLine =
              trimmed.split("\n")[0]?.trim() || "Assistant Thread";
            const title =
              firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
            const thread = await createAssistantThread(
              resolvedCodeMemoryId,
              title,
            );
            threadId = thread.thread_id;
            setAssistantThreadId(threadId);
            persistThreadId(resolvedCodeMemoryId, threadId);
          }
        }

        await updateCodeMemory(
          resolvedCodeMemoryId,
          codeEditor.code,
          codeEditor.lastOutput,
          codeEditor.lastError,
        );

        const recentMsgs = useChatStore.getState().assistantMessages.slice(-6);
        const editIntent = classifyEditIntent(content, recentMsgs);
        if (editIntent === "strong") {
          const bufferHash = await hashString(codeEditor.code || "");
          const response = await createEditProposal({
            query: content.trim(),
            thread_id: threadId,
            include_history: true,
            pedagogy_mode: "concise",
            editor_code: codeEditor.code,
            editor_selection: codeEditor.selection,
            last_stdout: codeEditor.lastOutput,
            last_error: codeEditor.lastError,
            language: "python",
            buffer_hash: bufferHash,
          });

          const hasEditBlock = response.answer.includes("```edit");
          const editBlockPayload = response.edit_block
            ? {
                version: "1",
                ...response.edit_block,
                buffer_hash: response.buffer_hash || bufferHash,
              }
            : null;
          const editBlockText = editBlockPayload
            ? `\n\n\`\`\`edit\n${JSON.stringify(editBlockPayload)}\n\`\`\``
            : "";
          const assistantMessage: Message = {
            role: "assistant",
            content: hasEditBlock
              ? response.answer
              : `${response.answer}${editBlockText}`,
            timestamp: new Date().toISOString(),
          };
          addAssistantMessage(assistantMessage);
          if (threadId) {
            persistThreadId(resolvedCodeMemoryId, threadId);
          }
        } else {
          const response = await postAssistantMessage(threadId, {
            query: content.trim(),
            include_history: true,
            pedagogy_mode: "concise",
            top_k: 5,
            editor_code: codeEditor.code,
            editor_selection: codeEditor.selection,
            last_stdout: codeEditor.lastOutput,
            last_error: codeEditor.lastError,
            language: "python",
          });

          const assistantMessage: Message = {
            role: "assistant",
            content: response.answer,
            timestamp: new Date().toISOString(),
            tokens: response.tokens_output || undefined,
            context_ids: response.context_ids,
          };
          addAssistantMessage(assistantMessage);
          if (threadId) {
            persistThreadId(resolvedCodeMemoryId, threadId);
          }
        }
      } catch {
        setError("I'm having trouble saving this assistant message right now.");
      } finally {
        setLoading(false);
      }
    },
    [
      addAssistantMessage,
      assistantThreadId,
      codeEditor,
      ensureWorkspaceAndMemory,
      isLoading,
      persistThreadId,
      setAssistantThreadId,
      setError,
      setLoading,
    ],
  );

  return {
    messages: assistantMessages,
    isLoading,
    sendMessage,
    loadHistory,
    loadThreads,
    createNewThread,
  };
};
