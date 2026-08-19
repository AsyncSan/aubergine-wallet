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
 *
 * THE CLOCK, stated plainly. `lockedUntil` is a wall-clock instant, and the
 * system clock is not ours. Two of the three ways that hurts are closed here:
 *
 *  - moving the clock *backwards* is detected (`lockedAt` records when the
 *    lockout began; a `now` before it cannot be honest) and costs the full
 *    delay again, re-anchored to the new reading, rather than clearing it;
 *  - moving it *forwards* while this worker is alive is overridden by
 *    {@link UnlockGuard.monotonicRemainingMs}, a `performance.now()` deadline
 *    that no clock change can move.
 *
 * What stays open, and cannot be closed by an extension: a forward jump
 * *combined with* a service-worker restart. MV3 tears the worker down at will,
 * which discards the monotonic anchor, and nothing an extension can read is
 * both monotonic and durable across that. "The browser was closed overnight"
 * and "the clock was moved a day forward" produce identical evidence. An
 * attacker who can do this gets back to one guess per Argon2id derivation
 * (~0.5 s on the owner's hardware) with the counter still climbing, which is
 * the floor this guard was ever able to promise, not a bypass of it.
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
  /**
   * When the current lockout was written, by the same clock as `lockedUntil`.
   * Defaulted so a record from a build before this field still parses; an
   * absent value simply means the backwards-jump check has nothing to compare
   * against yet, and the next failure supplies one.
   */
  lockedAt: z.number().nullable().default(null),
});

export type UnlockGuardState = z.infer<typeof stateSchema>;

const INITIAL_STATE: UnlockGuardState = { failures: 0, lockedUntil: null, lockedAt: null };

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
   * `performance.now()` deadline for the lockout this worker imposed, or null.
   *
   * Deliberately in-memory: its whole value is that it comes from a monotonic
   * source the system clock cannot move. It is lost when MV3 tears the worker
   * down, which is the limitation written up in this module's header, and it
   * is never the *only* thing consulted, `lockedUntil` covers the restart.
   */
  #monotonicUntil: number | null = null;

  /** Milliseconds the monotonic anchor still insists on, 0 when it has none. */
  monotonicRemainingMs(): number {
    if (this.#monotonicUntil === null) return 0;
    const remaining = this.#monotonicUntil - performance.now();
    if (remaining <= 0) {
      this.#monotonicUntil = null;
      return 0;
    }
    return remaining;
  }

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
      const now = Date.now();
      this.#monotonicUntil = delay > 0 ? performance.now() + delay : null;
      await writeState({
        failures,
        lockedUntil: delay > 0 ? now + delay : null,
        lockedAt: delay > 0 ? now : null,
      });
    } catch {
      /* best effort; an over-counted attempt only delays the owner slightly */
    }
  }

  /**
   * Throws `UNLOCK_THROTTLED` (detail = whole seconds remaining) while a
   * lockout is active. Call before every decryption attempt.
   *
   * Three sources are consulted and the longest wins: the stored wall-clock
   * deadline, the monotonic anchor this worker holds, and, when the clock has
   * demonstrably moved backwards, a fresh full delay. See the module header
   * for which clock attacks that does and does not cover.
   */
  async assertAllowed(now = Date.now()): Promise<void> {
    const state = await readState();
    let remaining = this.monotonicRemainingMs();

    if (state.lockedUntil !== null) {
      /**
       * `now` before the instant the lockout was written is not a clock this
       * wallet can reason with. Rather than trust either reading, serve the
       * whole delay again from the new one, so winding the clock back is
       * strictly worse for the attacker than leaving it alone.
       */
      if (state.lockedAt !== null && now < state.lockedAt) {
        const delay = delayForFailures(state.failures);
        remaining = Math.max(remaining, delay);
        this.#monotonicUntil = performance.now() + delay;
        await writeState({
          failures: state.failures,
          lockedUntil: now + delay,
          lockedAt: now,
        });
      } else if (now < state.lockedUntil) {
        remaining = Math.max(remaining, state.lockedUntil - now);
      }
    }

    if (remaining > 0) {
      throw new AppError('UNLOCK_THROTTLED', String(Math.max(1, Math.ceil(remaining / 1000))));
    }
  }

  /** Record a wrong password and (re)compute the lockout. */
  async registerFailure(now = Date.now()): Promise<UnlockGuardState> {
    const state = await readState();
    const failures = state.failures + 1;
    const delay = delayForFailures(failures);
    // Anchored on both clocks at once, so the pair can be cross-checked later.
    this.#monotonicUntil = delay > 0 ? performance.now() + delay : null;
    const next: UnlockGuardState = {
      failures,
      lockedUntil: delay > 0 ? now + delay : null,
      lockedAt: delay > 0 ? now : null,
    };
    await writeState(next);
    return next;
  }

  /** A correct password proves the caller is the owner: clear everything. */
  async reset(): Promise<void> {
    this.#monotonicUntil = null;
    try {
      await browser.storage.local.remove(GUARD_KEY);
    } catch {
      /* best effort; a stale counter only delays, never locks out forever */
    }
  }
}
