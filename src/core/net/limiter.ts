/**
 * The extension's one outbound request budget.
 *
 * ARCHITECTURE.md §3 says rate limiting happens in exactly one place. Until
 * now it happened in *one file*, `horizon.ts`, as a module-level private, so
 * the Soroban path (`soroban.ts`), which is on the mandatory path of every
 * aggregator swap and every unprepared dApp Soroban transaction, had no bucket
 * at all. Since the endpoint fallback chain landed, one outage there produced
 * up to four un-throttled requests back to back. This module is the shared
 * home, imported by both.
 *
 * Nothing here knows about Horizon or Soroban: the timeout and the error a
 * timeout raises are supplied by the caller, because the two paths classify
 * their own failures differently (`soroban.ts` needs its own error class so
 * the endpoint chain can tell transport from a reasoned "no").
 */
import { AppError } from '../errors';

/**
 * Minimal token bucket: at most `maxConcurrent` requests in flight, and at
 * least `minIntervalMs` between two starts.
 *
 * What this actually buys, stated honestly: it bounds *burstiness*, not the
 * hourly quota. Horizon's public instances document a limit of 3600 requests
 * per hour per IP; 4 in flight with a 60 ms minimum spacing allows up to
 * ~16.7 req/s, i.e. ~60,000 req/h, over sixteen times that quota. What it
 * prevents is the shape of traffic that gets an IP throttled immediately (a
 * popup opening and firing balances, history, path finding and fee stats in
 * the same tick) and it stops a black-holed endpoint from pinning every slot.
 * A real quota guard would have to count requests over a rolling hour and is
 * not implemented; see the report.
 */
export class RateLimiter {
  #queue: Array<() => void> = [];
  #inFlight = 0;
  constructor(
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
  ) {}
  #lastStart = 0;

  async acquire(): Promise<() => void> {
    if (this.#inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#inFlight++;
    const wait = this.#lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#lastStart = Date.now();
    return () => {
      this.#inFlight--;
      const next = this.#queue.shift();
      if (next) next();
    };
  }
}

/** The single shared bucket. Values unchanged from the Horizon-only version. */
export const limiter = new RateLimiter(4, 60);

/** Builds the rejection a timeout raises, so each caller keeps its own class. */
export type TimeoutErrorFactory = (ms: number) => unknown;

const defaultTimeoutError: TimeoutErrorFactory = (ms) =>
  new AppError('NETWORK_ERROR', `timeout after ${ms} ms`);

/** Marker on the reason an expired deadline aborts its controller with. */
export const TIMEOUT_ABORT_REASON = 'aborted: request deadline exceeded';

/**
 * Work that can be cancelled: it receives the deadline's `AbortSignal` and is
 * expected to hand it to whatever actually performs I/O. A plain promise is
 * still accepted for callers that have nothing to cancel, see below.
 */
export type Abortable<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Reject after `ms` **and cancel the work**.
 *
 * The previous version raced a timer against a promise and said so in its own
 * comment: "the underlying fetch may keep running". For a *payment* that is
 * not a cosmetic leak; the request that the wallet has stopped waiting for is
 * exactly the one that may still put the transaction into a ledger. The
 * deadline now owns an `AbortController`, aborts it before rejecting, and
 * passes its signal to the work.
 *
 * Honesty about reach: a signal only cancels what accepts one. `fetch` does;
 * `@stellar/stellar-sdk`'s call builders do not take a per-call config at all
 * (`CallBuilder.call()` is `httpClient.get(url)` with no options), so the
 * Horizon path routes the signal through the client's `cancelToken` channel
 * instead, see `attachCancellation` in `core/stellar/horizon.ts`. Passing a
 * bare promise keeps the old, uncancellable behaviour, and the only callers
 * that may do that are the ones with nothing to cancel.
 */
export async function withTimeout<T>(
  work: Abortable<T> | Promise<T>,
  ms: number,
  makeError: TimeoutErrorFactory = defaultTimeoutError,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = typeof work === 'function' ? work(controller.signal) : work;
  try {
    return await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Abort first, reject second: by the time the caller sees the
          // rejection the request underneath is already being torn down.
          controller.abort(TIMEOUT_ABORT_REASON);
          reject(makeError(ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One request: a bucket slot, a hard deadline, and the slot released either way. */
export async function limited<T>(
  fn: Abortable<T>,
  timeoutMs: number,
  makeError?: TimeoutErrorFactory,
): Promise<T> {
  const release = await limiter.acquire();
  try {
    return await withTimeout(fn, timeoutMs, makeError);
  } finally {
    release();
  }
}
