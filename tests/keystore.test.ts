import { describe, expect, it } from 'vitest';
import {
  BadPasswordError,
  IV_BYTES,
  KEYSTORE_VERSION,
  LEGACY_KEYSTORE_VERSION,
  decryptJson,
  decryptKeystore,
  encryptJson,
  encryptKeystore,
  fromBase64,
  keystoreSchema,
  toBase64,
  type Keystore,
} from '../src/core/crypto/keystore';
import {
  KDF_ARGON2ID,
  KDF_PBKDF2,
  SALT_BYTES,
  deriveKey,
  randomBytes,
  type KdfSpec,
} from '../src/core/crypto/kdf';

const cheapArgon = { kdf: KDF_ARGON2ID, params: { m: 1024, t: 1, p: 1 } } as const;
const cheapPbkdf2 = { kdf: KDF_PBKDF2, params: { iterations: 1000 } } as const;

const secret = new TextEncoder().encode('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN');

/**
 * Produce a blob exactly as the shipped v1 code did: same envelope, but no
 * `additionalData` on the GCM encrypt. Real v1 keystores exist in the wild and
 * must keep decrypting until every install has passed one unlock.
 */
async function encryptLegacyV1(
  plaintext: Uint8Array,
  password: string,
  spec: KdfSpec,
): Promise<Keystore> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const dk = await deriveKey(password, salt, spec);
  const key = await crypto.subtle.importKey('raw', dk as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      plaintext as unknown as BufferSource,
    ),
  );
  return {
    v: LEGACY_KEYSTORE_VERSION,
    kdf: spec.kdf,
    params: spec.params,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(ct),
  } as Keystore;
}

describe('keystore', () => {
  it('round-trips encrypt/decrypt with Argon2id', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapArgon);
    const plain = await decryptKeystore(ks, 'hunter2');
    expect(new TextDecoder().decode(plain)).toBe(new TextDecoder().decode(secret));
  });

  it('round-trips encrypt/decrypt with the PBKDF2 fallback', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapPbkdf2);
    expect(ks.kdf).toBe(KDF_PBKDF2);
    const plain = await decryptKeystore(ks, 'hunter2');
    expect(new TextDecoder().decode(plain)).toBe(new TextDecoder().decode(secret));
  });

  it('fails with BadPasswordError on a wrong password', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapArgon);
    await expect(decryptKeystore(ks, 'hunter3')).rejects.toBeInstanceOf(BadPasswordError);
    await expect(decryptKeystore(ks, 'hunter3')).rejects.toMatchObject({
      code: 'BAD_PASSWORD',
    });
  });

  it('fails with the right password but a tampered ciphertext (GCM auth tag)', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapArgon);
    const ct = fromBase64(ks.ct);
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    const tampered = { ...ks, ct: toBase64(ct) };
    await expect(decryptKeystore(tampered, 'hunter2')).rejects.toBeInstanceOf(
      BadPasswordError,
    );
  });

  it('fails when the IV is swapped', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapArgon);
    const tampered = { ...ks, iv: toBase64(randomBytes(12)) };
    await expect(decryptKeystore(tampered, 'hunter2')).rejects.toBeInstanceOf(
      BadPasswordError,
    );
  });

  it('emits the documented blob shape {v,kdf,params,salt,iv,ct}', async () => {
    const ks = await encryptKeystore(secret, 'pw', cheapArgon);
    expect(Object.keys(ks).sort()).toEqual(['ct', 'iv', 'kdf', 'params', 'salt', 'v'].sort());
    expect(ks.v).toBe(KEYSTORE_VERSION);
    expect(keystoreSchema.safeParse(ks).success).toBe(true);
  });

  it('rejects a malformed blob at the schema boundary', () => {
    expect(keystoreSchema.safeParse({ v: 1, kdf: 'rot13', salt: 'a', iv: 'b', ct: 'c' }).success).toBe(
      false,
    );
    // Unknown future version: unreadable, not silently treated as v2.
    expect(
      keystoreSchema.safeParse({
        v: 3,
        kdf: 'argon2id',
        params: { m: 1024, t: 1, p: 1 },
        salt: 'a',
        iv: 'b',
        ct: 'c',
      }).success,
    ).toBe(false);
  });

  it('authenticates the KDF header: tampered params fail decryption (v2 AAD)', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapArgon);
    expect(ks.kdf).toBe(KDF_ARGON2ID);
    if (ks.kdf !== KDF_ARGON2ID) return;
    // Weakening a cost parameter changes the derived key AND the AAD, but the
    // AAD makes the refusal a guarantee even if key separation ever regressed.
    const weakened = { ...ks, params: { ...ks.params, t: ks.params.t + 1 } };
    await expect(decryptKeystore(weakened, 'hunter2')).rejects.toBeInstanceOf(BadPasswordError);
  });

  it('authenticates the version byte: a v2 blob relabelled v1 fails decryption', async () => {
    const ks = await encryptKeystore(secret, 'hunter2', cheapArgon);
    // Stripping the version back to 1 makes decryption skip the AAD, the tag
    // no longer matches, so the downgrade is refused rather than honoured.
    const relabelled = { ...ks, v: LEGACY_KEYSTORE_VERSION } as Keystore;
    await expect(decryptKeystore(relabelled, 'hunter2')).rejects.toBeInstanceOf(BadPasswordError);
  });

  it('still decrypts a legacy v1 blob (no AAD) with both KDFs', async () => {
    for (const spec of [cheapArgon, cheapPbkdf2] as const) {
      const legacy = await encryptLegacyV1(secret, 'hunter2', spec);
      const plain = await decryptKeystore(legacy, 'hunter2');
      expect(new TextDecoder().decode(plain)).toBe(new TextDecoder().decode(secret));
    }
  });

  it('refuses a legacy blob relabelled as v2 (cannot skip the AAD by claiming it)', async () => {
    const legacy = await encryptLegacyV1(secret, 'hunter2', cheapArgon);
    const relabelled = { ...legacy, v: KEYSTORE_VERSION } as Keystore;
    await expect(decryptKeystore(relabelled, 'hunter2')).rejects.toBeInstanceOf(BadPasswordError);
  });

  it('uses a fresh salt and IV per encryption', async () => {
    const a = await encryptKeystore(secret, 'pw', cheapArgon);
    const b = await encryptKeystore(secret, 'pw', cheapArgon);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('never stores the plaintext inside the blob', async () => {
    const ks = await encryptKeystore(secret, 'pw', cheapArgon);
    const serialized = JSON.stringify(ks);
    expect(serialized).not.toContain('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN');
  });

  it('round-trips JSON payloads', async () => {
    const vault = { version: 1, mnemonic: 'abandon abandon about', accounts: [0, 1] };
    const ks = await encryptJson(vault, 'pw', cheapArgon);
    expect(await decryptJson(ks, 'pw')).toEqual(vault);
  });

  it('base64 helpers round-trip binary data', () => {
    const bytes = randomBytes(64);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
