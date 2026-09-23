import { useEffect, useState } from "react";
import "./App.css";
import { ChatContainer, ModeSelector } from "./features/chat";
import { Sidebar } from "./features/sidebar";
import { ToastContainer } from "./shared/ToastContainer";
import { KeyboardShortcutsModal } from "./shared/KeyboardShortcutsModal";
import { IdeWorkspace } from "./features/code-editor";
import SEO from "./shared/SEO";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useToastStore } from "./store/toastStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useChatStore } from "./store/chatStore";
import {
  webApplicationSchema,
  organizationSchema,
  injectStructuredData,
} from "./utils/structuredData";
import { LoginGate } from "./shared/LoginGate";
import {
  AUTH_SESSION_CHANGED_EVENT,
  getUserSession,
  setUserSessionWithToken,
  type UserSession,
} from "./utils/userSession";
import { STORAGE_KEYS } from "./config/constants";
import { trackAuthEvent, trackSessionResumed } from "./utils/analytics";
import {
  loginWithEmailPassword,
  loginWithGoogleIdToken,
  requestPasswordReset,
  resetPassword,
  signupWithEmailPassword,
  validatePasswordResetToken,
} from "./api/auth";

type ApiErrorPayload = {
  detail?: unknown;
  message?: unknown;
  code?: unknown;
};

const normalizeAuthError = (error: unknown, fallback: string) => {
  const payload =
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: ApiErrorPayload } }).response
      ?.data === "object"
      ? (error as { response?: { data?: ApiErrorPayload } }).response?.data
      : undefined;

  const status =
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { status?: number } }).response?.status ===
      "number"
      ? (error as { response?: { status?: number } }).response?.status
      : undefined;

  const code =
    typeof payload?.code === "string" ? payload.code.toLowerCase() : "";

  let message = "";
  if (typeof payload?.detail === "string" && payload.detail.trim()) {
    message = payload.detail.trim();
  } else if (Array.isArray(payload?.detail)) {
    const firstIssue = payload.detail.find(
      (item) => item && typeof item === "object",
    ) as { msg?: string } | undefined;
    if (firstIssue?.msg) {
      message = firstIssue.msg;
    }
  } else if (payload?.detail && typeof payload.detail === "object") {
    const detailObj = payload.detail as { message?: string; error?: string };
    message = detailObj.message || detailObj.error || "";
  }

  if (
    !message &&
    typeof payload?.message === "string" &&
    payload.message.trim()
  ) {
    message = payload.message.trim();
  }

  if (
    status === 409 ||
    code.includes("exists") ||
    /already exists?/i.test(message)
  ) {
    return new Error(
      "An account with this email already exists. Try logging in instead.",
    );
  }

  if (status === 401 && /invalid email or password/i.test(message)) {
    return new Error("Incorrect email or password. Please try again.");
  }

  if (status === 401 && /invalid google id token/i.test(message)) {
    return new Error(
      "Google sign-in token was invalid or expired. Please try again.",
    );
  }

  if (status === 503 && /not configured|unavailable/i.test(message)) {
    return new Error(
      "This authentication feature is temporarily unavailable. Please try again later.",
    );
  }

  if (
    status === 400 &&
    /password must be at least 8 characters/i.test(message)
  ) {
    return new Error("Password must be at least 8 characters long.");
  }

  if (message) {
    return new Error(message);
  }

  return new Error(fallback);
};

function App() {
  const isOnline = useOnlineStatus();
  const { addToast } = useToastStore();
  const {
    setEditorOpen,
    setLayoutMode,
    codeEditor,
    appMode,
    setWorkspaceId,
    clearSession,
    setSessions,
    setAppMode,
  } = useChatStore();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [userSession, setUserSessionState] = useState<UserSession | null>(() =>
    getUserSession(),
  );
  const [isReady] = useState(true);

  const handleAuthSuccess = (accessToken: string, email: string) => {
    const session = setUserSessionWithToken(accessToken, email);
    const previousUserId = localStorage.getItem(STORAGE_KEYS.LAST_AUTH_USER_ID);

    if (previousUserId && previousUserId !== session.user_id) {
      clearSession();
      setWorkspaceId(null);
      setSessions([]);
      setAppMode(null);
    }

    localStorage.setItem(STORAGE_KEYS.LAST_AUTH_USER_ID, session.user_id);
    setUserSessionState(session);
  };

  useEffect(() => {
    const initialSession = getUserSession();
    if (initialSession) {
      trackSessionResumed();
    }

    const syncSession = () => {
      setUserSessionState(getUserSession());
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, syncSession);
    window.addEventListener("storage", syncSession);
    window.addEventListener("focus", syncSession);

    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, syncSession);
      window.removeEventListener("storage", syncSession);
      window.removeEventListener("focus", syncSession);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      addToast(
        "You are currently offline. Some features may not work.",
        "warning",
        0,
      );
    } else {
      addToast("Connection restored", "success", 3000);
    }
  }, [isOnline, addToast]);

  useEffect(() => {
    const cleanupApp = injectStructuredData(webApplicationSchema);
    const cleanupOrg = injectStructuredData(organizationSchema);

    return () => {
      cleanupApp();
      cleanupOrg();
    };
  }, []);

  useKeyboardShortcuts([
    {
      key: "/",
      ctrl: true,
      action: () => setShowShortcuts(true),
      description: "Show keyboard shortcuts",
    },
    {
      key: "e",
      ctrl: true,
      action: () => setEditorOpen(!codeEditor.isOpen),
      description: "Toggle code editor",
    },
    {
      key: "Escape",
      action: () => setShowShortcuts(false),
      description: "Close modal",
    },
  ]);

  useEffect(() => {
    if (appMode === "chat") {
      setEditorOpen(false);
      setLayoutMode("stacked");
    }

    if (appMode === "ide") {
      setLayoutMode("split");
    }
  }, [appMode, setEditorOpen, setLayoutMode]);

  if (!isReady) {
    return null;
  }

  if (!userSession) {
    return (
      <LoginGate
        onLogin={async (email, password) => {
          try {
            const loginResult = await loginWithEmailPassword(email, password);
            handleAuthSuccess(
              loginResult.access_token,
              loginResult.email || email,
            );
            trackAuthEvent("login_success", "password");
          } catch (error: unknown) {
            trackAuthEvent("login_failed", "password");
            throw normalizeAuthError(
              error,
              "Unable to sign in. Please check your email and password.",
            );
          }
        }}
        onSignup={async (email, password) => {
          try {
            const signupResult = await signupWithEmailPassword(email, password);
            handleAuthSuccess(
              signupResult.access_token,
              signupResult.email || email,
            );
            trackAuthEvent("login_success", "password");
          } catch (error: unknown) {
            trackAuthEvent("login_failed", "password");
            throw normalizeAuthError(
              error,
              "Unable to create your account. Please try again.",
            );
          }
        }}
        onGoogleLogin={async (idToken) => {
          try {
            const googleResult = await loginWithGoogleIdToken(idToken);
            handleAuthSuccess(googleResult.access_token, googleResult.email);
            trackAuthEvent("login_success", "google");
          } catch (error: unknown) {
            trackAuthEvent("login_failed", "google");
            throw normalizeAuthError(
              error,
              "Unable to sign in with Google. Please try again.",
            );
          }
        }}
        onForgotPassword={async (email) => {
          try {
            const response = await requestPasswordReset(email);
            return response.message;
          } catch (error: unknown) {
            throw normalizeAuthError(
              error,
              "Unable to request a password reset right now. Please try again.",
            );
          }
        }}
        onValidateResetToken={async (token) => {
          try {
            return await validatePasswordResetToken(token);
          } catch {
            return false;
          }
        }}
        onResetPassword={async (token, newPassword) => {
          try {
            const response = await resetPassword(token, newPassword);
            return response.message;
          } catch (error: unknown) {
            throw normalizeAuthError(
              error,
              "Unable to reset password. Please request a new reset link.",
            );
          }
        }}
      />
    );
  }

  return (
    <>
      <SEO
        title="Chat Interface"
        description="Interactive AI tutoring chat interface with code editor. Get help with programming, debug code, and learn through conversation."
        keywords="AI tutor, programming chat, code editor, Python learning, interactive coding"
      />

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary-600 focus:text-white focus:rounded-lg focus:shadow-lg"
      >
        Skip to main content
      </a>

      <div
        className="app-container h-screen flex bg-white"
        role="application"
        aria-label="AI Tutor Chat Application"
      >
        <ToastContainer />

        {showShortcuts && (
          <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />
        )}

        <Sidebar />

        <div className="flex-1 flex flex-col overflow-hidden">
          <main
            id="main-content"
            className="flex-1 overflow-hidden"
            role="main"
            aria-label="Main content"
          >
            <div className="h-full transition-opacity duration-200 ease-in-out">
              {!appMode && <ModeSelector />}
              {appMode === "chat" && (
                <div className="h-full animate-fade-in">
                  <ChatContainer />
                </div>
              )}
              {appMode === "ide" && (
                <div className="h-full animate-fade-in">
                  <IdeWorkspace />
                </div>
              )}
              {appMode === "questions" && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-2">
                    <div className="text-3xl">📝</div>
                    <h2 className="text-xl font-semibold text-gray-900">
                      Question Generation
                    </h2>
                    <p className="text-sm text-gray-600">Coming soon.</p>
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

export default App;
