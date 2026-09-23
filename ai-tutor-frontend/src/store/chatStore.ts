/**
 * Zustand store for chat state management
 */
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
  // State
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

  // Session Management State
  sessions: SessionInfo[];
  isLoadingSessions: boolean;

  // Code Editor State
  codeEditor: CodeEditorState;
  editorDecorations: EditorDecoration[];
  editorDeletionZones: EditorDeletionZone[];

  // Program State
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

  // Session Management Actions
  setSessions: (sessions: SessionInfo[]) => void;
  loadSession: (sessionId: string, messages: Message[]) => void;
  deleteSessionFromStore: (sessionId: string) => void;
  setLoadingSessions: (loading: boolean) => void;

  // Code Editor Actions
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

  // Program Actions
  setPrograms: (programs: CodeProgram[]) => void;
  setActiveProgramId: (programId: string | null) => void;
  setLoadingPrograms: (loading: boolean) => void;
  updateProgramInStore: (program: CodeProgram) => void;
  removeProgramFromStore: (programId: string) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  // Initial state - always start with a new session
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

  // Session Management Initial State
  sessions: [],
  isLoadingSessions: false,

  // Code Editor Initial State
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

  // Program Initial State
  programs: [],
  activeProgramId: null,
  isLoadingPrograms: false,

  // Actions
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
    // Clear any previous unscoped key
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

  // Session Management Actions
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

  // Code Editor Actions
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
          ...state.codeEditor.history.slice(0, 19), // Keep last 20
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

  // Program Actions
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
