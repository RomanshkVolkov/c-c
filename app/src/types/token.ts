export interface AccessToken {
  id: string;
  name: string;
  preview: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  /** Empty or absent means read-only. */
  scopes?: string[];
}

export interface CreateTokenResult {
  token: AccessToken;
  /** Plaintext token — returned once, at creation. Never stored by cac. */
  value: string;
}
