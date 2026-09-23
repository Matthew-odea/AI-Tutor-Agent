import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { handleApiError } from '../services/api';

function failWith(status: number, data: unknown): unknown {
  const err = new AxiosError('Request failed with status code ' + status);
  err.response = { status, statusText: '', headers: {}, config: { headers: new AxiosHeaders() }, data };
  try {
    handleApiError(err);
  } catch (thrown) {
    return thrown;
  }
  throw new Error('handleApiError did not throw');
}

describe('handleApiError', () => {
  it("surfaces the envelope's message, not axios's generic one", () => {
    // "already submitted" must reach the store: submitAssessment treats it as success.
    const thrown = failWith(400, { ok: false, error: { code: 'submit_failed', message: 'Assessment already submitted' } });
    expect(thrown).toMatchObject({ message: 'Assessment already submitted', status: 400 });
  });

  it('keeps the friendly text for an unmatched route', () => {
    const thrown = failWith(404, { ok: false, error: { code: 'not_found', message: 'Not Found' } });
    expect((thrown as { message: string }).message).toMatch(/Assessment not found/);
  });
});
