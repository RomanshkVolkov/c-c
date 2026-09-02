export interface Session {
  id: string;
  username: string;
  /** Cómo se le llama. Puede faltar; ver `nombreDe`. */
  name?: string;
  /** Shown in the account menu: the username alone does not tell two accounts
   *  apart on a shared machine. */
  email?: string;
  superadmin?: boolean;
  mustChangePassword?: boolean;
  /** In which language this person reads cac; empty means "ask the machine". */
  locale?: string;
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
