import { useEffect, useRef, useState } from "react";
import logo9021 from "../assets/logo-concepts/chat9021_logo_concept_b.svg";

interface LoginGateProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onSignup: (email: string, password: string) => Promise<void>;
  onGoogleLogin: (idToken: string) => Promise<void>;
  onForgotPassword: (email: string) => Promise<string | void>;
  onValidateResetToken: (token: string) => Promise<boolean>;
  onResetPassword: (
    token: string,
    newPassword: string,
  ) => Promise<string | void>;
}

type AuthMode = "login" | "signup" | "forgot" | "reset";

export const LoginGate = ({
  onLogin,
  onSignup,
  onGoogleLogin,
  onForgotPassword,
  onValidateResetToken,
  onResetPassword,
}: LoginGateProps) => {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [isResetTokenValid, setIsResetTokenValid] = useState(false);
  const [isResetTokenChecking, setIsResetTokenChecking] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const googleInitializedRef = useRef(false);

  const googleClientId =
    (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || "";
  const isGoogleEnabled = false;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token")?.trim() || "";
    if (!token) {
      return;
    }

    setMode("reset");
    setResetToken(token);
    setIsResetTokenChecking(true);
    setError(null);
    setInfo(null);

    onValidateResetToken(token)
      .then((isValid) => {
        setIsResetTokenValid(isValid);
        if (!isValid) {
          setError("This password reset link is invalid or has expired.");
        }
      })
      .finally(() => {
        setIsResetTokenChecking(false);
      });
  }, [onValidateResetToken]);

  useEffect(() => {
    if (!isGoogleEnabled) {
      return;
    }

    const renderGoogleButton = () => {
      if (
        !window.google ||
        !googleButtonRef.current ||
        googleInitializedRef.current
      ) {
        return;
      }

      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response) => {
          const credential = response?.credential?.trim();
          if (!credential) {
            setError("Google sign-in did not return a token.");
            return;
          }

          setError(null);
          setIsSubmitting(true);
          try {
            await onGoogleLogin(credential);
          } catch (authError) {
            setError(
              authError instanceof Error
                ? authError.message
                : "Google sign-in failed. Please try again.",
            );
          } finally {
            setIsSubmitting(false);
          }
        },
      });

      googleButtonRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "continue_with",
        width: "320",
      });

      googleInitializedRef.current = true;
    };

    const existingScript = document.getElementById(
      "google-identity-services",
    ) as HTMLScriptElement | null;
    if (existingScript) {
      if (window.google) {
        renderGoogleButton();
      } else {
        existingScript.addEventListener("load", renderGoogleButton, {
          once: true,
        });
      }
      return;
    }

    const script = document.createElement("script");
    script.id = "google-identity-services";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => renderGoogleButton();
    script.onerror = () =>
      setError("Unable to load Google sign-in. Please use email and password.");
    document.head.appendChild(script);
  }, [googleClientId, isGoogleEnabled, onGoogleLogin]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    const trimmedPassword = password.trim();
    if (mode === "forgot") {
      const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
      if (!isValidEmail) {
        setError("Enter a valid email address.");
        return;
      }
      setError(null);
      setInfo(null);
      setIsSubmitting(true);
      try {
        const message = await onForgotPassword(trimmed);
        setInfo(
          message ||
            "If an account exists for this email, a reset link has been sent.",
        );
      } catch (authError) {
        setError(
          authError instanceof Error
            ? authError.message
            : "Unable to send reset link. Please try again.",
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (mode === "reset") {
      if (!resetToken || !isResetTokenValid) {
        setError("This password reset link is invalid or has expired.");
        return;
      }
      if (trimmedPassword.length < 8) {
        setError("Password must be at least 8 characters.");
        return;
      }
      if (trimmedPassword !== confirmPassword.trim()) {
        setError("Passwords do not match.");
        return;
      }
      setError(null);
      setInfo(null);
      setIsSubmitting(true);
      try {
        const message = await onResetPassword(resetToken, trimmedPassword);
        setInfo(message || "Password has been reset. You can now sign in.");
        setMode("login");
        setPassword("");
        setConfirmPassword("");
        setResetToken(null);
        setIsResetTokenValid(false);

        const params = new URLSearchParams(window.location.search);
        params.delete("token");
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
        window.history.replaceState({}, "", nextUrl);
      } catch (authError) {
        setError(
          authError instanceof Error
            ? authError.message
            : "Unable to reset password. Please request a new link.",
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!isValidEmail) {
      setError("Enter a valid email address.");
      return;
    }
    if (!trimmedPassword) {
      setError("Enter your password.");
      return;
    }

    if (mode === "signup") {
      if (trimmedPassword.length < 8) {
        setError("Password must be at least 8 characters.");
        return;
      }
      if (trimmedPassword !== confirmPassword.trim()) {
        setError("Passwords do not match.");
        return;
      }
    }

    setError(null);
    setInfo(null);
    setIsSubmitting(true);
    try {
      if (mode === "signup") {
        await onSignup(trimmed, trimmedPassword);
      } else {
        await onLogin(trimmed, trimmedPassword);
      }
    } catch (authError) {
      setError(
        authError instanceof Error
          ? authError.message
          : "Unable to sign in. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen w-full bg-gradient-to-br from-slate-50 via-white to-primary-50">
      <div className="grid h-full w-full overflow-hidden bg-white lg:grid-cols-[1.1fr_1fr]">
        <section className="hidden bg-gradient-to-br from-primary-50 via-white to-primary-100 text-slate-700 lg:flex lg:flex-col p-12 border-r border-primary-100/80">
          <div>
            <div className="h-1.5 w-24 rounded-full bg-gradient-to-r from-primary-500 to-primary-300" />
            <div className="mt-8 inline-flex items-center rounded-2xl border border-primary-200 bg-white/95 px-4 py-3 shadow-sm">
              <img src={logo9021} alt="Chat9021 logo" className="h-20 w-auto" />
            </div>
          </div>
          <div className="mt-auto">
            <div className="text-xs text-primary-800/80">
              <a
                href="/privacypolicy"
                className="font-medium hover:text-primary-900"
              >
                Privacy Policy
              </a>
              <span className="mx-2 text-primary-300">|</span>
              <a
                href="/termsofservice"
                className="font-medium hover:text-primary-900"
              >
                Terms of Service
              </a>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 max-w-xs">
              <div className="h-2 rounded-full bg-primary-200" />
              <div className="h-2 rounded-full bg-primary-300" />
              <div className="h-2 rounded-full bg-primary-400" />
            </div>
          </div>
        </section>

        <section className="p-6 sm:p-8 lg:p-10 self-center">
          <div className="mb-6 text-center lg:text-left">
            <h2 className="text-xl font-semibold text-gray-900">
              {mode === "signup"
                ? "Create your account"
                : mode === "forgot"
                  ? "Reset your password"
                  : mode === "reset"
                    ? "Set a new password"
                    : "Sign in"}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {mode === "signup"
                ? "Use your email to continue."
                : mode === "forgot"
                  ? "Enter the email address linked to your account."
                  : mode === "reset"
                    ? "Choose a password with at least 8 characters."
                    : "Use your existing account credentials."}
            </p>
          </div>

          <div className="mb-6 w-full max-w-md mx-auto">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-primary-50 p-1 border border-primary-100">
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError(null);
                  setInfo(null);
                }}
                className={`rounded-md py-2 text-sm font-medium transition-colors ${
                  mode === "login"
                    ? "bg-white text-primary-800 shadow-sm border border-primary-200 ring-1 ring-primary-100"
                    : "text-primary-700/80 hover:text-primary-800 hover:bg-primary-100/60"
                }`}
              >
                Log in
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("signup");
                  setError(null);
                  setInfo(null);
                }}
                className={`rounded-md py-2 text-sm font-medium transition-colors ${
                  mode === "signup"
                    ? "bg-white text-primary-800 shadow-sm border border-primary-200 ring-1 ring-primary-100"
                    : "text-primary-700/80 hover:text-primary-800 hover:bg-primary-100/60"
                }`}
              >
                Sign up
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isGoogleEnabled && (mode === "login" || mode === "signup") && (
              <div className="space-y-3">
                <div ref={googleButtonRef} className="flex justify-center" />
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-gray-200" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-white px-2 text-gray-400">
                      or continue with email
                    </span>
                  </div>
                </div>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-2">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-gray-50/30 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                placeholder="you@example.com"
                autoComplete="email"
                required
                disabled={mode === "reset"}
              />
            </div>
            {(mode === "login" || mode === "signup" || mode === "reset") && (
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-2">
                  {mode === "reset" ? "New Password" : "Password"}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50/30 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="••••••••"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  required
                />
              </div>
            )}
            {(mode === "signup" || mode === "reset") && (
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-2">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50/30 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
              </div>
            )}
            {mode === "login" && (
              <div className="-mt-1 text-right">
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setPassword("");
                    setConfirmPassword("");
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-xs font-medium text-primary-700 hover:text-primary-800"
                >
                  Forgot password?
                </button>
              </div>
            )}
            {mode === "forgot" && (
              <div className="-mt-1 text-right">
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                  className="text-xs font-medium text-gray-600 hover:text-gray-800"
                >
                  Back to login
                </button>
              </div>
            )}
            {error && (
              <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </p>
            )}
            {info && (
              <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {info}
              </p>
            )}
            {mode === "reset" && isResetTokenChecking && (
              <p className="mt-2 text-xs text-gray-500">Checking reset link…</p>
            )}
            <button
              type="submit"
              disabled={
                isSubmitting ||
                (mode === "reset" &&
                  (!resetToken || !isResetTokenValid || isResetTokenChecking))
              }
              className="w-full rounded-lg bg-primary-600 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting
                ? mode === "signup"
                  ? "Creating account…"
                  : mode === "forgot"
                    ? "Sending reset link…"
                    : mode === "reset"
                      ? "Resetting password…"
                      : "Signing in…"
                : mode === "signup"
                  ? "Create account"
                  : mode === "forgot"
                    ? "Send reset link"
                    : mode === "reset"
                      ? "Reset password"
                      : "Continue"}
            </button>
            <p className="text-[11px] text-gray-500 text-center">
              Your sign-in session is encrypted and used only for account
              access.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
};
