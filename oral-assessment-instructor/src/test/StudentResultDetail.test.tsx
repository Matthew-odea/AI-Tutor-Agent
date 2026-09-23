import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useToastStore } from '../store/toastStore';

// Every apiService method is an auto-created vi.fn(), so unstubbed calls resolve to undefined.
const api = vi.hoisted(() => {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(fns, { get: (t, k: string) => (t[k] ??= vi.fn()) });
});
vi.mock('../services/api', () => ({ apiService: api }));

import StudentResultDetail from '../pages/StudentResultDetail';

const question = (over: Record<string, unknown> = {}) => ({
  questionId: 'q1',
  questionText: 'Explain your loop',
  maxScore: 10,
  aiScore: 4,
  instructorScore: null,
  effectiveScore: 4,
  needsReview: false,
  ...over,
});

const detail = (q: ReturnType<typeof question>) => ({
  ok: true,
  studentId: 's1',
  studentName: 'Student One',
  studentEmail: 's1@example.edu',
  assessmentId: 'a1',
  totalScore: q.effectiveScore ?? 0,
  maxScore: 10,
  percentage: ((q.effectiveScore as number | null) ?? 0) * 10,
  grade: 'Developing',
  questions: [q],
  proctoring: { totalChunks: 0, missingIndexes: [], chunks: [] },
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/assessments/a1/student/s1/results']}>
      <Routes>
        <Route path="/assessments/:assessmentId/student/:studentId/results" element={<StudentResultDetail />} />
      </Routes>
    </MemoryRouter>
  );

// The collapsed question header's score chip, e.g. "4 / 10".
const headerChip = () => within(screen.getByRole('button', { name: /Explain your loop/ })).getByText(/\/ 10/);

describe('StudentResultDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(api).forEach(fn => fn.mockReset());
    useToastStore.setState({ toasts: [] });
  });

  it('sends the typed override score and then shows the override, not the AI score', async () => {
    api.getStudentDetail
      .mockResolvedValueOnce(detail(question()))
      .mockResolvedValueOnce(detail(question({ instructorScore: 7, effectiveScore: 7 })));
    api.overrideScore.mockResolvedValue({ ok: true });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Explain your loop/ }));
    expect(headerChip()).toHaveTextContent('4 / 10');
    fireEvent.click(screen.getByRole('button', { name: 'Set Override' }));
    fireEvent.change(screen.getByLabelText('Override score (0-10)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Override comment (optional)'), { target: { value: 'Explained it in viva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(headerChip()).toHaveTextContent('7 / 10'));
    expect(api.overrideScore).toHaveBeenCalledWith('a1', 's1', 'q1', 7, 'Explained it in viva');
    // The form closes after a save, so the instructor can see and edit the saved override.
    expect(screen.getByRole('button', { name: 'Edit Override' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Override score (0-10)')).not.toBeInTheDocument();
  });

  it('rejects an out-of-range override without calling the server', async () => {
    api.getStudentDetail.mockResolvedValue(detail(question()));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Explain your loop/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Set Override' }));
    fireEvent.change(screen.getByLabelText('Override score (0-10)'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Score must be between 0 and 10');
    expect(api.overrideScore).not.toHaveBeenCalled();
  });

  it('shows a question awaiting review as flagged and ungraded, with the reason', async () => {
    api.getStudentDetail.mockResolvedValue(
      detail(question({ aiScore: null, effectiveScore: null, needsReview: true, reviewReasons: ['low_confidence_transcript'] }))
    );
    renderPage();

    const header = await screen.findByRole('button', { name: /Explain your loop/ });
    expect(within(header).getByText('⚠ review')).toBeInTheDocument();
    expect(headerChip()).toHaveTextContent('— / 10');
    fireEvent.click(header);
    expect(screen.getByText('⚠ Flagged for instructor review')).toBeInTheDocument();
    expect(screen.getByText('Low transcription confidence')).toBeInTheDocument();
  });
});
