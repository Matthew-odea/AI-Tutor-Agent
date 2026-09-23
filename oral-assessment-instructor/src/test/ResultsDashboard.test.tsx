import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useToastStore } from '../store/toastStore';
import { useAssessmentStore } from '../store/assessmentStore';

// Every apiService method is an auto-created vi.fn(), so unstubbed calls resolve to undefined.
const api = vi.hoisted(() => {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(fns, { get: (t, k: string) => (t[k] ??= vi.fn()) });
});
vi.mock('../services/api', () => ({ apiService: api }));

import ResultsDashboard from '../components/ResultsDashboard';

const result = (studentId: string, over: Record<string, unknown> = {}) => ({
  studentId,
  name: `Student ${studentId}`,
  totalScore: 7,
  maxScore: 10,
  percentage: 70,
  grade: 'Competent',
  completedAt: null,
  ...over,
});

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <ResultsDashboard assessmentId="a1" />
    </MemoryRouter>
  );

const toasts = () => useToastStore.getState().toasts;

describe('ResultsDashboard', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset());
    useToastStore.setState({ toasts: [] });
    useAssessmentStore.getState().reset();
    api.getAssessment.mockResolvedValue({ id: 'a1', resultsReleased: false });
    api.getAssessmentResults.mockResolvedValue([result('s1')]);
    api.getAssessmentProgress.mockResolvedValue([{ studentId: 's1', status: 'completed' }]);
  });

  it('asks for confirmation before releasing, and Cancel releases nothing', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Release Results' }));

    expect(api.releaseResults).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm release?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.releaseResults).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Release Results' })).toBeInTheDocument();
  });

  it('releases on confirm and shows the released state', async () => {
    api.releaseResults.mockResolvedValue({ ok: true, assessmentId: 'a1', resultsReleased: true });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Release Results' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Release' }));

    expect(await screen.findByText('Results Released')).toBeInTheDocument();
    expect(api.releaseResults).toHaveBeenCalledTimes(1);
    expect(api.releaseResults).toHaveBeenCalledWith('a1');
    expect(toasts()).toEqual([expect.objectContaining({ type: 'success' })]);
  });

  it('warns in the confirm step when some submitted students have no evaluation', async () => {
    api.getAssessmentProgress.mockResolvedValue([
      { studentId: 's1', status: 'completed' },
      { studentId: 's2', status: 'completed' },
    ]);
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Release Results' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Only 1 of 2 submitted students have been evaluated.');
  });

  it('passes on the server warning when it released with students still unevaluated', async () => {
    api.releaseResults.mockResolvedValue({
      ok: true,
      assessmentId: 'a1',
      resultsReleased: true,
      warning: 'Only 1/2 submitted students have been evaluated',
    });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Release Results' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Release' }));

    await screen.findByText('Results Released');
    expect(toasts()).toEqual([
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('Only 1/2 submitted students have been evaluated') }),
    ]);
  });

  it('stays unreleased and reports the error when the release fails', async () => {
    api.releaseResults.mockRejectedValue(new Error('Network Error'));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Release Results' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Release' }));

    expect(await screen.findByRole('button', { name: 'Release Results' })).toBeInTheDocument();
    expect(screen.queryByText('Results Released')).not.toBeInTheDocument();
    expect(toasts()).toEqual([expect.objectContaining({ type: 'error', message: 'Network Error' })]);
  });

  it('shows each student score and grade, and "Not Graded" when there is no grade', async () => {
    api.getAssessmentResults.mockResolvedValue([
      result('s1'),
      result('s2', { totalScore: 3, percentage: 30, grade: null }),
    ]);
    renderDashboard();

    const row1 = (await screen.findByText('Student s1')).closest('tr')!;
    expect(within(row1).getByText('7/10 (70%)')).toBeInTheDocument();
    expect(within(row1).getByText('Competent')).toBeInTheDocument();
    const row2 = screen.getByText('Student s2').closest('tr')!;
    expect(within(row2).getByText('3/10 (30%)')).toBeInTheDocument();
    expect(within(row2).getByText('Not Graded')).toBeInTheDocument();
  });
});
