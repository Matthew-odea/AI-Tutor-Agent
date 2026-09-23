/**
 * AppShell — the single page chrome for every instructor screen.
 *
 * Before this existed, all ten instructor pages hand-rolled their own
 * `<header className="bg-white border-b border-gray-200">` + `max-w-7xl mx-auto`
 * block. The consequences: Settings and Log out existed ONLY on AssessmentList,
 * back-links were ad hoc ("← Back", "← Back to Assessments", `navigate(-1)`),
 * content column widths drifted between 4xl/5xl/7xl, and there was no product
 * identity anywhere in the chrome. AppShell owns all of that.
 *
 * WHAT IT GIVES YOU, ON EVERY PAGE
 *   - the product mark + wordmark (links back to /assessments)
 *   - a real <nav aria-label="Breadcrumb"> trail — use it instead of a back-link
 *   - the global user menu (Settings + Log out), including the logout handler and
 *     the user-management Settings modal, both moved out of AssessmentList
 *   - a header action row that WRAPS instead of overflowing on narrow viewports
 *   - a <main> landmark with the standard content column
 *
 * USAGE
 *   Replace the page's outer `<div className="min-h-screen …">`, its `<header>`
 *   and its `<main>` with a single <AppShell>. Do NOT render your own header,
 *   your own logout button, or your own Settings modal.
 *
 *     <AppShell
 *       breadcrumbs={[
 *         { label: 'Assessments', to: '/assessments' },
 *         { label: assessment.title, to: `/assessments/${assessmentId}/results` },
 *         { label: 'Monitor Progress' },
 *       ]}
 *       title={`Monitor Progress: ${assessment.title}`}
 *       subtitle={assessment.course}
 *       actions={
 *         <Link to={`/assessments/${assessmentId}/results`} className="…">View Results</Link>
 *       }
 *     >
 *       <StudentProgressTable assessmentId={assessmentId} />
 *     </AppShell>
 *
 * PROPS
 *   title            ReactNode. Required. Rendered as the page's font-serif <h1>.
 *   subtitle         ReactNode. Optional secondary line under the title — the
 *                    course code, a student's email + id, etc.
 *   breadcrumbs      { label, to? }[]. Max three levels, and the LAST entry must
 *                    be the current page's own name — never the assessment
 *                    title, unless the assessment title IS the page (ViewResults).
 *                    Ancestor entries with `to` render as <Link>s; the last entry
 *                    always renders as plain text with aria-current="page", so a
 *                    `to` on it is ignored. Omit entirely on the root page
 *                    (AssessmentList).
 *                      Assessments > {title} > "Monitor Progress"
 *   actions          ReactNode. Right-aligned page actions. Any nodes are fine —
 *                    buttons, <Link>s, or a read-only status pill (e.g.
 *                    QuestionEditor's "Locked" badge). The row wraps under the
 *                    title on small screens, so four buttons is safe.
 *   banner           ReactNode. Rendered FULL BLEED directly under the header and
 *                    above <main> — e.g. <SetupStepIndicator />. The banner owns
 *                    its own padding, width container and bottom border.
 *   maxWidth         'default' (max-w-7xl, tables/dashboards — the default)
 *                    | 'medium'  (max-w-5xl, StudentResultDetail)
 *                    | 'narrow'  (max-w-4xl, forms: create/upload/generate/editor).
 *                    Applies to the header rows AND <main> so the chrome and the
 *                    content share one column.
 *   contentClassName Extra classes for <main>, for pages that want vertical
 *                    rhythm between sections (e.g. "space-y-6"). Padding and the
 *                    width container are already applied.
 *   children         Page content, rendered inside <main>.
 *
 * NOT AppShell's job: full-page loading and error states. Keep returning your own
 * centred spinner / retry card before the data arrives; mount AppShell once you
 * have something to title it with.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import type { Schemas } from '../../../shared/types/assessment';
import { useToastStore } from '../store/toastStore';

export interface Breadcrumb {
  label: string;
  /** Omit to render as plain text (i.e. the current page). */
  to?: string;
}

export type AppShellMaxWidth = 'default' | 'medium' | 'narrow';

export interface AppShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
  banner?: ReactNode;
  maxWidth?: AppShellMaxWidth;
  contentClassName?: string;
  children: ReactNode;
}

const MAX_WIDTH_CLASS: Record<AppShellMaxWidth, string> = {
  default: 'max-w-7xl',
  medium: 'max-w-5xl',
  narrow: 'max-w-4xl',
};

/** Best-effort display label for the signed-in user, read from the JWT. */
function currentUserLabel(): string | null {
  try {
    const token = localStorage.getItem('authToken');
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    const label = payload.email || payload.sub;
    return typeof label === 'string' && label.length > 0 ? label : null;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Settings modal — user management.

   Moved wholesale out of AssessmentList (which had it as an untitled, un-trapped
   `fixed inset-0` div) and reimplemented tokenized + accessible: role="dialog",
   aria-modal, labelled by its heading, Escape to close, focus trapped inside,
   background scroll locked. Focus is returned to the trigger by the caller.
   ──────────────────────────────────────────────────────────────────────────── */

type UserRecord = Schemas['UserRecord'];

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roleUpdating, setRoleUpdating] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Intentional: fetch the user list once when the dialog mounts. Every state
    // toggle below happens after an await, i.e. in the fetch's own
    // loading/data/error transitions rather than synchronously during the effect.
    (async () => {
      try {
        const data = await apiService.listUsers();
        if (!cancelled) setUsers(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load users');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus the close button on open, trap Tab inside the dialog, and close on
  // Escape. Focusables are re-queried on every keypress because the user list
  // arrives asynchronously.
  useEffect(() => {
    closeButtonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const toggleInstructor = async (email: string, currentRoles: string[]) => {
    setRoleUpdating(email);
    const isInstructor = currentRoles.includes('instructor');
    const newRoles = isInstructor
      ? currentRoles.filter((r) => r !== 'instructor')
      : [...currentRoles.filter((r) => r !== 'instructor'), 'instructor'];
    try {
      await apiService.setUserRoles(email, newRoles);
      setUsers((prev) => prev.map((u) => (u.email === email ? { ...u, roles: newRoles } : u)));
      addToast(
        isInstructor ? `Instructor access removed for ${email}.` : `${email} is now an instructor.`,
        'success'
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to update roles', 'error');
    } finally {
      setRoleUpdating(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--scrim)' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-shell-settings-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-paper rounded-xl shadow-overlay w-full max-w-lg max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between gap-4 p-6 border-b border-hairline">
          <h2 id="app-shell-settings-title" className="font-serif text-lg font-semibold text-ink">
            User Management
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex-shrink-0 text-slate hover:text-ink transition-colors rounded"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          <p className="text-sm text-slate mb-4">
            Toggle instructor access for registered users.
          </p>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <div
                className="h-8 w-8 animate-spin motion-reduce:animate-none rounded-full border-4 border-ink/10 border-t-accent"
                role="status"
                aria-label="Loading users"
              />
            </div>
          ) : loadError ? (
            <p className="text-sm text-danger text-center py-4">{loadError}</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-slate text-center py-4">No registered users found.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {users.map((user) => {
                const isInstructor = user.roles.includes('instructor');
                const isUpdating = roleUpdating === user.email;
                return (
                  <li key={user.email} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{user.email}</p>
                      <p className="text-xs text-slate">
                        {user.roles.length > 0 ? user.roles.join(', ') : 'no roles'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleInstructor(user.email, user.roles)}
                      disabled={isUpdating}
                      aria-pressed={isInstructor}
                      className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors disabled:opacity-50 ${
                        isInstructor
                          ? 'bg-accent/10 text-accent hover:bg-danger/10 hover:text-danger'
                          : 'bg-ink/5 text-slate hover:bg-accent/10 hover:text-accent'
                      }`}
                    >
                      {isUpdating ? '…' : isInstructor ? 'Instructor ✓' : 'Make instructor'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   User menu — the global Settings + Log out popover.
   ──────────────────────────────────────────────────────────────────────────── */

function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const userLabel = currentUserLabel();

  const closeMenu = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    []
  );

  // Click outside closes the menu (without stealing focus back).
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const handleMenuKeyDown = (e: ReactKeyboardEvent) => {
    const focusables = items();
    if (focusables.length === 0) return;
    const index = focusables.indexOf(document.activeElement as HTMLElement);

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        closeMenu();
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusables[(index + 1 + focusables.length) % focusables.length].focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusables[(index - 1 + focusables.length) % focusables.length].focus();
        break;
      case 'Home':
        e.preventDefault();
        focusables[0].focus();
        break;
      case 'End':
        e.preventDefault();
        focusables[focusables.length - 1].focus();
        break;
      case 'Tab':
        // Tabbing out of a menu dismisses it, per the WAI-ARIA menu pattern.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    navigate('/login');
  };

  const menuItemClass =
    'w-full text-left px-4 py-2 text-sm text-ink hover:bg-ink/5 focus:bg-ink/5 focus:outline-none transition-colors';

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="app-shell-user-menu"
        className="flex items-center gap-2 px-2 py-1.5 rounded-xl border border-hairline bg-paper text-slate hover:bg-ink/5 hover:text-ink transition-colors"
      >
        <span
          aria-hidden="true"
          className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-xs font-semibold"
        >
          {(userLabel?.[0] ?? 'I').toUpperCase()}
        </span>
        <span className="hidden sm:inline max-w-[14rem] truncate text-sm">
          {userLabel ?? 'Account'}
        </span>
        <svg
          aria-hidden="true"
          className="w-4 h-4 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <span className="sr-only">Account menu</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          id="app-shell-user-menu"
          role="menu"
          aria-label="Account"
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 mt-2 w-60 py-1 bg-paper border border-hairline rounded-xl shadow-overlay z-50"
        >
          {userLabel && (
            <p className="px-4 py-2 text-xs text-slate border-b border-hairline truncate">
              Signed in as <span className="text-ink">{userLabel}</span>
            </p>
          )}
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              setOpen(false);
              handleLogout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Breadcrumbs
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The trail is always `Assessments` → (`{assessment.title}`) → the current
 * page's own name. The LAST crumb is the current page by definition, so it is
 * rendered as unlinked text carrying aria-current="page" even if the caller
 * supplied a `to`. A self-link on the leaf is a no-op for sighted users but,
 * left as a <Link>, it would silently drop aria-current and announce the wrong
 * page — ViewResults in particular ends on the assessment title, whose crumb is
 * linked on every other screen. Dropping the leaf's `to` is the cheap fix and
 * keeps the rule to one sentence.
 */
function Breadcrumbs({ items }: { items: Breadcrumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-slate">
        {items.map((crumb, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex items-center gap-x-1.5 min-w-0">
              {i > 0 && (
                <svg
                  aria-hidden="true"
                  className="w-3.5 h-3.5 flex-shrink-0 text-slate/60"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
              {crumb.to && !isLast ? (
                <Link to={crumb.to} className="hover:text-ink transition-colors truncate">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-ink truncate" aria-current={isLast ? 'page' : undefined}>
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   AppShell
   ──────────────────────────────────────────────────────────────────────────── */

export default function AppShell({
  title,
  subtitle,
  breadcrumbs,
  actions,
  banner,
  maxWidth = 'default',
  contentClassName = '',
  children,
}: AppShellProps) {
  const [showSettings, setShowSettings] = useState(false);
  const width = MAX_WIDTH_CLASS[maxWidth];
  const column = `${width} mx-auto px-4 sm:px-6 lg:px-8`;

  // The user menu's trigger lives inside <UserMenu>; when the Settings dialog it
  // opened closes, focus must land back on something sensible in the chrome.
  const settingsReturnRef = useRef<HTMLElement | null>(null);

  const openSettings = () => {
    settingsReturnRef.current = document.activeElement as HTMLElement | null;
    setShowSettings(true);
  };

  const closeSettings = () => {
    setShowSettings(false);
    settingsReturnRef.current?.focus();
  };

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-paper border-b border-hairline">
        {/* Product chrome: identity on the left, account menu on the right. */}
        <div className="border-b border-hairline">
          <div className={`${column} flex items-center justify-between gap-4 h-14`}>
            <Link
              to="/assessments"
              className="flex items-center gap-2.5 min-w-0 rounded transition-opacity hover:opacity-80"
            >
              <img src="/c9-logo.svg" alt="" aria-hidden="true" className="w-7 h-7 flex-shrink-0" />
              <span className="font-serif text-base font-semibold text-ink leading-none truncate">
                Oral Assessment
              </span>
              <span className="hidden sm:inline flex-shrink-0 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate border border-hairline rounded-full leading-normal">
                Instructor
              </span>
            </Link>
            <UserMenu onOpenSettings={openSettings} />
          </div>
        </div>

        {/* Page identity: breadcrumbs, title/subtitle, and the wrapping action row. */}
        <div className={`${column} py-4`}>
          {breadcrumbs && breadcrumbs.length > 0 && (
            <div className="mb-2">
              <Breadcrumbs items={breadcrumbs} />
            </div>
          )}
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h1 className="font-serif text-2xl font-semibold text-ink break-words">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-slate break-words">{subtitle}</p>}
            </div>
            {actions && (
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">{actions}</div>
            )}
          </div>
        </div>
      </header>

      {banner}

      <main className={`${column} py-8 ${contentClassName}`}>{children}</main>

      {showSettings && <SettingsModal onClose={closeSettings} />}
    </div>
  );
}
