import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ApiError } from '../types';

// Part A: uploadAudioToS3's timeout. api.ts also calls axios.create(), so provide a benign instance.
const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  const instance = Object.assign((c: unknown) => Promise.resolve(c), {
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  });
  return {
    ...actual,
    default: { ...actual.default, create: () => instance, put: putMock, isAxiosError: actual.isAxiosError },
    create: () => instance,
    put: putMock,
    isAxiosError: actual.isAxiosError,
  };
});

import { uploadAudioToS3 } from '../services/api';

beforeEach(() => {
  putMock.mockReset();
  // Make backoff instant.
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploadAudioToS3 — S3 PUT timeout', () => {
  it('passes an explicit finite timeout to the bare axios.put', async () => {
    putMock.mockResolvedValue({ data: {} });
    const blob = new Blob(['x'], { type: 'audio/webm' });
    await uploadAudioToS3('https://s3/put', blob);
    expect(putMock).toHaveBeenCalledTimes(1);
    const config = putMock.mock.calls[0][2];
    expect(config.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(config.timeout)).toBe(true);
    expect(config.timeout).toBe(120000);
  });

  it('retries a timeout (ECONNABORTED) and succeeds, then throws ApiError if all fail', async () => {
    const timeout = new AxiosError('timeout', 'ECONNABORTED');
    (timeout as unknown as { request: unknown }).request = {};
    const blob = new Blob(['x'], { type: 'audio/webm' });

    putMock.mockRejectedValueOnce(timeout).mockResolvedValueOnce({ data: {} });
    await expect(uploadAudioToS3('https://s3/put', blob)).resolves.toBeUndefined();
    expect(putMock).toHaveBeenCalledTimes(2);

    putMock.mockReset();
    putMock.mockRejectedValue(timeout);
    await expect(uploadAudioToS3('https://s3/put', blob)).rejects.toMatchObject({
      message: 'Failed to upload audio file',
    });
  });
});

// Part B: uploadMedia refetches a presigned URL on a 403 PUT.
vi.resetModules();

const getUploadUrlMock = vi.fn();
const uploadToS3Mock = vi.fn();

vi.doMock('../services/api', () => ({
  getUploadUrl: getUploadUrlMock,
  uploadAudioToS3: uploadToS3Mock,
}));

function expired403(): ApiError {
  const ax = new AxiosError('Forbidden');
  ax.response = {
    status: 403,
    statusText: 'Forbidden',
    data: '<Error><Code>SignatureDoesNotMatch</Code></Error>',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return { message: 'Failed to upload audio file', details: ax };
}

describe('uploadMedia — presigned URL refetch on 403', () => {
  beforeEach(() => {
    getUploadUrlMock.mockReset();
    uploadToS3Mock.mockReset();
  });

  it('refetches getUploadUrl exactly once and retries the PUT against the fresh url', async () => {
    const { uploadAudio } = await import('../services/s3');

    getUploadUrlMock
      .mockResolvedValueOnce({ uploadUrl: 'https://s3/stale', fileUrl: 'https://s3/file1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://s3/fresh', fileUrl: 'https://s3/file2' });
    uploadToS3Mock
      .mockRejectedValueOnce(expired403())
      .mockResolvedValueOnce(undefined);

    const blob = new Blob(['x'], { type: 'audio/webm' });
    const url = await uploadAudio(blob, 'q1');

    expect(getUploadUrlMock).toHaveBeenCalledTimes(2); // initial + one refetch
    expect(uploadToS3Mock).toHaveBeenCalledTimes(2);
    // Second PUT used the fresh url, and the fresh fileUrl is returned.
    expect(uploadToS3Mock.mock.calls[1][0]).toBe('https://s3/fresh');
    expect(url).toBe('https://s3/file2');
  });

  it('does NOT refetch on a non-403 failure, and maps the ApiError to a friendly network message', async () => {
    const { uploadAudio } = await import('../services/s3');

    getUploadUrlMock.mockResolvedValue({ uploadUrl: 'https://s3/u', fileUrl: 'https://s3/f' });
    const netErr = new AxiosError('Network Error', 'ERR_NETWORK');
    (netErr as unknown as { request: unknown }).request = {};
    uploadToS3Mock.mockRejectedValue({ message: 'Failed to upload audio file', details: netErr });

    const blob = new Blob(['x'], { type: 'audio/webm' });
    // uploadAudioToS3 throws a plain ApiError object, not an Error; mapping must read .details.
    await expect(uploadAudio(blob, 'q1')).rejects.toThrow(
      'Network error: please check your internet connection and try again.'
    );
    expect(getUploadUrlMock).toHaveBeenCalledTimes(1); // no refetch
    expect(uploadToS3Mock).toHaveBeenCalledTimes(1);
  });

  it('maps an ApiError-wrapped ECONNABORTED timeout to the friendly timeout message', async () => {
    const { uploadAudio } = await import('../services/s3');

    getUploadUrlMock.mockResolvedValue({ uploadUrl: 'https://s3/u', fileUrl: 'https://s3/f' });
    const timeout = new AxiosError('timeout', 'ECONNABORTED');
    (timeout as unknown as { request: unknown }).request = {};
    uploadToS3Mock.mockRejectedValue({ message: 'Failed to upload audio file', details: timeout });

    const blob = new Blob(['x'], { type: 'audio/webm' });
    await expect(uploadAudio(blob, 'q1')).rejects.toThrow(
      'Upload timed out. Please check your connection and try again.'
    );
  });

  it('only refetches ONCE — a second 403 propagates and maps to the friendly auth-expired message', async () => {
    const { uploadAudio } = await import('../services/s3');

    getUploadUrlMock
      .mockResolvedValueOnce({ uploadUrl: 'https://s3/u1', fileUrl: 'https://s3/f1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://s3/u2', fileUrl: 'https://s3/f2' });
    uploadToS3Mock.mockRejectedValue(expired403());

    const blob = new Blob(['x'], { type: 'audio/webm' });
    await expect(uploadAudio(blob, 'q1')).rejects.toThrow(
      'Upload authorization expired. Please try again.'
    );
    expect(getUploadUrlMock).toHaveBeenCalledTimes(2); // initial + exactly one refetch
    expect(uploadToS3Mock).toHaveBeenCalledTimes(2);
  });
});
