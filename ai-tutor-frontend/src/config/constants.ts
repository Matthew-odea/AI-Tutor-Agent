export const APP_NAME = import.meta.env.VITE_APP_NAME || "AI Tutor";
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || "1.0.0";

export const DEFAULT_TOP_K = 5;

export const STORAGE_KEYS = {
  SESSION_ID: "ai-tutor-session-id",
  WORKSPACE_ID: "ai-tutor-workspace-id",
  APP_MODE: "ai-tutor-app-mode",
  LAST_AUTH_USER_ID: "ai-tutor-last-auth-user-id",
  THEME: "ai-tutor-theme",
  ASSISTANT_THREAD_MAP: "ai-tutor-assistant-thread-map",
  USER_SESSION: "ai-tutor-user-session",
} as const;

export const API_TIMEOUT = Number(import.meta.env.VITE_API_TIMEOUT) || 30000; // ms
