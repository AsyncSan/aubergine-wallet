/**
 * Typed error codes crossing the popup/background boundary.
 *
 * ARCHITECTURE.md §6: errors travel as codes, never as raw exception strings,
 * so the UI can translate them.
 */
export const ERROR_CODES = [
  'WALLET_LOCKED',
  'WALLET_EXISTS',
  'NO_WALLET',
  'BAD_PASSWORD',
  /**
   * A password offered for a *new* vault does not clear the strength floor.
   *
   * Distinct from `BAD_PASSWORD` (an existing password that did not verify)
   * and from `BAD_REQUEST` (a malformed message): this one is a refusal the
   * caller can act on, so it gets its own translatable code rather than being
   * folded into "that request was malformed". See `MIN_PASSWORD_SCORE` in
   * `core/password-strength` for the calibration.
   */
  'WEAK_PASSWORD',
  'UNLOCK_THROTTLED',
  'MEMO_REQUIRED',
  'TOO_MANY_REQUESTS',
  'BAD_REQUEST',
  'USER_REJECTED',
  'NETWORK_ERROR',
  'INVALID_MNEMONIC',
  'INVALID_ADDRESS',
  'INVALID_AMOUNT',
  'INVALID_MEMO',
  'ACCOUNT_NOT_FOUND',
  'DEVELOPER_MODE_REQUIRED',
  'SOROBAN_SIMULATION_FAILED',
  'QUOTE_EXPIRED',
  'SWAP_ENVELOPE_MISMATCH',
  'KEYSTORE_UNREADABLE',
  'PERMISSION_REQUIRED',
  /**
   * A passkey ceremony produced material that does not open this wallet.
   *
   * Distinct from `BAD_PASSWORD` and deliberately *not* counted by the unlock
   * throttle: there is nothing to brute-force here. The PRF output is 32 bytes
   * from an authenticator that already demanded user verification, so a wrong
   * one means a foreign credential or a stale record, not a guessing attempt,
   * and throttling it would only lock a user out of the password path too.
   */
  'PASSKEY_FAILED',
  /** No passkey is enrolled on this installation. */
  'PASSKEY_NOT_ENROLLED',
  'UNSUPPORTED_OPERATION',
  /**
   * A previous submission from this account has no known outcome yet, so
   * building a second transaction is refused.
   *
   * This is the *refusal* half of "outcome unknown". The state itself is a
   * return value (`tx.submit` -> `outcome: 'unknown'`), because it carries data
   * the UI must show (the hash and the timebound), and an error can only carry
   * a code and a string. But `tx.build` has nothing to return in that
   * situation: the honest answer there is "no", and a typed code is exactly how
   * §6 says no.
   */
  'SUBMIT_OUTCOME_UNKNOWN',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** `TX_FAILED:<result_code>` is a dynamic member of the code space (§6). */
export type WireErrorCode = ErrorCode | `TX_FAILED:${string}`;

export interface WireError {
  readonly code: WireErrorCode;
  /** Untranslated technical detail. Never rendered on its own in beginner mode. */
  readonly detail?: string;
}

export class AppError extends Error {
  readonly code: WireErrorCode;
  readonly detail: string | undefined;

  constructor(code: WireErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }

  toWire(): WireError {
    return this.detail === undefined
      ? { code: this.code }
      : { code: this.code, detail: this.detail };
  }
}

export function txFailed(resultCode: string): AppError {
  return new AppError(`TX_FAILED:${resultCode}`);
}

/** Map anything thrown into a wire error without leaking stack traces. */
export function toWireError(err: unknown): WireError {
  if (err instanceof AppError) return err.toWire();
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return { code: code as ErrorCode, detail: err.message };
    }
    return { code: 'INTERNAL_ERROR', detail: err.message };
  }
  return { code: 'INTERNAL_ERROR', detail: String(err) };
}

const TX_FAILED_PREFIX = 'TX_FAILED:';

/**
 * The Horizon result code inside a `TX_FAILED:*` wire code, or `null` for
 * every other code. `horizon.ts` puts the *operation* code there when there is
 * one and the transaction code otherwise, so both spaces show up here.
 */
export function txResultCode(code: WireErrorCode): string | null {
  return code.startsWith(TX_FAILED_PREFIX) ? code.slice(TX_FAILED_PREFIX.length) : null;
}

/**
 * Result codes this wallet can actually produce *and* has a beginner-readable
 * text for (`error.txcode.<code>` in both catalogues; `tests/i18n.test.ts`
 * enforces that).
 *
 * The list is deliberately narrow. It covers the operations the builder emits
 * (create account, payment, path payment strict *send*, change trust), plus
 * the aggregator's `invokeHostFunction` swap, plus the transaction-level
 * checks that apply to all of them. Codes that only exist for operations this
 * wallet never submits (account merge, offers, claimable balances, liquidity
 * pools, sponsorships, strict *receive*) are left out on purpose: an unknown
 * code still renders through `error.TX_FAILED`, which is honest, whereas a
 * confident sentence about an operation we never build would not be.
 *
 * Sources: Horizon's own mapping from XDR result codes to these strings
 * (`services/horizon/internal/codes/main.go`) and the result-code reference on
 * developers.stellar.org. Note that the Soroban operation codes carry **no**
 * `op_` prefix, Horizon returns `function_trapped`, not `op_function_trapped`.
 */
export const TX_RESULT_CODES = [
  // Transaction level.
  'tx_failed',
  'tx_bad_seq',
  'tx_too_late',
  'tx_too_early',
  'tx_insufficient_fee',
  'tx_insufficient_balance',
  'tx_no_source_account',
  'tx_bad_auth',
  'tx_bad_auth_extra',
  'tx_missing_operation',
  'tx_malformed',
  'tx_not_supported',
  'tx_internal_error',
  'tx_soroban_invalid',
  /*
   * There used to be a `tx_unsuccessful` entry here, described as what
   * `horizon.ts` raises for `200 {successful: false}`. That stopped being true
   * when the ambiguous answer was reclassified: it now returns
   * `outcome: 'unknown', reason: 'ambiguous'` and never a `TX_FAILED:*` code,
   * so nothing in the wallet could produce the string any more. Its i18n text
   * and the test that checked that text's wording, were green but empty,
   * asserting things about a sentence no user could ever see. Every code in
   * this list is one Horizon actually returns.
   */
  // Operation level, generic.
  'op_malformed',
  'op_too_many_subentries',
  'op_exceeded_work_limit',
  // Payment / create account / path payment.
  'op_underfunded',
  'op_low_reserve',
  'op_already_exists',
  'op_no_destination',
  'op_no_trust',
  'op_not_authorized',
  'op_line_full',
  'op_no_issuer',
  'op_src_no_trust',
  'op_src_not_authorized',
  // Path payment strict send (i.e. swap) only.
  'op_too_few_offers',
  'op_cross_self',
  'op_under_dest_min',
  // Change trust (asset approval) only.
  'op_invalid_limit',
  'op_self_not_allowed',
  'op_cannot_delete',
  'op_not_aut_maintain_liabilities',
  // Soroban `invokeHostFunction`, reachable through an aggregator swap.
  'function_trapped',
  'resource_limit_exceeded',
  'entry_archived',
  'insufficient_refundable_fee',
] as const;

export type TxResultCode = (typeof TX_RESULT_CODES)[number];

const TRANSLATED_TX_RESULT_CODES: ReadonlySet<string> = new Set(TX_RESULT_CODES);

export function isTranslatedTxResultCode(code: string): code is TxResultCode {
  return TRANSLATED_TX_RESULT_CODES.has(code);
}

/** An i18n key plus the parameters that key needs, everything the UI renders. */
export interface ErrorMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Resolve a wire code to the text the user sees.
 *
 * For `TX_FAILED:*` this tries `error.txcode.<code>` first and falls back to
 * the collective `error.TX_FAILED` with the raw code as a parameter. The
 * decision is made against {@link TX_RESULT_CODES} rather than by probing a
 * catalogue: `src/i18n/index.tsx` already owns the one missing-key mechanism
 * (English, then the key itself), and a second one here would only hide gaps
 * that `tests/i18n.test.ts` is meant to catch.
 */
export function errorMessage(code: WireErrorCode): ErrorMessage {
  const result = txResultCode(code);
  if (result === null) return { key: `error.${code}` };
  if (isTranslatedTxResultCode(result)) return { key: `error.txcode.${result}` };
  return { key: 'error.TX_FAILED', params: { code: result } };
}

/** i18n key for an error code. See {@link errorMessage} for the parameters. */
export function errorI18nKey(code: WireErrorCode): string {
  return errorMessage(code).key;
}
