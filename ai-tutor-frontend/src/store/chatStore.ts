import { create } from "zustand";
import type {
  AppMode,
  Message,
  CodeEditorState,
  CodeProgram,
  EditorDecoration,
  EditorDeletionZone,
  SessionInfo,
} from "../types";
import { STORAGE_KEYS } from "../config/constants";
import { EDITOR_TEMPLATE } from "../config/editorDefaults";
import { getUserSession } from "../utils/userSession";

interface ChatStore {
  messages: Message[];
  assistantMessages: Message[];
  sessionId: string | null;
  assistantThreadId: string | null;
  workspaceId: string | null;
  codeMemoryId: string | null;
  appMode: AppMode | null;
  isLoading: boolean;
  error: string | null;
  layoutMode: "stacked" | "split";

  // Sessions
  sessions: SessionInfo[];
  isLoadingSessions: boolean;

  // Code editor
  codeEditor: CodeEditorState;
  editorDecorations: EditorDecoration[];
  editorDeletionZones: EditorDeletionZone[];

  // Programs
  programs: CodeProgram[];
  activeProgramId: string | null;
  isLoadingPrograms: boolean;

  // Actions
  addMessage: (message: Message) => void;
  addAssistantMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  setAssistantMessages: (messages: Message[]) => void;
  setSessionId: (id: string | null) => void;
  setAssistantThreadId: (id: string | null) => void;
  setWorkspaceId: (id: string | null, userId?: string) => void;
  setCodeMemoryId: (id: string | null) => void;
  setAppMode: (mode: AppMode | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setLayoutMode: (mode: "stacked" | "split") => void;
  clearMessages: () => void;
  clearAssistantMessages: () => void;
  clearSession: () => void;

  // Session actions
  setSessions: (sessions: SessionInfo[]) => void;
  loadSession: (sessionId: string, messages: Message[]) => void;
  deleteSessionFromStore: (sessionId: string) => void;
  setLoadingSessions: (loading: boolean) => void;

  // Code editor actions
  setEditorCode: (code: string) => void;
  setEditorOpen: (isOpen: boolean) => void;
  setEditorMinimized: (isMinimized: boolean) => void;
  setEditorOutput: (output: string | null, error: string | null) => void;
  setEditorExecuting: (isExecuting: boolean) => void;
  setEditorSelection: (selection: string | null) => void;
  setEditorDecorations: (decorations: EditorDecoration[]) => void;
  clearEditorDecorations: () => void;
  setEditorDeletionZones: (zones: EditorDeletionZone[]) => void;
  clearEditorDeletionZones: () => void;
  clearEditor: () => void;
  insertCodeIntoEditor: (code: string) => void;
  addToHistory: (
    code: string,
    output: string | null,
    error: string | null,
  ) => void;
  loadFromHistory: (index: number) => void;

  // Program actions
  setPrograms: (programs: CodeProgram[]) => void;
  setActiveProgramId: (programId: string | null) => void;
  setLoadingPrograms: (loading: boolean) => void;
  updateProgramInStore: (program: CodeProgram) => void;
  removeProgramFromStore: (programId: string) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  // SESSION_ID is persisted but deliberately not restored, so each page load starts a new chat.
  messages: [],
  assistantMessages: [],
  sessionId: null,
  assistantThreadId: null,
  workspaceId: (() => {
    const session = getUserSession();
    if (session?.user_id) {
      return localStorage.getItem(
        `${STORAGE_KEYS.WORKSPACE_ID}:${session.user_id}`,
      );
    }
    return null;
  })(),
  codeMemoryId: null,
  appMode: (localStorage.getItem(STORAGE_KEYS.APP_MODE) as AppMode) || null,
  isLoading: false,
  error: null,
  layoutMode: "split",

  sessions: [],
  isLoadingSessions: false,

  codeEditor: {
    code: EDITOR_TEMPLATE,
    isOpen: false,
    isMinimized: false,
    lastOutput: null,
    lastError: null,
    isExecuting: false,
    selection: null,
    history: [],
  },
  editorDecorations: [],
  editorDeletionZones: [],

  programs: [],
  activeProgramId: null,
  isLoadingPrograms: false,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  addAssistantMessage: (message) =>
    set((state) => ({
      assistantMessages: [...state.assistantMessages, message],
    })),

  setMessages: (messages) => set({ messages }),

  setAssistantMessages: (messages) => set({ assistantMessages: messages }),

  setSessionId: (id) => {
    if (id) {
      localStorage.setItem(STORAGE_KEYS.SESSION_ID, id);
    } else {
      localStorage.removeItem(STORAGE_KEYS.SESSION_ID);
    }
    set({ sessionId: id });
  },

  setAssistantThreadId: (id) => set({ assistantThreadId: id }),
  setWorkspaceId: (id, userId) => {
    // Drop the legacy unscoped key; workspace ids are now stored per user.
    localStorage.removeItem(STORAGE_KEYS.WORKSPACE_ID);
    if (id && userId) {
      localStorage.setItem(`${STORAGE_KEYS.WORKSPACE_ID}:${userId}`, id);
    }
    set({ workspaceId: id });
  },
  setCodeMemoryId: (id) => set({ codeMemoryId: id }),

  setAppMode: (mode) => {
    if (mode) {
      localStorage.setItem(STORAGE_KEYS.APP_MODE, mode);
    } else {
      localStorage.removeItem(STORAGE_KEYS.APP_MODE);
    }
    set({ appMode: mode });
  },

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  setLayoutMode: (mode) => set({ layoutMode: mode }),

  clearMessages: () => set({ messages: [] }),

  clearAssistantMessages: () => set({ assistantMessages: [] }),

  clearSession: () => {
    localStorage.removeItem(STORAGE_KEYS.SESSION_ID);
    set({ messages: [], sessionId: null, error: null });
  },

  // Session actions
  setSessions: (sessions) => set({ sessions }),

  loadSession: (sessionId, messages) => {
    localStorage.setItem(STORAGE_KEYS.SESSION_ID, sessionId);
    set({ sessionId, messages, error: null });
  },

  deleteSessionFromStore: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.session_id !== sessionId),
    })),

  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  // Code editor actions
  setEditorCode: (code) =>
    set((state) => ({
      codeEditor: { ...state.codeEditor, code },
    })),

  setEditorOpen: (isOpen) =>
    set((state) => ({
      codeEditor: { ...state.codeEditor, isOpen },
    })),

  setEditorMinimized: (isMinimized) =>
    set((state) => ({
      codeEditor: { ...state.codeEditor, isMinimized },
    })),

  setEditorOutput: (output, error) =>
    set((state) => ({
      codeEditor: { ...state.codeEditor, lastOutput: output, lastError: error },
    })),

  setEditorExecuting: (isExecuting) =>
    set((state) => ({
      codeEditor: { ...state.codeEditor, isExecuting },
    })),

  setEditorSelection: (selection) =>
    set((state) => ({
      codeEditor: { ...state.codeEditor, selection },
    })),

  setEditorDecorations: (decorations) =>
    set({ editorDecorations: decorations }),

  clearEditorDecorations: () => set({ editorDecorations: [] }),

  setEditorDeletionZones: (zones) => set({ editorDeletionZones: zones }),

  clearEditorDeletionZones: () => set({ editorDeletionZones: [] }),

  clearEditor: () =>
    set((state) => ({
      codeEditor: {
        ...state.codeEditor,
        code: EDITOR_TEMPLATE,
        lastOutput: null,
        lastError: null,
        selection: null,
        history: [],
      },
    })),

  insertCodeIntoEditor: (code) =>
    set((state) => ({
      codeEditor: {
        ...state.codeEditor,
        code,
        isOpen: true,
        isMinimized: false,
        selection: null,
      },
    })),

  addToHistory: (code, output, error) =>
    set((state) => ({
      codeEditor: {
        ...state.codeEditor,
        history: [
          { code, output, error, timestamp: Date.now() },
          ...state.codeEditor.history.slice(0, 19),
        ],
      },
    })),

  loadFromHistory: (index) =>
    set((state) => {
      const entry = state.codeEditor.history[index];
      if (!entry) return state;

      return {
        codeEditor: {
          ...state.codeEditor,
          code: entry.code,
          lastOutput: entry.output,
          lastError: entry.error,
          selection: null,
        },
      };
    }),

  // Program actions
  setPrograms: (programs) => set({ programs }),

  setActiveProgramId: (programId) => set({ activeProgramId: programId }),

  setLoadingPrograms: (loading) => set({ isLoadingPrograms: loading }),

  updateProgramInStore: (program) =>
    set((state) => ({
      programs: state.programs.map((item) =>
        item.program_id === program.program_id ? program : item,
      ),
    })),

  removeProgramFromStore: (programId) =>
    set((state) => ({
      programs: state.programs.filter((item) => item.program_id !== programId),
    })),
}));
