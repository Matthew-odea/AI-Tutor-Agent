import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAssessmentStore } from '../store/assessmentStore';

// Every apiService method is an auto-created vi.fn(), so unstubbed calls resolve to undefined.
const api = vi.hoisted(() => {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(fns, { get: (t, k: string) => (t[k] ??= vi.fn()) });
});
vi.mock('../services/api', () => ({ apiService: api }));

import QuestionGenerationProgress from '../components/QuestionGenerationProgress';

describe('QuestionGenerationProgress', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset());
    useAssessmentStore.getState().reset();
    api.getAssessmentStudents.mockResolvedValue([]);
  });

  // The job lives in a global store; opening another assessment's Generate page
  // used to show the previous assessment's finished job as if it were this one's.
  it("does not show another assessment's generation job", async () => {
    useAssessmentStore.getState().setGenerationJob({
      jobId: 'j1', assessmentId: 'A', status: 'completed', totalStudents: 30, processedCount: 30, failedCount: 0,
    } as never);
    render(
      <MemoryRouter>
        <QuestionGenerationProgress assessmentId="B" />
      </MemoryRouter>
    );

    expect(await screen.findByRole('button', { name: 'Generate Questions' })).toBeInTheDocument();
    expect(screen.queryByText('Status: Completed')).not.toBeInTheDocument();
  });
});
