/**
 * dApp connector broker (ARCHITECTURE.md §4 / §6, invariant 7).
 *
 * Scope of this phase-1 implementation:
 *  - the content script is registered *dynamically* and only while developer
 *    mode is on, so a beginner install has zero web-page attack surface,
 *  - every `connect` and every `signTransaction` from a page becomes a pending
 *    prompt that the popup must resolve explicitly (invariant 5),
 *  - approved origins are remembered in settings so a returning dApp only needs
 *    a signing confirmation, not a connection one.
 *
 * Deliberately NOT built out yet: per-origin account scoping, permission expiry
 * and a dedicated approval window. The popup answers prompts today.
 */
import { browser } from 'wxt/browser';
import { AppError } from '../core/errors';
import { DAPP_CONNECTOR_ORIGINS } from '../core/stellar/networks';

export const CONTENT_SCRIPT_ID = 'aubergine-dapp-connector';

export interface PendingPrompt {
  readonly requestId: string;
  readonly origin: string;
  readonly kind: 'connect' | 'sign';
  readonly xdr: string | null;
  /**
   * The network passphrase the calling page declared, verbatim. The popup hands
   * it to `tx.describe`, which raises NETWORK_MISMATCH when it disagrees with
   * the wallet's network (finding 5). Never used for parsing or signing.
   */
  readonly declaredNetworkPassphrase: string | null;
  /**
   * P2: the public key of the account that will produce the signature,
   * resolved *before* the prompt is shown. `null` for connect prompts. The
   * popup renders it so the user sees exactly which account a page-supplied
   * `accountToSign` selects, not just "a transaction".
   */
  readonly signerPublicKey: string | null;
  /** False when the page requested a different account than the active one. */
  readonly signerIsSelected: boolean | null;
  /**
   * The SEP-0005 index of {@link signerPublicKey}. The popup describes the
   * envelope in *this* account's context, so the trust warnings belong to the
   * account that signs rather than to whichever one happens to be selected.
   */
  readonly signerAccountIndex: number | null;
}

interface Waiter {
  readonly prompt: PendingPrompt;
  readonly resolve: (approved: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const PROMPT_TIMEOUT_MS = 120_000;

/**
 * Flood protection: a page gets at most this many prompts queued at once.
 * Beyond that the request is rejected immediately instead of letting a
 * hostile dApp bury a real confirmation under dozens of decoys (prompt
 * fatigue is an attack, not an inconvenience).
 */
export const MAX_PENDING_PER_ORIGIN = 3;

/**
 * Global ceiling across all origins. The per-origin cap alone is not enough:
 * subdomains are separate origins, so `a.evil`, `b.evil`, … each got their own
 * budget, and a pending prompt takes over the whole popup, including the Lock
 * button and the Settings screen the user would need in order to turn the
 * connector off. Six is comfortably above any honest multi-dApp session.
 */
export const MAX_PENDING_TOTAL = 6;

/** Queue of prompts awaiting a human decision in the popup. */
export class PromptQueue {
  #waiters = new Map<string, Waiter>();
  #order: string[] = [];
  #counter = 0;

  /** How many prompts are waiting; the flood caps are asserted against this. */
  get size(): number {
    return this.#order.length;
  }

  get pending(): PendingPrompt | null {
    const id = this.#order[0];
    if (id === undefined) return null;
    return this.#waiters.get(id)?.prompt ?? null;
  }

  /**
   * Register a prompt and block until the popup resolves it (or it times out).
   * A timeout counts as a rejection, fail closed.
   */
  ask(
    kind: PendingPrompt['kind'],
    origin: string,
    xdr: string | null,
    declaredNetworkPassphrase: string | null = null,
    signer: { publicKey: string; isSelected: boolean; index: number } | null = null,
  ): Promise<boolean> {
    let pendingForOrigin = 0;
    for (const id of this.#order) {
      if (this.#waiters.get(id)?.prompt.origin === origin) pendingForOrigin += 1;
    }
    if (pendingForOrigin >= MAX_PENDING_PER_ORIGIN) {
      throw new AppError('TOO_MANY_REQUESTS', origin);
    }
    if (this.#order.length >= MAX_PENDING_TOTAL) {
      throw new AppError('TOO_MANY_REQUESTS', origin);
    }
    this.#counter += 1;
    const requestId = `prompt-${Date.now().toString(36)}-${this.#counter}`;
    const prompt: PendingPrompt = {
      requestId,
      origin,
      kind,
      xdr,
      declaredNetworkPassphrase,
      signerPublicKey: signer?.publicKey ?? null,
      signerIsSelected: signer?.isSelected ?? null,
      signerAccountIndex: signer?.index ?? null,
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#finish(requestId, false);
      }, PROMPT_TIMEOUT_MS);
      this.#waiters.set(requestId, { prompt, resolve, timer });
      this.#order.push(requestId);
      void this.#notify();
    });
  }

  resolve(requestId: string, approved: boolean): void {
    if (!this.#waiters.has(requestId)) {
      throw new AppError('BAD_REQUEST', 'unknown or expired prompt');
    }
    this.#finish(requestId, approved);
  }

  /** Reject everything, e.g. when the wallet locks. */
  rejectAll(): void {
    for (const id of [...this.#order]) this.#finish(id, false);
  }

  #finish(requestId: string, approved: boolean): void {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#waiters.delete(requestId);
    this.#order = this.#order.filter((id) => id !== requestId);
    waiter.resolve(approved);
    void this.#notify();
  }

  /** Badge the toolbar icon so a background prompt is not missed. */
  async #notify(): Promise<void> {
    try {
      const count = this.#order.length;
      await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      // Deep brand aubergine: the badge text Chrome writes on it is white.
      await browser.action.setBadgeBackgroundColor({ color: '#7B2FB8' });
    } catch {
      /* badge is cosmetic */
    }
  }
}

/**
 * Does the user actually hold the broad web access the connector needs?
 *
 * `http(s)://*` is an *optional* host permission (finding B): it is requested
 * from the Settings toggle with a user gesture, and the user may decline or
 * revoke it later in the browser's own UI. Registration must therefore check,
 * not assume.
 */
export async function hasDappConnectorPermission(): Promise<boolean> {
  try {
    const permissions = browser.permissions;
    if (!permissions?.contains) return false;
    return await permissions.contains({ origins: [...DAPP_CONNECTOR_ORIGINS] });
  } catch {
    return false;
  }
}

/**
 * Register or unregister the content script at runtime.
 * Invariant 7: nothing is declared statically in the manifest.
 *
 * Returns `true` when the requested state was reached. `false` means developer
 * mode is on but the host permission is missing, so the connector stays off,
 * the caller surfaces that instead of pretending it worked.
 */
export async function syncContentScriptRegistration(enabled: boolean): Promise<boolean> {
  const scripting = browser.scripting;
  if (!scripting?.getRegisteredContentScripts) return !enabled;
  if (enabled && !(await hasDappConnectorPermission())) {
    // Fail closed and also clean up a registration left over from a run where
    // the permission was still granted.
    await syncContentScriptRegistration(false);
    return false;
  }
  try {
    const existing = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    const isRegistered = existing.length > 0;
    if (enabled && !isRegistered) {
      await scripting.registerContentScripts([
        {
          id: CONTENT_SCRIPT_ID,
          js: ['content-scripts/content.js'],
          matches: [...DAPP_CONNECTOR_ORIGINS],
          runAt: 'document_start',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    } else if (!enabled && isRegistered) {
      await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    return true;
  } catch {
    /* Registration is best-effort; the provider simply stays unavailable. */
    return false;
  }
}

export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    throw new AppError('BAD_REQUEST', `malformed origin: ${origin}`);
  }
}
