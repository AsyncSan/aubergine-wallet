/**
 * Cancellation for the Stellar SDK's HTTP client.
 *
 * `withTimeout` in `limiter.ts` owns an `AbortController` and aborts it when a
 * deadline passes, but a signal only cancels what accepts one, and the SDK's
 * call builders accept nothing: `CallBuilder.call()` is `httpClient.get(url)`
 * with no per-call config, and `rpc.Server` posts through the same client.
 *
 * What the client *does* read on every request are its own `defaults`, and one
 * of them is exactly an "abort when this promise settles" channel: the fetch
 * build's `makeRequest` subscribes to `cancelToken.promise`, aborts the
 * controller it hands to the fetch adapter, and rejects the pending call. The
 * adapter forwards that controller's signal into `fetch`, so the socket is
 * really torn down rather than left running with nobody listening.
 *
 * `defaults.signal` is set as well: the axios-backed build of the same client
 * honours that one, and `subscribe`/`unsubscribe` exist so an axios build
 * taking the cancel-token path finds the methods it expects instead of a
 * TypeError.
 *
 * Safe only because both `horizonServer()` and `sorobanServer()` construct a
 * *fresh* server, and therefore a fresh client with fresh defaults, for every
 * request. These defaults are never shared between two calls in flight.
 */
import { AppError } from '../errors';

interface CancellableClient {
  readonly defaults: Record<string, unknown>;
}

export function attachCancellation(
  client: { httpClient: unknown },
  signal: AbortSignal,
): void {
  const httpClient = client.httpClient as CancellableClient | undefined;
  const defaults = httpClient?.defaults;
  // Never let a shape change in the SDK break a payment: without the hook the
  // deadline still rejects, exactly as it did before.
  if (defaults === undefined || defaults === null) return;

  const listeners: Array<(reason: unknown) => void> = [];
  const reason = new AppError('NETWORK_ERROR', 'request aborted by deadline');
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        for (const listener of listeners) listener(reason);
        resolve();
      },
      { once: true },
    );
  });

  defaults['signal'] = signal;
  defaults['cancelToken'] = {
    promise,
    reason: reason.message,
    throwIfRequested(): void {
      if (signal.aborted) throw reason;
    },
    subscribe(listener: (r: unknown) => void): void {
      listeners.push(listener);
    },
    unsubscribe(listener: (r: unknown) => void): void {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
}
