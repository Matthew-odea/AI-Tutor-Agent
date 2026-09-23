import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ApiError } from '../types';
import ErrorBoundary from '../components/ErrorBoundary';
import { useAssessmentStore } from '../store/assessmentStore';

let shouldThrow = true;
function Boom() {
  if (shouldThrow) throw new Error('kaboom');
  return <div>recovered child</div>;
}

beforeEach(() => {
  shouldThrow = true;
  // React logs caught render errors to console.error — silence the noise.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useAssessmentStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows only a Reload Page action when there is no unsaved work', () => {
    useAssessmentStore.setState({ recordedBlob: null, textAnswer: '' });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Reload Page')).toBeInTheDocument();
    expect(screen.queryByText('Try to recover')).toBeNull();
  });

  it('warns about the unsubmitted answer and offers soft recovery when a recording exists', () => {
    useAssessmentStore.setState({ recordedBlob: new Blob(['x'], { type: 'audio/webm' }) });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/unsubmitted answer/i)).toBeInTheDocument();
    expect(screen.getByText('Try to recover')).toBeInTheDocument();
    // Hard reload is still offered, but only as a secondary action.
    expect(screen.getByText('Reload Page')).toBeInTheDocument();
  });

  it('also detects unsaved work from a non-empty typed answer', () => {
    useAssessmentStore.setState({ recordedBlob: null, textAnswer: 'half a sentence' });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Try to recover')).toBeInTheDocument();
  });

  it('soft-recovers by clearing the error and re-rendering children WITHOUT a full reload', () => {
    useAssessmentStore.setState({
      recordedBlob: new Blob(['x'], { type: 'audio/webm' }),
      error: { message: 'boom' } as ApiError,
    });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    // The crash is transient — let the child render cleanly on the retry.
    shouldThrow = false;
    fireEvent.click(screen.getByText('Try to recover'));

    // Children re-rendered in place (proof no full reload happened) and the
    // store error was cleared.
    expect(screen.getByText('recovered child')).toBeInTheDocument();
    expect(useAssessmentStore.getState().error).toBeNull();
  });
});
