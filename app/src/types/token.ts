export interface AccessToken {
  id: string;
  name: string;
  preview: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

export interface CreateTokenResult {
  token: AccessToken;
  /** Plaintext token — returned once, at creation. Never stored by cac. */
  value: string;
}
