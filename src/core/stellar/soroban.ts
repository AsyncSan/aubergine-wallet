/**
 * Soroban RPC access.
 *
 * Phase 1 scope (§4): developer mode may *simulate and prepare* contract
 * invocations; beginner mode blocks them with an explanatory text. The broker
 * lives in the background like Horizon's.
 *
 * v1.3: the endpoint is no longer a single URL. `NetworkConfig.sorobanRpcUrls`
 * is an ordered chain and everything in this file walks it, because this code
 * path is mandatory; an aggregator swap and an unprepared dApp Soroban
 * transaction both go through `prepareSorobanTransaction`, and on Mainnet the
 * one endpoint we had was a free service run by a single person with no ToS
 * and no SLA (see the source notes in `networks.ts`).
 */
import { rpc, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { AppError } from '../errors';
import { limited } from '../net/limiter';
import { attachCancellation } from '../net/sdk-cancel';
import type { NetworkConfig } from './networks';

/**
 * Hard ceiling for one Soroban RPC round trip.
 *
 * The SDK's RPC client has no timeout of its own, so a black-holed endpoint
 * (accepts the connection, never answers) used to hang `tx.build` until the
 * popup's own 30 s RPC ceiling fired, with no fallback and no way to tell the
 * user what was stuck. Below Horizon's 20 s on purpose: this call is on the
 * mandatory path *and* has somewhere to fall back to, so giving up early is
 * cheaper than waiting.
 */
export const SOROBAN_TIMEOUT_MS = 12_000;

/**
 * How long a working endpoint stays the preferred one.
 *
 * Without this every call would start at the top of the chain and pay the
 * full timeout of every dead entry again. With it, one call pays that price
 * and the rest of the session follows. It expires so a temporary outage does
 * not permanently demote the primary (which, when the user configured one, is
 * *their* endpoint).
 */
export const SOROBAN_STICKY_MS = 5 * 60_000;

/**
 * Rate limiting: done. The bucket moved out of `horizon.ts` into
 * `core/net/limiter.ts` and this file now shares it; §3 ("rate limiting
 * happens in exactly one place") is finally true of the Soroban path too.
 * It matters most here: since the endpoint chain landed, one outage sent up to
 * four requests in a row with nothing between them but their own timeouts.
 */

/**
 * Something this file decided is a transport failure before the classifier
 * below ever sees the original exception: a timeout we imposed, or an endpoint
 * that answered but declared itself unhealthy. Stays inside the existing
 * `NETWORK_ERROR` code space (§6); no new wire code, no missing i18n entry.
 */
class SorobanTransportError extends AppError {
  constructor(detail: string) {
    super('NETWORK_ERROR', detail);
    this.name = 'SorobanTransportError';
  }
}

/** A round trip that never came back. */
class SorobanTimeoutError extends SorobanTransportError {
  constructor(ms: number) {
    super(`soroban rpc timeout after ${ms} ms`);
    this.name = 'SorobanTimeoutError';
  }
}

/**
 * Strip credentials out of anything that might be shown or logged.
 *
 * The user's own endpoint may be an Alchemy URL of the form
 * `https://stellar-mainnet.g.alchemy.com/v2/<key>`; the API key is *in the
 * path*. The SDK's HTTP errors carry the request URL, and `toWireError` passes
 * `err.message` straight to the popup, so an unredacted detail would put a
 * live credential into an error toast (and into any future log line). The
 * origin is kept: it is not a secret and it is what makes the message useful.
 */
export function redactEndpoints(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>()[\]{},;]+/giu, (match) => {
    try {
      return new URL(match).origin;
    } catch {
      return '<endpoint>';
    }
  });
}

/** Message of anything throwable, already redacted. Never a stack trace. */
function safeMessage(err: unknown): string {
  if (err instanceof Error) return redactEndpoints(err.message);
  if (typeof err === 'object' && err !== null) {
    // JSON-RPC errors arrive as a bare `{code, message}` object, not an Error
    // (see the SDK's `postObject`), so `String(err)` would be "[object Object]".
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return redactEndpoints(message);
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return `rpc error ${code}`;
    return 'rpc error';
  }
  return redactEndpoints(String(err));
}

function httpStatusOf(err: unknown): number | null {
  const status = (err as { response?: { status?: unknown }; status?: unknown })?.response
    ?.status;
  if (typeof status === 'number') return status;
  const direct = (err as { status?: unknown })?.status;
  return typeof direct === 'number' ? direct : null;
}

const TRANSPORT_MESSAGE = new RegExp(
  [
    'failed to fetch',
    'fetch failed',
    'networkerror',
    'network request failed',
    'load failed',
    'timeout',
    'timed out',
    'socket hang up',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'etimedout',
    'connection closed',
  ].join('|'),
  'iu',
);

/**
 * Transport failure (try the next endpoint) versus a reasoned answer (do not).
 *
 * This distinction is the whole point of the chain. Failing over on a
 * *business* answer; a simulation that says "this contract call reverts",
 * would hide the real reason behind two more timeouts and then report a
 * network problem that does not exist. So the default is deliberately
 * "not transport": an error we cannot place is surfaced, not retried.
 *
 * Transport, per the brief: network error, timeout, HTTP 5xx, HTTP 429. Plus
 * 408 (same class as a timeout) and a JSON parse failure, which means the host
 * answered with something that is not a JSON-RPC endpoint at all, a captive
 * portal or a proxy error page, never a statement about the transaction.
 */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof SorobanTransportError) return true;

  const status = httpStatusOf(err);
  if (status !== null) return status >= 500 || status === 429 || status === 408;

  // A JSON-RPC error object: the server understood us and said no.
  if (
    typeof err === 'object' &&
    err !== null &&
    !(err instanceof Error) &&
    typeof (err as { code?: unknown }).code === 'number'
  ) {
    return false;
  }

  if (err instanceof SyntaxError) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    return TRANSPORT_MESSAGE.test(err.message);
  }
  return false;
}

/**
 * The deadline is the shared one now; only the *error* stays local, because
 * `isTransportFailure` keys on `SorobanTransportError` to decide whether the
 * chain advances. A generic timeout error would still be classified as
 * transport (its message contains "timeout"), but by accident rather than by
 * type, so the factory is passed in explicitly.
 */
const sorobanTimeout = (ms: number): unknown => new SorobanTimeoutError(ms);

/* ------------------------------------------------------ endpoint selection */

interface StickyEndpoint {
  readonly url: string;
  readonly expiresAt: number;
}

/**
 * Keyed by the chain itself, not by network id: changing the configured
 * override changes the key, so a stale preference cannot survive a settings
 * change. One entry per worker lifetime is all this needs.
 */
const sticky = new Map<string, StickyEndpoint>();

function chainKey(chain: readonly string[]): string {
  return chain.join(' ');
}

/** Test seam and settings-change hook, forget every remembered endpoint. */
export function resetSorobanEndpointCache(): void {
  sticky.clear();
}

/**
 * The chain in the order it will actually be tried: the remembered endpoint
 * first (while it is fresh), otherwise the configured order, which already has
 * the user's own endpoint at the front.
 */
export function orderedEndpoints(
  network: NetworkConfig,
  now: number = Date.now(),
): readonly string[] {
  const chain = network.sorobanRpcUrls;
  const key = chainKey(chain);
  const remembered = sticky.get(key);
  if (remembered === undefined) return chain;
  if (remembered.expiresAt <= now || !chain.includes(remembered.url)) {
    sticky.delete(key);
    return chain;
  }
  if (remembered.url === chain[0]) return chain;
  return [remembered.url, ...chain.filter((url) => url !== remembered.url)];
}

function remember(network: NetworkConfig, url: string, now: number = Date.now()): void {
  sticky.set(chainKey(network.sorobanRpcUrls), { url, expiresAt: now + SOROBAN_STICKY_MS });
}

function forget(network: NetworkConfig, url: string): void {
  const key = chainKey(network.sorobanRpcUrls);
  if (sticky.get(key)?.url === url) sticky.delete(key);
}

export function sorobanServer(endpoint: string, signal?: AbortSignal): rpc.Server {
  // `allowHttp: false` is a second lock on the https-only rule the settings
  // schema already enforces for a user-supplied endpoint.
  const server = new rpc.Server(endpoint, { allowHttp: false });
  // Same reasoning as on the Horizon side: the deadline in `limiter.ts` now
  // aborts the request instead of only abandoning it. It matters here for the
  // opposite reason; a Soroban call that keeps running after the chain moved
  // on to the next endpoint spends the user's quota twice.
  if (signal !== undefined) attachCancellation(server, signal);
  return server;
}

/**
 * Run `op` against the first endpoint that answers.
 *
 * Transport failures advance to the next endpoint; anything else is surfaced
 * immediately, wrapped so no raw exception string (and therefore no URL with a
 * key in it) reaches the wire. If every endpoint fails on transport, the last
 * transport failure decides the message.
 */
export async function withSorobanEndpoint<T>(
  network: NetworkConfig,
  op: (server: rpc.Server, endpoint: string) => Promise<T>,
): Promise<T> {
  const endpoints = orderedEndpoints(network);
  let lastTransportError: unknown = null;
  for (const endpoint of endpoints) {
    try {
      const result = await limited(
        (signal) => op(sorobanServer(endpoint, signal), endpoint),
        SOROBAN_TIMEOUT_MS,
        sorobanTimeout,
      );
      remember(network, endpoint);
      return result;
    } catch (err) {
      if (!isTransportFailure(err)) {
        // A reasoned "no" from the RPC. Keep the endpoint, it is working,
        // and let the caller see the real reason.
        throw err instanceof AppError
          ? err
          : new AppError('NETWORK_ERROR', safeMessage(err));
      }
      lastTransportError = err;
      forget(network, endpoint);
    }
  }
  throw new AppError(
    'NETWORK_ERROR',
    `all ${endpoints.length} soroban rpc endpoint(s) failed: ${
      lastTransportError === null ? 'no endpoint configured' : safeMessage(lastTransportError)
    }`,
  );
}

/* ------------------------------------------------------------- operations */

/** Operation types that make a transaction a Soroban transaction (§4 row 3). */
const SOROBAN_OPERATION_TYPES: readonly string[] = [
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
];

/**
 * True when the envelope invokes a smart contract (or touches contract state).
 * Beginner mode refuses to sign these; developer mode simulates them first.
 */
export function isSorobanTransaction(tx: Transaction): boolean {
  return tx.operations.some((op) => SOROBAN_OPERATION_TYPES.includes(op.type));
}

/**
 * True when the envelope already carries a resource footprint, i.e. it has been
 * prepared (by the dApp or by us) and can be signed as it stands.
 *
 * `TransactionExt` discriminant 1 is `sorobanData`; 0 means "no Soroban data".
 */
export function hasSorobanFootprint(tx: Transaction): boolean {
  try {
    return tx.toEnvelope().v1().tx().ext().switch() === 1;
  } catch {
    return false;
  }
}

export interface SimulationSummary {
  readonly ok: boolean;
  /** Recommended total fee in stroops after simulation, when available. */
  readonly minResourceFee: string | null;
  readonly error: string | null;
}

export interface PreparedSorobanTransaction {
  readonly preparedXdr: string;
  readonly summary: SimulationSummary;
}

/**
 * Simulate and, on success, return the prepared (footprint-annotated) envelope.
 * A failed simulation is surfaced, never swallowed, signing something we could
 * not simulate is exactly the fail-closed case §5 warns about.
 *
 * A failed simulation is also the canonical *non*-transport failure: the RPC
 * did its job and the answer is no. It returns normally, so no other endpoint
 * is consulted and the user sees the contract's reason rather than three
 * timeouts followed by "network unreachable".
 */
export async function prepareSorobanTransaction(
  network: NetworkConfig,
  xdrString: string,
): Promise<PreparedSorobanTransaction> {
  const tx = TransactionBuilder.fromXDR(xdrString, network.passphrase) as Transaction;
  return withSorobanEndpoint(network, async (server) => {
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return {
        preparedXdr: xdrString,
        summary: { ok: false, minResourceFee: null, error: redactEndpoints(sim.error) },
      };
    }
    const prepared = await server.prepareTransaction(tx);
    return {
      preparedXdr: prepared.toXDR(),
      summary: {
        ok: true,
        minResourceFee: rpc.Api.isSimulationSuccess(sim) ? sim.minResourceFee : null,
        error: null,
      },
    };
  });
}

/** True when *any* endpoint in the chain reports healthy. */
export async function sorobanHealth(network: NetworkConfig): Promise<boolean> {
  try {
    return await withSorobanEndpoint(network, async (server) => {
      const health = await server.getHealth();
      // An endpoint that declares itself unhealthy is not an answer we can
      // use, treated as transport so the chain moves on to the next one.
      if (health.status !== 'healthy') {
        throw new SorobanTransportError('soroban rpc reports unhealthy');
      }
      return true;
    });
  } catch {
    return false;
  }
}
