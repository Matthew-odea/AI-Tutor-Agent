/**
 * Error Tracking Service
 *
 * Provides centralized error tracking and reporting.
 * In production, this would integrate with services like Sentry, Rollbar, or LogRocket.
 * For now, we'll create a framework that can be extended with any service.
 *
 * @example
 * ```tsx
 * import { trackError, setUserContext } from './utils/errorTracking'
 *
 * try {
 *   // risky operation
 * } catch (error) {
 *   trackError(error, { context: 'API call failed' })
 * }
 * ```
 */

interface ErrorContext {
  /** Component or function where error occurred */
  component?: string;
  /** Additional context about the error */
  context?: string;
  /** User action that triggered the error */
  action?: string;
  /** Any additional metadata */
  metadata?: Record<string, unknown>;
}

interface UserContext {
  id?: string;
  sessionId?: string;
  /** Do not include PII like email or name */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for error tracking
 */
const config = {
  enabled: import.meta.env.PROD, // Only track in production
  dsn: import.meta.env.VITE_SENTRY_DSN, // Sentry DSN from env
  environment: import.meta.env.MODE,
  sampleRate: 1.0, // Track 100% of errors
};

/**
 * Initialize error tracking service
 * Call this once at app startup
 */
export const initErrorTracking = () => {
  if (!config.enabled) {
    console.log("[Error Tracking] Disabled in development");
    return;
  }

  // In a real implementation, initialize Sentry here:
  // Sentry.init({
  //   dsn: config.dsn,
  //   environment: config.environment,
  //   tracesSampleRate: config.sampleRate,
  //   integrations: [new BrowserTracing()],
  // })

  console.log("[Error Tracking] Initialized");
};

/**
 * Track an error with context
 *
 * @param error - The error object
 * @param context - Additional context about the error
 */
export const trackError = (error: Error | unknown, context?: ErrorContext) => {
  if (!config.enabled) {
    console.error("[Error Tracking]", error, context);
    return;
  }

  // In production, send to error tracking service
  // Sentry.captureException(error, {
  //   tags: {
  //     component: context?.component,
  //     action: context?.action,
  //   },
  //   extra: {
  //     context: context?.context,
  //     metadata: context?.metadata,
  //   },
  // })

  console.error("[Error Tracking] Would send to service:", error, context);
};

/**
 * Track a custom message (non-error)
 * Useful for logging important events or warnings
 *
 * @param message - The message to track
 * @param level - Severity level
 * @param context - Additional context
 */
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

  // Sentry.captureMessage(message, {
  //   level,
  //   tags: {
  //     component: context?.component,
  //   },
  //   extra: context?.metadata,
  // })

  const logFn =
    level === "warning"
      ? console.warn
      : level === "error"
        ? console.error
        : console.log;
  logFn("[Error Tracking] Would send message:", message, context);
};

/**
 * Set user context for error reports
 * Do NOT include PII (personally identifiable information)
 *
 * @param user - User context (no PII)
 */
export const setUserContext = (user: UserContext | null) => {
  if (!config.enabled) return;

  // Sentry.setUser(user ? {
  //   id: user.id,
  //   segment: user.metadata?.segment,
  // } : null)

  console.log("[Error Tracking] User context set:", user?.id);
};

/**
 * Add breadcrumb for debugging
 * Breadcrumbs show the trail of events leading to an error
 *
 * @param message - Breadcrumb message
 * @param category - Category of the event
 * @param level - Severity level
 */
export const addBreadcrumb = (
  message: string,
  category: string = "user-action",
  level: "info" | "warning" | "error" = "info",
) => {
  if (!config.enabled) return;

  // Sentry.addBreadcrumb({
  //   message,
  //   category,
  //   level,
  //   timestamp: Date.now() / 1000,
  // })

  if (config.enabled || level) {
    console.log("[Breadcrumb]", category, message);
  }
};

/**
 * Wrap async functions with error tracking
 *
 * @param fn - Function to wrap
 * @param context - Error context
 * @returns Wrapped function
 */
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
