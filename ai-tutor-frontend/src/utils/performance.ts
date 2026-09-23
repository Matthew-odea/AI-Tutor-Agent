/**
 * Core Web Vitals (LCP, INP, CLS, FCP, TTFB) and custom timings via web-vitals.
 * No reporting backend is wired up: metrics are only console-logged in dev.
 */

import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from "web-vitals";

interface PerformanceConfig {
  enabled: boolean;
  debug: boolean;
  reportEndpoint?: string;
}

const config: PerformanceConfig = {
  enabled: import.meta.env.PROD,
  debug: import.meta.env.DEV,
  reportEndpoint: import.meta.env.VITE_PERFORMANCE_ENDPOINT,
};

const sendMetric = (metric: Metric) => {
  if (config.debug) {
    console.log("[Performance]", metric.name, metric.value, metric.rating);
  }

  if (!config.enabled) return;
};

export const initPerformanceTracking = () => {
  if (!config.enabled && !config.debug) {
    console.log("[Performance] Monitoring disabled");
    return;
  }

  onLCP(sendMetric);
  onINP(sendMetric);
  onCLS(sendMetric);
  onFCP(sendMetric);
  onTTFB(sendMetric);

  console.log("[Performance] Monitoring initialized");
};

/** @param value - milliseconds */
export const reportCustomMetric = (name: string, value: number) => {
  if (config.debug) {
    console.log("[Performance]", name, value);
  }

  if (!config.enabled) return;
};

export const mark = (name: string) => {
  if ("performance" in window && performance.mark) {
    performance.mark(name);
  }
};

/** Returns the duration in ms; endMark defaults to now. Returns undefined if marks are missing. */
export const measure = (name: string, startMark: string, endMark?: string) => {
  if ("performance" in window && performance.measure) {
    try {
      const measure = performance.measure(name, startMark, endMark);
      reportCustomMetric(name, measure.duration);
      return measure.duration;
    } catch (error) {
      console.warn("[Performance] Failed to measure:", error);
    }
  }
};

export const trackAPITiming = (
  endpoint: string,
  duration: number,
  status: number,
) => {
  if (config.debug) {
    console.log("[Performance] API timing:", endpoint, duration, status);
  }

  if (!config.enabled) return;
};

export const trackRouteChange = (route: string, duration: number) => {
  if (config.debug) {
    console.log("[Performance] Route change:", route, duration);
  }

  if (!config.enabled) return;
};

export const createTimer = (name: string) => {
  const startTime = performance.now();
  const markName = `${name}_start`;
  mark(markName);

  return {
    stop: () => {
      const endTime = performance.now();
      const duration = endTime - startTime;
      reportCustomMetric(name, duration);
      return duration;
    },
  };
};
