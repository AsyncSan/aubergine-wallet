/**
 * Popup-side RPC client. Thin, typed, and the only way the UI reaches the
 * background (ARCHITECTURE.md §3/§6).
 */
import { browser } from 'wxt/browser';
import { AppError, errorMessage, type ErrorMessage, type WireError } from '../core/errors';
import type { TParams } from '../i18n';
import {
  parseResult,
  rpcSchemas,
  type RpcMethod,
  type RpcParamsInput,
  type RpcResponse,
  type RpcResult,
} from './protocol';

/**
 * Ceiling for one round trip to the background.
 *
 * `browser.runtime.sendMessage` does *not* reject when the service worker is
 * wedged or was torn down mid-handler; the promise simply never settles, and
 * the popup sits on a spinner with no way out. Every call therefore races a
 * timer.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Calls that legitimately outlive the default ceiling. Exempting them by name
 * keeps the guarantee for everything else instead of dropping it for all.
 *
 * - `dapp.requestConnect` / `dapp.signXdr` block on a *human*: the background
 *   queue waits `PROMPT_TIMEOUT_MS` = 120 s for the confirmation dialog
 *   (`src/background/dapp.ts`). Anything shorter here would abort a prompt the
 *   user is still reading. Today these arrive from the content script, not
 *   from this client; the entries exist so that stays true if the popup ever
 *   brokers them itself.
 * - `tx.submit` waits on Horizon, whose SDK client gives up after 60 s. Cutting
 *   it earlier would report "took too long" for a transaction that is still on
 *   its way into a ledger; the single worst message a wallet can show. If the
 *   deadline does fire (a service worker torn down mid-request will do it), the
 *   screens do *not* treat it as a failure: they ask `tx.pendingSubmission`,
 *   which the background wrote before the envelope left, and show the
 *   open-outcome screen instead.
 */
export const RPC_TIMEOUT_OVERRIDES_MS: Partial<Record<RpcMethod, number>> = {
  'dapp.requestConnect': 125_000,
  'dapp.signXdr': 125_000,
  'tx.submit': 75_000,
};

export function rpcTimeoutMs(method: RpcMethod): number {
  return RPC_TIMEOUT_OVERRIDES_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
}

/**
 * A call that never came back. Stays inside the wire code space of §6
 * (`NETWORK_ERROR`) so every existing error path keeps working, but is its own
 * type so the UI can say "took too long" instead of "network unreachable".
 */
export class RpcTimeoutError extends AppError {
  readonly method: RpcMethod;
  readonly timeoutMs: number;

  constructor(method: RpcMethod, timeoutMs: number) {
    super('NETWORK_ERROR', `timeout after ${timeoutMs} ms: ${method}`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export function isRpcTimeout(err: unknown): err is RpcTimeoutError {
  return err instanceof RpcTimeoutError;
}

/**
 * Everything the UI needs to render something thrown by {@link rpc}: timeouts
 * get their own text, typed codes keep theirs, everything else stays the
 * generic internal error. `TX_FAILED:*` resolves per result code and only
 * carries the `{code}` parameter when it lands on the collective fallback
 * (see `errorMessage` in `core/errors.ts`).
 *
 * This is the single copy of what `Send`, `Swap`, `AddAsset` and `Home` each
 * used to spell out for themselves.
 */
export function rpcErrorMessage(err: unknown): ErrorMessage {
  if (isRpcTimeout(err)) return { key: 'error.TIMEOUT' };
  return err instanceof AppError ? errorMessage(err.code) : { key: 'error.INTERNAL_ERROR' };
}

/** {@link rpcErrorMessage}, already translated; what a screen actually shows. */
export function formatRpcError(
  t: (key: string, params?: TParams) => string,
  err: unknown,
): string {
  const { key, params } = rpcErrorMessage(err);
  return t(key, params);
}

/**
 * i18n key for anything thrown by {@link rpc}. Kept for callers that only need
 * the key; anything that renders a failure should use {@link formatRpcError},
 * which also passes the parameters along.
 */
export function rpcErrorI18nKey(err: unknown): string {
  return rpcErrorMessage(err).key;
}

/** Reject with a typed timeout instead of waiting on a promise that never settles. */
function withTimeout<T>(pending: Promise<T>, method: RpcMethod): Promise<T> {
  const ms = rpcTimeoutMs(method);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(method, ms)), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

function isResponse(value: unknown): value is RpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'ok' in value &&
    typeof (value as { ok: unknown }).ok === 'boolean'
  );
}

/**
 * Send a typed request to the background and validate the reply.
 * Rejects with an {@link AppError} carrying a translatable code.
 */
export async function rpc<M extends RpcMethod>(
  method: M,
  params: RpcParamsInput<M>,
): Promise<RpcResult<M>> {
  const request = {
    id: nextId(),
    method,
    params: rpcSchemas[method].params.parse(params ?? {}),
  };

  let raw: unknown;
  try {
    raw = await withTimeout(browser.runtime.sendMessage(request), method);
  } catch (err) {
    // A typed error (including the timeout) travels on untouched; only raw
    // transport exceptions become INTERNAL_ERROR.
    if (err instanceof AppError) throw err;
    throw new AppError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  }

  if (!isResponse(raw)) {
    throw new AppError('INTERNAL_ERROR', 'malformed response from background');
  }
  if (!raw.ok) {
    const error = raw.error as WireError;
    throw new AppError(error.code, error.detail);
  }
  return parseResult(method, raw.result);
}

/** Convenience wrappers used across screens. */
export const api = {
  /** The mainnet gate: the only path that may raise the acknowledgement. */
  acknowledgeMainnet: () => rpc('settings.acknowledgeMainnet', { confirmation: 'MAINNET' as const }),
  status: () => rpc('wallet.status', {}),
  unlock: (password: string) => rpc('wallet.unlock', { password }),
  lock: () => rpc('wallet.lock', {}),
  create: (password: string, strength: 128 | 256) =>
    rpc('wallet.create', { password, strength }),
  importMnemonic: (password: string, mnemonic: string, bip39Passphrase?: string) =>
    rpc('wallet.importMnemonic', {
      password,
      mnemonic,
      ...(bip39Passphrase ? { bip39Passphrase } : {}),
    }),
  revealRecoveryPhrase: (password: string) =>
    rpc('wallet.revealRecoveryPhrase', { password }),
  reset: () => rpc('wallet.reset', { confirm: true }),
  accounts: () => rpc('account.list', {}),
  addAccount: (label: string, password: string) =>
    rpc('account.add', { label, password }),
  selectAccount: (index: number) => rpc('account.select', { index }),
  balances: (index?: number) =>
    rpc('account.balances', index === undefined ? {} : { index }),
  history: (index?: number) =>
    rpc('account.history', index === undefined ? {} : { index }),
  fund: (index?: number) => rpc('account.fund', index === undefined ? {} : { index }),
  buildTx: (intent: RpcParamsInput<'tx.build'>['intent'], accountIndex?: number) =>
    rpc('tx.build', accountIndex === undefined ? { intent } : { intent, accountIndex }),
  describeTx: (xdr: string, declaredNetworkPassphrase?: string) =>
    rpc('tx.describe', {
      xdr,
      ...(declaredNetworkPassphrase ? { declaredNetworkPassphrase } : {}),
    }),
  swapQuote: (
    sendAssetId: string,
    sendAmount: string,
    destAssetId: string,
    slippageBps?: number,
  ) =>
    rpc('swap.quote', {
      sendAssetId,
      sendAmount,
      destAssetId,
      ...(slippageBps === undefined ? {} : { slippageBps }),
    }),
  signTx: (xdr: string) => rpc('tx.sign', { xdr }),
  submitTx: (signedXdr: string) => rpc('tx.submit', { signedXdr }),
  /** The submission whose outcome is still open, if there is one. */
  pendingSubmission: () => rpc('tx.pendingSubmission', {}),
  /** One resolution step for a submitted hash, see `tx.status`. */
  txStatus: (hash: string) => rpc('tx.status', { hash }),
  getSettings: () => rpc('settings.get', {}),
  setSettings: (patch: RpcParamsInput<'settings.set'>['patch']) =>
    rpc('settings.set', { patch }),
  pendingPrompt: () => rpc('dapp.pendingPrompt', {}),
  resolvePrompt: (requestId: string, approved: boolean) =>
    rpc('dapp.resolvePrompt', { requestId, approved }),
} as const;
