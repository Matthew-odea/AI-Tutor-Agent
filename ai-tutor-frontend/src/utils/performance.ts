/**
 * Performance Monitoring Utility
 *
 * Tracks Core Web Vitals and other performance metrics using the web-vitals library.
 * Sends metrics to analytics or monitoring services.
 *
 * Core Web Vitals tracked:
 * - LCP (Largest Contentful Paint): Loading performance
 * - FID (First Input Delay): Interactivity
 * - CLS (Cumulative Layout Shift): Visual stability
 * - FCP (First Contentful Paint): Initial render
 * - TTFB (Time to First Byte): Server response time
 *
 * @see https://web.dev/vitals/
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

/**
 * Send metric to analytics/monitoring service
 *
 * @param metric - Web Vitals metric
 */
const sendMetric = (metric: Metric) => {
  if (config.debug) {
    console.log("[Performance]", metric.name, metric.value, metric.rating);
  }

  if (!config.enabled) return;

  // Send to analytics service
  // Example with Google Analytics:
  // gtag('event', metric.name, {
  //   value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
  //   metric_id: metric.id,
  //   metric_value: metric.value,
  //   metric_delta: metric.delta,
  //   metric_rating: metric.rating,
  // })

  // Or send to custom endpoint:
  // if (config.reportEndpoint) {
  //   fetch(config.reportEndpoint, {
  //     method: 'POST',
  //     body: JSON.stringify({
  //       name: metric.name,
  //       value: metric.value,
  //       rating: metric.rating,
  //       id: metric.id,
  //       delta: metric.delta,
  //       timestamp: Date.now(),
  //     }),
  //     headers: { 'Content-Type': 'application/json' },
  //     keepalive: true,
  //   })
  // }
};

/**
 * Initialize performance monitoring
 * Starts tracking Core Web Vitals
 */
export const initPerformanceTracking = () => {
  if (!config.enabled && !config.debug) {
    console.log("[Performance] Monitoring disabled");
    return;
  }

  // Track all Core Web Vitals
  onLCP(sendMetric); // Largest Contentful Paint
  onINP(sendMetric); // Interaction to Next Paint (replaces FID)
  onCLS(sendMetric); // Cumulative Layout Shift
  onFCP(sendMetric); // First Contentful Paint
  onTTFB(sendMetric); // Time to First Byte

  console.log("[Performance] Monitoring initialized");
};

/**
 * Measure and report custom timing
 *
 * @param name - Name of the metric
 * @param value - Time in milliseconds
 */
export const reportCustomMetric = (name: string, value: number) => {
  if (config.debug) {
    console.log("[Performance]", name, value);
  }

  if (!config.enabled) return;

  // gtag('event', 'timing_complete', {
  //   name,
  //   value: Math.round(value),
  // })
};

/**
 * Performance mark for measuring code execution
 *
 * @param name - Name of the mark
 */
export const mark = (name: string) => {
  if ("performance" in window && performance.mark) {
    performance.mark(name);
  }
};

/**
 * Measure time between two marks
 *
 * @param name - Name of the measurement
 * @param startMark - Start mark name
 * @param endMark - End mark name (optional, uses now if not provided)
 */
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

/**
 * Track API request timing
 *
 * @param endpoint - API endpoint
 * @param duration - Request duration in ms
 * @param status - HTTP status code
 */
export const trackAPITiming = (
  endpoint: string,
  duration: number,
  status: number,
) => {
  if (config.debug) {
    console.log("[Performance] API timing:", endpoint, duration, status);
  }

  if (!config.enabled) return;

  // gtag('event', 'api_timing', {
  //   endpoint,
  //   duration: Math.round(duration),
  //   status,
  // })
};

/**
 * Track route change performance
 *
 * @param route - Route path
 * @param duration - Time to render in ms
 */
export const trackRouteChange = (route: string, duration: number) => {
  if (config.debug) {
    console.log("[Performance] Route change:", route, duration);
  }

  if (!config.enabled) return;

  // gtag('event', 'route_change', {
  //   route,
  //   duration: Math.round(duration),
  // })
};

/**
 * Create a timer for measuring operations
 *
 * @param name - Name of the operation
 * @returns Object with stop function
 *
 * @example
 * ```tsx
 * const timer = createTimer('data_processing')
 * // ... do work
 * timer.stop()
 * ```
 */
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
