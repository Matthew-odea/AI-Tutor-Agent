// Timer expiry while offline: stop recording (the store keeps the blob), warn, and re-run
// the expiry decision once on reconnect. Never lose a real answer.

export interface OfflineDeferDeps {
  isInFlight: () => boolean; // upload/submit/stop in flight
  isRecording: () => boolean;
  answerMode: 'oral' | 'written';
  stopRecording: () => Promise<void>; // resolves once the blob is captured
  notify: (message: string) => void;
  // Must fire at most once despite a flapping connection, re-checking the in-flight guard.
  registerReconnect: (run: () => void) => void;
  runOnReconnect: () => void;
}

export const OFFLINE_DEFER_MESSAGE =
  'You appear to be offline — your answer is saved and will submit when you reconnect.';

// Currently always returns true: the caller must not take the online path.
export async function deferSubmitWhileOffline(deps: OfflineDeferDeps): Promise<boolean> {
  if (deps.isInFlight()) return true; // don't stack a deferral on an in-flight submit
  if (deps.answerMode === 'oral' && deps.isRecording()) {
    await deps.stopRecording();
  }
  deps.notify(OFFLINE_DEFER_MESSAGE);
  deps.registerReconnect(deps.runOnReconnect);
  return true;
}
