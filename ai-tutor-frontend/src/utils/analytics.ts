/**
 * Analytics Service
 *
 * Privacy principles:
 * - No message body content
 * - No email addresses
 * - Respect Do Not Track settings
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
  /** Page path */
  path: string;
  /** Page title */
  title?: string;
  /** Referrer */
  referrer?: string;
}

/**
 * Analytics configuration
 */
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

/**
 * Initialize analytics tracking
 * Call this once at app startup
 */
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

/**
 * Track a custom event
 *
 * @param eventName - Name of the event
 * @param properties - Event properties
 */
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

/**
 * Track a page view
 *
 * @param properties - Page view properties
 */
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

/**
 * Set user properties (no PII)
 *
 * @param properties - User properties
 */
export const setUserProperties = (properties: EventProperties) => {
  if (config.debug) {
    console.log("[Analytics] User properties:", properties);
  }

  trackEvent("user_properties_updated", properties);
};

// Predefined event tracking functions for common actions

/**
 * Track when a message is sent
 */
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

/**
 * Track when code is executed
 */
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

/**
 * Track when a new session is created
 */
export const trackSessionCreated = () => {
  trackEvent("session_created");
};

export const trackSessionResumed = () => {
  trackEvent("session_resumed");
};

/**
 * Track when pedagogy mode is changed
 */
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

/**
 * Track when code editor is toggled
 */
export const trackCodeEditorToggled = (isOpen: boolean) => {
  trackEvent("code_editor_toggled", {
    is_open: isOpen,
  });
};

/**
 * Track when a file is uploaded
 */
export const trackFileUploaded = (fileType: string, fileSize: number) => {
  trackEvent("file_uploaded", {
    file_type: fileType,
    file_size_kb: Math.round(fileSize / 1024),
  });
};

/**
 * Track API errors
 */
export const trackAPIError = (endpoint: string, statusCode: number) => {
  trackEvent("api_error", {
    endpoint,
    status_code: statusCode,
  });
};

/**
 * Track when user goes offline/online
 */
export const trackNetworkStatus = (isOnline: boolean) => {
  trackEvent("network_status_changed", {
    is_online: isOnline,
  });
};
