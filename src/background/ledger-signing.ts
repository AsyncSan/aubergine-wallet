/**
 * Pending hardware signatures (ARCHITECTURE.md §3).
 *
 * ## Why the signing path splits at all
 *
 * `navigator.hid` exists only in a window context, never in an MV3 service
 * worker, so the bytes have to travel through a page to reach the device. The
 * shape that keeps that from weakening anything is:
 *
 *   background: run every guard, hand out the **signature base**
 *   page:       carry bytes to the device and back, decide nothing
 *   background: verify the answer, attach it, return the signed envelope
 *
 * The page is a courier. It cannot skip a check, because it never performs
 * one; it cannot forge a signature, because the attach step verifies against
 * the key recorded at enrolment; and it learns nothing it did not already
 * have, because the signature base is computable from the envelope and the
 * network passphrase, both of which the page was given in order to display
 * them.
 *
 * A request is **single use**. One `begin` authorises at most one signature,
 * for the same reason `consumeInternalSoroban` is a take and not a get: a
 * reusable handle to "sign this" is a second envelope waiting to happen.
 */
import { AppError } from '../core/errors';

/**
 * How long a request stays open.
 *
 * Generous on purpose. The user may have to find the device, plug it in,
 * enter a PIN, open the Stellar app and page through the operation on a
 * five-line screen. Two minutes — the dApp prompt timeout — would expire in
 * the middle of an honest ceremony. It is still bounded, because a request
 * that outlives the transaction's own timebound is worthless anyway.
 */
export const LEDGER_REQUEST_TTL_MS = 300_000;

export interface LedgerSignRequest {
  readonly requestId: string;
  /** Wallet slot that signs, for the submission bookkeeping. */
  readonly accountIndex: number;
  /** Path position to ask the device for. */
  readonly derivationIndex: number;
  /** The key enrolled for this slot; the answer is checked against it. */
  readonly publicKey: string;
  /** The envelope, unchanged, so the page can render it while waiting. */
  readonly xdr: string;
  readonly networkPassphrase: string;
  /** Base64 of the exact bytes the device must sign. */
  readonly signatureBase: string;
  readonly expiresAt: number;
}

export class LedgerSignQueue {
  #requests = new Map<string, LedgerSignRequest>();
  #counter = 0;

  get size(): number {
    this.#sweep();
    return this.#requests.size;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, request] of this.#requests) {
      if (request.expiresAt <= now) this.#requests.delete(id);
    }
  }

  open(spec: Omit<LedgerSignRequest, 'requestId' | 'expiresAt'>): LedgerSignRequest {
    this.#sweep();
    this.#counter += 1;
    const request: LedgerSignRequest = {
      ...spec,
      requestId: `ledger-${Date.now().toString(36)}-${this.#counter}`,
      expiresAt: Date.now() + LEDGER_REQUEST_TTL_MS,
    };
    this.#requests.set(request.requestId, request);
    return request;
  }

  /** Read without consuming, so the page can render what it is waiting for. */
  peek(requestId: string): LedgerSignRequest {
    this.#sweep();
    const request = this.#requests.get(requestId);
    if (!request) throw new AppError('LEDGER_REQUEST_EXPIRED');
    return request;
  }

  /** Read *and* consume. The only path to attaching a signature. */
  take(requestId: string): LedgerSignRequest {
    const request = this.peek(requestId);
    this.#requests.delete(requestId);
    return request;
  }

  cancel(requestId: string): void {
    this.#requests.delete(requestId);
  }

  /**
   * Drop everything.
   *
   * Called on lock, exactly like `prompts.rejectAll()`. A request that
   * outlived a lock would let a signature be attached to an envelope built
   * under an authorisation the user has since withdrawn.
   */
  clear(): void {
    this.#requests.clear();
  }
}
