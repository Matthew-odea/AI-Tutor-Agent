import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

// ── Controllable fake axios instance ───────────────────────────────────────
// We mock `axios.create` to return a callable instance whose response-interceptor
// error handler we capture, then drive it directly. This lets us assert the
// single-flight refresh behavior without a real network.

type ErrorHandler = (err: AxiosError) => Promise<unknown>;

// Declared via vi.hoisted so they exist when the hoisted vi.mock factory runs.
const h = vi.hoisted(() => ({
  capturedErrorHandler: null as ErrorHandler | null,
  tokenPostMock: vi.fn(),
  replayMock: vi.fn(),
}));
const tokenPostMock = h.tokenPostMock;
const replayMock = h.replayMock;

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();

  // The instance is itself callable (apiClient(originalRequest)).
  const instance = Object.assign(
    (config: unknown) => h.replayMock(config),
    {
      post: (url: string, body: unknown) => {
        if (url.includes('/auth/student/exchange')) return h.tokenPostMock(body);
        return Promise.resolve({ data: {} });
      },
      put: vi.fn().mockResolvedValue({ data: {} }),
      get: vi.fn().mockResolvedValue({ data: {} }),
      interceptors: {
        request: { use: vi.fn() },
        response: {
          use: (_onFulfilled: unknown, onRejected: ErrorHandler) => {
            h.capturedErrorHandler = onRejected;
          },
        },
      },
    }
  );

  return {
    ...actual,
    default: {
      ...actual.default,
      create: () => instance,
      isAxiosError: actual.isAxiosError,
      put: vi.fn().mockResolvedValue({ data: {} }),
    },
    isAxiosError: actual.isAxiosError,
    create: () => instance,
  };
});

// Import AFTER the mock is registered so the module wires our fake instance.
import '../services/api';

function make401(url: string): AxiosError {
  const err = new AxiosError('Unauthorized');
  const headers = new AxiosHeaders();
  err.config = { url, headers };
  err.response = {
    status: 401,
    statusText: 'Unauthorized',
    data: {},
    headers: {},
    config: { headers },
  };
  return err;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  // The session is renewed by re-exchanging the student's own invite token.
  localStorage.setItem('inviteToken', 'invite-abc');
  tokenPostMock.mockReset();
  replayMock.mockReset();
  replayMock.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('single-flight session renewal interceptor', () => {
  it('captured the response error handler', () => {
    expect(h.capturedErrorHandler).toBeTypeOf('function');
  });

  it('N concurrent 401s trigger exactly ONE invite exchange and all are replayed', async () => {
    let resolveToken: (v: { data: { access_token: string } }) => void = () => {};
    tokenPostMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        })
    );

    // Fire 5 concurrent 401s.
    const requests = Array.from({ length: 5 }, (_, i) =>
      h.capturedErrorHandler!(make401(`/api/student/req${i}`))
    );

    // Let microtasks settle so all 5 reach the await on refreshPromise.
    await Promise.resolve();
    await Promise.resolve();

    // Resolve the single in-flight token POST.
    resolveToken({ data: { access_token: 'fresh-token' } });
    await Promise.all(requests);

    expect(tokenPostMock).toHaveBeenCalledTimes(1);
    expect(replayMock).toHaveBeenCalledTimes(5);
    expect(localStorage.getItem('studentToken')).toBe('fresh-token');
    // Every replay carried the fresh Authorization header.
    for (const call of replayMock.mock.calls) {
      expect(call[0].headers['Authorization']).toBe('Bearer fresh-token');
    }
  });

  it('refresh failure rejects all waiters (none replayed)', async () => {
    tokenPostMock.mockRejectedValue(new Error('refresh failed'));

    const original1 = make401('/api/student/r1');
    const original2 = make401('/api/student/r2');
    const results = await Promise.allSettled([
      h.capturedErrorHandler!(original1),
      h.capturedErrorHandler!(original2),
    ]);

    expect(tokenPostMock).toHaveBeenCalledTimes(1);
    expect(replayMock).not.toHaveBeenCalled();
    // Both reject with the original error (refresh swallowed → fall through).
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
  });

  it('clears the in-flight promise so a SUBSEQUENT expiry can refresh again', async () => {
    tokenPostMock.mockResolvedValue({ data: { access_token: 't1' } });
    await h.capturedErrorHandler!(make401('/api/student/first'));
    expect(tokenPostMock).toHaveBeenCalledTimes(1);

    tokenPostMock.mockResolvedValue({ data: { access_token: 't2' } });
    await h.capturedErrorHandler!(make401('/api/student/second'));
    expect(tokenPostMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('studentToken')).toBe('t2');
  });

  it('does NOT refresh the exchange endpoint itself (avoids loops)', async () => {
    await h.capturedErrorHandler!(make401('/api/auth/student/exchange')).catch(() => {});
    expect(tokenPostMock).not.toHaveBeenCalled();
  });

  it('does NOT refresh when no invite token is stored', async () => {
    localStorage.clear();
    await h.capturedErrorHandler!(make401('/api/student/r1')).catch(() => {});
    expect(tokenPostMock).not.toHaveBeenCalled();
  });

  it('sends the stored invite token to the exchange endpoint', async () => {
    tokenPostMock.mockResolvedValue({ data: { access_token: 't1' } });
    await h.capturedErrorHandler!(make401('/api/student/r1'));
    expect(tokenPostMock).toHaveBeenCalledWith({ invite_token: 'invite-abc' });
  });

  it('respects the _retried guard (no double refresh for one request)', async () => {
    tokenPostMock.mockResolvedValue({ data: { access_token: 't1' } });
    const err = make401('/api/student/r1');
    (err.config as { _retried?: boolean })._retried = true;
    await h.capturedErrorHandler!(err).catch(() => {});
    expect(tokenPostMock).not.toHaveBeenCalled();
  });
});
