import { useCallback } from "react";
import { useChatStore } from "../store/chatStore";
import { createWorkspace } from "../api/history";
import {
  createProgram,
  deleteProgram,
  getProgram,
  listPrograms,
  updateProgram,
} from "../api/history";
import type { CodeProgram } from "../types";

const generateProgramTitle = (code: string) => {
  const lines = code
    .split("\n")
    .slice(0, 30)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "Untitled Program";
  }

  // Priority 1: Look for a class or function definition
  for (const line of lines) {
    const defMatch = /^(?:def|class)\s+(\w+)/.exec(line);
    if (defMatch) {
      const name = defMatch[1];
      const kind = line.startsWith("class") ? "Class" : "Function";
      return `${kind}: ${name}`;
    }
  }

  // Priority 2: Look for a meaningful comment (skip template comments)
  const templatePhrases = [
    "write python",
    "your code",
    "write your",
    "enter code",
    "start coding",
  ];
  for (const line of lines) {
    const commentMatch = /^#\s*(.+)/.exec(line);
    if (commentMatch) {
      const comment = commentMatch[1].trim();
      if (
        comment.length > 3 &&
        !templatePhrases.some((p) => comment.toLowerCase().includes(p))
      ) {
        return comment.length > 60 ? `${comment.slice(0, 60)}...` : comment;
      }
    }
  }

  // Priority 3: First meaningful non-comment line
  const firstCode = lines.find(
    (l) =>
      !l.startsWith("#") &&
      !l.startsWith("//") &&
      !l.startsWith("import ") &&
      !l.startsWith("from "),
  );
  if (firstCode) {
    const cleaned =
      firstCode.length > 60 ? `${firstCode.slice(0, 60)}...` : firstCode;
    return cleaned;
  }

  return "Untitled Program";
};

export const usePrograms = () => {
  const {
    programs,
    activeProgramId,
    isLoadingPrograms,
    workspaceId,
    codeEditor,
    setWorkspaceId,
    setPrograms,
    setActiveProgramId,
    setLoadingPrograms,
    updateProgramInStore,
    removeProgramFromStore,
    setEditorCode,
    setEditorOutput,
    setEditorSelection,
    setEditorOpen,
    setEditorMinimized,
    setCodeMemoryId,
    setAssistantThreadId,
    setAssistantMessages,
  } = useChatStore();

  const ensureWorkspace = useCallback(async () => {
    if (workspaceId) return workspaceId;
    const workspace = await createWorkspace("AI Assistant");
    setWorkspaceId(workspace.workspace_id);
    return workspace.workspace_id;
  }, [workspaceId, setWorkspaceId]);

  const fetchPrograms = useCallback(async () => {
    const resolvedWorkspaceId = await ensureWorkspace();
    setLoadingPrograms(true);
    try {
      const result = await listPrograms(resolvedWorkspaceId);
      setPrograms(result.programs);
    } finally {
      setLoadingPrograms(false);
    }
  }, [ensureWorkspace, setLoadingPrograms, setPrograms]);

  const createNewProgram = useCallback(
    async (code: string, language = "python") => {
      const resolvedWorkspaceId = await ensureWorkspace();
      const title = generateProgramTitle(code);
      const program = await createProgram(
        resolvedWorkspaceId,
        code,
        title,
        language,
      );
      setPrograms([program, ...programs]);
      setActiveProgramId(program.program_id);
      setCodeMemoryId(program.code_memory_id);
      setAssistantThreadId(null);
      setAssistantMessages([]);
      return program;
    },
    [
      ensureWorkspace,
      programs,
      setActiveProgramId,
      setAssistantMessages,
      setCodeMemoryId,
      setPrograms,
      setAssistantThreadId,
    ],
  );

  const saveProgram = useCallback(
    async (
      program: CodeProgram,
      updates: {
        current_code?: string;
        last_output?: string | null;
        last_error?: string | null;
      },
    ) => {
      const title = generateProgramTitle(
        updates.current_code ?? program.current_code,
      );
      const updated = await updateProgram(program.program_id, {
        title,
        current_code: updates.current_code,
        last_output: updates.last_output ?? undefined,
        last_error: updates.last_error ?? undefined,
      });
      updateProgramInStore(updated);
      return updated;
    },
    [updateProgramInStore],
  );

  const loadProgram = useCallback(
    async (programId: string) => {
      if (activeProgramId && activeProgramId !== programId) {
        const currentProgram = programs.find(
          (item) => item.program_id === activeProgramId,
        );
        if (currentProgram) {
          await saveProgram(currentProgram, {
            current_code: codeEditor.code,
            last_output: codeEditor.lastOutput,
            last_error: codeEditor.lastError,
          });
        }
      }

      const program = await getProgram(programId);
      setActiveProgramId(program.program_id);
      setCodeMemoryId(program.code_memory_id);
      setEditorCode(program.current_code || "");
      setEditorOutput(program.last_output ?? null, program.last_error ?? null);
      setEditorSelection(null);
      setEditorOpen(true);
      setEditorMinimized(false);
      setAssistantThreadId(null);
      setAssistantMessages([]);
      return program;
    },
    [
      activeProgramId,
      codeEditor.code,
      codeEditor.lastError,
      codeEditor.lastOutput,
      programs,
      saveProgram,
      setActiveProgramId,
      setAssistantMessages,
      setCodeMemoryId,
      setEditorCode,
      setEditorMinimized,
      setEditorOpen,
      setEditorOutput,
      setEditorSelection,
      setAssistantThreadId,
    ],
  );

  const removeProgram = useCallback(
    async (programId: string) => {
      await deleteProgram(programId);
      removeProgramFromStore(programId);
      if (programId === activeProgramId) {
        setActiveProgramId(null);
        setEditorCode("");
        setEditorOutput(null, null);
        setEditorSelection(null);
        setCodeMemoryId(null);
        setAssistantThreadId(null);
        setAssistantMessages([]);
      }
    },
    [
      activeProgramId,
      removeProgramFromStore,
      setActiveProgramId,
      setAssistantMessages,
      setCodeMemoryId,
      setEditorCode,
      setEditorOutput,
      setEditorSelection,
      setAssistantThreadId,
    ],
  );

  return {
    programs,
    activeProgramId,
    isLoadingPrograms,
    fetchPrograms,
    createNewProgram,
    loadProgram,
    saveProgram,
    removeProgram,
  };
};
