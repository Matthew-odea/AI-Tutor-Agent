// Troubleshooting modal. Contact details come only from props (backend data), never
// hardcoded; generic copy when absent.
import { useEffect, useRef, useState } from 'react';

interface HelpButtonProps {
  instructorName?: string;
  supportEmail?: string;
  supportUrl?: string;
  className?: string;
}

export default function HelpButton({
  instructorName,
  supportEmail,
  supportUrl,
  className = '',
}: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Focus trap as in ConsentModal, plus focus returns to the persistent trigger on close.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
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
  }, [open]);

  const handleClose = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const hasDirectContact = Boolean(supportEmail || supportUrl);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Get help"
        title="Get help"
        className={`inline-flex items-center justify-center w-9 h-9 rounded-full border border-hairline bg-paper text-slate hover:bg-ink/5 hover:text-accent focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent transition-colors ${className}`}
      >
        <span className="text-lg font-semibold leading-none" aria-hidden="true">?</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50"
          onClick={handleClose}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
            className="bg-paper rounded-xl shadow-overlay max-w-lg w-full max-h-[85vh] overflow-y-auto p-6"
          >
            <div className="flex items-start justify-between mb-4">
              <h2 id="help-title" className="text-xl font-bold font-serif text-ink">
                Need help?
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close help"
                className="ml-4 flex-shrink-0 text-slate hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent rounded"
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

            <p className="text-sm text-slate mb-5">
              Trouble with your microphone, camera, or submitting an answer? Try the
              steps below.
            </p>

            <div className="space-y-4">
              <section className="bg-ink/5 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-ink mb-2">
                  Microphone not detected or no sound
                </h3>
                <ul className="text-sm text-slate space-y-1 list-disc list-inside">
                  <li>Check that your microphone is allowed in your operating system's privacy/sound settings.</li>
                  <li>Allow microphone access for this site in your browser (click the lock icon in the address bar).</li>
                  <li>Make sure the correct input device is selected and not muted, then reload the page.</li>
                </ul>
              </section>

              <section className="bg-ink/5 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-ink mb-2">
                  Camera blocked or access revoked
                </h3>
                <ul className="text-sm text-slate space-y-1 list-disc list-inside">
                  <li>Click the lock icon in your browser's address bar and re-grant camera (and microphone) access for this site.</li>
                  <li>Then use the on-screen "Restore camera" prompt to resume recording.</li>
                  <li>Close other apps that may be using your camera, then try again.</li>
                </ul>
              </section>

              <section className="bg-ink/5 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-ink mb-2">
                  An answer won't submit
                </h3>
                <ul className="text-sm text-slate space-y-1 list-disc list-inside">
                  <li>Check your internet connection.</li>
                  <li>Wait a moment and retry — submitting will resume automatically when you reconnect.</li>
                  <li>Your recording is preserved while you retry, so you won't lose your answer.</li>
                </ul>
              </section>
            </div>

            <section className="mt-5 border-t border-hairline pt-4">
              <h3 className="text-sm font-semibold text-ink mb-2">Still stuck?</h3>
              {hasDirectContact ? (
                <div className="text-sm text-slate space-y-1">
                  {instructorName && (
                    <p>
                      Contact <span className="font-medium text-ink">{instructorName}</span> for help.
                    </p>
                  )}
                  {supportEmail && (
                    <p>
                      Email:{' '}
                      <a
                        href={`mailto:${supportEmail}`}
                        className="text-accent hover:text-accent-hover underline break-all"
                      >
                        {supportEmail}
                      </a>
                    </p>
                  )}
                  {supportUrl && (
                    <p>
                      Support page:{' '}
                      <a
                        href={supportUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:text-accent-hover underline break-all"
                      >
                        {supportUrl}
                      </a>
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate">
                  {instructorName ? (
                    <>
                      Contact <span className="font-medium text-ink">{instructorName}</span> or your
                      course administrator for help with your invite link.
                    </>
                  ) : (
                    <>Contact your instructor or course administrator for help with your invite link.</>
                  )}
                </p>
              )}
            </section>

            <button
              type="button"
              onClick={handleClose}
              className="mt-6 w-full bg-accent text-white px-4 py-2.5 rounded-xl hover:bg-accent-hover transition-colors font-medium"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
