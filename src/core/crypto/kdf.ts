/**
 * Password-based key derivation.
 *
 * ARCHITECTURE.md §1: Argon2id (hash-wasm) is the primary KDF because it
 * resists GPU brute force far better than PBKDF2 and runs under the MV3 CSP
 * without `eval` (wasm-unsafe-eval only). PBKDF2-SHA-512 with 600 000
 * iterations is the fallback for environments where WASM is blocked.
 */
import { argon2id } from 'hash-wasm';
import { secretToBytes, zeroize } from './zeroize';

export const KDF_ARGON2ID = 'argon2id';
export const KDF_PBKDF2 = 'pbkdf2-sha512';

export type KdfName = typeof KDF_ARGON2ID | typeof KDF_PBKDF2;

/** Argon2id cost parameters. `m` is memory in KiB, `t` passes, `p` lanes. */
export interface Argon2idParams {
  readonly m: number;
  readonly t: number;
  readonly p: number;
}

export interface Pbkdf2Params {
  readonly iterations: number;
}

export type KdfSpec =
  | { readonly kdf: typeof KDF_ARGON2ID; readonly params: Argon2idParams }
  | { readonly kdf: typeof KDF_PBKDF2; readonly params: Pbkdf2Params };

/** Interactive-login profile: ~64 MiB / 3 passes. */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = { m: 65536, t: 3, p: 1 };

/** OWASP 2023 recommendation for PBKDF2-HMAC-SHA-512. */
export const DEFAULT_PBKDF2_PARAMS: Pbkdf2Params = { iterations: 600_000 };

export const DERIVED_KEY_BYTES = 32; // AES-256
export const SALT_BYTES = 16;

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

async function deriveArgon2id(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  const hash = await argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: DERIVED_KEY_BYTES,
    outputType: 'binary',
  });
  return new Uint8Array(hash);
}

async function derivePbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  params: Pbkdf2Params,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    password as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: params.iterations,
      hash: 'SHA-512',
    },
    baseKey,
    DERIVED_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive a 32-byte AES key from a password. The caller owns the returned
 * buffer and must zeroize it.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  spec: KdfSpec,
): Promise<Uint8Array> {
  const pw = secretToBytes(password);
  try {
    if (spec.kdf === KDF_ARGON2ID) {
      return await deriveArgon2id(pw, salt, spec.params);
    }
    return await derivePbkdf2(pw, salt, spec.params);
  } finally {
    zeroize(pw);
  }
}

let wasmAvailable: boolean | undefined;

/**
 * Probe whether hash-wasm can actually instantiate. Result is cached for the
 * lifetime of the context, so the fallback decision costs one cheap hash.
 */
export async function isArgon2Available(): Promise<boolean> {
  if (wasmAvailable !== undefined) return wasmAvailable;
  try {
    await argon2id({
      password: new Uint8Array([0]),
      salt: new Uint8Array(SALT_BYTES),
      parallelism: 1,
      iterations: 1,
      memorySize: 256,
      hashLength: 16,
      outputType: 'binary',
    });
    wasmAvailable = true;
  } catch {
    wasmAvailable = false;
  }
  return wasmAvailable;
}

/** Pick Argon2id when WASM works, otherwise the PBKDF2 fallback. */
export async function preferredKdfSpec(): Promise<KdfSpec> {
  if (await isArgon2Available()) {
    return { kdf: KDF_ARGON2ID, params: DEFAULT_ARGON2ID_PARAMS };
  }
  return { kdf: KDF_PBKDF2, params: DEFAULT_PBKDF2_PARAMS };
}

/** Test seam only: reset the cached WASM probe. */
export function resetKdfProbeCache(): void {
  wasmAvailable = undefined;
}
