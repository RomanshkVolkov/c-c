export interface Session {
  id: string;
  username: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  session: Session;
}

export interface AuthRefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface APIResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
