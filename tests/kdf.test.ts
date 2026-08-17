import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_PBKDF2_PARAMS,
  DERIVED_KEY_BYTES,
  KDF_ARGON2ID,
  KDF_PBKDF2,
  deriveKey,
  isArgon2Available,
  preferredKdfSpec,
  randomBytes,
} from '../src/core/crypto/kdf';
import { zeroize } from '../src/core/crypto/zeroize';

const cheapArgon = { kdf: KDF_ARGON2ID, params: { m: 1024, t: 1, p: 1 } } as const;
const cheapPbkdf2 = { kdf: KDF_PBKDF2, params: { iterations: 1000 } } as const;

describe('kdf', () => {
  it('derives a 32-byte key with Argon2id', async () => {
    const salt = randomBytes(16);
    const key = await deriveKey('correct horse battery staple', salt, cheapArgon);
    expect(key.length).toBe(DERIVED_KEY_BYTES);
  });

  it('is deterministic for the same password and salt', async () => {
    const salt = randomBytes(16);
    const a = await deriveKey('pw', salt, cheapArgon);
    const b = await deriveKey('pw', salt, cheapArgon);
    expect(a).toEqual(b);
  });

  it('produces a different key for a different password', async () => {
    const salt = randomBytes(16);
    const a = await deriveKey('pw-a', salt, cheapArgon);
    const b = await deriveKey('pw-b', salt, cheapArgon);
    expect(a).not.toEqual(b);
  });

  it('produces a different key for a different salt', async () => {
    const a = await deriveKey('pw', randomBytes(16), cheapArgon);
    const b = await deriveKey('pw', randomBytes(16), cheapArgon);
    expect(a).not.toEqual(b);
  });

  it('derives a 32-byte key with the PBKDF2-SHA-512 fallback', async () => {
    const salt = randomBytes(16);
    const key = await deriveKey('pw', salt, cheapPbkdf2);
    expect(key.length).toBe(DERIVED_KEY_BYTES);
  });

  it('matches the RFC 6070 style PBKDF2-SHA-512 reference vector', async () => {
    // PBKDF2-HMAC-SHA512, password "password", salt "salt", 1 iteration.
    const salt = new TextEncoder().encode('salt');
    const key = await deriveKey('password', salt, {
      kdf: KDF_PBKDF2,
      params: { iterations: 1 },
    });
    const hex = Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252');
  });

  it('yields different keys for the two KDFs', async () => {
    const salt = randomBytes(16);
    const a = await deriveKey('pw', salt, cheapArgon);
    const b = await deriveKey('pw', salt, cheapPbkdf2);
    expect(a).not.toEqual(b);
  });

  it('reports Argon2id as available and prefers it', async () => {
    expect(await isArgon2Available()).toBe(true);
    const spec = await preferredKdfSpec();
    expect(spec.kdf).toBe(KDF_ARGON2ID);
    expect(spec.params).toEqual(DEFAULT_ARGON2ID_PARAMS);
  });

  it('keeps sane production defaults', () => {
    expect(DEFAULT_PBKDF2_PARAMS.iterations).toBe(600_000);
    expect(DEFAULT_ARGON2ID_PARAMS.m).toBeGreaterThanOrEqual(19_456);
  });

  it('zeroizes buffers in place', () => {
    const buf = randomBytes(32);
    zeroize(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });
});
