/**
 * Timer-expiry decision. Never destroy a real answer: navigation is forward-only, so a
 * question burned with a junk answer is lost for good. Decides on state re-read after
 * stopRecording: captured audio or any non-empty text is submitted, otherwise skip.
 */

export interface TimerExpiryDeps {
  inFlight: boolean; // re-entrancy guard
  answerMode: 'oral' | 'written';
  // Getters, so state is re-read after stopRecording.
  getIsRecording: () => boolean;
  getRecordedBlob: () => Blob | null;
  getTextAnswer: () => string;
  stopRecording: () => Promise<void>; // resolves once the blob is captured
  notify: (message: string) => void;
  submitAudio: () => Promise<void>;
  submitText: () => Promise<void>;
  skip: (mode: 'oral' | 'written') => Promise<void>;
}

export async function runTimerExpiry(deps: TimerExpiryDeps): Promise<void> {
  if (deps.inFlight) return;

  // Stop first, then read. Gating on a pre-stop snapshot once burned in-progress answers.
  if (deps.answerMode === 'oral' && deps.getIsRecording()) {
    await deps.stopRecording();
  }

  if (deps.answerMode === 'oral') {
    if (deps.getRecordedBlob()) {
      deps.notify("Time's up! Submitting your audio answer.");
      await deps.submitAudio();
    } else {
      deps.notify("Time's up! No answer recorded — moving on.");
      await deps.skip('oral');
    }
    return;
  }

  // Any non-empty text counts; there is deliberately no minimum length.
  if (deps.getTextAnswer().trim().length > 0) {
    deps.notify("Time's up! Submitting your written answer.");
    await deps.submitText();
  } else {
    deps.notify("Time's up! No answer recorded — moving on.");
    await deps.skip('written');
  }
}
