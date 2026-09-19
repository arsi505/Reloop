import {
  encryptCredentials,
  decryptCredentials,
  parseMasterEncryptionKey,
  EncryptionError,
} from './crypto';

describe('Shopify Credential Authenticated Encryption (AES-256-GCM)', () => {
  const validHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const alternativeHexKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  it('validates 32-byte key encoding properly', () => {
    const keyBuf = parseMasterEncryptionKey(validHexKey);
    expect(keyBuf.length).toBe(32);

    expect(() => parseMasterEncryptionKey('')).toThrow(EncryptionError);
    expect(() => parseMasterEncryptionKey('too_short')).toThrow(EncryptionError);
    expect(() => parseMasterEncryptionKey(Buffer.alloc(16))).toThrow(EncryptionError);
  });

  it('performs full encrypt/decrypt round-trip with zero plaintext in envelope', () => {
    const payload = {
      accessToken: 'shpat_123456789abcdef',
      refreshToken: 'shprf_987654321fedcba',
      expiresAt: '2026-07-01T12:00:00Z',
      scope: 'read_orders,read_inventory',
    };

    const envelope = encryptCredentials(payload, validHexKey);

    expect(envelope.version).toBe(1);
    expect(envelope.algorithm).toBe('aes-256-gcm');
    expect(envelope.iv).toBeDefined();
    expect(envelope.tag).toBeDefined();
    expect(envelope.ciphertext).toBeDefined();

    // Verify plaintext does not appear in serialized envelope
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('shpat_');
    expect(serialized).not.toContain('shprf_');

    const decrypted = decryptCredentials<typeof payload>(envelope, validHexKey);
    expect(decrypted).toEqual(payload);
  });

  it('throws EncryptionError when ciphertext is tampered', () => {
    const payload = { secret: 'merchant-token' };
    const envelope = encryptCredentials(payload, validHexKey);

    // Tamper ciphertext
    const tamperedCiphertext = Buffer.from(envelope.ciphertext, 'base64');
    tamperedCiphertext[0] ^= 0xff;
    const tamperedEnvelope = { ...envelope, ciphertext: tamperedCiphertext.toString('base64') };

    expect(() => decryptCredentials(tamperedEnvelope, validHexKey)).toThrow(EncryptionError);
  });

  it('throws EncryptionError when auth tag is tampered', () => {
    const payload = { secret: 'merchant-token' };
    const envelope = encryptCredentials(payload, validHexKey);

    // Tamper tag
    const tamperedTag = Buffer.from(envelope.tag, 'base64');
    tamperedTag[0] ^= 0xff;
    const tamperedEnvelope = { ...envelope, tag: tamperedTag.toString('base64') };

    expect(() => decryptCredentials(tamperedEnvelope, validHexKey)).toThrow(EncryptionError);
  });

  it('fails decryption with wrong encryption key', () => {
    const payload = { secret: 'merchant-token' };
    const envelope = encryptCredentials(payload, validHexKey);

    expect(() => decryptCredentials(envelope, alternativeHexKey)).toThrow(EncryptionError);
  });
});
