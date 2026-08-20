/**
 * Passkey unlock (WebAuthn PRF), ARCHITECTURE.md §1.
 *
 * The design in one sentence: a random 32-byte **vault key** is wrapped twice,
 * once by the password-derived key and once by a key derived from the
 * authenticator's PRF output, and the vault is encrypted under that vault key.
 * Either wrapper opens the wallet; neither can be computed from the other.
 *
 * Two decisions worth stating outright, because both are the difference
 * between a real second factor and theatre:
 *
 * **PRF or nothing.** A passkey without the `prf` extension can only *assert*
 * that someone was present. It produces no key material, so the only way to
 * use one for unlocking is to keep the unlock secret somewhere the assertion
 * can reach — which in an extension means `storage.local`, i.e. next to the
 * ciphertext it is supposed to protect. That is not encryption, it is a lock
 * with the key taped to it. If the authenticator does not do PRF, this wallet
 * offers no passkey unlock at all and says so.
 *
 * **The PRF salt is a local secret.** WebAuthn ties a credential to an RP ID,
 * and an extension may only claim an RP ID it holds a host permission for, so
 * ours is the product's own domain. That means a script running on that
 * domain could ask the same authenticator to evaluate the same PRF — with a
 * *known* salt it would obtain exactly our wrapping key. The salt is therefore
 * 32 random bytes generated at enrolment and stored only in extension storage:
 * whoever can read it can already read the ciphertext next to it, so the
 * website compromise buys nothing.
 *
 * The primary keystore (`core/crypto/keystore.ts`) is untouched by all of
 * this. If anything here is wrong, the password path is byte-for-byte what it
 * was, which is the property worth more than any of the above.
 */
import { z } from 'zod';
import {
  IV_BYTES,
  fromBase64,
  keystoreSchema,
  toBase64,
  type Keystore,
} from './keystore';
import { DERIVED_KEY_BYTES, randomBytes } from './kdf';
import { zeroize } from './zeroize';

/**
 * The relying party this wallet's credentials belong to.
 *
 * Not a free choice: Chrome 122+/Firefox 150+ let an extension name an RP ID
 * only for a domain it holds a host permission for, and `chrome-extension://`
 * itself is not usable as one. The matching pattern lives in
 * `optional_host_permissions` and is requested at enrolment, from the user's
 * click — never at install, so nobody pays for a feature they did not switch
 * on. See `wxt.config.ts`.
 */
export const PASSKEY_RP_ID = 'aubergine.tech';
export const PASSKEY_RP_ORIGIN_PATTERN = `https://${PASSKEY_RP_ID}/*`;
export const PASSKEY_RP_NAME = 'Aubergine Wallet';

/** Bytes of PRF input. 32 is the output width, and there is no reason to skimp. */
export const PRF_SALT_BYTES = 32;
/** Salt for the HKDF step that turns the PRF output into an AES key. */
export const HKDF_SALT_BYTES = 16;

export const PASSKEY_RECORD_VERSION = 1;

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u, 'not base64');

const wrappedSchema = z.object({
  hkdfSalt: base64,
  iv: base64,
  ct: base64,
});

export type WrappedByPasskey = z.infer<typeof wrappedSchema>;

export const passkeyRecordSchema = z.object({
  v: z.literal(PASSKEY_RECORD_VERSION),
  /** Raw credential id, base64. Passed back to `get()` as an allowed credential. */
  credentialId: base64,
  /** PRF input. Secret, see the module note. */
  prfSalt: base64,
  /** The vault key under the PRF-derived key. */
  vaultKeyUnderPasskey: wrappedSchema,
  /** The same vault key under the password, in the ordinary keystore format. */
  vaultKeyUnderPassword: keystoreSchema,
  /** The vault JSON under the vault key. */
  vaultUnderVaultKey: z.object({ iv: base64, ct: base64 }),
});

export type PasskeyRecord = z.infer<typeof passkeyRecordSchema>;

export class PasskeyUnwrapError extends Error {
  readonly code = 'PASSKEY_FAILED';
  constructor(message = 'passkey material did not decrypt') {
    super(message);
    this.name = 'PasskeyUnwrapError';
  }
}

const textEncoder = new TextEncoder();

/**
 * Domain separation for the two independent uses of the vault key, so that a
 * future third wrapper can never accidentally reuse this one's key stream.
 */
const HKDF_INFO_PASSKEY = 'aubergine-passkey-vaultkey-v1';
const AAD_PREFIX = 'aubergine-passkey';

/**
 * The header bytes the passkey wrapper authenticates.
 *
 * Same reasoning as `keystoreAad`: the credential id and both salts cannot be
 * encrypted (they are needed to get the key), but they can be bound, so that
 * swapping in a different credential's ciphertext fails the tag check rather
 * than failing implicitly somewhere later. Fixed-order template string, not
 * JSON — object key order must not become part of the ciphertext contract.
 */
export function passkeyAad(header: {
  v: number;
  credentialId: string;
  prfSalt: string;
  hkdfSalt: string;
}): Uint8Array {
  return textEncoder.encode(
    `${AAD_PREFIX};v=${header.v};cred=${header.credentialId};prf=${header.prfSalt};hkdf=${header.hkdfSalt}`,
  );
}

/**
 * PRF output → AES key, via HKDF-SHA-256.
 *
 * The PRF output is already 32 uniformly random bytes, so this is not about
 * entropy. It is about never using a value the authenticator also hands to
 * anyone else who asks with the same salt directly as a content key, and about
 * the `info` label above, which makes "this key is for wrapping the vault key"
 * part of the derivation rather than a comment.
 */
async function prfToKey(prfOutput: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    prfOutput as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: hkdfSalt as unknown as BufferSource,
      info: textEncoder.encode(HKDF_INFO_PASSKEY) as unknown as BufferSource,
    },
    base,
    DERIVED_KEY_BYTES * 8,
  );
  const raw = new Uint8Array(bits);
  try {
    return await crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  } finally {
    zeroize(raw);
  }
}

async function importVaultKey(vaultKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', vaultKey as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** A fresh vault key. Callers must zeroize it when done. */
export function generateVaultKey(): Uint8Array {
  return randomBytes(DERIVED_KEY_BYTES);
}

export async function wrapVaultKeyWithPrf(
  vaultKey: Uint8Array,
  prfOutput: Uint8Array,
  credentialId: string,
  prfSalt: string,
): Promise<WrappedByPasskey> {
  const hkdfSalt = randomBytes(HKDF_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await prfToKey(prfOutput, hkdfSalt);
  const header = {
    v: PASSKEY_RECORD_VERSION,
    credentialId,
    prfSalt,
    hkdfSalt: toBase64(hkdfSalt),
  };
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: passkeyAad(header) as unknown as BufferSource,
      },
      key,
      vaultKey as unknown as BufferSource,
    ),
  );
  return { hkdfSalt: header.hkdfSalt, iv: toBase64(iv), ct: toBase64(ct) };
}

export async function unwrapVaultKeyWithPrf(
  wrapped: WrappedByPasskey,
  prfOutput: Uint8Array,
  credentialId: string,
  prfSalt: string,
): Promise<Uint8Array> {
  const hkdfSalt = fromBase64(wrapped.hkdfSalt);
  const iv = fromBase64(wrapped.iv);
  if (hkdfSalt.length !== HKDF_SALT_BYTES || iv.length !== IV_BYTES) {
    throw new PasskeyUnwrapError('malformed passkey wrapper');
  }
  const key = await prfToKey(prfOutput, hkdfSalt);
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: passkeyAad({
          v: PASSKEY_RECORD_VERSION,
          credentialId,
          prfSalt,
          hkdfSalt: wrapped.hkdfSalt,
        }) as unknown as BufferSource,
      },
      key,
      fromBase64(wrapped.ct) as unknown as BufferSource,
    );
    const out = new Uint8Array(plain);
    if (out.length !== DERIVED_KEY_BYTES) {
      zeroize(out);
      throw new PasskeyUnwrapError('unexpected vault key length');
    }
    return out;
  } catch (err) {
    if (err instanceof PasskeyUnwrapError) throw err;
    throw new PasskeyUnwrapError();
  }
}

/** Encrypt the vault JSON under the vault key. */
export async function sealVault(
  plaintext: Uint8Array,
  vaultKey: Uint8Array,
): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(IV_BYTES);
  const key = await importVaultKey(vaultKey);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      plaintext as unknown as BufferSource,
    ),
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

export async function openVault(
  sealed: { iv: string; ct: string },
  vaultKey: Uint8Array,
): Promise<Uint8Array> {
  const iv = fromBase64(sealed.iv);
  if (iv.length !== IV_BYTES) throw new PasskeyUnwrapError('malformed sealed vault');
  const key = await importVaultKey(vaultKey);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      fromBase64(sealed.ct) as unknown as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new PasskeyUnwrapError();
  }
}

/** Re-export for the storage layer, which stores the password wrapper verbatim. */
export type { Keystore };
