import axios, { AxiosError } from 'axios';
import { getUploadUrl, uploadAudioToS3 } from './api';
import type { UploadTarget } from './api';
import type { ApiError } from '../types';

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

// Expired presigned URL (S3 403 / SignatureDoesNotMatch), distinct from the transient retries
// in uploadAudioToS3. The AxiosError lives on the ApiError's `details`.
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

/** Returns the permanent S3 file URL. */
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
    // Expired URL: refetch once and retry. Anything else, or a second expiry, propagates.
    if (!isPresignedUrlExpired(error)) throw error;
    const refreshed = await getUploadUrl(target, blob.type);
    await uploadAudioToS3(refreshed.uploadUrl, blob, reportProgress);
    return refreshed.fileUrl;
  }
}

// uploadAudioToS3 throws a plain ApiError object (not instanceof Error) with the AxiosError
// on `details`, so check that first; the instanceof branch is for validation Errors.
function toFriendlyUploadError(error: unknown): Error {
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
      return error;
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

export async function uploadAudio(
  audioBlob: Blob,
  questionId: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<string> {
  try {
    // The server builds the key from the auth token, so no student id is sent.
    return await uploadMedia(audioBlob, { kind: 'audio', questionId }, onProgress);
  } catch (error) {
    console.error('Failed to upload audio:', error);
    throw toFriendlyUploadError(error);
  }
}

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
