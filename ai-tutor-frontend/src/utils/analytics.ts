/**
 * Batched analytics events posted to the backend. Never send message bodies or email addresses.
 * Disabled when Do Not Track is set.
 */

import { API_CONFIG, API_ENDPOINTS } from "../config/api.config";
import { STORAGE_KEYS } from "../config/constants";
import { getUserSession } from "./userSession";

interface EventProperties {
  [key: string]: string | number | boolean | undefined;
}

type QueuedEvent = {
  event_name: string;
  occurred_at: string;
  session_id?: string;
  app_mode?: string;
  properties: EventProperties;
};

interface PageViewProperties {
  path: string;
  title?: string;
  referrer?: string;
}

const config = {
  enabled:
    (import.meta.env.VITE_ANALYTICS_ENABLED
      ? String(import.meta.env.VITE_ANALYTICS_ENABLED).toLowerCase() === "true"
      : import.meta.env.PROD) && !navigator.doNotTrack,
  debug: import.meta.env.DEV,
  batchSize: Number(import.meta.env.VITE_ANALYTICS_BATCH_SIZE || 20),
  flushIntervalMs: Number(import.meta.env.VITE_ANALYTICS_FLUSH_MS || 10000),
};

const queue: QueuedEvent[] = [];
let flushTimer: number | null = null;

const getAnonymousSessionId = () => {
  const existing = localStorage.getItem(STORAGE_KEYS.SESSION_ID);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEYS.SESSION_ID, generated);
  return generated;
};

const getAuthHeaders = (): Record<string, string> => {
  const session = getUserSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  return headers;
};

const flushQueue = async (useBeacon = false) => {
  if (!config.enabled || queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  const payload = JSON.stringify({
    sent_at: new Date().toISOString(),
    events,
  });

  // sendBeacon survives page unload but cannot carry the Authorization header.
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    const ok = navigator.sendBeacon(
      `${API_CONFIG.baseURL}${API_ENDPOINTS.ANALYTICS_BATCH}`,
      blob,
    );
    if (!ok) {
      queue.unshift(...events);
    }
    return;
  }

  try {
    const response = await fetch(
      `${API_CONFIG.baseURL}${API_ENDPOINTS.ANALYTICS_BATCH}`,
      {
        method: "POST",
        headers: getAuthHeaders(),
        body: payload,
        keepalive: true,
      },
    );
    if (!response.ok) {
      queue.unshift(...events);
    }
  } catch {
    queue.unshift(...events);
  }
};

const scheduleFlush = () => {
  if (!config.enabled) return;
  if (queue.length >= config.batchSize) {
    void flushQueue();
    return;
  }
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, config.flushIntervalMs);
};

export const initAnalytics = () => {
  if (!config.enabled) {
    console.log("[Analytics] Disabled (dev mode or DNT enabled)");
    return;
  }

  const handleVisibilityOrUnload = () => {
    void flushQueue(true);
  };

  window.addEventListener("beforeunload", handleVisibilityOrUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushQueue(true);
    }
  });

  console.log("[Analytics] Initialized");
};

export const trackEvent = (eventName: string, properties?: EventProperties) => {
  if (config.debug) {
    console.log("[Analytics] Event:", eventName, properties);
  }

  if (!config.enabled) return;

  const appMode = localStorage.getItem(STORAGE_KEYS.APP_MODE) || undefined;
  const sessionId = getAnonymousSessionId();
  queue.push({
    event_name: eventName,
    occurred_at: new Date().toISOString(),
    session_id: sessionId,
    app_mode: appMode,
    properties: properties || {},
  });
  scheduleFlush();
};

export const trackPageView = (properties: PageViewProperties) => {
  if (config.debug) {
    console.log("[Analytics] Page view:", properties);
  }

  trackEvent("page_view", {
    path: properties.path,
    title: properties.title,
    referrer: properties.referrer,
  });
};

/** Must not contain PII. */
export const setUserProperties = (properties: EventProperties) => {
  if (config.debug) {
    console.log("[Analytics] User properties:", properties);
  }

  trackEvent("user_properties_updated", properties);
};

export const trackMessageSent = (
  experienceMode: string,
  messageLength: number,
  hasEditorContext = false,
) => {
  const lengthBucket =
    messageLength < 40
      ? "short"
      : messageLength < 200
        ? "medium"
        : messageLength < 600
          ? "long"
          : "very_long";
  trackEvent("message_sent", {
    experience_mode: experienceMode,
    message_length_bucket: lengthBucket,
    has_editor_context: hasEditorContext,
  });
};

export const trackCodeExecuted = (
  hasError: boolean,
  executionTimeMs?: number,
  errorType?: string,
) => {
  trackEvent("code_executed", {
    has_error: hasError,
    execution_time_ms: executionTimeMs
      ? Math.round(executionTimeMs)
      : undefined,
    error_type: errorType,
  });
};

export const trackSessionCreated = () => {
  trackEvent("session_created");
};

export const trackSessionResumed = () => {
  trackEvent("session_resumed");
};

export const trackModeChanged = (fromMode: string, toMode: string) => {
  trackEvent("mode_changed", {
    from_mode: fromMode,
    to_mode: toMode,
  });
};

export const trackAuthEvent = (
  action: "login_success" | "login_failed" | "logout",
  provider?: "password" | "google",
  reason?: string,
) => {
  trackEvent("auth_event", {
    action,
    provider,
    reason,
  });
};

export const trackChatResponse = (
  latencyMs: number,
  isError: boolean,
  tokensOutput?: number,
) => {
  const tokenBucket = !tokensOutput
    ? "none"
    : tokensOutput < 100
      ? "low"
      : tokensOutput < 400
        ? "medium"
        : "high";
  trackEvent("chat_response_received", {
    latency_ms: Math.round(latencyMs),
    is_error: isError,
    token_bucket: tokenBucket,
  });
};

export const trackUIEvent = (
  action: string,
  value?: string | boolean | number,
) => {
  trackEvent("ui_event", {
    action,
    value,
  });
};

export const trackCodeEditorToggled = (isOpen: boolean) => {
  trackEvent("code_editor_toggled", {
    is_open: isOpen,
  });
};

export const trackFileUploaded = (fileType: string, fileSize: number) => {
  trackEvent("file_uploaded", {
    file_type: fileType,
    file_size_kb: Math.round(fileSize / 1024),
  });
};

export const trackAPIError = (endpoint: string, statusCode: number) => {
  trackEvent("api_error", {
    endpoint,
    status_code: statusCode,
  });
};

export const trackNetworkStatus = (isOnline: boolean) => {
  trackEvent("network_status_changed", {
    is_online: isOnline,
  });
};
