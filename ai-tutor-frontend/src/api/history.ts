import { apiClient } from "./client";
import { API_ENDPOINTS } from "../config/api.config";
import type { ChatRequest, ChatResponse } from "../types";
import { getUserSession } from "../utils/userSession";

export interface WorkspaceResponse {
  workspace_id: string;
  title: string;
  created_at: string;
  last_accessed: string;
  user_id?: string | null;
}

export interface ViewSessionResponse {
  view_session_id: string;
  workspace_id: string;
  view_type: string;
  title?: string | null;
  created_at: string;
  last_accessed: string;
  message_count: number;
  total_tokens: number;
  pedagogy_mode?: string | null;
}

export interface ViewSessionListResponse {
  workspace_id: string;
  view_type?: string | null;
  views: ViewSessionResponse[];
}

export interface CodeMemoryResponse {
  code_memory_id: string;
  workspace_id: string;
  language: string;
  current_code: string;
  last_output?: string | null;
  last_error?: string | null;
  created_at: string;
  last_accessed: string;
}

export interface ProgramResponse {
  program_id: string;
  workspace_id: string;
  code_memory_id: string;
  title: string;
  language: string;
  current_code: string;
  last_output?: string | null;
  last_error?: string | null;
  created_at: string;
  last_accessed: string;
}

export interface ProgramListResponse {
  workspace_id: string;
  programs: ProgramResponse[];
}

export interface AssistantThreadResponse {
  thread_id: string;
  code_memory_id: string;
  title: string;
  created_at: string;
  last_accessed: string;
}

export interface AssistantThreadListResponse {
  code_memory_id: string;
  threads: AssistantThreadResponse[];
}

export interface AssistantHistoryResponse {
  thread_id: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
    tokens?: number;
    context_ids?: string[];
    edit_block?: Record<string, unknown>;
  }>;
  message_count: number;
  created_at: string;
  last_accessed: string;
  code_memory_id: string;
}

export interface ViewHistoryResponse {
  view_session_id: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
    tokens?: number;
    context_ids?: string[];
  }>;
  message_count: number;
  created_at: string;
  last_accessed: string;
  total_tokens: number;
  view_type: string;
}

export interface EditProposalRequest {
  query: string;
  thread_id?: string | null;
  editor_code?: string;
  editor_selection?: string | null;
  last_stdout?: string | null;
  last_error?: string | null;
  language?: string;
  buffer_hash?: string | null;
  include_history?: boolean;
  pedagogy_mode?: string | null;
}

export interface EditProposalResponse {
  answer: string;
  edit_block?: Record<string, unknown> | null;
  buffer_hash?: string | null;
}

export const createWorkspace = async (
  title?: string,
): Promise<WorkspaceResponse> => {
  const session = getUserSession();
  const response = await apiClient.post<WorkspaceResponse>(
    API_ENDPOINTS.HISTORY_WORKSPACES,
    {
      title: title || "New Workspace",
      user_id: session?.user_id || null,
    },
  );
  return response.data;
};

export const createViewSession = async (
  workspaceId: string,
  viewType: string,
  pedagogyMode?: string | null,
): Promise<ViewSessionResponse> => {
  const session = getUserSession();
  const response = await apiClient.post<ViewSessionResponse>(
    API_ENDPOINTS.HISTORY_VIEWS,
    {
      workspace_id: workspaceId,
      view_type: viewType,
      pedagogy_mode: pedagogyMode || null,
      user_id: session?.user_id || null,
    },
  );
  return response.data;
};

export const listViewSessions = async (
  workspaceId: string,
  viewType?: string,
): Promise<ViewSessionListResponse> => {
  const response = await apiClient.get<ViewSessionListResponse>(
    API_ENDPOINTS.HISTORY_VIEWS_BY_WORKSPACE(workspaceId, viewType),
  );
  return response.data;
};

export const deleteViewSession = async (
  viewSessionId: string,
): Promise<{ ok: boolean; view_session_id: string }> => {
  const response = await apiClient.delete<{
    ok: boolean;
    view_session_id: string;
  }>(API_ENDPOINTS.HISTORY_VIEW_ID(viewSessionId));
  return response.data;
};

export const createCodeMemory = async (
  workspaceId: string,
  currentCode: string,
  language = "python",
): Promise<CodeMemoryResponse> => {
  const session = getUserSession();
  const response = await apiClient.post<CodeMemoryResponse>(
    API_ENDPOINTS.HISTORY_CODEMEMORY,
    {
      workspace_id: workspaceId,
      current_code: currentCode,
      language,
      user_id: session?.user_id || null,
    },
  );
  return response.data;
};

export const createProgram = async (
  workspaceId: string,
  currentCode: string,
  title?: string,
  language = "python",
): Promise<ProgramResponse> => {
  const session = getUserSession();
  const response = await apiClient.post<ProgramResponse>(
    API_ENDPOINTS.HISTORY_PROGRAMS,
    {
      workspace_id: workspaceId,
      current_code: currentCode,
      language,
      title: title || undefined,
      user_id: session?.user_id || null,
    },
  );
  return response.data;
};

export const listPrograms = async (
  workspaceId: string,
): Promise<ProgramListResponse> => {
  const response = await apiClient.get<ProgramListResponse>(
    API_ENDPOINTS.HISTORY_PROGRAMS_BY_WORKSPACE(workspaceId),
  );
  return response.data;
};

export const getProgram = async (
  programId: string,
): Promise<ProgramResponse> => {
  const response = await apiClient.get<ProgramResponse>(
    API_ENDPOINTS.HISTORY_PROGRAM_ID(programId),
  );
  return response.data;
};

export const updateProgram = async (
  programId: string,
  payload: {
    title?: string;
    current_code?: string;
    last_output?: string | null;
    last_error?: string | null;
  },
): Promise<ProgramResponse> => {
  const response = await apiClient.patch<ProgramResponse>(
    API_ENDPOINTS.HISTORY_PROGRAM_ID(programId),
    payload,
  );
  return response.data;
};

export const deleteProgram = async (
  programId: string,
): Promise<{ ok: boolean; program_id: string }> => {
  const response = await apiClient.delete<{ ok: boolean; program_id: string }>(
    API_ENDPOINTS.HISTORY_PROGRAM_ID(programId),
  );
  return response.data;
};

export const updateCodeMemory = async (
  codeMemoryId: string,
  currentCode?: string,
  lastOutput?: string | null,
  lastError?: string | null,
): Promise<CodeMemoryResponse> => {
  const response = await apiClient.patch<CodeMemoryResponse>(
    API_ENDPOINTS.HISTORY_CODEMEMORY_ID(codeMemoryId),
    {
      current_code: currentCode,
      last_output: lastOutput ?? null,
      last_error: lastError ?? null,
    },
  );
  return response.data;
};

export const createAssistantThread = async (
  codeMemoryId: string,
  title?: string,
): Promise<AssistantThreadResponse> => {
  const response = await apiClient.post<AssistantThreadResponse>(
    API_ENDPOINTS.HISTORY_THREADS(codeMemoryId),
    {
      title: title || "New Assistant Thread",
    },
  );
  return response.data;
};

export const listAssistantThreads = async (
  codeMemoryId: string,
): Promise<AssistantThreadListResponse> => {
  const response = await apiClient.get<AssistantThreadListResponse>(
    API_ENDPOINTS.HISTORY_THREADS(codeMemoryId),
  );
  return response.data;
};

export const deleteAssistantThread = async (
  threadId: string,
): Promise<{ ok: boolean; thread_id: string }> => {
  const response = await apiClient.delete<{ ok: boolean; thread_id: string }>(
    `/internal/history/threads/${threadId}`,
  );
  return response.data;
};

export const getAssistantHistory = async (
  threadId: string,
): Promise<AssistantHistoryResponse> => {
  const response = await apiClient.get<AssistantHistoryResponse>(
    API_ENDPOINTS.HISTORY_THREAD_HISTORY(threadId),
  );
  return response.data;
};

export const getViewHistory = async (
  viewSessionId: string,
): Promise<ViewHistoryResponse> => {
  const response = await apiClient.get<ViewHistoryResponse>(
    API_ENDPOINTS.HISTORY_VIEW_HISTORY(viewSessionId),
  );
  return response.data;
};

export const postAssistantMessage = async (
  threadId: string,
  request: ChatRequest,
): Promise<ChatResponse> => {
  const response = await apiClient.post<ChatResponse>(
    API_ENDPOINTS.HISTORY_THREAD_MESSAGE(threadId),
    request,
  );
  return response.data;
};

export const postViewMessage = async (
  viewSessionId: string,
  request: ChatRequest,
): Promise<ChatResponse> => {
  const response = await apiClient.post<ChatResponse>(
    API_ENDPOINTS.HISTORY_VIEW_MESSAGE(viewSessionId),
    request,
  );
  return response.data;
};

export const createEditProposal = async (
  request: EditProposalRequest,
): Promise<EditProposalResponse> => {
  const response = await apiClient.post<EditProposalResponse>(
    API_ENDPOINTS.HISTORY_EDIT_PROPOSAL,
    request,
  );
  return response.data;
};
