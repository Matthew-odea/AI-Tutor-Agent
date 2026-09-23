/** Error-tracking facade. No vendor (e.g. Sentry) is wired up yet, so everything goes to the console. */

interface ErrorContext {
  component?: string;
  context?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

interface UserContext {
  id?: string;
  sessionId?: string;
  /** Do not include PII like email or name */
  metadata?: Record<string, unknown>;
}

const config = {
  enabled: import.meta.env.PROD,
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  sampleRate: 1.0,
};

export const initErrorTracking = () => {
  if (!config.enabled) {
    console.log("[Error Tracking] Disabled in development");
    return;
  }

  console.log("[Error Tracking] Initialized");
};

export const trackError = (error: Error | unknown, context?: ErrorContext) => {
  if (!config.enabled) {
    console.error("[Error Tracking]", error, context);
    return;
  }

  console.error("[Error Tracking] Would send to service:", error, context);
};

export const trackMessage = (
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: ErrorContext,
) => {
  if (!config.enabled) {
    const logFn =
      level === "warning"
        ? console.warn
        : level === "error"
          ? console.error
          : console.log;
    logFn(`[Error Tracking] ${message}`, context);
    return;
  }

  const logFn =
    level === "warning"
      ? console.warn
      : level === "error"
        ? console.error
        : console.log;
  logFn("[Error Tracking] Would send message:", message, context);
};

/** Never pass PII here. */
export const setUserContext = (user: UserContext | null) => {
  if (!config.enabled) return;

  console.log("[Error Tracking] User context set:", user?.id);
};

export const addBreadcrumb = (
  message: string,
  category: string = "user-action",
  level: "info" | "warning" | "error" = "info",
) => {
  if (!config.enabled) return;

  if (config.enabled || level) {
    console.log("[Breadcrumb]", category, message);
  }
};

export const withErrorTracking = <
  T extends (...args: unknown[]) => Promise<unknown>,
>(
  fn: T,
  context?: ErrorContext,
): T => {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      trackError(error, context);
      throw error;
    }
  }) as T;
};
