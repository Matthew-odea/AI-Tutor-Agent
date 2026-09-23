import { useRef, useEffect } from 'react';

interface ConsentModalProps {
  onConsent: () => void;
  onDecline: () => void;
  isRequestingPermission?: boolean;
}

export default function ConsentModal({
  onConsent,
  onDecline,
  isRequestingPermission = false,
}: ConsentModalProps) {
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
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        className="bg-paper rounded-xl shadow-overlay max-w-md w-full p-6"
      >
        <div className="flex items-center justify-center w-14 h-14 bg-accent/10 rounded-full mx-auto mb-4">
          <svg className="w-7 h-7 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M15 10l4.553-2.069A1 1 0 0121 8.868V15.13a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>

        <h2 id="consent-title" className="text-xl font-bold font-serif text-ink text-center mb-2">
          Proctoring
        </h2>
        <p className="text-slate text-sm text-center mb-4">
          This assessment supports webcam proctoring. Your camera will record during the session so your instructor can verify your identity.
        </p>

        <ul className="text-sm text-ink space-y-2 mb-6 bg-ink/5 rounded-xl p-4">
          <li className="flex items-start space-x-2">
            <svg className="w-4 h-4 text-primary-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>Footage is accessible only to your instructor.</span>
          </li>
          <li className="flex items-start space-x-2">
            <svg className="w-4 h-4 text-primary-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>A small preview appears so you can confirm your camera is working.</span>
          </li>
        </ul>
        <div className="flex space-x-3">
          <button
            onClick={onDecline}
            disabled={isRequestingPermission}
            className="flex-1 bg-ink/5 text-slate px-4 py-2.5 rounded-xl hover:bg-ink/10 disabled:opacity-50 transition-colors font-medium"
          >
            Continue without recording
          </button>
          <button
            onClick={onConsent}
            disabled={isRequestingPermission}
            className="flex-1 bg-accent text-white px-4 py-2.5 rounded-xl hover:bg-accent-hover disabled:opacity-50 transition-colors font-medium flex items-center justify-center space-x-2"
          >
            {isRequestingPermission ? (
              <>
                <svg className="w-4 h-4 animate-spin motion-reduce:animate-none" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span>Requesting…</span>
              </>
            ) : (
              <span>I Consent</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
