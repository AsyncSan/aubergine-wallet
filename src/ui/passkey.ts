/**
 * The WebAuthn half of passkey unlock. Lives in the popup, not the background:
 * `navigator.credentials` needs a document, and an MV3 service worker has none.
 *
 * The background owns every byte that is stored; this module owns exactly one
 * thing, turning a user's biometric gesture into 32 bytes of PRF output, and
 * hands them straight back. See `core/crypto/passkey.ts` for what happens to
 * them and why the salt is a secret.
 */
import { browser } from 'wxt/browser';
import {
  PASSKEY_RP_ID,
  PASSKEY_RP_NAME,
  PASSKEY_RP_ORIGIN_PATTERN,
} from '../core/crypto/passkey';
import { ensureOrigins, hasOrigins } from './permissions';

/** Why a passkey operation could not be carried out, as a translatable code. */
export type PasskeyFailure =
  | 'unsupported' // no WebAuthn in this browser at all
  | 'noPrf' // authenticator cannot do PRF, so there is no key material
  | 'permissionDenied' // the user declined the host permission for the RP ID
  | 'cancelled' // the user dismissed the OS prompt
  | 'popupClosed'; // Firefox: the prompt closed the popup out from under us

export class PasskeyError extends Error {
  constructor(readonly failure: PasskeyFailure) {
    super(failure);
    this.name = 'PasskeyError';
  }
}

/**
 * A WebAuthn `challenge` is what a *server* uses to bind an assertion to a
 * session. We have no server and never verify the signature: the only thing
 * taken from the ceremony is the PRF output, which does not depend on the
 * challenge. It is still required by the API, and it is still random, because
 * a constant would be a needless deviation that some authenticator or future
 * policy check would be entirely right to reject.
 */
function challenge(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface PrfExtensionResults {
  readonly enabled?: boolean;
  readonly results?: { readonly first?: ArrayBuffer };
}

function prfOutputOf(credential: PublicKeyCredential): Uint8Array | null {
  const ext = credential.getClientExtensionResults() as { prf?: PrfExtensionResults };
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/**
 * Is passkey unlock possible on this machine at all?
 *
 * Deliberately *not* a promise of success: whether the authenticator supports
 * PRF cannot be known before a credential is created (the platform reports it
 * in the creation's extension results). This answers the cheaper question —
 * "is there a user-verifying authenticator and an API to reach it" — and
 * enrolment fails cleanly with `noPrf` if the answer turns out to be no.
 */
export async function passkeySupported(): Promise<boolean> {
  try {
    if (typeof PublicKeyCredential === 'undefined') return false;
    if (!navigator.credentials?.create) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Has the user already granted the host permission the RP ID needs? */
export async function passkeyOriginGranted(): Promise<boolean> {
  return hasOrigins([PASSKEY_RP_ORIGIN_PATTERN]);
}

/**
 * Firefox closes the extension popup when the credential prompt appears
 * (bugzil.la/2026687), which tears down the page mid-ceremony. The wallet
 * therefore tells the user to open it in a tab first rather than letting them
 * discover it as a silent failure.
 */
export function passkeyNeedsTab(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Firefox') &&
    // In a tab the popup document is the full-size page, not the 360 px panel.
    window.innerWidth <= 420
  );
}

/** Open the wallet UI in a normal tab, for the case above. */
export async function openInTab(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL('/popup.html') });
}

function classify(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new PasskeyError('cancelled');
  }
  return new PasskeyError('unsupported');
}

/**
 * Enrol a new credential and evaluate the PRF for `prfSalt`.
 *
 * Must be called from a user gesture: both the host-permission request and the
 * WebAuthn ceremony require one.
 */
export async function createPasskey(prfSalt: string): Promise<{
  credentialId: string;
  prfOutput: string;
}> {
  if (!(await passkeySupported())) throw new PasskeyError('unsupported');
  if (!(await ensureOrigins([PASSKEY_RP_ORIGIN_PATTERN]))) {
    throw new PasskeyError('permissionDenied');
  }

  const salt = fromBase64(prfSalt);
  /**
   * The user handle identifies the account *to the authenticator*. It is
   * random and never stored: every ceremony this wallet performs names the
   * credential explicitly in `allowCredentials`, so nothing needs to look it
   * up by handle, and a random value avoids putting anything identifying into
   * a credential that may sync to a password manager.
   */
  const userId = new Uint8Array(16);
  crypto.getRandomValues(userId);

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: PASSKEY_RP_ID, name: PASSKEY_RP_NAME },
        user: { id: userId as unknown as BufferSource, name: PASSKEY_RP_NAME, displayName: PASSKEY_RP_NAME },
        challenge: challenge() as unknown as BufferSource,
        // ES256 first, RS256 as the fallback every platform still accepts.
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          /**
           * Not restricted to `platform`: a hardware key with hmac-secret is a
           * better second factor than a laptop's own TPM, and there is no
           * reason to refuse one.
           *
           * `residentKey: 'discouraged'` because this wallet always knows the
           * credential id it wants. A discoverable credential would only
           * consume one of a security key's scarce resident slots and buy
           * nothing.
           */
          residentKey: 'discouraged',
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: salt as unknown as BufferSource } } },
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw classify(err);
  }
  if (!credential) throw new PasskeyError('cancelled');

  const credentialId = toBase64(new Uint8Array(credential.rawId));

  /**
   * Some platforms report `prf.enabled` at creation but only produce output on
   * a subsequent assertion. One extra prompt is the honest cost; silently
   * enrolling a credential that cannot unlock anything is not.
   */
  const output = prfOutputOf(credential);
  if (output) return { credentialId, prfOutput: toBase64(output) };
  const ext = credential.getClientExtensionResults() as { prf?: PrfExtensionResults };
  if (ext.prf?.enabled !== true) throw new PasskeyError('noPrf');
  return { credentialId, prfOutput: await assertPrf(credentialId, prfSalt) };
}

async function assertPrf(credentialId: string, prfSalt: string): Promise<string> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        rpId: PASSKEY_RP_ID,
        challenge: challenge() as unknown as BufferSource,
        allowCredentials: [
          { type: 'public-key', id: fromBase64(credentialId) as unknown as BufferSource },
        ],
        userVerification: 'required',
        extensions: {
          prf: { eval: { first: fromBase64(prfSalt) as unknown as BufferSource } },
        },
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw classify(err);
  }
  if (!credential) throw new PasskeyError('cancelled');
  const output = prfOutputOf(credential);
  if (!output) throw new PasskeyError('noPrf');
  return toBase64(output);
}

/** Evaluate the PRF for an existing credential; the unlock path. */
export async function usePasskey(credentialId: string, prfSalt: string): Promise<string> {
  if (!(await passkeySupported())) throw new PasskeyError('unsupported');
  if (!(await passkeyOriginGranted())) throw new PasskeyError('permissionDenied');
  return assertPrf(credentialId, prfSalt);
}
