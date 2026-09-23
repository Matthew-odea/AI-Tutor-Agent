/** Design tokens and shared app config. Colours live in tailwind.config.js. */

export const BREAKPOINTS = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

// Milliseconds
export const TIMEOUTS = {
  API_REQUEST: 30000,
  TOAST_DEFAULT: 3000,
  TOAST_ERROR: 5000,
  TOAST_PERSISTENT: 0, // 0 = never auto-dismiss
  DEBOUNCE_INPUT: 300,
  ANIMATION_SHORT: 150,
  ANIMATION_MEDIUM: 300,
  ANIMATION_LONG: 500,
} as const;

export const Z_INDEX = {
  dropdown: 10,
  sticky: 20,
  modal: 30,
  overlay: 40,
  toast: 50,
  tooltip: 60,
} as const;

export const EASINGS = {
  easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeOut: "cubic-bezier(0.0, 0, 0.2, 1)",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
  sharp: "cubic-bezier(0.4, 0, 0.6, 1)",
} as const;

export const RADIUS = {
  none: "0",
  sm: "0.125rem",
  md: "0.375rem",
  lg: "0.5rem",
  xl: "0.75rem",
  "2xl": "1rem",
  full: "9999px",
} as const;

// Spacing (matches Tailwind defaults)
export const SPACING = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  10: "2.5rem",
  12: "3rem",
  16: "4rem",
  20: "5rem",
  24: "6rem",
} as const;

export const SHADOWS = {
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
} as const;

export const FONT_SIZE = {
  xs: ["0.75rem", { lineHeight: "1rem" }],
  sm: ["0.875rem", { lineHeight: "1.25rem" }],
  base: ["1rem", { lineHeight: "1.5rem" }],
  lg: ["1.125rem", { lineHeight: "1.75rem" }],
  xl: ["1.25rem", { lineHeight: "1.75rem" }],
  "2xl": ["1.5rem", { lineHeight: "2rem" }],
  "3xl": ["1.875rem", { lineHeight: "2.25rem" }],
  "4xl": ["2.25rem", { lineHeight: "2.5rem" }],
} as const;

export const FONT_WEIGHT = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const API_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // ms, doubled per retry
  RETRY_STATUS_CODES: [408, 429, 500, 502, 503, 504],
} as const;

export const SESSION_CONFIG = {
  MAX_TITLE_LENGTH: 50,
  MAX_MESSAGE_PREVIEW: 100,
  DEFAULT_TITLE: "New Chat",
} as const;

export const CODE_EDITOR_CONFIG = {
  DEFAULT_LANGUAGE: "python",
  TAB_SIZE: 4,
  MINIMAP_ENABLED: false,
  LINE_NUMBERS: "on" as const,
  WORD_WRAP: "on" as const,
  FONT_FAMILY: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
  FONT_SIZE: 14,
} as const;

export const MESSAGE_CONFIG = {
  MAX_LENGTH: 2000,
  MIN_LENGTH: 1,
} as const;
