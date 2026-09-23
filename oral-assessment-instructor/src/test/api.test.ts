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

describe('apiService evaluation progress stream', () => {
  // The backend authenticates only from the Authorization header. The old EventSource
  // put the token in `?token=`, which was always 401, so live progress never showed.
  it('sends the token as a header, not in the URL, and delivers each data frame', async () => {
    localStorage.setItem('authToken', 'tok-123');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"status":"evaluating","questionsEvaluated":1}\n\n'));
        c.enqueue(encoder.encode('data: {"status":"comp'));
        c.enqueue(encoder.encode('leted","questionsEvaluated":2}\n\n'));
        c.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const stream = apiService.openStudentEvaluationProgressStream('a1', 's1');
    const messages: string[] = [];
    const ended = new Promise<void>((resolve) => {
      stream.onmessage = (e) => messages.push(JSON.parse(e.data).status);
      stream.onerror = () => resolve();
    });
    await ended;

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('token');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(messages).toEqual(['evaluating', 'completed']);
    vi.unstubAllGlobals();
  });
});
