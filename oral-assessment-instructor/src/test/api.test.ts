import { describe, it, expect, vi } from 'vitest';

// api.ts builds its own axios instance; capture what it posts.
const post = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));
vi.mock('axios', () => ({
  default: { create: () => ({ post, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }) },
}));

import { apiService } from '../services/api';

describe('apiService student selection payloads', () => {
  // The backend reads `studentIds`; the app used to send `student_ids`, which the
  // server ignored, so "these students only" silently meant "everyone".
  it('sends the chosen students as studentIds when generating questions', async () => {
    await apiService.generateQuestions('a1', ['s1', 's2']);
    expect(post).toHaveBeenLastCalledWith('/api/assessment/a1/generate-questions-batch', { studentIds: ['s1', 's2'] });
  });

  it('sends the chosen students as studentIds when evaluating', async () => {
    await apiService.evaluateAssessment('a1', ['s2']);
    expect(post).toHaveBeenLastCalledWith('/api/assessment/a1/evaluate-batch', { studentIds: ['s2'] });
  });
});
