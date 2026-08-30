/**
 * The hardware device seen from the rest of the wallet.
 *
 * Deliberately one small interface rather than the Ledger SDK passed around:
 *
 *  - the WebHID implementation can only exist in a window context
 *    (`navigator.hid` does not exist in an MV3 service worker), while
 *    everything that *reasons* about hardware accounts lives in the
 *    background. One interface keeps that split from leaking upward.
 *  - it makes the flow testable without hardware. {@link FakeLedgerDevice}
 *    implements exactly this, so the enrolment and signing paths are covered
 *    by unit tests rather than by a device on someone's desk.
 *
 * Note what is *not* here: nothing returns a private key, because the device
 * never emits one. Invariant 1 holds here for free rather than by discipline.
 */
import { StrKey } from '@stellar/stellar-sdk';
import { AppError } from '../errors';
import { STELLAR_COIN_TYPE } from '../crypto/mnemonic';

/**
 * BIP-32 path in the form the Ledger SDK expects: **no** `m/` prefix.
 *
 * `stellarAccountPath` in `crypto/mnemonic` produces `m/44'/148'/n'` for the
 * SLIP-0010 derivation and for display. Handing that string to the device
 * yields a parse error, so the two forms get two functions instead of one
 * string that is right in one place and wrong in the other.
 */
export function ledgerAccountPath(derivationIndex: number): string {
  if (!Number.isInteger(derivationIndex) || derivationIndex < 0) {
    throw new AppError('BAD_REQUEST', `invalid derivation index: ${derivationIndex}`);
  }
  return `44'/${STELLAR_COIN_TYPE}'/${derivationIndex}'`;
}

export interface LedgerAppConfiguration {
  readonly version: string;
  /** Whether the device will sign a bare hash it cannot render. */
  readonly hashSigningEnabled: boolean;
  /** Largest payload the Stellar app will parse, when it reports one. */
  readonly maxDataSize: number | null;
}

export interface LedgerDevice {
  getAppConfiguration(): Promise<LedgerAppConfiguration>;
  /**
   * The account key at `derivationIndex`, as a `G…` strkey.
   *
   * `display` asks the device to show the address for the user to compare.
   * Enrolment uses it; a signature does not, because the signing screen the
   * user is about to read already names the account.
   */
  getPublicKey(derivationIndex: number, display?: boolean): Promise<string>;
  /**
   * Sign a transaction's signature base and return the raw 64-byte signature.
   *
   * The signature base — not the XDR — because that is what ed25519 actually
   * covers: network id hash, envelope type, transaction. The caller gets bytes
   * back and nothing else; deciding they belong on an envelope is the
   * background's job, and it verifies them before attaching.
   */
  signTransaction(derivationIndex: number, signatureBase: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Raw ed25519 point (32 bytes) as the device returns it -> `G…` strkey. */
export function rawPublicKeyToStrkey(raw: Uint8Array): string {
  if (raw.length !== 32) {
    throw new AppError('LEDGER_UNAVAILABLE', `device returned ${raw.length} key bytes, expected 32`);
  }
  return StrKey.encodeEd25519PublicKey(Buffer.from(raw));
}

/**
 * Map whatever the Ledger stack threw onto the wallet's own code space (§6).
 *
 * The one that matters is refusal: pressing "reject" on the device is a
 * *decision*, not a fault, and it has to arrive in the UI as `USER_REJECTED`
 * so the screen says "you declined this" rather than "something went wrong".
 */
export function toLedgerAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  // The SDK's own named errors, matched by name so this module does not have
  // to import the Ledger error classes into the background bundle.
  if (name === 'StellarUserRefusedError') return new AppError('USER_REJECTED', message);
  if (name === 'StellarHashSigningNotEnabledError') {
    return new AppError('UNSUPPORTED_OPERATION', 'hash signing is disabled on the device');
  }
  if (name === 'StellarDataTooLargeError' || name === 'StellarDataParsingFailedError') {
    return new AppError('UNSUPPORTED_OPERATION', message);
  }
  // 0x6985 is the raw status code behind a refusal on older app versions.
  if (/\b0x6985\b|CONDITIONS_OF_USE_NOT_SATISFIED|DENIED/iu.test(message)) {
    return new AppError('USER_REJECTED', message);
  }
  if (/locked|no device|not found|disconnect|InvalidStateError|NotFoundError/iu.test(message)) {
    return new AppError('LEDGER_UNAVAILABLE', message);
  }
  return new AppError('LEDGER_UNAVAILABLE', message);
}
