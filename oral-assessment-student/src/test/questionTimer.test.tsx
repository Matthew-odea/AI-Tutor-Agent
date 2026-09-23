import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import QuestionTimer from '../components/QuestionTimer';

// Fixed epoch base so persisted-anchor maths is deterministic under fake timers
// (vitest fakes Date, so Date.now() === BASE at the start of each test).
const BASE = 1_700_000_000_000;

describe('QuestionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    sessionStorage.clear();
  });

  it('fires onExpire exactly once at zero and never double-fires', () => {
    const onExpire = vi.fn();
    render(<QuestionTimer timeLimitSeconds={3} resetKey="q1" onExpire={onExpire} />);

    act(() => { vi.advanceTimersByTime(3500); });
    expect(onExpire).toHaveBeenCalledTimes(1);

    // Keep ticking well past expiry — the expiredRef guard must hold.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('freezes while paused and resumes without burning recording time', () => {
    const onExpire = vi.fn();
    const { rerender } = render(
      <QuestionTimer timeLimitSeconds={3} resetKey="q1" onExpire={onExpire} paused={false} />
    );

    act(() => { vi.advanceTimersByTime(1000); }); // 2s of the 3s budget left

    // Pause for a long time — must NOT expire while paused.
    rerender(<QuestionTimer timeLimitSeconds={3} resetKey="q1" onExpire={onExpire} paused={true} />);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(onExpire).not.toHaveBeenCalled();

    // Resume — the remaining ~2s should still be available (paused time excluded).
    rerender(<QuestionTimer timeLimitSeconds={3} resetKey="q1" onExpire={onExpire} paused={false} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(onExpire).not.toHaveBeenCalled(); // still ~0.5s left

    act(() => { vi.advanceTimersByTime(1000); }); // now past the remaining budget
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  // Refresh anchoring

  it('(a) first mount with no stored anchor persists one and counts down from the full limit', () => {
    const onExpire = vi.fn();
    const key = 'qtimer_start_a1_q1';
    render(<QuestionTimer timeLimitSeconds={120} resetKey="q1" persistKey={key} onExpire={onExpire} />);

    // Renders the full limit immediately and persists the anchor at "now".
    expect(screen.getByRole('timer').textContent).toContain('2:00');
    expect(sessionStorage.getItem(key)).toBe(String(BASE));

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('timer').textContent).toContain('1:55');
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('(b) continues from elapsed time after a refresh (same resetKey remount), not the full limit', () => {
    const onExpire = vi.fn();
    const key = 'qtimer_start_a1_q1';

    const first = render(
      <QuestionTimer timeLimitSeconds={120} resetKey="q1" persistKey={key} onExpire={onExpire} />
    );
    act(() => { vi.advanceTimersByTime(30_000); }); // burn 30s of the 2:00 budget
    expect(screen.getByRole('timer').textContent).toContain('1:30');
    first.unmount(); // simulate a page refresh: the component is torn down

    // Remount fresh against the SAME persisted key — must resume, not restart.
    const { getByRole } = render(
      <QuestionTimer timeLimitSeconds={120} resetKey="q1" persistKey={key} onExpire={onExpire} />
    );
    expect(getByRole('timer').textContent).toContain('1:30');
    expect(getByRole('timer').textContent).not.toContain('2:00');
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('(c) renders 0 immediately and fires onExpire once when the stored anchor has already elapsed', () => {
    const onExpire = vi.fn();
    const key = 'qtimer_start_a1_q1';
    // Pre-seed an anchor far enough in the past that the 60s limit is already gone.
    sessionStorage.setItem(key, String(BASE - 120_000));

    render(<QuestionTimer timeLimitSeconds={60} resetKey="q1" persistKey={key} onExpire={onExpire} />);

    expect(screen.getByRole('timer').textContent).toContain('0:00');
    expect(onExpire).toHaveBeenCalledTimes(1);

    // No double-fire as time continues past expiry.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('(d) prefers a server-provided start over any persisted local anchor', () => {
    const onExpire = vi.fn();
    const key = 'qtimer_start_a1_q1';
    // A local anchor that would imply a near-full clock (only 5s elapsed)...
    sessionStorage.setItem(key, String(BASE - 5_000));
    // ...but the server says the question was first served 90s ago.
    const serverStartedAtMs = BASE - 90_000;

    render(
      <QuestionTimer
        timeLimitSeconds={120}
        resetKey="q1"
        persistKey={key}
        serverStartedAtMs={serverStartedAtMs}
        onExpire={onExpire}
      />
    );

    // Server wins: 120 - 90 = 30s remaining (NOT 115s implied by the local anchor).
    expect(screen.getByRole('timer').textContent).toContain('0:30');
    expect(screen.getByRole('timer').textContent).not.toContain('1:55');
  });

  it('(e) renders nothing and writes no anchor when the time limit is null or 0', () => {
    const onExpire = vi.fn();
    const key = 'qtimer_start_a1_q1';

    const { container, rerender } = render(
      <QuestionTimer timeLimitSeconds={null} resetKey="q1" persistKey={key} onExpire={onExpire} />
    );
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();

    rerender(<QuestionTimer timeLimitSeconds={0} resetKey="q1" persistKey={key} onExpire={onExpire} />);
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('persists nothing and uses the live clock when no persistKey is given (oral timer unchanged)', () => {
    const onExpire = vi.fn();
    render(<QuestionTimer timeLimitSeconds={3} resetKey="q1-rec-123" onExpire={onExpire} />);

    // The recording-elapsed oral timer must not touch sessionStorage at all.
    expect(sessionStorage.length).toBe(0);

    act(() => { vi.advanceTimersByTime(3500); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
