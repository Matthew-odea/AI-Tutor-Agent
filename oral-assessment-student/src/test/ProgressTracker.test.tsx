import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import ProgressTracker from '../components/ProgressTracker';

afterEach(cleanup);

// Attribute selector rather than getByLabelText, which is unreliable for plain divs.
const byLabel = (root: HTMLElement, label: string) =>
  root.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;

describe('ProgressTracker', () => {
  it('renders answered, skipped, and current questions distinctly', () => {
    const { container } = render(
      <ProgressTracker
        currentIndex={0}
        totalQuestions={3}
        answeredCount={1}
        questionIds={['q1', 'q2', 'q3']}
        answeredQuestionIds={new Set(['q2'])}
        skippedQuestionIds={new Set(['q3'])}
      />
    );

    const current = byLabel(container, 'Question 1, current');
    const answered = byLabel(container, 'Question 2, answered');
    const skipped = byLabel(container, 'Question 3, skipped');

    expect(current).not.toBeNull();
    expect(answered).not.toBeNull();
    expect(skipped).not.toBeNull();

    // Current — primary highlight + step semantics.
    expect(current!.getAttribute('aria-current')).toBe('step');
    expect(current!.className).toContain('bg-accent');

    // Answered — green, and crucially NOT the skipped amber.
    expect(answered!.className).toContain('bg-success');
    expect(answered!.className).not.toContain('bg-caution');

    // Skipped — amber, and crucially NOT the answered green check styling.
    expect(skipped!.className).toContain('bg-caution');
    expect(skipped!.className).not.toContain('bg-success');
  });

  it('renders a question that is both answered and skipped as skipped — skip wins, never the green check', () => {
    const { container } = render(
      <ProgressTracker
        currentIndex={0}
        totalQuestions={2}
        answeredCount={2}
        questionIds={['q1', 'q2']}
        answeredQuestionIds={new Set(['q1', 'q2'])}
        skippedQuestionIds={new Set(['q2'])}
      />
    );

    // q2 is in BOTH sets: the server's authoritative answered list may include a
    // skipped id, but we know locally it was skipped, so it must render skipped.
    const q2 = byLabel(container, 'Question 2, skipped');
    expect(q2).not.toBeNull();
    expect(q2!.className).toContain('bg-caution');
    expect(q2!.className).not.toContain('bg-success');
    expect(byLabel(container, 'Question 2, answered')).toBeNull();
  });

  it('falls back to the index heuristic when the id sets are undefined (unchanged legacy behavior)', () => {
    const { container } = render(
      <ProgressTracker currentIndex={2} totalQuestions={3} answeredCount={2} />
    );

    // No id sets supplied → answered iff i < answeredCount.
    expect(byLabel(container, 'Question 1, answered')!.className).toContain('bg-success');
    expect(byLabel(container, 'Question 2, answered')!.className).toContain('bg-success');
    expect(byLabel(container, 'Question 3, current')!.getAttribute('aria-current')).toBe('step');
  });

  it('is display-only (divs, not buttons) when onNavigate is omitted', () => {
    const { container } = render(
      <ProgressTracker currentIndex={0} totalQuestions={2} answeredCount={0} questionIds={['q1', 'q2']} />
    );
    // Indicators are plain divs and carry the display-only "Question N" label.
    expect(byLabel(container, 'Question 1, current')!.tagName).toBe('DIV');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders navigable buttons and fires onNavigate when provided (review mode)', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <ProgressTracker
        currentIndex={0}
        totalQuestions={3}
        answeredCount={1}
        questionIds={['q1', 'q2', 'q3']}
        answeredQuestionIds={new Set(['q2'])}
        onNavigate={onNavigate}
      />
    );

    // Navigable indicators are buttons with a "Go to question N" label.
    const target = byLabel(container, 'Go to question 2, answered');
    expect(target).not.toBeNull();
    expect(target!.tagName).toBe('BUTTON');

    fireEvent.click(target!);
    expect(onNavigate).toHaveBeenCalledWith(1);
  });
});
