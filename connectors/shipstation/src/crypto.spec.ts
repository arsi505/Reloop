import {
  parseMasterEncryptionKey,
  encryptCredentials,
  decryptCredentials,
  EncryptionError,
} from './crypto';

describe('ShipStation Crypto Utilities', () => {
  const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const sampleCredentials = {
    apiKey: 'shipstation_live_secret_key_12345',
    keyId: 'v1',
    validatedAt: '2026-09-20T00:00:00.000Z',
  };

  describe('parseMasterEncryptionKey', () => {
    it('accepts 64-char hex string and produces 32-byte buffer', () => {
      const buf = parseMasterEncryptionKey(hexKey);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(32);
    });

    it('rejects empty or invalid keys', () => {
      expect(() => parseMasterEncryptionKey('')).toThrow(EncryptionError);
      expect(() => parseMasterEncryptionKey('too-short')).toThrow(EncryptionError);
      expect(() => parseMasterEncryptionKey(Buffer.alloc(16))).toThrow(EncryptionError);
    });
  });

  describe('encryptCredentials & decryptCredentials', () => {
    it('round-trips credential object correctly with AES-256-GCM', () => {
      const envelope = encryptCredentials(sampleCredentials, hexKey);
      expect(envelope.version).toBe(1);
      expect(envelope.algorithm).toBe('aes-256-gcm');
      expect(envelope.iv).toBeDefined();
      expect(envelope.tag).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.keyId).toBe('v1');

      const decrypted = decryptCredentials<typeof sampleCredentials>(envelope, hexKey);
      expect(decrypted).toEqual(sampleCredentials);
    });

    it('fails to decrypt if ciphertext is tampered with', () => {
      const envelope = encryptCredentials(sampleCredentials, hexKey);
      // Tamper with ciphertext
      const tamperedBytes = Buffer.from(envelope.ciphertext, 'base64');
      tamperedBytes[0] ^= 0xff;
      const tamperedEnvelope = { ...envelope, ciphertext: tamperedBytes.toString('base64') };

      expect(() => decryptCredentials(tamperedEnvelope, hexKey)).toThrow(EncryptionError);
    });

    it('fails to decrypt if authentication tag does not match', () => {
      const envelope = encryptCredentials(sampleCredentials, hexKey);
      const tamperedTag = Buffer.from(envelope.tag, 'base64');
      tamperedTag[0] ^= 0xff;
      const tamperedEnvelope = { ...envelope, tag: tamperedTag.toString('base64') };

      expect(() => decryptCredentials(tamperedEnvelope, hexKey)).toThrow(EncryptionError);
    });

    it('fails to decrypt with wrong master key', () => {
      const wrongHexKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const envelope = encryptCredentials(sampleCredentials, hexKey);

      expect(() => decryptCredentials(envelope, wrongHexKey)).toThrow(EncryptionError);
    });
  });
});
