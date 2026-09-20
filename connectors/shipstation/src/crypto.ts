import * as crypto from 'crypto';
import { EncryptedCredentialEnvelope } from '@reloop/integration-sdk';

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * Validates and converts master key into a 32-byte Buffer.
 * Supports 64-char hex strings or 32-byte raw Buffers.
 */
export function parseMasterEncryptionKey(keyInput: string | Buffer): Buffer {
  if (!keyInput) {
    throw new EncryptionError('Encryption key is required and cannot be empty');
  }

  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== 32) {
      throw new EncryptionError(`Encryption key buffer must be exactly 32 bytes, got ${keyInput.length}`);
    }
    return keyInput;
  }

  if (typeof keyInput === 'string') {
    const trimmed = keyInput.trim();
    if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    if (trimmed.length === 44 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length === 32) {
        return buf;
      }
    }
    const utf8Buf = Buffer.from(trimmed, 'utf8');
    if (utf8Buf.length === 32) {
      return utf8Buf;
    }
    throw new EncryptionError(
      'Invalid encryption key format: expected 64-character hex string or 32-byte base64 string',
    );
  }

  throw new EncryptionError('Encryption key must be a string or Buffer');
}

/**
 * Encrypts an object with AES-256-GCM.
 * Returns a versioned, authenticated envelope.
 */
export function encryptCredentials(
  data: unknown,
  masterKey: string | Buffer,
  keyId = 'v1',
): EncryptedCredentialEnvelope {
  const keyBuffer = parseMasterEncryptionKey(masterKey);
  const iv = crypto.randomBytes(12); // Recommended 12 bytes for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    keyId,
  };
}

/**
 * Decrypts an authenticated AES-256-GCM envelope.
 * Throws EncryptionError if decryption fails or authentication tag does not match.
 */
export function decryptCredentials<T = unknown>(
  envelope: EncryptedCredentialEnvelope,
  masterKey: string | Buffer,
): T {
  if (!envelope || envelope.algorithm !== 'aes-256-gcm' || envelope.version !== 1) {
    throw new EncryptionError('Unsupported or invalid encrypted envelope structure');
  }

  const keyBuffer = parseMasterEncryptionKey(masterKey);

  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

    if (iv.length !== 12) {
      throw new EncryptionError(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
    }

    if (tag.length !== 16) {
      throw new EncryptionError(`Invalid tag length: expected 16 bytes, got ${tag.length}`);
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch (err: unknown) {
    if (err instanceof EncryptionError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new EncryptionError(`Decryption failed: authentication check failed or corrupted data (${message})`);
  }
}
