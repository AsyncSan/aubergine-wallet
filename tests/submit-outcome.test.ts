/**
 * The third outcome: "we do not know".
 *
 * The bug these tests exist for: a submission that timed out (or hit a 504,
 * which is the everyday answer while a ledger backlog clears) was reported as
 * `NETWORK_ERROR`. The user read "the network cannot be reached right now",
 * went back to the form and sent again, and because `tx.build` fetches a
 * *fresh* sequence number, a first payment that did land made the second one
 * seq+1. Both went through. With real money.
 *
 * Three properties are load-bearing here and each has its own test:
 *   1. an open outcome is never reported as a failure,
 *   2. the hash survives every failure path, because it is the only handle on
 *      a transaction nobody can confirm yet,
 *   3. a *reasoned* rejection (`op_underfunded` and friends) still lands in
 *      the ordinary error path. Softening those into "unknown" would make the
 *      wallet worse, not better.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/* ------------------------------------------------------------------ stubs */

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
const sessionStore = new Map<string, unknown>();

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: area(localStore),
      sync: area(syncStore),
      session: area(sessionStore),
    },
    alarms: { clear: async () => true, create: async () => undefined },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
    permissions: { contains: async () => true },
  },
}));

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
  memoRequired: false,
};

/** What `tx.submit` "gets back" from Horizon in a given test. */
const submitMock = vi.fn();
/** What `GET /transactions/{hash}` "answers" in a given test. */
const resolveMock = vi.fn();

vi.mock('../src/core/stellar/horizon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/horizon')>();
  return {
    ...actual,
    fetchAccount: async (_network: unknown, accountId: string) => ({
      ...BASE_SNAPSHOT,
      accountId,
    }),
    fetchFeeStats: async () => null,
    submitTransactionXdr: async (...args: unknown[]) => submitMock(...args) as unknown,
    resolveSubmission: async (...args: unknown[]) => resolveMock(...args) as unknown,
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
/**
 * The unmocked module. `vi.mock` above replaces `submitTransactionXdr` and
 * `resolveSubmission` for the *handlers*, which is what the guard tests need;
 * the classification tests below exercise the real implementations against a
 * stubbed SDK instead.
 */
const {
  TX_LOOKUP_GRACE_MS,
  envelopeIdentity,
  resolveSubmission,
  submitTransactionXdr,
  unresolvedReasonFor,
} = await vi.importActual<typeof import('../src/core/stellar/horizon')>(
  '../src/core/stellar/horizon',
);
const {
  PENDING_GRACE_MS,
  PENDING_MAX_LIFETIME_MS,
  pendingIsStale,
  readPendingSubmission,
} = await import('../src/background/pending-submission');
const { rpcSchemas } = await import('../src/messaging/protocol');
const { TESTNET } = await import('../src/core/stellar/networks');
const { AppError } = await import('../src/core/errors');
const { DEFAULT_TIMEOUT_SECONDS } = await import('../src/core/stellar/tx-builder');
const { withTimeout } = await import('../src/core/net/limiter');

const PASSWORD = 'correct horse battery';
const DEST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

interface Envelope {
  xdr: string;
  hash: string;
  maxTimeUnix: string;
  source: string;
}

/**
 * A real, signed envelope with the timebound the wallet's builder sets.
 *
 * `source` may be one of the wallet's own accounts (that is what the
 * account-binding tests need) or a random key, in which case the signature is
 * that key's own; the guard never looks at signatures, only at hash, source
 * and timebound.
 */
function signedEnvelope(
  options: { timeoutSeconds?: number; source?: string; sequence?: string } = {},
): Envelope {
  const key = Keypair.random();
  const source = options.source ?? key.publicKey();
  const tx = new TransactionBuilder(new Account(source, options.sequence ?? '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' }))
    .setTimeout(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
  tx.sign(key);
  return {
    xdr: tx.toXDR(),
    hash: tx.hash().toString('hex'),
    maxTimeUnix: String(tx.timeBounds?.maxTime ?? '0'),
    source,
  };
}

/** An error shaped like the SDK's, i.e. with an HTTP response attached. */
function httpError(status: number, data: unknown = {}): Error {
  const err = new Error(`Request failed with status code ${status}`);
  (err as unknown as { response: unknown }).response = { status, data };
  return err;
}

function rejectionError(operationCode: string): Error {
  return httpError(400, {
    extras: { result_codes: { transaction: 'tx_failed', operations: [operationCode] } },
  });
}

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
  sessionStore.clear();
  submitMock.mockReset();
  resolveMock.mockReset();
  vi.restoreAllMocks();
});

/* ------------------------------------------------- 1. classification rules */

describe('classifying a failed submission', () => {
  it('calls a timeout open, not failed', () => {
    expect(unresolvedReasonFor(new AppError('NETWORK_ERROR', 'timeout after 60000 ms'))).toBe(
      'timeout',
    );
  });

  it('calls every 5xx open; a 504 while a ledger backlog clears is the normal case', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(unresolvedReasonFor(httpError(status)), String(status)).toBe('server_error');
    }
  });

  it('calls a request without any HTTP answer open', () => {
    expect(unresolvedReasonFor(new TypeError('Failed to fetch'))).toBe('transport');
  });

  it('errs towards open on 429: rate limited probably never reached consensus, but "probably" is not "no"', () => {
    expect(unresolvedReasonFor(httpError(429))).toBe('throttled');
  });

  /**
   * The half that keeps this change from making things worse. A result code is
   * the network having *looked* at the transaction and said no: nothing was
   * applied, the sequence number was not consumed, and the user may retry at
   * once. Turning those into a three-minute "we do not know" would be a new
   * bug in the opposite direction.
   */
  it('leaves a reasoned rejection exactly where it was', () => {
    expect(unresolvedReasonFor(rejectionError('op_underfunded'))).toBeNull();
    expect(unresolvedReasonFor(rejectionError('op_no_destination'))).toBeNull();
    expect(unresolvedReasonFor(httpError(400, { title: 'Transaction Malformed' }))).toBeNull();
  });
});

/* ------------------------------------------------------ 2. submit outcomes */

describe('submitTransactionXdr', () => {
  const stubSubmit = (impl: () => Promise<unknown>) =>
    vi
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockImplementation(impl as () => Promise<Horizon.HorizonApi.SubmitTransactionResponse>);

  it('reports a timeout as an open outcome and not as a failure', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => {
      throw new AppError('NETWORK_ERROR', 'timeout after 60000 ms');
    });
    const result = await submitTransactionXdr(TESTNET, envelope.xdr);
    expect(result.outcome).toBe('unknown');
    expect(result.reason).toBe('timeout');
    expect(result.successful).toBe(false);
  });

  it('carries the hash through the failure path; it is known before the request leaves', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => {
      throw httpError(504, { title: 'Timeout' });
    });
    const result = await submitTransactionXdr(TESTNET, envelope.xdr);
    expect(result.hash).toBe(envelope.hash);
    expect(result.maxTimeUnix).toBe(envelope.maxTimeUnix);
    expect(Number(result.maxTimeUnix)).toBeGreaterThan(0);
  });

  it('still throws TX_FAILED for a rejection the network reasoned about', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => {
      throw rejectionError('op_underfunded');
    });
    await expect(submitTransactionXdr(TESTNET, envelope.xdr)).rejects.toMatchObject({
      code: 'TX_FAILED:op_underfunded',
    });
  });

  it('treats "200 but successful: false" as unknown rather than as success', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => ({ hash: envelope.hash, successful: false, ledger: 1 }));
    const result = await submitTransactionXdr(TESTNET, envelope.xdr);
    expect(result.outcome).toBe('unknown');
    expect(result.reason).toBe('ambiguous');
  });

  it('reports a real success as a success', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => ({ hash: envelope.hash, successful: true, ledger: 42 }));
    const result = await submitTransactionXdr(TESTNET, envelope.xdr);
    expect(result).toMatchObject({ outcome: 'success', ledger: 42, hash: envelope.hash });
  });

  it('reads hash, timebound and source out of the envelope without a network call', async () => {
    const envelope = signedEnvelope();
    await expect(envelopeIdentity(TESTNET, envelope.xdr)).resolves.toEqual({
      hash: envelope.hash,
      maxTimeUnix: envelope.maxTimeUnix,
      sourceAccount: envelope.source,
    });
  });

  /**
   * The reported hash used to win over the locally computed one, with no
   * comparison between them. An endpoint answering about a *different*
   * transaction would have rendered the green receipt, under a hash the user
   * never sent, and cleared the pending record along with it.
   */
  it('refuses to call it a success when the endpoint answers about another transaction', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => ({ hash: 'cd'.repeat(32), successful: true, ledger: 42 }));
    const result = await submitTransactionXdr(TESTNET, envelope.xdr);
    expect(result.outcome).toBe('unknown');
    expect(result.reason).toBe('ambiguous');
    // And whatever it reports, it reports under the hash of the bytes we sent.
    expect(result.hash).toBe(envelope.hash);
  });

  it('reports the locally computed hash, not the endpoint\'s, on a matching success', async () => {
    const envelope = signedEnvelope();
    stubSubmit(async () => ({ hash: envelope.hash, successful: true, ledger: 42 }));
    await expect(submitTransactionXdr(TESTNET, envelope.xdr)).resolves.toMatchObject({
      outcome: 'success',
      hash: envelope.hash,
    });
  });
});

/* ------------------------------------------------------- 3. the resolution */

describe('resolveSubmission', () => {
  const stubLookup = (impl: () => Promise<unknown>) =>
    vi.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({ call: impl }),
    } as unknown as ReturnType<Horizon.Server['transactions']>);

  const notFound = (): Error => httpError(404, { title: 'Resource Missing' });

  it('reads a 404 before the timebound as "not yet", never as "never"', async () => {
    const maxTime = Math.floor(Date.now() / 1000) + 120;
    stubLookup(async () => {
      throw notFound();
    });
    const resolution = await resolveSubmission(TESTNET, 'ab'.repeat(32), String(maxTime));
    expect(resolution.state).toBe('pending');
  });

  it('only reads a 404 as final once the timebound plus the ingestion grace has passed', async () => {
    const now = Date.now();
    const maxTime = Math.floor(now / 1000) - 1;
    stubLookup(async () => {
      throw notFound();
    });
    // One second past `maxTime` is not enough: Horizon may still be ingesting
    // a transaction that made it into the last possible ledger.
    const early = await resolveSubmission(TESTNET, 'ab'.repeat(32), String(maxTime), now);
    expect(early.state).toBe('pending');

    const late = await resolveSubmission(
      TESTNET,
      'ab'.repeat(32),
      String(maxTime),
      now + TX_LOOKUP_GRACE_MS + 2_000,
    );
    expect(late.state).toBe('expired');
  });

  it('never expires an envelope without an upper timebound; nothing could prove it', async () => {
    stubLookup(async () => {
      throw notFound();
    });
    const resolution = await resolveSubmission(
      TESTNET,
      'ab'.repeat(32),
      '0',
      Date.now() + 10 * 60_000,
    );
    expect(resolution.state).toBe('pending');
  });

  it('reports an included transaction with its ledger', async () => {
    stubLookup(async () => ({ successful: true, ledger: 4242 }));
    const resolution = await resolveSubmission(TESTNET, 'ab'.repeat(32), '0');
    expect(resolution).toMatchObject({ state: 'included', successful: true, ledger: 4242 });
  });

  it('reports an included but failed transaction as included, not as pending', async () => {
    stubLookup(async () => ({ successful: false, ledger: 7 }));
    const resolution = await resolveSubmission(TESTNET, 'ab'.repeat(32), '0');
    expect(resolution).toMatchObject({ state: 'included', successful: false });
  });

  it('says "unknown" when the lookup itself fails, and does not guess', async () => {
    stubLookup(async () => {
      throw httpError(503);
    });
    const resolution = await resolveSubmission(TESTNET, 'ab'.repeat(32), '0');
    expect(resolution.state).toBe('unknown');
  });
});

/* --------------------------------------------------- 4. the guard in build */

async function freshWallet(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  publicKey: string;
}> {
  const ctx = new BackgroundContext();
  const created = await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const first = created.accounts[0];
  if (!first) throw new Error('wallet.create returned no account');
  return { ctx, publicKey: first.publicKey };
}

function paymentIntent(accountIndex?: number): Parameters<(typeof handlers)['tx.build']>[1] {
  return {
    intent: { kind: 'payment', destination: DEST, assetId: 'native', amount: '1', path: [] },
    ...(accountIndex === undefined ? {} : { accountIndex }),
  } as unknown as Parameters<(typeof handlers)['tx.build']>[1];
}

describe('tx.submit remembers what it sent', () => {
  it('keeps a record when the outcome is open, and hands the hash to the popup', async () => {
    const { ctx } = await freshWallet();
    const envelope = signedEnvelope();
    submitMock.mockResolvedValue({
      outcome: 'unknown',
      hash: envelope.hash,
      successful: false,
      ledger: null,
      maxTimeUnix: envelope.maxTimeUnix,
      reason: 'timeout',
    });

    const result = await handlers['tx.submit'](ctx, { signedXdr: envelope.xdr });
    expect(result.outcome).toBe('unknown');
    expect(result.hash).toBe(envelope.hash);

    const pending = await readPendingSubmission();
    expect(pending?.hash).toBe(envelope.hash);
    expect(pending?.answered).toBe(true);
    expect(await handlers['tx.pendingSubmission'](ctx, {})).toMatchObject({
      pending: { hash: envelope.hash },
    });
  });

  it('clears the record on success', async () => {
    const { ctx } = await freshWallet();
    const envelope = signedEnvelope();
    submitMock.mockResolvedValue({
      outcome: 'success',
      hash: envelope.hash,
      successful: true,
      ledger: 9,
      maxTimeUnix: envelope.maxTimeUnix,
      reason: null,
    });
    await handlers['tx.submit'](ctx, { signedXdr: envelope.xdr });
    expect(await readPendingSubmission()).toBeNull();
  });

  /**
   * The other direction of the same guard: a rejection means nothing was
   * applied, so the wallet must *not* keep the user locked out.
   */
  it('clears the record when the network reasons a rejection', async () => {
    const { ctx } = await freshWallet();
    const envelope = signedEnvelope();
    submitMock.mockRejectedValue(new AppError('TX_FAILED:op_underfunded'));
    await expect(
      handlers['tx.submit'](ctx, { signedXdr: envelope.xdr }),
    ).rejects.toMatchObject({ code: 'TX_FAILED:op_underfunded' });
    expect(await readPendingSubmission()).toBeNull();
  });

  it('writes the record before the envelope leaves, so a dying worker still leaves a trace', async () => {
    const { ctx } = await freshWallet();
    const envelope = signedEnvelope();
    let recordDuringSubmit: unknown = null;
    submitMock.mockImplementation(async () => {
      // Stands in for the service worker being torn down here: whatever this
      // handler would have done afterwards never runs.
      recordDuringSubmit = await readPendingSubmission();
      throw new AppError('NETWORK_ERROR', 'worker gone');
    });
    await expect(handlers['tx.submit'](ctx, { signedXdr: envelope.xdr })).rejects.toBeTruthy();
    expect((recordDuringSubmit as { hash?: string } | null)?.hash).toBe(envelope.hash);
  });
});

describe('tx.build while an outcome is open', () => {
  async function withOpenSubmission(): Promise<InstanceType<typeof BackgroundContext>> {
    const { ctx } = await freshWallet();
    const envelope = signedEnvelope();
    submitMock.mockResolvedValue({
      outcome: 'unknown',
      hash: envelope.hash,
      successful: false,
      ledger: null,
      maxTimeUnix: envelope.maxTimeUnix,
      reason: 'server_error',
    });
    await handlers['tx.submit'](ctx, { signedXdr: envelope.xdr });
    return ctx;
  }

  /**
   * The actual protection. Everything in the UI is a courtesy on top of this:
   * as long as the first transaction can still be included, no second envelope
   * with a fresh sequence number gets built for that account.
   */
  it('refuses to build a second transaction for the same account', async () => {
    const ctx = await withOpenSubmission();
    await expect(handlers['tx.build'](ctx, paymentIntent())).rejects.toMatchObject({
      code: 'SUBMIT_OUTCOME_UNKNOWN',
    });
  });

  it('builds again once the resolution came back', async () => {
    const ctx = await withOpenSubmission();
    const pending = await readPendingSubmission();
    resolveMock.mockResolvedValue({
      state: 'expired',
      successful: null,
      ledger: null,
      resultCode: null,
    });
    await handlers['tx.status'](ctx, { hash: pending?.hash ?? '' });
    expect(await readPendingSubmission()).toBeNull();
    await expect(handlers['tx.build'](ctx, paymentIntent())).resolves.toHaveProperty('xdr');
  });

  it('never locks an account out for good: the record expires with the envelope', async () => {
    const created = Date.now();
    const record = {
      hash: 'ab'.repeat(32),
      maxTimeUnix: String(Math.floor(created / 1000) + DEFAULT_TIMEOUT_SECONDS),
      accountIndex: 0,
      networkPassphrase: TESTNET.passphrase,
      kind: 'payment' as const,
      createdAt: created,
      answered: true,
    };
    expect(pendingIsStale(record, created)).toBe(false);
    expect(pendingIsStale(record, created + (DEFAULT_TIMEOUT_SECONDS + 120) * 1000)).toBe(true);
  });
});

/* ------------------------------- 4b. the guard as a chokepoint, not a build */

/**
 * The lock used to sit in `tx.build` alone. Three other doors led past it, and
 * all three end in the same place: a second envelope with a fresh sequence
 * number for an account whose first transaction can still be included.
 */
const ORIGIN = 'https://dapp.example';

async function walletWithTwoAccounts(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  first: string;
  second: string;
}> {
  const { ctx, publicKey } = await freshWallet();
  const added = await handlers['account.add'](ctx, { label: 'Second', password: PASSWORD });
  return { ctx, first: publicKey, second: added.account.publicKey };
}

/** Submit `envelope` and leave its outcome open, i.e. leave a live record. */
async function submitOpen(
  ctx: InstanceType<typeof BackgroundContext>,
  envelope: Envelope,
): Promise<void> {
  submitMock.mockResolvedValue({
    outcome: 'unknown',
    hash: envelope.hash,
    successful: false,
    ledger: null,
    maxTimeUnix: envelope.maxTimeUnix,
    reason: 'timeout',
  });
  await handlers['tx.submit'](ctx, { signedXdr: envelope.xdr });
}

describe('a second tx.submit while the first outcome is open (B1/B11)', () => {
  /**
   * The worst of the findings. `tx.submit` wrote its record unconditionally,
   * so a second submit overwrote the first hash; the only handle anything had
   * on a transaction that could still land, and then cleared the record when
   * *it* succeeded, unlocking `tx.build` while the first envelope was still
   * valid. Two payments, one intended.
   */
  it('refuses a different envelope and keeps the first hash', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    const open = signedEnvelope({ source: first });
    await submitOpen(ctx, open);

    const second = signedEnvelope({ source: first, sequence: '101' });
    await expect(
      handlers['tx.submit'](ctx, { signedXdr: second.xdr }),
    ).rejects.toMatchObject({ code: 'SUBMIT_OUTCOME_UNKNOWN' });

    // The record still names the *first*, unresolved transaction.
    expect((await readPendingSubmission())?.hash).toBe(open.hash);
    // ...and the lock it holds is still in force.
    await expect(handlers['tx.build'](ctx, paymentIntent())).rejects.toMatchObject({
      code: 'SUBMIT_OUTCOME_UNKNOWN',
    });
  });

  /**
   * A success answer for the *second* envelope must not be read as an answer
   * about the first. Before the fix this was the unlock: submit #2 returns
   * `success`, the handler clears "the" record, `tx.build` is free again.
   */
  it('cannot be unlocked by a second envelope succeeding', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    const open = signedEnvelope({ source: first });
    await submitOpen(ctx, open);

    const second = signedEnvelope({ source: first, sequence: '101' });
    submitMock.mockResolvedValue({
      outcome: 'success',
      hash: second.hash,
      successful: true,
      ledger: 12,
      maxTimeUnix: second.maxTimeUnix,
      reason: null,
    });
    await expect(handlers['tx.submit'](ctx, { signedXdr: second.xdr })).rejects.toMatchObject({
      code: 'SUBMIT_OUTCOME_UNKNOWN',
    });
    expect((await readPendingSubmission())?.hash).toBe(open.hash);
  });

  /**
   * The legitimate case, and the reason the rule is "a *different* envelope".
   * Re-sending the same bytes is what a user whose submission timed out should
   * do: same hash, same sequence number, the network deduplicates it.
   */
  it('lets the same envelope through a second time', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    const open = signedEnvelope({ source: first });
    await submitOpen(ctx, open);
    const createdAt = (await readPendingSubmission())?.createdAt;

    submitMock.mockResolvedValue({
      outcome: 'success',
      hash: open.hash,
      successful: true,
      ledger: 12,
      maxTimeUnix: open.maxTimeUnix,
      reason: null,
    });
    await expect(
      handlers['tx.submit'](ctx, { signedXdr: open.xdr }),
    ).resolves.toMatchObject({ outcome: 'success' });
    // A ledger is a final answer for this hash, so the lock comes off.
    expect(await readPendingSubmission()).toBeNull();
    expect(createdAt).toBeTypeOf('number');
  });

  /**
   * A resubmission keeps its original `createdAt`, otherwise an envelope
   * without a timebound could be kept alive past PENDING_MAX_LIFETIME_MS
   * forever by resubmitting it.
   */
  it('does not extend the record\'s lifetime by resubmitting', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    const open = signedEnvelope({ source: first });
    await submitOpen(ctx, open);
    const before = (await readPendingSubmission())?.createdAt ?? 0;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await submitOpen(ctx, open);
    expect((await readPendingSubmission())?.createdAt).toBe(before);
  });

  /**
   * Storage holds one record. Overwriting it with another account's hash loses
   * the first one just as completely as overwriting it with the same account's,
   * so the submit-side rule is deliberately not account-scoped.
   */
  it('refuses to overwrite the record with another account\'s submission', async () => {
    const { ctx, first, second } = await walletWithTwoAccounts();
    const open = signedEnvelope({ source: first });
    await submitOpen(ctx, open);

    const other = signedEnvelope({ source: second });
    await expect(
      handlers['tx.submit'](ctx, { signedXdr: other.xdr }),
    ).rejects.toMatchObject({ code: 'SUBMIT_OUTCOME_UNKNOWN' });
    expect((await readPendingSubmission())?.hash).toBe(open.hash);
  });
});

describe('tx.sign while an outcome is open (B2)', () => {
  it('refuses to sign a second envelope for that account', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    await submitOpen(ctx, signedEnvelope({ source: first }));

    const next = signedEnvelope({ source: first, sequence: '101' });
    await expect(handlers['tx.sign'](ctx, { xdr: next.xdr })).rejects.toMatchObject({
      code: 'SUBMIT_OUTCOME_UNKNOWN',
    });
  });

  it('still signs the very same envelope; that is not a second transaction', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    const open = signedEnvelope({ source: first });
    await submitOpen(ctx, open);
    await expect(handlers['tx.sign'](ctx, { xdr: open.xdr })).resolves.toHaveProperty(
      'signedXdr',
    );
  });

  it('leaves an unaffected account alone', async () => {
    const { ctx, first, second } = await walletWithTwoAccounts();
    await submitOpen(ctx, signedEnvelope({ source: first }));
    const other = signedEnvelope({ source: second });
    await expect(
      handlers['tx.sign'](ctx, { xdr: other.xdr, accountIndex: 1 }),
    ).resolves.toHaveProperty('signedXdr');
  });
});

describe('dapp.signXdr while an outcome is open (B3)', () => {
  async function developerMode(ctx: InstanceType<typeof BackgroundContext>): Promise<void> {
    await handlers['settings.set'](ctx, {
      patch: { mode: 'developer', allowedOrigins: [ORIGIN] },
    });
  }

  /**
   * The shortest way around the old guard: an approved origin builds its own
   * envelope with its own fresh sequence number and submits it itself, so
   * `tx.build` never sees any of it. All the wallet controls is the signature,
   * which is exactly why the refusal has to sit there.
   */
  it('refuses the signature, and refuses it before bothering the user', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    await developerMode(ctx);
    await submitOpen(ctx, signedEnvelope({ source: first }));

    const fresh = signedEnvelope({ source: first, sequence: '999' });
    await expect(
      handlers['dapp.signXdr'](ctx, { origin: ORIGIN, xdr: fresh.xdr }),
    ).rejects.toMatchObject({ code: 'SUBMIT_OUTCOME_UNKNOWN' });
    // No confirmation dialog was ever raised: nothing to approve, nothing to
    // click through by accident.
    expect(await handlers['dapp.pendingPrompt'](ctx, {})).toBeNull();
  });

  /**
   * B5 reached through its own door: `accountToSign` picks the account, so a
   * record filed under the *selected* one would have left the signing account
   * wide open.
   */
  it('refuses for the account the page asked to sign with, not the selected one', async () => {
    const { ctx, second } = await walletWithTwoAccounts();
    await developerMode(ctx);
    // Selected is account 0; the open submission belongs to account 1.
    await submitOpen(ctx, signedEnvelope({ source: second }));

    const fresh = signedEnvelope({ source: second, sequence: '999' });
    await expect(
      handlers['dapp.signXdr'](ctx, { origin: ORIGIN, xdr: fresh.xdr, accountToSign: second }),
    ).rejects.toMatchObject({ code: 'SUBMIT_OUTCOME_UNKNOWN' });
  });
});

describe('which account the record belongs to (B5)', () => {
  /**
   * `tx.submit` filed the record under `selectedIndex()` while every check
   * resolved `resolveIndex(params.accountIndex)`. The record then locked an
   * uninvolved account and left the signing one free; the exact opposite of
   * what it is for.
   */
  it('files the record under the envelope\'s source account, not the selected one', async () => {
    const { ctx, second } = await walletWithTwoAccounts();
    expect(await ctx.selectedIndex()).toBe(0);
    await submitOpen(ctx, signedEnvelope({ source: second }));

    expect((await readPendingSubmission())?.accountIndex).toBe(1);
    // The account that signed is locked...
    await expect(
      handlers['tx.build'](ctx, paymentIntent(1)),
    ).rejects.toMatchObject({ code: 'SUBMIT_OUTCOME_UNKNOWN' });
    // ...and the uninvolved one is not.
    await expect(handlers['tx.build'](ctx, paymentIntent(0))).resolves.toHaveProperty('xdr');
  });
});

describe('the lock and the network (B12 / M34)', () => {
  async function openOnTestnetThenSwitch(): Promise<InstanceType<typeof BackgroundContext>> {
    const { ctx, first } = await walletWithTwoAccounts();
    await submitOpen(ctx, signedEnvelope({ source: first }));
    // Futurenet is a developer-mode network; in beginner mode
    // `effectiveNetworkId` would fall straight back to Testnet.
    await handlers['settings.set'](ctx, {
      patch: { mode: 'developer', networkId: 'futurenet' },
    });
    return ctx;
  }

  /**
   * M34: without the passphrase comparison the popup would offer to resolve a
   * Testnet hash against Futurenet's Horizon, which can only ever answer 404.
   */
  it('reports no pending submission on another network', async () => {
    const ctx = await openOnTestnetThenSwitch();
    expect(await handlers['tx.pendingSubmission'](ctx, {})).toEqual({ pending: null });
  });

  /**
   * B12: the refusal used to compare the account index only, so a record from
   * another network blocked a build it can never collide with, and the UI had
   * no record to explain the error with, because its own query filtered the
   * record away. Query and lock now apply the same criterion.
   */
  it('does not block a build on the other network', async () => {
    const ctx = await openOnTestnetThenSwitch();
    await expect(handlers['tx.build'](ctx, paymentIntent(0))).resolves.toHaveProperty('xdr');
  });

  /**
   * The other half: a submission on the other network must still not destroy
   * the record, because there is only one slot for it.
   */
  it('still refuses to overwrite the record from the other network', async () => {
    const ctx = await openOnTestnetThenSwitch();
    const elsewhere = signedEnvelope();
    await expect(
      handlers['tx.submit'](ctx, { signedXdr: elsewhere.xdr }),
    ).rejects.toMatchObject({ code: 'SUBMIT_OUTCOME_UNKNOWN' });
  });

  /** A hash the current network has no record for never gets a final answer. */
  it('never expires a foreign-network hash through tx.status', async () => {
    const ctx = await openOnTestnetThenSwitch();
    const record = await readPendingSubmission();
    resolveMock.mockResolvedValue({
      state: 'pending',
      successful: null,
      ledger: null,
      resultCode: null,
    });
    await handlers['tx.status'](ctx, { hash: record?.hash ?? '' });
    // `'0'`, not the record's timebound: on this network we know nothing.
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), record?.hash, '0');
    expect(await readPendingSubmission()).not.toBeNull();
  });
});

describe('only a final answer lifts the lock (M30)', () => {
  async function withOpen(): Promise<{
    ctx: InstanceType<typeof BackgroundContext>;
    hash: string;
  }> {
    const { ctx, first } = await walletWithTwoAccounts();
    const envelope = signedEnvelope({ source: first });
    await submitOpen(ctx, envelope);
    return { ctx, hash: envelope.hash };
  }

  /**
   * The central assurance of the whole fix, and the one that had only its
   * positive half tested: `included` and `expired` clear the record, and
   * *nothing else does*. Drop the state check and every poll, six seconds
   * apart, while the transaction is still perfectly able to land, unlocks the
   * wallet.
   */
  it('keeps the record while the transaction can still land', async () => {
    const { ctx, hash } = await withOpen();
    resolveMock.mockResolvedValue({
      state: 'pending',
      successful: null,
      ledger: null,
      resultCode: null,
    });
    expect(await handlers['tx.status'](ctx, { hash })).toMatchObject({ state: 'pending' });
    expect((await readPendingSubmission())?.hash).toBe(hash);
    await expect(handlers['tx.build'](ctx, paymentIntent())).rejects.toMatchObject({
      code: 'SUBMIT_OUTCOME_UNKNOWN',
    });
  });

  /** A lookup that failed is not an answer either, least of all a licence. */
  it('keeps the record when the lookup itself could not answer', async () => {
    const { ctx, hash } = await withOpen();
    resolveMock.mockResolvedValue({
      state: 'unknown',
      successful: null,
      ledger: null,
      resultCode: null,
    });
    await handlers['tx.status'](ctx, { hash });
    expect((await readPendingSubmission())?.hash).toBe(hash);
    await expect(handlers['tx.build'](ctx, paymentIntent())).rejects.toMatchObject({
      code: 'SUBMIT_OUTCOME_UNKNOWN',
    });
  });

  it('lifts it on included', async () => {
    const { ctx, hash } = await withOpen();
    resolveMock.mockResolvedValue({
      state: 'included',
      successful: true,
      ledger: 5,
      resultCode: null,
    });
    await handlers['tx.status'](ctx, { hash });
    expect(await readPendingSubmission()).toBeNull();
  });

  it('leaves someone else\'s hash alone', async () => {
    const { ctx, hash } = await withOpen();
    resolveMock.mockResolvedValue({
      state: 'expired',
      successful: null,
      ledger: null,
      resultCode: null,
    });
    await handlers['tx.status'](ctx, { hash: 'cd'.repeat(32) });
    expect((await readPendingSubmission())?.hash).toBe(hash);
  });
});

describe('the deadline comes from the record, not from the caller (B13b)', () => {
  /**
   * `maxTimeUnix: '1'` used to make the next 404 read as `expired`: record
   * cleared, `tx.build` free, up to 180 s before the first envelope stopped
   * being valid. The parameter is gone from the schema, and the handler takes
   * the timebound off the record even if one is smuggled past the schema.
   */
  it('ignores a timebound supplied by the caller', async () => {
    const { ctx, first } = await walletWithTwoAccounts();
    const envelope = signedEnvelope({ source: first });
    await submitOpen(ctx, envelope);

    resolveMock.mockResolvedValue({
      state: 'pending',
      successful: null,
      ledger: null,
      resultCode: null,
    });
    await handlers['tx.status'](ctx, {
      hash: envelope.hash,
      maxTimeUnix: '1',
    } as unknown as Parameters<(typeof handlers)['tx.status']>[1]);
    expect(resolveMock).toHaveBeenCalledWith(
      expect.anything(),
      envelope.hash,
      envelope.maxTimeUnix,
    );
    expect(await readPendingSubmission()).not.toBeNull();
  });

  it('does not accept the parameter at the wire boundary at all', () => {
    const parsed = rpcSchemas['tx.status'].params.parse({
      hash: 'ab'.repeat(32),
      maxTimeUnix: '1',
    });
    expect(parsed).not.toHaveProperty('maxTimeUnix');
  });
});

describe('the two deadlines of a pending record', () => {
  const recordWith = (
    over: Partial<{ maxTimeUnix: string; createdAt: number }>,
  ): Parameters<typeof pendingIsStale>[0] => ({
    hash: 'ab'.repeat(32),
    maxTimeUnix: '0',
    accountIndex: 0,
    networkPassphrase: TESTNET.passphrase,
    kind: 'payment' as const,
    createdAt: Date.now(),
    answered: true,
    ...over,
  });

  /**
   * M12. The relation between the two graces was stated in a comment and
   * nowhere else, so `PENDING_GRACE_MS = 0` passed every test, and a record
   * that goes stale 30 s *before* a 404 may be read as `expired` means the
   * wallet unlocks itself during the one window where nothing can answer:
   * `tx.status` still says `pending`, the record is already gone, `tx.build`
   * builds. This nails the order down as behaviour.
   */
  it('outlives the moment its resolution is first allowed to say "expired"', () => {
    const maxTime = Math.floor(Date.now() / 1000);
    const record = recordWith({ maxTimeUnix: String(maxTime) });
    // The first instant `resolveSubmission` may turn a 404 into a final answer.
    const firstFinalAnswer = maxTime * 1000 + TX_LOOKUP_GRACE_MS + 1;
    expect(pendingIsStale(record, firstFinalAnswer)).toBe(false);
    expect(PENDING_GRACE_MS).toBeGreaterThan(TX_LOOKUP_GRACE_MS);
    // And it does lift, shortly after.
    expect(pendingIsStale(record, maxTime * 1000 + PENDING_GRACE_MS + 1)).toBe(true);
  });

  /**
   * M27. An envelope with `maxTime = 0` is the one case nothing can ever prove
   * expired, so the ceiling is the *only* thing holding its lock. At zero the
   * record is stale the instant it is written and a foreign envelope submitted
   * through `tx.submit` gets no protection at all.
   */
  it('locks a timebound-less envelope for a bounded but real time', () => {
    const created = Date.now();
    const record = recordWith({ maxTimeUnix: '0', createdAt: created });
    expect(pendingIsStale(record, created)).toBe(false);
    // A minute later the transaction is still perfectly able to be included.
    expect(pendingIsStale(record, created + 60_000)).toBe(false);
    expect(pendingIsStale(record, created + PENDING_MAX_LIFETIME_MS + 1)).toBe(true);
  });
});

/* ------------------------------------------------------ 5. the abort itself */

describe('withTimeout', () => {
  it('aborts the work it gave up on instead of letting it run to completion', async () => {
    let seen: AbortSignal | null = null;
    const work = (signal: AbortSignal): Promise<never> => {
      seen = signal;
      return new Promise<never>(() => {
        /* never settles; a black-holed endpoint */
      });
    };
    await expect(withTimeout(work, 10)).rejects.toBeTruthy();
    expect(seen).not.toBeNull();
    expect((seen as unknown as AbortSignal).aborted).toBe(true);
  });

  it('does not abort work that finished in time', async () => {
    let seen: AbortSignal | null = null;
    const value = await withTimeout(async (signal) => {
      seen = signal;
      return 'done';
    }, 1_000);
    expect(value).toBe('done');
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
  });
});
