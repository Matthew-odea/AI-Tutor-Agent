import { useRef, useEffect } from 'react';

interface CameraRevokedOverlayProps {
  onRestore: () => void;
  isRestoring?: boolean;
  // Adds a "Continue without recording" escape; otherwise the overlay is restore-only.
  proctoringOptional?: boolean;
  onContinueWithout?: () => void;
  // Copy override for the resume re-grant variant.
  title?: string;
  description?: string;
}

export default function CameraRevokedOverlay({
  onRestore,
  isRestoring = false,
  proctoringOptional = false,
  onContinueWithout,
  title,
  description,
}: CameraRevokedOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center p-4 z-50">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="camera-revoked-title"
        className="bg-paper rounded-xl shadow-overlay max-w-md w-full p-6 text-center"
      >
        <div className="flex items-center justify-center w-16 h-16 bg-danger/10 rounded-full mx-auto mb-4">
          <svg className="w-8 h-8 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </div>

        <h2 id="camera-revoked-title" className="text-xl font-bold font-serif text-ink mb-2">
          {title ?? 'Camera Access Revoked'}
        </h2>
        <p className="text-slate text-sm mb-6">
          {description ??
            'Your assessment has been paused because camera or microphone access was revoked. Please restore access in your browser settings and click below to continue.'}
        </p>

        <div className="bg-caution/10 border border-caution/20 rounded-xl p-3 mb-6 text-left">
          <p className="text-caution text-xs font-medium mb-1">How to restore access:</p>
          <ol className="text-caution text-xs space-y-1 list-decimal list-inside">
            <li>Click the camera icon in your browser's address bar</li>
            <li>Select "Allow" for camera and microphone</li>
            <li>Click "Restore Camera" below</li>
          </ol>
        </div>

        <button
          onClick={onRestore}
          disabled={isRestoring}
          className="w-full bg-accent text-white px-4 py-2.5 rounded-xl hover:bg-accent-hover disabled:bg-ink/20 transition-colors font-medium flex items-center justify-center space-x-2"
        >
          {isRestoring ? (
            <>
              <svg className="w-4 h-4 animate-spin motion-reduce:animate-none" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <span>Restoring…</span>
            </>
          ) : (
            <span>Restore Camera</span>
          )}
        </button>

        {proctoringOptional && onContinueWithout && (
          <button
            onClick={onContinueWithout}
            disabled={isRestoring}
            className="mt-3 w-full bg-ink/5 text-slate px-4 py-2.5 rounded-xl hover:bg-ink/10 disabled:opacity-50 transition-colors font-medium"
          >
            Continue without recording
          </button>
        )}
      </div>
    </div>
  );
}
