/**
 * Progressive unlock throttling (brute-force protection).
 *
 * Every password-checking path funnels through `BackgroundContext.loadVault`,
 * so a single guard covers unlock, revealRecoveryPhrase and account.add.
 * Argon2id already makes one guess cost ~0.5 s; this guard adds a persistent,
 * exponentially growing delay so an attacker driving the popup (or the RPC
 * surface) cannot try passwords at machine speed, and the count survives a
 * service-worker restart because it lives in `storage.local`.
 *
 * Policy: the first {@link FREE_ATTEMPTS} failures are free (typos happen).
 * From then on each failure locks the wallet for
 * `BASE_DELAY_MS * 2^(failures - FREE_ATTEMPTS - 1)`, capped at
 * {@link MAX_DELAY_MS}. Any successful decryption resets the counter.
 *
 * Threat-model note: the state is same-privilege storage. Code that can edit
 * `storage.local` could clear it, but such code could also read the keystore
 * blob and grind offline, so the guard targets what it can actually stop:
 * online guessing through the wallet's own RPC surface.
 */
import { z } from 'zod';
import { browser } from 'wxt/browser';
import { AppError } from '../core/errors';
import { BadPasswordError } from '../core/crypto/keystore';

const GUARD_KEY = 'unlockGuard.v1';

export const FREE_ATTEMPTS = 4;
export const BASE_DELAY_MS = 30_000;
export const MAX_DELAY_MS = 30 * 60_000;

const stateSchema = z.object({
  failures: z.number().int().nonnegative(),
  lockedUntil: z.number().nullable(),
});

export type UnlockGuardState = z.infer<typeof stateSchema>;

const INITIAL_STATE: UnlockGuardState = { failures: 0, lockedUntil: null };

/** Delay imposed *after* the given total number of failures. Pure, for tests. */
export function delayForFailures(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const exponent = failures - FREE_ATTEMPTS - 1;
  // 2^exponent can overflow Number for absurd counts; cap the exponent first.
  if (exponent >= 31) return MAX_DELAY_MS;
  return Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
}

async function readState(): Promise<UnlockGuardState> {
  try {
    const stored = await browser.storage.local.get(GUARD_KEY);
    const parsed = stateSchema.safeParse(stored[GUARD_KEY]);
    return parsed.success ? parsed.data : INITIAL_STATE;
  } catch {
    // Fail closed is tempting, but an unreadable store would then brick the
    // wallet forever. Missing state only weakens the throttle, never the KDF.
    return INITIAL_STATE;
  }
}

async function writeState(state: UnlockGuardState): Promise<void> {
  await browser.storage.local.set({ [GUARD_KEY]: state });
}

export class UnlockGuard {
  /**
   * Attempts run one at a time. Without this, `assertAllowed` → KDF →
   * `registerFailure` is a check-then-act over shared storage: twelve
   * simultaneous `wallet.unlock` calls used to cost *two* counted failures and
   * trip no lockout at all, turning the throttle into a formality and the
   * guessing rate into "one core per Argon2id derivation".
   */
  #chain: Promise<unknown> = Promise.resolve();

  /**
   * Run one password attempt under the guard. `attempt` must throw
   * {@link BadPasswordError} for a wrong password and anything else for a
   * problem that is not the user's fault (an unreadable store, a schema error).
   */
  async attempt<T>(run: () => Promise<T>): Promise<T> {
    const settled = this.#chain.then(
      () => this.#guarded(run),
      () => this.#guarded(run),
    );
    // Keep the chain alive regardless of outcome, and never leave it rejected.
    this.#chain = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  async #guarded<T>(run: () => Promise<T>): Promise<T> {
    await this.assertAllowed();
    // Count *before* the attempt, not after: a worker that dies mid-derivation
    // (or is killed on purpose) must not hand the attacker a free guess.
    const reserved = await this.registerFailure();
    try {
      const value = await run();
      await this.reset();
      return value;
    } catch (err) {
      if (err instanceof BadPasswordError) {
        /**
         * P2 "Unlock-Politur": the attempt that trips a lockout reports the
         * lockout, not just BAD_PASSWORD; the password was wrong either way,
         * but only UNLOCK_THROTTLED (detail = seconds) lets the popup start
         * its countdown ring immediately instead of on the next futile try.
         */
        if (reserved.lockedUntil !== null) {
          const seconds = Math.max(1, Math.ceil((reserved.lockedUntil - Date.now()) / 1000));
          throw new AppError('UNLOCK_THROTTLED', String(seconds));
        }
        throw err;
      }
      // Not a wrong password, give the attempt back.
      await this.#release(reserved);
      throw err;
    }
  }

  /** Undo one reservation (used when the failure was not a wrong password). */
  async #release(reserved: UnlockGuardState): Promise<void> {
    try {
      const current = await readState();
      // Only roll back our own reservation; a concurrent reset must win.
      if (current.failures !== reserved.failures) return;
      const failures = Math.max(0, current.failures - 1);
      const delay = delayForFailures(failures);
      await writeState({ failures, lockedUntil: delay > 0 ? Date.now() + delay : null });
    } catch {
      /* best effort; an over-counted attempt only delays the owner slightly */
    }
  }

  /**
   * Throws `UNLOCK_THROTTLED` (detail = whole seconds remaining) while a
   * lockout is active. Call before every decryption attempt.
   */
  async assertAllowed(now = Date.now()): Promise<void> {
    const state = await readState();
    if (state.lockedUntil !== null && now < state.lockedUntil) {
      const seconds = Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
      throw new AppError('UNLOCK_THROTTLED', String(seconds));
    }
  }

  /** Record a wrong password and (re)compute the lockout. */
  async registerFailure(now = Date.now()): Promise<UnlockGuardState> {
    const state = await readState();
    const failures = state.failures + 1;
    const delay = delayForFailures(failures);
    const next: UnlockGuardState = {
      failures,
      lockedUntil: delay > 0 ? now + delay : null,
    };
    await writeState(next);
    return next;
  }

  /** A correct password proves the caller is the owner: clear everything. */
  async reset(): Promise<void> {
    try {
      await browser.storage.local.remove(GUARD_KEY);
    } catch {
      /* best effort; a stale counter only delays, never locks out forever */
    }
  }
}
