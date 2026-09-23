import { STORAGE_KEYS } from "../config/constants";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_SESSION_CHANGED_EVENT = "ai-tutor:auth-session-changed";

export type UserSession = {
  user_id: string;
  email: string;
  access_token: string;
  expires_at: number;
};

const notifyAuthSessionChanged = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_SESSION_CHANGED_EVENT));
};

const normalizeEmail = (email: string) => email.trim().toLowerCase();

type JwtPayload = {
  sub?: string;
  user_id?: string;
  email?: string;
  exp?: number;
};

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(`${normalized}${padding}`);
};

const parseJwtPayload = (token: string): JwtPayload => {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid token format");
  }

  try {
    const decoded = decodeBase64Url(parts[1]);
    const payload = JSON.parse(decoded) as JwtPayload;
    return payload;
  } catch {
    throw new Error("Unable to parse token");
  }
};

const sha256Hex = async (value: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const toUuid = (hex: string) => {
  const clean = hex
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 32)
    .padEnd(32, "0");
  const part1 = clean.slice(0, 8);
  const part2 = clean.slice(8, 12);
  const part3 = `4${clean.slice(13, 16)}`;
  const variantNibble = (
    (parseInt(clean.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  const part4 = `${variantNibble}${clean.slice(17, 20)}`;
  const part5 = clean.slice(20, 32);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
};

export const generateUserIdFromEmail = async (email: string) => {
  const normalized = normalizeEmail(email);
  const hash = await sha256Hex(normalized);
  return toUuid(hash);
};

export const getUserSession = (): UserSession | null => {
  const raw = localStorage.getItem(STORAGE_KEYS.USER_SESSION);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UserSession;
    if (
      !parsed?.user_id ||
      !parsed?.email ||
      !parsed?.access_token ||
      !parsed?.expires_at
    )
      return null;
    if (Date.now() > parsed.expires_at) {
      localStorage.removeItem(STORAGE_KEYS.USER_SESSION);
      notifyAuthSessionChanged();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const setUserSession = async (email: string): Promise<UserSession> => {
  const fallbackUserId = await generateUserIdFromEmail(email);
  const staticToken = (
    import.meta.env.VITE_AUTH_STATIC_TOKEN as string | undefined
  )?.trim();
  const token = staticToken || "";

  if (!token) {
    throw new Error("Token is required");
  }

  const payload = parseJwtPayload(token);
  const user_id = String(
    payload.sub || payload.user_id || fallbackUserId,
  ).trim();
  if (!user_id) {
    throw new Error("Token missing subject");
  }

  const tokenEmail =
    typeof payload.email === "string" && payload.email.trim()
      ? normalizeEmail(payload.email)
      : normalizeEmail(email);
  const expiresAtFromToken =
    typeof payload.exp === "number" ? payload.exp * 1000 : null;

  const session: UserSession = {
    user_id,
    email: tokenEmail,
    access_token: token,
    expires_at: expiresAtFromToken ?? Date.now() + WEEK_MS,
  };
  localStorage.setItem(STORAGE_KEYS.USER_SESSION, JSON.stringify(session));
  notifyAuthSessionChanged();
  return session;
};

export const setUserSessionWithToken = (
  token: string,
  email?: string,
): UserSession => {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error("Token is required");
  }

  const payload = parseJwtPayload(trimmedToken);
  const userId = String(payload.sub || payload.user_id || "").trim();
  if (!userId) {
    throw new Error("Token missing subject");
  }

  const resolvedEmail =
    typeof payload.email === "string" && payload.email.trim()
      ? normalizeEmail(payload.email)
      : normalizeEmail(email || `${userId}@local`);

  const expiresAtFromToken =
    typeof payload.exp === "number" ? payload.exp * 1000 : null;

  const session: UserSession = {
    user_id: userId,
    email: resolvedEmail,
    access_token: trimmedToken,
    expires_at: expiresAtFromToken ?? Date.now() + WEEK_MS,
  };

  localStorage.setItem(STORAGE_KEYS.USER_SESSION, JSON.stringify(session));
  notifyAuthSessionChanged();
  return session;
};

export const clearUserSession = () => {
  localStorage.removeItem(STORAGE_KEYS.USER_SESSION);
  notifyAuthSessionChanged();
};
