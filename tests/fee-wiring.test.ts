/**
 * The fee strategy where it has to arrive: in `tx.build`, in the envelope, and
 * in the confirmation the user reads before signing.
 *
 * Same stub strategy as the other handler suites, `wxt/browser` and Horizon
 * are stubbed, everything else is the real code path. `fetchFeeStats` is the
 * one seam: it is the only network call the strategy makes, so driving it
 * drives the whole feature.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Networks, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';

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

/** What `/fee_stats` "says" in a given test. `null` = endpoint unavailable. */
const feeStatsMock = vi.fn();

vi.mock('../src/core/stellar/horizon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/horizon')>();
  return {
    ...actual,
    fetchAccount: async (_network: unknown, accountId: string) => ({
      ...BASE_SNAPSHOT,
      accountId,
    }),
    fetchFeeStats: async () => feeStatsMock() as unknown,
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { parseFeeStats, MAX_FEE_PER_OPERATION_STROOPS } = await import(
  '../src/core/stellar/horizon'
);

const PASSWORD = 'correct horse battery';
const DEST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ISSUER = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';

function feeStats(feeCharged: Record<string, string>, capacity = '0.03'): unknown {
  return parseFeeStats({
    last_ledger: '1234567',
    last_ledger_base_fee: '100',
    ledger_capacity_usage: capacity,
    fee_charged: { min: '100', mode: '100', p50: '100', p95: '100', max: '100', ...feeCharged },
    max_fee: { min: '100', mode: '100', p50: '100', p95: '10000', max: '100000' },
  });
}

async function freshWallet(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  publicKey: string;
}> {
  localStore.clear();
  syncStore.clear();
  const ctx = new BackgroundContext();
  const created = await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const first = created.accounts[0];
  if (!first) throw new Error('wallet.create returned no account');
  return { ctx, publicKey: first.publicKey };
}

async function developerWallet(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  publicKey: string;
}> {
  const wallet = await freshWallet();
  await handlers['settings.set'](wallet.ctx, { patch: { mode: 'developer' } });
  return wallet;
}

/** The envelope's own fee field; the total, i.e. per-operation × op count. */
function envelopeFee(xdr: string): string {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  return tx.fee;
}

beforeEach(() => {
  feeStatsMock.mockReset();
  feeStatsMock.mockReturnValue(null);
});

/* ------------------------------------------------------------- tx.build */

describe('tx.build prices the envelope from /fee_stats', () => {
  it('still builds, at BASE_FEE, when /fee_stats is unavailable (fail-open)', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(null);
    const built = await handlers['tx.build'](ctx, {
      intent: { kind: 'payment', destination: DEST, assetId: 'native', amount: '1' },
    });
    expect(envelopeFee(built.xdr)).toBe('100');
  });

  it('leaves a calm market at 100; no change to the everyday envelope', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({}));
    const built = await handlers['tx.build'](ctx, {
      intent: { kind: 'payment', destination: DEST, assetId: 'native', amount: '1' },
    });
    expect(envelopeFee(built.xdr)).toBe('100');
  });

  it('raises the fee during a surge', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '3000', p95: '2500' }, '0.97'));
    const built = await handlers['tx.build'](ctx, {
      intent: { kind: 'payment', destination: DEST, assetId: 'native', amount: '1' },
    });
    expect(envelopeFee(built.xdr)).toBe('12000');
  });

  it('caps a hostile /fee_stats instead of emptying the account', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '4000000000' }, '1'));
    const built = await handlers['tx.build'](ctx, {
      intent: { kind: 'payment', destination: DEST, assetId: 'native', amount: '1' },
    });
    expect(envelopeFee(built.xdr)).toBe(String(MAX_FEE_PER_OPERATION_STROOPS));
  });

  it('prices a trustline too; the screen with no manual fee field at all', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '900' }));
    const built = await handlers['tx.build'](ctx, {
      intent: { kind: 'changeTrust', assetCode: 'USDC', issuer: ISSUER },
    });
    expect(envelopeFee(built.xdr)).toBe('900');
  });

  it('prices a DEX swap too', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '750' }));
    const built = await handlers['tx.build'](ctx, {
      intent: {
        kind: 'swap',
        sendAssetId: 'native',
        sendAmount: '1',
        destAssetId: `USDC:${ISSUER}`,
        destMin: '0.9',
        path: [],
        route: 'dex',
      },
    });
    expect(envelopeFee(built.xdr)).toBe('750');
  });
});

/* --------------------------------------------------- the developer override */

describe('the developer-mode override keeps precedence', () => {
  it('wins over a network-derived fee', async () => {
    const { ctx } = await developerWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '9000' }, '0.99'));
    const built = await handlers['tx.build'](ctx, {
      intent: {
        kind: 'payment',
        destination: DEST,
        assetId: 'native',
        amount: '1',
        feeStroops: '54321',
      },
    });
    expect(envelopeFee(built.xdr)).toBe('54321');
    // The override short-circuits the lookup entirely.
    expect(feeStatsMock).not.toHaveBeenCalled();
  });

  it('is ignored in beginner mode, which then gets the network fee', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '900' }));
    const built = await handlers['tx.build'](ctx, {
      intent: {
        kind: 'payment',
        destination: DEST,
        assetId: 'native',
        amount: '1',
        feeStroops: '54321',
      },
    });
    expect(envelopeFee(built.xdr)).toBe('900');
  });

  it('may exceed the wallet ceiling; that ceiling guards against Horizon, not the user', async () => {
    const { ctx } = await developerWallet();
    const built = await handlers['tx.build'](ctx, {
      intent: {
        kind: 'changeTrust',
        assetCode: 'USDC',
        issuer: ISSUER,
        feeStroops: String(MAX_FEE_PER_OPERATION_STROOPS * 3),
      },
    });
    expect(envelopeFee(built.xdr)).toBe(String(MAX_FEE_PER_OPERATION_STROOPS * 3));
  });
});

/* ------------------------------------------------------------ tx.describe */

describe('the chosen fee reaches the confirmation', () => {
  it('is what tx.describe reports, in stroops and in XLM', async () => {
    const { ctx } = await freshWallet();
    feeStatsMock.mockReturnValue(feeStats({ max: '2000' }, '0.9'));
    const built = await handlers['tx.build'](ctx, {
      intent: { kind: 'payment', destination: DEST, assetId: 'native', amount: '1' },
    });
    const described = await handlers['tx.describe'](ctx, { xdr: built.xdr });
    expect(described.meta.feeStroops).toBe('8000');
    expect(described.meta.feeXlm).toBe('0.0008');
    // One operation, so the per-operation fee and the total coincide, but
    // both are published so a multi-operation envelope cannot confuse them.
    expect(described.meta.feePerOperationStroops).toBe('8000');
    expect(described.meta.operationCount).toBe(1);
  });

  it('separates the per-operation fee from the total on a multi-op envelope', async () => {
    const { ctx, publicKey } = await freshWallet();
    const { Account, Asset, Operation } = await import('@stellar/stellar-sdk');
    const xdr = new TransactionBuilder(new Account(publicKey, '100'), {
      fee: '2500',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' }))
      .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '2' }))
      .setTimeout(180)
      .build()
      .toXDR();
    const described = await handlers['tx.describe'](ctx, { xdr });
    expect(described.meta.operationCount).toBe(2);
    expect(described.meta.feeStroops).toBe('5000');
    expect(described.meta.feePerOperationStroops).toBe('2500');
  });
});
