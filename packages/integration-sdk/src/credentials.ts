export interface EncryptedCredentialEnvelope {
  version: number;
  algorithm: 'aes-256-gcm';
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
  keyId: string;
}

export interface StoredShopifyCredential {
  accessToken: string;
  expiresAt?: string; // ISO date string (kept for backward compat)
  accessTokenExpiresAt?: string; // ISO date string
  refreshToken?: string;
  refreshTokenExpiresAt?: string; // ISO date string
  scope: string;
  tokenType?: string;
  associatedUser?: Record<string, unknown>;
}

export interface StoredShipStationCredential {
  apiKey: string;
  keyId?: string;
  validatedAt?: string;
}
