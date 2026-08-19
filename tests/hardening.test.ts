/**
 * Security-hardening round (Aug 2026): the four defenses added after the
 * first release-candidate review.
 *
 *  1. progressive unlock throttling, brute force through the RPC surface
 *     hits an exponentially growing, storage-persisted lockout,
 *  2. SEP-29 memo requirement; a memo-less payment to an account flagged
 *     `config.memo_required` is refused at build time and flagged as a
 *     danger warning at describe time,
 *  3. prompt-flood cap; a dApp origin cannot bury a real confirmation
 *     under an unbounded queue of decoys,
 *  4. (UI: type-to-confirm reset, covered by E2E, not unit-testable here.)
 *
 * Same stub strategy as dapp-flow.test.ts: `wxt/browser` and Horizon are
 * stubbed, everything else is the real code path including Argon2id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Asset,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/* ------------------------------------------------------------- stubs */

interface Area {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function area(store: Map<string, unknown>): Area {
  return {
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (key) => {
      store.delete(key);
    },
  };
}

const localStore = new Map<string, unknown>();
const syncStore = new Map<string, unknown>();

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: area(localStore), sync: area(syncStore) },
    alarms: { clear: async () => true, create: async () => undefined },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
    permissions: { contains: async () => true },
  },
}));

/** Destination flagged per SEP-29; everything else exists without the flag. */
const MEMO_DEST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const PLAIN_DEST = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';

const BASE_SNAPSHOT = {
  exists: true,
  sequence: '100',
  balances: [],
  reserves: {
    baseReserveXlm: '0.5',
    subentryCount: 0,
    numSponsoring: 0,
    numSponsored: 0,
    totalReservedXlm: '1.0000000',
    spendableXlm: '100.0000000',
    maxSendableXlm: '100.0000000',
  },
  signers: [],
  thresholds: { low: 0, medium: 0, high: 0 },
  subentryCount: 0,
};

vi.mock('../src/core/stellar/horizon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/horizon')>();
  return {
    ...actual,
    /**
     * The fee strategy calls this on every build. Stubbed to "unavailable" so
     * this suite stays offline and exercises the fail-open path (BASE_FEE);
     * the strategy itself is covered in tests/fee-strategy.test.ts.
     */
    fetchFeeStats: async () => null,
    fetchAccount: async (_network: unknown, accountId: string) => ({
      ...BASE_SNAPSHOT,
      accountId,
      memoRequired: accountId === MEMO_DEST,
    }),
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { AppError } = await import('../src/core/errors');
const {
  BASE_DELAY_MS,
  FREE_ATTEMPTS,
  MAX_DELAY_MS,
  UnlockGuard,
  delayForFailures,
} = await import('../src/background/unlock-guard');
const { memoRequiredFromData } = await import('../src/core/stellar/horizon');
const { describeTransaction } = await import('../src/core/stellar/tx-describe');
const { PromptQueue, MAX_PENDING_PER_ORIGIN } = await import('../src/background/dapp');

const PASSWORD = 'correct horse battery';
const GUARD_KEY = 'unlockGuard.v1';

async function freshWallet(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  publicKey: string;
}> {
  localStore.clear();
  syncStore.clear();
  const ctx = new BackgroundContext();
  const created = await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const publicKey = created.accounts[0]?.publicKey ?? '';
  expect(publicKey).not.toBe('');
  return { ctx, publicKey };
}

/** Wrong passwords surface as `BadPasswordError` (code BAD_PASSWORD), the
 * guard as `AppError`; the wire only ever sees the code, so assert on that. */
async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<{ code: string; detail?: string | undefined }> {
  try {
    await promise;
  } catch (err) {
    const wire = err as { code?: unknown; detail?: string };
    expect(wire.code).toBe(code);
    return wire as { code: string; detail?: string | undefined };
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

/* ----------------------------------------- 1. unlock throttling */

describe('delayForFailures schedule', () => {
  it('gives the first free attempts no delay', () => {
    for (let f = 0; f <= FREE_ATTEMPTS; f++) expect(delayForFailures(f)).toBe(0);
  });

  it('doubles from the base delay onwards', () => {
    expect(delayForFailures(FREE_ATTEMPTS + 1)).toBe(BASE_DELAY_MS);
    expect(delayForFailures(FREE_ATTEMPTS + 2)).toBe(BASE_DELAY_MS * 2);
    expect(delayForFailures(FREE_ATTEMPTS + 3)).toBe(BASE_DELAY_MS * 4);
  });

  it('caps at the maximum, even for absurd counts', () => {
    expect(delayForFailures(FREE_ATTEMPTS + 30)).toBe(MAX_DELAY_MS);
    expect(delayForFailures(10_000)).toBe(MAX_DELAY_MS);
    expect(Number.isFinite(delayForFailures(10_000))).toBe(true);
  });
});

describe('unlock throttling through the real handler path', () => {
  it('locks out after the free attempts and refuses even the right password', async () => {
    const { ctx } = await freshWallet();
    await handlers['wallet.lock'](ctx, {});

    // Pre-seed the guard at the edge of the free budget so the test needs
    // only two real Argon2id runs instead of six.
    localStore.set(GUARD_KEY, { failures: FREE_ATTEMPTS, lockedUntil: null });

    // The attempt that trips the lockout already reports UNLOCK_THROTTLED
    // (detail = seconds) so the popup can start its countdown ring at once
    // (P2 Unlock-Politur). The password was wrong either way.
    const tripErr = await expectCode(
      handlers['wallet.unlock'](ctx, { password: 'wrong-password' }),
      'UNLOCK_THROTTLED',
    );
    expect(Number(tripErr.detail)).toBeGreaterThan(0);

    const state = localStore.get(GUARD_KEY) as { failures: number; lockedUntil: number | null };
    expect(state.failures).toBe(FREE_ATTEMPTS + 1);
    expect(state.lockedUntil).not.toBeNull();

    // While locked, even the correct password is refused, and the error
    // carries the remaining wait in seconds for the UI.
    const err = await expectCode(
      handlers['wallet.unlock'](ctx, { password: PASSWORD }),
      'UNLOCK_THROTTLED',
    );
    expect(Number(err.detail)).toBeGreaterThan(0);
    expect(Number(err.detail)).toBeLessThanOrEqual(Math.ceil(BASE_DELAY_MS / 1000));
  });

  it('lets an expired lockout through and resets the counter on success', async () => {
    const { ctx } = await freshWallet();
    await handlers['wallet.lock'](ctx, {});

    localStore.set(GUARD_KEY, { failures: 7, lockedUntil: Date.now() - 1_000 });

    const unlocked = await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    expect(unlocked.accounts.length).toBeGreaterThan(0);
    // Success clears the guard entirely.
    expect(localStore.has(GUARD_KEY)).toBe(false);
  });

  it('covers revealRecoveryPhrase through the same chokepoint', async () => {
    const { ctx } = await freshWallet();
    localStore.set(GUARD_KEY, { failures: 10, lockedUntil: Date.now() + 60_000 });
    await expectCode(
      handlers['wallet.revealRecoveryPhrase'](ctx, { password: PASSWORD }),
      'UNLOCK_THROTTLED',
    );
  });

  it('wallet.reset clears the guard along with the keystore', async () => {
    const { ctx } = await freshWallet();
    localStore.set(GUARD_KEY, { failures: 10, lockedUntil: Date.now() + 60_000 });
    await handlers['wallet.reset'](ctx, { confirm: true });
    expect(localStore.has(GUARD_KEY)).toBe(false);
  });

  it('survives a service-worker restart (state lives in storage, not RAM)', async () => {
    const { ctx } = await freshWallet();
    await handlers['wallet.lock'](ctx, {});
    localStore.set(GUARD_KEY, { failures: 6, lockedUntil: Date.now() + 60_000 });

    // A "restarted worker" is simply a new context over the same storage.
    const ctx2 = new BackgroundContext();
    await expectCode(handlers['wallet.unlock'](ctx2, { password: PASSWORD }), 'UNLOCK_THROTTLED');
  });
});

/* ----------------------------------------- 2. SEP-29 memo required */

describe('memoRequiredFromData (SEP-29 flag parsing)', () => {
  it('accepts the canonical base64 "1"', () => {
    expect(memoRequiredFromData({ 'config.memo_required': 'MQ==' })).toBe(true);
  });
  it('rejects other values and missing entries', () => {
    expect(memoRequiredFromData({ 'config.memo_required': btoa('0') })).toBe(false);
    expect(memoRequiredFromData({ other: 'MQ==' })).toBe(false);
    expect(memoRequiredFromData(undefined)).toBe(false);
  });
  it('tolerates a non-base64 raw "1" instead of ignoring it', () => {
    expect(memoRequiredFromData({ 'config.memo_required': '1' })).toBe(true);
  });
});

describe('tx.build refuses memo-less payments to flagged accounts', () => {
  it('throws MEMO_REQUIRED without a memo and builds fine with one', async () => {
    const { ctx } = await freshWallet();

    await expectCode(
      handlers['tx.build'](ctx, {
        intent: { kind: 'payment', destination: MEMO_DEST, assetId: 'native', amount: '5' },
      }),
      'MEMO_REQUIRED',
    );

    const withMemo = await handlers['tx.build'](ctx, {
      intent: {
        kind: 'payment',
        destination: MEMO_DEST,
        assetId: 'native',
        amount: '5',
        memo: '12345',
      },
    });
    expect(withMemo.xdr.length).toBeGreaterThan(0);

    const unflagged = await handlers['tx.build'](ctx, {
      intent: { kind: 'payment', destination: PLAIN_DEST, assetId: 'native', amount: '5' },
    });
    expect(unflagged.xdr.length).toBeGreaterThan(0);
  });
});

describe('tx.describe raises the MEMO_REQUIRED danger warning', () => {
  function payment(withMemo: boolean): string {
    const source = new Account(PLAIN_DEST, '100');
    let builder = new TransactionBuilder(source, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    }).addOperation(
      Operation.payment({ destination: MEMO_DEST, asset: Asset.native(), amount: '1' }),
    );
    if (withMemo) builder = builder.addMemo(Memo.text('12345'));
    return builder.setTimeout(180).build().toXDR();
  }

  const ctx = {
    networkPassphrase: Networks.TESTNET,
    accountId: PLAIN_DEST,
    memoRequiredAccounts: [MEMO_DEST],
  };

  it('warns (danger) when the transaction has no memo', () => {
    const description = describeTransaction(payment(false), ctx);
    const warning = description.warnings.find((w) => w.code === 'MEMO_REQUIRED');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('danger');
    expect(warning?.opIndex).toBe(0);
  });

  it('stays silent when a memo is present', () => {
    const description = describeTransaction(payment(true), ctx);
    expect(description.warnings.some((w) => w.code === 'MEMO_REQUIRED')).toBe(false);
  });

  it('stays silent for destinations without the flag', () => {
    const description = describeTransaction(payment(false), {
      ...ctx,
      memoRequiredAccounts: [],
    });
    expect(description.warnings.some((w) => w.code === 'MEMO_REQUIRED')).toBe(false);
  });
});

/* ----------------------------------------- 3. prompt-flood cap */

describe('prompt queue flood protection', () => {
  it('rejects the request over the per-origin cap, immediately', () => {
    const queue = new PromptQueue();
    const origin = 'https://dapp.example';
    const pending: Promise<boolean>[] = [];
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) {
      pending.push(queue.ask('sign', origin, null));
    }

    let thrown: unknown;
    try {
      void queue.ask('sign', origin, null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as InstanceType<typeof AppError>).code).toBe('TOO_MANY_REQUESTS');

    // A different origin is unaffected...
    const other = queue.ask('connect', 'https://other.example', null);

    // ...and resolving one frees a slot for the first origin again.
    queue.rejectAll();
    return Promise.all([...pending, other]).then((answers) => {
      for (const answer of answers) expect(answer).toBe(false);
      expect(() => queue.ask('sign', origin, null)).not.toThrow();
      queue.rejectAll();
    });
  });
});

/**
 * The lockout deadline is a wall-clock instant and the system clock belongs to
 * whoever is sitting at the machine. These pin the two clock moves the guard
 * can actually answer; the one it cannot is written up in the module header.
 */
describe('the unlock lockout does not simply believe the clock', () => {
  /** A lockout written `agoMs` ago by a clock reading `at`. */
  function seedLockout(at: number, delay = BASE_DELAY_MS): void {
    localStore.set(GUARD_KEY, {
      failures: FREE_ATTEMPTS + 1,
      lockedUntil: at + delay,
      lockedAt: at,
    });
  }

  it('serves the full delay again when the clock is wound backwards', async () => {
    const guard = new UnlockGuard();
    const lockedAt = Date.now();
    seedLockout(lockedAt);

    // A reading from before the lockout was written cannot be honest.
    const rewound = lockedAt - 24 * 3_600_000;
    const err = await expectCode(guard.assertAllowed(rewound), 'UNLOCK_THROTTLED');
    // Not "the deadline already passed": the whole delay, from the new reading.
    expect(Number(err.detail)).toBeGreaterThan(BASE_DELAY_MS / 1000 - 2);

    // And the record is re-anchored, so repeating the trick gains nothing.
    const state = localStore.get(GUARD_KEY) as { lockedAt: number; lockedUntil: number };
    expect(state.lockedAt).toBe(rewound);
    expect(state.lockedUntil).toBe(rewound + BASE_DELAY_MS);
  });

  it('holds the lockout against a forward jump while the worker is alive', async () => {
    const guard = new UnlockGuard();
    localStore.set(GUARD_KEY, { failures: FREE_ATTEMPTS, lockedUntil: null, lockedAt: null });

    // This worker imposes the lockout, so it holds a monotonic anchor for it.
    await guard.registerFailure();
    expect(guard.monotonicRemainingMs()).toBeGreaterThan(0);

    // Ten years of "wall clock" later, the anchor has not moved at all.
    await expectCode(
      guard.assertAllowed(Date.now() + 10 * 365 * 24 * 3_600_000),
      'UNLOCK_THROTTLED',
    );
  });

  it('drops the anchor on a correct password, so an unlock is not delayed', async () => {
    const guard = new UnlockGuard();
    localStore.set(GUARD_KEY, { failures: FREE_ATTEMPTS, lockedUntil: null, lockedAt: null });
    await guard.registerFailure();
    expect(guard.monotonicRemainingMs()).toBeGreaterThan(0);

    await guard.reset();
    expect(guard.monotonicRemainingMs()).toBe(0);
    await expect(guard.assertAllowed()).resolves.toBeUndefined();
  });

  it('still reads a record written before lockedAt existed', async () => {
    const guard = new UnlockGuard();
    // No `lockedAt` key at all, the shape shipped by the previous build.
    localStore.set(GUARD_KEY, { failures: FREE_ATTEMPTS + 1, lockedUntil: Date.now() + 5_000 });
    await expectCode(guard.assertAllowed(), 'UNLOCK_THROTTLED');
  });
});
