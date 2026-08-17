/**
 * Encrypted keystore blob.
 *
 * ARCHITECTURE.md §3, invariant 2: `chrome.storage.local` only ever holds this
 * ciphertext envelope plus non-sensitive settings. The blob format is
 * `{ v, kdf, params, salt, iv, ct }`; AES-256-GCM via WebCrypto.
 */
import { z } from 'zod';
import {
  DERIVED_KEY_BYTES,
  KDF_ARGON2ID,
  KDF_PBKDF2,
  SALT_BYTES,
  deriveKey,
  preferredKdfSpec,
  randomBytes,
  type KdfSpec,
} from './kdf';
import { zeroize } from './zeroize';

export const IV_BYTES = 12; // 96-bit nonce, the GCM standard size
/**
 * v2 binds the KDF header into the ciphertext as AES-GCM `additionalData`
 * (see {@link keystoreAad}); v1 blobs did not and stay decryptable.
 */
export const KEYSTORE_VERSION = 2;
export const LEGACY_KEYSTORE_VERSION = 1;

/**
 * The KDF header is unauthenticated by construction (it is what we need in
 * order to derive the key that would authenticate it), so it must be bounded.
 * Unbounded `m` was a denial-of-service: a hand-edited `m: 2**30` made the next
 * unlock attempt ask for a terabyte of memory and hang the service worker,
 * and the resulting library error escaped the BadPasswordError mapping, so it
 * did not even count as a failed attempt against the unlock throttle.
 *
 * The ceilings sit far above anything this wallet writes (m=65536, t=3, p=1)
 * and far below anything that could wedge a browser.
 */
const argon2ParamsSchema = z.object({
  m: z.number().int().min(8).max(1_048_576), // KiB → at most 1 GiB
  t: z.number().int().min(1).max(64),
  p: z.number().int().min(1).max(16),
});

const pbkdf2ParamsSchema = z.object({
  iterations: z.number().int().min(1).max(50_000_000),
});

/**
 * Base64 with padding. Validating it here is what makes "present but corrupt"
 * a *readable* verdict: without it a truncated blob only blew up inside
 * `atob()` as an untyped DOMException, which crossed the RPC boundary as
 * INTERNAL_ERROR and burned an unlock attempt on the way.
 */
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u, 'not base64');

const keystoreVersion = z.union([
  z.literal(LEGACY_KEYSTORE_VERSION),
  z.literal(KEYSTORE_VERSION),
]);

export const keystoreSchema = z.union([
  z.object({
    v: keystoreVersion,
    kdf: z.literal(KDF_ARGON2ID),
    params: argon2ParamsSchema,
    salt: base64,
    iv: base64,
    ct: base64,
  }),
  z.object({
    v: keystoreVersion,
    kdf: z.literal(KDF_PBKDF2),
    params: pbkdf2ParamsSchema,
    salt: base64,
    iv: base64,
    ct: base64,
  }),
]);

export type Keystore = z.infer<typeof keystoreSchema>;

export class BadPasswordError extends Error {
  readonly code = 'BAD_PASSWORD';
  constructor() {
    super('Decryption failed: wrong password or corrupted keystore');
    this.name = 'BadPasswordError';
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The header bytes a v2 blob authenticates.
 *
 * The KDF header cannot be *encrypted* (it is what derives the key), but it
 * can be *authenticated*: feeding a canonical serialisation of every header
 * field into AES-GCM as `additionalData` makes any post-hoc edit, a swapped
 * KDF name, weakened cost parameters, a foreign salt, fail decryption exactly
 * like a wrong password, instead of failing only implicitly via the derived
 * key. No practical downgrade existed without it (different params derive a
 * different key, so the tag check failed anyway), but with the AAD the
 * guarantee is by construction rather than by accident of key separation.
 *
 * The encoding is a fixed-order template string, not JSON: object key order
 * would otherwise silently become part of the ciphertext contract.
 */
export function keystoreAad(
  header: Pick<Keystore, 'v' | 'kdf' | 'params' | 'salt'>,
): Uint8Array {
  const params =
    'iterations' in header.params
      ? `iterations=${header.params.iterations}`
      : `m=${header.params.m};t=${header.params.t};p=${header.params.p}`;
  return textEncoder.encode(
    `aubergine-keystore;v=${header.v};kdf=${header.kdf};${params};salt=${header.salt}`,
  );
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt arbitrary secret bytes (in practice: the JSON-serialised vault).
 * `spec` is exposed so tests can use cheap KDF parameters.
 */
export async function encryptKeystore(
  plaintext: Uint8Array,
  password: string,
  spec?: KdfSpec,
): Promise<Keystore> {
  const kdfSpec = spec ?? (await preferredKdfSpec());
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const dk = await deriveKey(password, salt, kdfSpec);
  try {
    if (dk.length !== DERIVED_KEY_BYTES) throw new Error('unexpected derived key length');
    const key = await importAesKey(dk);
    const header = {
      v: KEYSTORE_VERSION as typeof KEYSTORE_VERSION,
      kdf: kdfSpec.kdf,
      params: kdfSpec.params,
      salt: toBase64(salt),
    } as Pick<Keystore, 'v' | 'kdf' | 'params' | 'salt'>;
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv as unknown as BufferSource,
          additionalData: keystoreAad(header) as unknown as BufferSource,
        },
        key,
        plaintext as unknown as BufferSource,
      ),
    );
    const base = {
      v: KEYSTORE_VERSION as typeof KEYSTORE_VERSION,
      salt: header.salt,
      iv: toBase64(iv),
      ct: toBase64(ct),
    };
    return kdfSpec.kdf === KDF_ARGON2ID
      ? { ...base, kdf: KDF_ARGON2ID, params: kdfSpec.params }
      : { ...base, kdf: KDF_PBKDF2, params: kdfSpec.params };
  } finally {
    zeroize(dk);
  }
}

/**
 * Decrypt a keystore. Throws {@link BadPasswordError} on a wrong password,
 * AES-GCM authentication failure is indistinguishable from tampering, and both
 * map to the same user-facing message.
 */
export async function decryptKeystore(
  keystore: Keystore,
  password: string,
): Promise<Uint8Array> {
  const parsed = keystoreSchema.parse(keystore);
  const salt = fromBase64(parsed.salt);
  const iv = fromBase64(parsed.iv);
  const ct = fromBase64(parsed.ct);
  // Wrong-sized salt or IV cannot come from this wallet. Reject them as a bad
  // keystore instead of letting the crypto library throw an untyped error from
  // outside the try block below.
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
    throw new BadPasswordError();
  }
  const spec: KdfSpec =
    parsed.kdf === KDF_ARGON2ID
      ? { kdf: KDF_ARGON2ID, params: parsed.params }
      : { kdf: KDF_PBKDF2, params: parsed.params };
  const dk = await deriveKey(password, salt, spec);
  try {
    const key = await importAesKey(dk);
    // v1 blobs predate the AAD; their header is still implicitly bound via the
    // derived key. Only v2 carries the explicit authentication.
    const aad =
      parsed.v === KEYSTORE_VERSION
        ? { additionalData: keystoreAad(parsed) as unknown as BufferSource }
        : {};
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, ...aad },
      key,
      ct as unknown as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new BadPasswordError();
  } finally {
    zeroize(dk);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Convenience wrapper for JSON payloads. The intermediate buffer is zeroized. */
export async function encryptJson(
  value: unknown,
  password: string,
  spec?: KdfSpec,
): Promise<Keystore> {
  const bytes = textEncoder.encode(JSON.stringify(value));
  try {
    return await encryptKeystore(bytes, password, spec);
  } finally {
    zeroize(bytes);
  }
}

export async function decryptJson(keystore: Keystore, password: string): Promise<unknown> {
  const bytes = await decryptKeystore(keystore, password);
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } finally {
    zeroize(bytes);
  }
}
