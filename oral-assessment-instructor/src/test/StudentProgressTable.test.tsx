import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

class FakeEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
  fail() { this.onerror?.(new Event('error')); }
}

const { streams, api } = vi.hoisted(() => {
  const streams: FakeEventSource[] = [];
  const api = {
    getAssessmentProgress: vi.fn(),
    getAssessmentStudents: vi.fn(),
    evaluateAssessment: vi.fn(),
    openStudentEvaluationProgressStream: vi.fn(),
  };
  return { streams, api };
});

vi.mock('../services/api', () => ({ apiService: api }));

import StudentProgressTable from '../components/StudentProgressTable';
import { useAssessmentStore } from '../store/assessmentStore';

const progressRow = {
  studentId: 's1',
  assessmentId: 'a1',
  name: 'Student One',
  email: '',
  answeredQuestions: 3,
  totalQuestions: 3,
  status: 'completed' as const,
};

const evaluating = { status: 'evaluating', questionsEvaluated: 1, totalQuestions: 3, percentage: 33 };

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

async function renderAndStartEvaluation() {
  const utils = render(
    <MemoryRouter>
      <StudentProgressTable assessmentId="a1" />
    </MemoryRouter>,
  );
  await flush();
  await flush();
  fireEvent.click(screen.getByRole('button', { name: /Evaluate Student One's answers/ }));
  await flush();
  await flush();
  return utils;
}

describe('StudentProgressTable evaluation progress stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    streams.length = 0;
    useAssessmentStore.setState({ progress: [], students: [] });
    api.getAssessmentProgress.mockResolvedValue([progressRow]);
    api.getAssessmentStudents.mockResolvedValue([]);
    api.evaluateAssessment.mockResolvedValue({});
    api.openStudentEvaluationProgressStream.mockImplementation(() => {
      const es = new FakeEventSource();
      streams.push(es);
      return es;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('re-opens the stream after an error while the student is still evaluating', async () => {
    await renderAndStartEvaluation();
    expect(streams).toHaveLength(1);

    act(() => streams[0].emit(evaluating));
    act(() => streams[0].fail());
    expect(streams[0].closed).toBe(true);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(streams).toHaveLength(2);
  });

  it('does not re-open when the last status was not evaluating', async () => {
    await renderAndStartEvaluation();
    act(() => streams[0].emit({ status: 'not_started', questionsEvaluated: 0, totalQuestions: 0, percentage: 0 }));
    act(() => streams[0].fail());
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(streams).toHaveLength(1);
  });

  it('caps retries so a persistently failing stream cannot loop forever', async () => {
    await renderAndStartEvaluation();
    for (let i = 0; i < 10; i++) {
      const es = streams[streams.length - 1];
      act(() => es.emit(evaluating));
      act(() => es.fail());
      act(() => { vi.advanceTimersByTime(3000); });
    }
    // Initial open + 5 retries.
    expect(streams).toHaveLength(6);
  });

  it('cancels a pending retry on unmount', async () => {
    const { unmount } = await renderAndStartEvaluation();
    act(() => streams[0].emit(evaluating));
    act(() => streams[0].fail());
    unmount();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(streams).toHaveLength(1);
  });
});

describe('StudentProgressTable progress polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAssessmentStore.setState({ progress: [], students: [] });
    api.getAssessmentProgress.mockResolvedValue([progressRow]);
    api.getAssessmentStudents.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stops polling after unmount', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <StudentProgressTable assessmentId="a1" />
      </MemoryRouter>,
    );
    await flush();
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    const callsBeforeUnmount = api.getAssessmentProgress.mock.calls.length;
    expect(callsBeforeUnmount).toBeGreaterThanOrEqual(2);

    unmount();
    act(() => { vi.advanceTimersByTime(30_000); });
    await flush();
    expect(api.getAssessmentProgress).toHaveBeenCalledTimes(callsBeforeUnmount);
  });
});
