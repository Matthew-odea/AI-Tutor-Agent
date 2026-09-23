const DEFAULT_DEV_API_BASE_URL = "http://localhost:8000";
const DEFAULT_PROD_API_BASE_URL = "https://api.chat9021.org";

const resolveApiBaseUrl = (): string => {
  const fallback = import.meta.env.PROD
    ? DEFAULT_PROD_API_BASE_URL
    : DEFAULT_DEV_API_BASE_URL;
  const configured = (import.meta.env.VITE_API_BASE_URL || fallback).trim();

  if (typeof window === "undefined") {
    return configured;
  }

  // Avoid mixed-content blocks on HTTPS pages: upgrade http URLs, and map the legacy bare EC2 IP (no TLS cert) to the prod domain.
  const isSecurePage = window.location.protocol === "https:";
  if (!isSecurePage || !configured.startsWith("http://")) {
    return configured;
  }

  try {
    const parsed = new URL(configured);
    if (parsed.hostname === "3.27.56.110") {
      return DEFAULT_PROD_API_BASE_URL;
    }
    return configured.replace(/^http:\/\//, "https://");
  } catch {
    return DEFAULT_PROD_API_BASE_URL;
  }
};

export const API_CONFIG = {
  baseURL: resolveApiBaseUrl(),
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
} as const;

export const API_ENDPOINTS = {
  AUTH_LOGIN: "/api/auth/login",
  AUTH_SIGNUP: "/api/auth/signup",
  AUTH_GOOGLE: "/api/auth/google",
  AUTH_FORGOT_PASSWORD: "/api/auth/forgot-password",
  AUTH_RESET_PASSWORD_VALIDATE: "/api/auth/reset-password/validate",
  AUTH_RESET_PASSWORD: "/api/auth/reset-password",
  ANALYTICS_BATCH: "/internal/analytics/events/batch",
  ANALYTICS_SUMMARY: "/internal/analytics/summary",
  HISTORY_WORKSPACES: "/internal/history/workspaces",
  HISTORY_VIEWS: "/internal/history/views",
  HISTORY_VIEW_HISTORY: (viewSessionId: string) =>
    `/internal/history/views/${viewSessionId}/history`,
  HISTORY_VIEW_MESSAGE: (viewSessionId: string) =>
    `/internal/history/views/${viewSessionId}/message`,
  HISTORY_VIEWS_BY_WORKSPACE: (workspaceId: string, viewType?: string) =>
    `/internal/history/workspaces/${workspaceId}/views${viewType ? `?view_type=${viewType}` : ""}`,
  HISTORY_VIEW_ID: (viewSessionId: string) =>
    `/internal/history/views/${viewSessionId}`,
  HISTORY_CODEMEMORY: "/internal/history/codememory",
  HISTORY_CODEMEMORY_ID: (codeMemoryId: string) =>
    `/internal/history/codememory/${codeMemoryId}`,
  HISTORY_PROGRAMS: "/internal/history/programs",
  HISTORY_PROGRAMS_BY_WORKSPACE: (workspaceId: string) =>
    `/internal/history/workspaces/${workspaceId}/programs`,
  HISTORY_PROGRAM_ID: (programId: string) =>
    `/internal/history/programs/${programId}`,
  HISTORY_EDIT_PROPOSAL: "/internal/history/edit-proposal",
  HISTORY_THREADS: (codeMemoryId: string) =>
    `/internal/history/codememory/${codeMemoryId}/threads`,
  HISTORY_THREAD_HISTORY: (threadId: string) =>
    `/internal/history/threads/${threadId}/history`,
  HISTORY_THREAD_MESSAGE: (threadId: string) =>
    `/internal/history/threads/${threadId}/message`,
  HEALTH: "/health",
} as const;
