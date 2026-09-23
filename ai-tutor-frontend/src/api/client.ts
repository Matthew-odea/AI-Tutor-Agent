/**
 * Axios API client with interceptors and error handling
 */
import axios from "axios";
import type { AxiosError, InternalAxiosRequestConfig } from "axios";
import { API_CONFIG } from "../config/api.config";
import { API_CONFIG as RETRY_CONFIG } from "../config/theme";
import { trackAPIError, trackAuthEvent } from "../utils/analytics";
import { trackAPITiming } from "../utils/performance";
import { trackError } from "../utils/errorTracking";
import { clearUserSession, getUserSession } from "../utils/userSession";

// Retry configuration
const { MAX_RETRIES, RETRY_DELAY, RETRY_STATUS_CODES } = RETRY_CONFIG;

type TimedRequestConfig = InternalAxiosRequestConfig & {
  startTime?: number;
  retryCount?: number;
};

export const apiClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  timeout: API_CONFIG.timeout,
  headers: API_CONFIG.headers,
});

// Helper function for exponential backoff delay
const getRetryDelay = (retryCount: number): number => {
  return RETRY_DELAY * Math.pow(2, retryCount);
};

// Helper function to check if request should be retried
const shouldRetry = (error: AxiosError, retryCount: number): boolean => {
  if (retryCount >= MAX_RETRIES) return false;

  // Retry on network errors
  if (!error.response) return true;

  // Retry on specific status codes
  if (
    error.response.status &&
    (RETRY_STATUS_CODES as readonly number[]).includes(error.response.status)
  ) {
    return true;
  }

  return false;
};

// Request interceptor
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Start timing the request
    const timedConfig = config as TimedRequestConfig;
    timedConfig.startTime = performance.now();

    const session = getUserSession();
    if (session?.access_token) {
      config.headers = {
        ...config.headers,
        Authorization: `Bearer ${session.access_token}`,
      } as unknown as import("axios").AxiosRequestHeaders;
    }

    // Log requests in development
    if (import.meta.env.DEV) {
      console.log(
        `[API Request] ${config.method?.toUpperCase()} ${config.url}`,
        config.data,
      );
    }
    return config;
  },
  (error) => {
    console.error("[API Request Error]", error);
    trackError(error, {
      component: "apiClient",
      context: "Request interceptor error",
    });
    return Promise.reject(error);
  },
);

// Response interceptor with retry logic
apiClient.interceptors.response.use(
  (response) => {
    // Track API timing
    const startTime = (response.config as TimedRequestConfig).startTime;
    if (startTime) {
      const duration = performance.now() - startTime;
      const endpoint = response.config.url || "unknown";
      trackAPITiming(endpoint, duration, response.status);
    }

    // Log responses in development
    if (import.meta.env.DEV) {
      console.log(`[API Response] ${response.config.url}`, response.data);
    }
    return response;
  },
  async (error: AxiosError) => {
    const config = error.config as TimedRequestConfig | undefined;

    // Track API errors
    if (error.response) {
      const endpoint = config?.url || "unknown";
      trackAPIError(endpoint, error.response.status);
      trackError(error, {
        component: "apiClient",
        context: `API error: ${endpoint}`,
        metadata: {
          status: error.response.status,
          statusText: error.response.statusText,
        },
      });

      if (error.response.status === 401) {
        trackAuthEvent("logout", undefined, "401");
        clearUserSession();
      }
    }

    // Initialize retry count if not present
    if (!config) {
      return Promise.reject(error);
    }

    config.retryCount = config.retryCount || 0;

    // Check if we should retry
    if (shouldRetry(error, config.retryCount)) {
      config.retryCount += 1;
      const delay = getRetryDelay(config.retryCount - 1);

      if (import.meta.env.DEV) {
        console.warn(
          `[API Retry] Attempt ${config.retryCount}/${MAX_RETRIES} after ${delay}ms for ${config.url}`,
        );
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Retry the request
      return apiClient.request(config);
    }

    // Handle different error types
    if (error.response) {
      // Server responded with error status
      console.error("[API Error Response]", {
        status: error.response.status,
        data: error.response.data,
        url: error.config?.url,
      });
    } else if (error.request) {
      // Request made but no response received
      console.error("[API No Response]", {
        url: error.config?.url,
        message: "No response from server. Check if backend is running.",
      });
    } else {
      // Error in request setup
      console.error("[API Request Setup Error]", error.message);
    }

    return Promise.reject(error);
  },
);

export default apiClient;
