import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAssessmentStore } from '../store/assessmentStore';

// Every apiService method is an auto-created vi.fn(), so unstubbed calls resolve to undefined.
const api = vi.hoisted(() => {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(fns, { get: (t, k: string) => (t[k] ??= vi.fn()) });
});
vi.mock('../services/api', () => ({ apiService: api }));

import StudentProgressTable from '../components/StudentProgressTable';

const row = (studentId: string, name: string, status: string) => ({
  studentId, name, email: `${studentId}@example.edu`, status, totalQuestions: 3, answeredQuestions: 3, percentage: 100,
});

describe('StudentProgressTable evaluation', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset());
    useAssessmentStore.getState().reset();
    api.getAssessmentProgress.mockResolvedValue([
      row('s1', 'Ada', 'completed'),
      row('s2', 'Bob', 'completed'),
      row('s3', 'Cy', 'in-progress'),
    ]);
    api.getAssessmentStudents.mockResolvedValue([]);
    api.evaluateAssessment.mockResolvedValue({ jobId: 'j1' });
    api.openStudentEvaluationProgressStream.mockImplementation(() => ({ close: vi.fn() }));
  });

  const renderTable = () =>
    render(
      <MemoryRouter>
        <StudentProgressTable assessmentId="a1" />
      </MemoryRouter>
    );

  it('evaluates only the one student whose Evaluate button was pressed', async () => {
    renderTable();
    fireEvent.click(await screen.findByRole('button', { name: "Evaluate Bob's answers" }));

    await vi.waitFor(() => expect(api.evaluateAssessment).toHaveBeenCalledWith('a1', ['s2']));
    expect(api.evaluateAssessment).toHaveBeenCalledTimes(1);
  });

  it('Evaluate All sends every finished student and no unfinished one', async () => {
    renderTable();
    fireEvent.click(await screen.findByRole('button', { name: 'Evaluate All (2)' }));

    await vi.waitFor(() => expect(api.evaluateAssessment).toHaveBeenCalledWith('a1', ['s1', 's2']));
  });

  it('stops polling for progress once the table is gone', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderTable();
      await vi.advanceTimersByTimeAsync(10_000);
      const whileMounted = api.getAssessmentProgress.mock.calls.length;
      expect(whileMounted).toBeGreaterThan(1); // initial load + at least one poll

      unmount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.getAssessmentProgress.mock.calls.length).toBe(whileMounted);
    } finally {
      vi.useRealTimers();
    }
  });
});
