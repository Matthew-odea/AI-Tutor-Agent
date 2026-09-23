/**
 * Shared axios instance: attaches the JWT, clears the session on 401, and retries network errors
 * and RETRY_STATUS_CODES with exponential backoff. Retries apply to every method, including POST.
 */
import axios from "axios";
import type { AxiosError, InternalAxiosRequestConfig } from "axios";
import { API_CONFIG } from "../config/api.config";
import { API_CONFIG as RETRY_CONFIG } from "../config/theme";
import { trackAPIError, trackAuthEvent } from "../utils/analytics";
import { trackAPITiming } from "../utils/performance";
import { trackError } from "../utils/errorTracking";
import { clearUserSession, getUserSession } from "../utils/userSession";

// Retry settings live in config/theme, not config/api.config.
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

const getRetryDelay = (retryCount: number): number => {
  return RETRY_DELAY * Math.pow(2, retryCount);
};

const shouldRetry = (error: AxiosError, retryCount: number): boolean => {
  if (retryCount >= MAX_RETRIES) return false;

  if (!error.response) return true;

  if (
    error.response.status &&
    (RETRY_STATUS_CODES as readonly number[]).includes(error.response.status)
  ) {
    return true;
  }

  return false;
};

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const timedConfig = config as TimedRequestConfig;
    timedConfig.startTime = performance.now();

    const session = getUserSession();
    if (session?.access_token) {
      config.headers = {
        ...config.headers,
        Authorization: `Bearer ${session.access_token}`,
      } as unknown as import("axios").AxiosRequestHeaders;
    }

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

apiClient.interceptors.response.use(
  (response) => {
    const startTime = (response.config as TimedRequestConfig).startTime;
    if (startTime) {
      const duration = performance.now() - startTime;
      const endpoint = response.config.url || "unknown";
      trackAPITiming(endpoint, duration, response.status);
    }

    if (import.meta.env.DEV) {
      console.log(`[API Response] ${response.config.url}`, response.data);
    }
    return response;
  },
  async (error: AxiosError) => {
    const config = error.config as TimedRequestConfig | undefined;

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

    if (!config) {
      return Promise.reject(error);
    }

    config.retryCount = config.retryCount || 0;

    if (shouldRetry(error, config.retryCount)) {
      config.retryCount += 1;
      const delay = getRetryDelay(config.retryCount - 1);

      if (import.meta.env.DEV) {
        console.warn(
          `[API Retry] Attempt ${config.retryCount}/${MAX_RETRIES} after ${delay}ms for ${config.url}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delay));

      return apiClient.request(config);
    }

    if (error.response) {
      console.error("[API Error Response]", {
        status: error.response.status,
        data: error.response.data,
        url: error.config?.url,
      });
    } else if (error.request) {
      console.error("[API No Response]", {
        url: error.config?.url,
        message: "No response from server. Check if backend is running.",
      });
    } else {
      console.error("[API Request Setup Error]", error.message);
    }

    return Promise.reject(error);
  },
);

export default apiClient;
