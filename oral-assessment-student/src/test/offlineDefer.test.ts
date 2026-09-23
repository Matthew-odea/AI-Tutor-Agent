import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deferSubmitWhileOffline,
  OFFLINE_DEFER_MESSAGE,
  type OfflineDeferDeps,
} from '../utils/offlineDefer';

function baseDeps(overrides: Partial<OfflineDeferDeps> = {}): OfflineDeferDeps {
  return {
    isInFlight: () => false,
    isRecording: () => false,
    answerMode: 'oral',
    stopRecording: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    registerReconnect: vi.fn(),
    runOnReconnect: vi.fn(),
    ...overrides,
  };
}

describe('deferSubmitWhileOffline', () => {
  it('stops an active oral recording, warns, and registers a reconnect listener', async () => {
    const stopRecording = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const registerReconnect = vi.fn();
    const deps = baseDeps({
      answerMode: 'oral',
      isRecording: () => true,
      stopRecording,
      notify,
      registerReconnect,
    });

    await deferSubmitWhileOffline(deps);

    expect(stopRecording).toHaveBeenCalledTimes(1); // blob captured/preserved
    expect(notify).toHaveBeenCalledWith(OFFLINE_DEFER_MESSAGE);
    expect(registerReconnect).toHaveBeenCalledTimes(1);
    expect(registerReconnect).toHaveBeenCalledWith(deps.runOnReconnect);
  });

  it('does NOT call stopRecording for written mode', async () => {
    const stopRecording = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ answerMode: 'written', isRecording: () => true, stopRecording });
    await deferSubmitWhileOffline(deps);
    expect(stopRecording).not.toHaveBeenCalled();
  });

  it('is a no-op (no new deferral) when a submit is already in flight', async () => {
    const registerReconnect = vi.fn();
    const stopRecording = vi.fn();
    const deps = baseDeps({ isInFlight: () => true, registerReconnect, stopRecording });
    await deferSubmitWhileOffline(deps);
    expect(stopRecording).not.toHaveBeenCalled();
    expect(registerReconnect).not.toHaveBeenCalled();
  });
});

// Integration: TakeAssessment-style one-shot registerReconnect against real `online` events.
describe('deferred submit on reconnect (one-shot, no double-submit)', () => {
  let listener: (() => void) | null;
  let inFlight: boolean;

  // Keep in sync with registerDeferredSubmit in TakeAssessment.
  function makeRegisterReconnect() {
    listener = null;
    return (run: () => void) => {
      if (listener) {
        window.removeEventListener('online', listener);
        listener = null;
      }
      const onReconnect = () => {
        if (listener) {
          window.removeEventListener('online', listener);
          listener = null;
        }
        if (inFlight) return; // double-submit guard
        run();
      };
      listener = onReconnect;
      window.addEventListener('online', onReconnect);
    };
  }

  beforeEach(() => {
    inFlight = false;
    listener = null;
  });

  it('fires the submit exactly once when online fires, and not again on a second online', async () => {
    const run = vi.fn();
    const deps = baseDeps({
      answerMode: 'oral',
      isRecording: () => true,
      registerReconnect: makeRegisterReconnect(),
      runOnReconnect: run,
    });

    await deferSubmitWhileOffline(deps);
    expect(run).not.toHaveBeenCalled(); // nothing until reconnect

    window.dispatchEvent(new Event('online'));
    expect(run).toHaveBeenCalledTimes(1);

    // Flapping connection: a second online must NOT re-fire (listener detached).
    window.dispatchEvent(new Event('online'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not fire on reconnect if a submit became in-flight in the meantime', async () => {
    const run = vi.fn();
    const deps = baseDeps({
      registerReconnect: makeRegisterReconnect(),
      runOnReconnect: run,
    });

    await deferSubmitWhileOffline(deps);
    inFlight = true; // e.g. the student manually re-submitted before reconnect
    window.dispatchEvent(new Event('online'));
    expect(run).not.toHaveBeenCalled();
  });
});
