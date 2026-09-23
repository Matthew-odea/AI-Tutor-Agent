/**
 * S3 Upload Service - Handles audio file uploads
 */

import axios, { AxiosError } from 'axios';
import { getUploadUrl, uploadAudioToS3 } from './api';
import type { UploadTarget } from './api';
import type { ApiError } from '../types';

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

/**
 * A presigned S3 PUT can fail because the URL expired (S3 returns 403, often with
 * a `SignatureDoesNotMatch`/`AuthorizationExpired` body) — this is distinct from
 * the network/5xx transient retries handled inside uploadAudioToS3's withRetry.
 * uploadAudioToS3 rethrows an ApiError whose `details` is the underlying
 * AxiosError, so we inspect that to decide whether refetching a fresh URL would
 * help.
 */
function isPresignedUrlExpired(err: unknown): boolean {
  const details = (err as ApiError | undefined)?.details;
  if (axios.isAxiosError(details)) {
    if (details.response?.status === 403) return true;
    const body = details.response?.data;
    if (typeof body === 'string' && /SignatureDoesNotMatch|expired/i.test(body)) {
      return true;
    }
  }
  return false;
}

/**
 * Upload a media blob (audio or video) to S3 via a presigned URL.
 * Returns the permanent S3 file URL.
 */
async function uploadMedia(
  blob: Blob,
  target: UploadTarget,
  onProgress?: (progress: UploadProgress) => void
): Promise<string> {
  const reportProgress = (percentage: number) => {
    if (onProgress) {
      onProgress({
        loaded: (blob.size * percentage) / 100,
        total: blob.size,
        percentage,
      });
    }
  };

  const { uploadUrl, fileUrl } = await getUploadUrl(target, blob.type);
  try {
    await uploadAudioToS3(uploadUrl, blob, reportProgress);
    return fileUrl;
  } catch (error) {
    // If the presigned URL expired (403), refetch a FRESH url exactly once and
    // retry the PUT against it. Any other failure (including a second expiry)
    // propagates to uploadAudio's error-message mapping unchanged.
    if (!isPresignedUrlExpired(error)) throw error;
    const refreshed = await getUploadUrl(target, blob.type);
    await uploadAudioToS3(refreshed.uploadUrl, blob, reportProgress);
    return refreshed.fileUrl;
  }
}

/**
 * Map an upload failure to a friendly, user-facing Error.
 *
 * Important: uploadAudioToS3 rethrows an `ApiError` *plain object*
 * `{ message: 'Failed to upload audio file', details: <AxiosError> }`, which is
 * NOT an `instanceof Error`. So the AxiosError-derived cases (timeout / 403 /
 * network) must be detected by inspecting `details`, BEFORE the
 * `instanceof Error` string-matching branch (which only catches the
 * descriptive validation Errors thrown by validateAudioBlob et al).
 */
function toFriendlyUploadError(error: unknown): Error {
  // ApiError-shaped failures from uploadAudioToS3 carry the AxiosError on .details.
  const details = (error as ApiError | undefined)?.details;
  if (axios.isAxiosError(details)) {
    const ax = details as AxiosError;
    const status = ax.response?.status;
    if (status === 403) {
      return new Error('Upload authorization expired. Please try again.');
    }
    if (ax.code === 'ECONNABORTED') {
      return new Error('Upload timed out. Please check your connection and try again.');
    }
    if (ax.code === 'ERR_NETWORK' || (!ax.response && ax.request)) {
      return new Error('Network error: please check your internet connection and try again.');
    }
  }

  if (error instanceof Error) {
    if (error.message.includes('too large') || error.message.includes('Maximum size')) {
      return error; // Already a descriptive validation error
    }
    if (error.message.includes('Network Error') || error.message.includes('ERR_NETWORK') || error.message === 'Failed to fetch') {
      return new Error('Network error: please check your internet connection and try again.');
    }
    if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      return new Error('Upload timed out. Please check your connection and try again.');
    }
    if (error.message.includes('403') || error.message.includes('Forbidden')) {
      return new Error('Upload authorization expired. Please try again.');
    }
  }

  return new Error('Failed to upload audio file. Please try again.');
}

/**
 * Upload audio blob to S3 and return the file URL
 */
export async function uploadAudio(
  audioBlob: Blob,
  questionId: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<string> {
  try {
    // The key (audio/<student>/<question>_<timestamp>.<ext>) is built server-side
    // from the auth token, so no student id is sent from here.
    return await uploadMedia(audioBlob, { kind: 'audio', questionId }, onProgress);
  } catch (error) {
    console.error('Failed to upload audio:', error);
    throw toFriendlyUploadError(error);
  }
}

/**
 * Validate audio blob before upload
 */
export function validateAudioBlob(blob: Blob, maxSizeMB: number = 50): boolean {
  if (!blob || blob.size === 0) {
    throw new Error('Audio recording is empty');
  }

  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  if (blob.size > maxSizeBytes) {
    throw new Error(`Audio file is too large. Maximum size is ${maxSizeMB}MB`);
  }

  if (!blob.type.includes('audio')) {
    throw new Error('Invalid audio format');
  }

  return true;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export default {
  uploadAudio,
  validateAudioBlob,
  formatFileSize,
};
