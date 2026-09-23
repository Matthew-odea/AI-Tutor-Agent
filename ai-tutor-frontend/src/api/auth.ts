import { API_ENDPOINTS } from "../config/api.config";
import apiClient from "./client";

export type LoginApiResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  user_id: string;
  email: string;
  roles: string[];
};

type MessageResponse = {
  message: string;
};

type ResetTokenValidationResponse = {
  valid: boolean;
};

export const loginWithEmailPassword = async (
  email: string,
  password: string,
): Promise<LoginApiResponse> => {
  const response = await apiClient.post<LoginApiResponse>(
    API_ENDPOINTS.AUTH_LOGIN,
    {
      email,
      password,
    },
  );

  return response.data;
};

export const signupWithEmailPassword = async (
  email: string,
  password: string,
): Promise<LoginApiResponse> => {
  const response = await apiClient.post<LoginApiResponse>(
    API_ENDPOINTS.AUTH_SIGNUP,
    {
      email,
      password,
    },
  );

  return response.data;
};

export const loginWithGoogleIdToken = async (
  idToken: string,
): Promise<LoginApiResponse> => {
  const response = await apiClient.post<LoginApiResponse>(
    API_ENDPOINTS.AUTH_GOOGLE,
    {
      id_token: idToken,
    },
  );

  return response.data;
};

export const requestPasswordReset = async (
  email: string,
): Promise<MessageResponse> => {
  const response = await apiClient.post<MessageResponse>(
    API_ENDPOINTS.AUTH_FORGOT_PASSWORD,
    {
      email,
    },
  );

  return response.data;
};

export const validatePasswordResetToken = async (
  token: string,
): Promise<boolean> => {
  const response = await apiClient.post<ResetTokenValidationResponse>(
    API_ENDPOINTS.AUTH_RESET_PASSWORD_VALIDATE,
    {
      token,
    },
  );

  return Boolean(response.data.valid);
};

export const resetPassword = async (
  token: string,
  newPassword: string,
): Promise<MessageResponse> => {
  const response = await apiClient.post<MessageResponse>(
    API_ENDPOINTS.AUTH_RESET_PASSWORD,
    {
      token,
      new_password: newPassword,
    },
  );

  return response.data;
};
