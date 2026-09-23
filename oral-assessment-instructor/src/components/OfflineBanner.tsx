/**
 * Always mounted in App.tsx; renders only while offline. Unlike the student app's
 * version it owns its own online state (the instructor store has no isOnline field).
 */

import { useEffect, useState } from 'react';

export default function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(
    // SSR/test-safe: assume online when the API is unavailable.
    () => (typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : true)
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Re-sync: a change between first render and listener attach fires no event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOnline((prev) => (prev === navigator.onLine ? prev : navigator.onLine));

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 inset-x-0 z-50 bg-caution/10 border-b border-caution/30 px-4 py-2"
    >
      <div className="flex items-center justify-center gap-2 text-sm font-medium text-caution">
        <svg
          className="h-4 w-4 flex-shrink-0 text-caution"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728M12 12h.01"
          />
        </svg>
        <span>
          You appear to be offline. Changes you make now may not be saved — reconnect
          before continuing.
        </span>
      </div>
    </div>
  );
}
