/**
 * Swap routing across the two quote sources, and the §4 refinement:
 * wallet-internal aggregator swaps may be signed in beginner mode, exactly
 * once, exactly the built bytes, while every other Soroban envelope stays
 * developer-gated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Address,
  Asset,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

/* ------------------------------------------------------------------ stubs */

type Area = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

function area(store: Map<string, unknown>): Area {
  return {
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (values) => {
      for (const [k, v] of Object.entries(values)) store.set(k, v);
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

const dexQuote = vi.fn();

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
    }),
    findStrictSendPath: (...args: unknown[]) => dexQuote(...args),
  };
});

/** A real invokeHostFunction envelope for whatever source the handler passes. */
function makeSorobanTx(source: string): Transaction {
  const contract = Asset.native().contractId(Networks.TESTNET);
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: 'swap',
      args: [],
    }),
  );
  return new TransactionBuilder(new Account(source, '7'), {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(180)
    .build();
}

const soroswapQuoteMock = vi.fn();
const soroswapConfigMock = vi.fn(() => ({ apiUrl: 'https://api.example.test', apiKey: 'sk_t' }));

vi.mock('../src/core/stellar/soroswap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/soroswap')>();
  return {
    ...actual,
    soroswapConfigFromEnv: () => soroswapConfigMock(),
    fetchSoroswapQuote: (...args: unknown[]) => soroswapQuoteMock(...args),
    buildSoroswapSwap: async (
      _config: unknown,
      _network: unknown,
      _quote: unknown,
      from: string,
    ) => {
      const tx = makeSorobanTx(from);
      return { xdr: tx.toXDR(), tx };
    },
  };
});

// The aggregator returns prepared envelopes; simulate that so `tx.build`
// does not reach out to a Soroban RPC in this suite.
vi.mock('../src/core/stellar/soroban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/soroban')>();
  return { ...actual, hasSorobanFootprint: () => true };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { AppError } = await import('../src/core/errors');

const PASSWORD = 'correct horse battery';

const SOROSWAP_QUOTE = {
  destAmount: '9.5',
  minReceived: '9.4525',
  priceImpactPct: '0.12',
  platform: 'soroswap',
  raw: { amountOut: '95000000' },
};

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

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as InstanceType<typeof AppError>).code).toBe(code);
  }
}

const QUOTE_PARAMS = {
  sendAssetId: 'native',
  sendAmount: '1',
  destAssetId: 'USDC:GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
  slippageBps: 50,
};

beforeEach(() => {
  dexQuote.mockReset();
  soroswapQuoteMock.mockReset();
  soroswapConfigMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------ swap.quote */

describe('swap.quote source selection', () => {
  it('lets the aggregator win when it yields more, and caches the quote', async () => {
    const { ctx } = await freshWallet();
    dexQuote.mockResolvedValue({ destAmount: '9.0', path: [] });
    soroswapQuoteMock.mockResolvedValue(SOROSWAP_QUOTE);

    const result = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(result.found).toBe(true);
    expect(result.source).toBe('soroswap');
    expect(result.destAmount).toBe('9.5');
    expect(result.minReceived).toBe('9.4525');
    expect(result.quoteId).not.toBeNull();
    expect(result.dexDestAmount).toBe('9.0');
    expect(result.soroswapDestAmount).toBe('9.5');
  });

  it('keeps the DEX when it is at least as good; no quoteId, path preserved', async () => {
    const { ctx } = await freshWallet();
    dexQuote.mockResolvedValue({ destAmount: '9.6', path: ['native'] });
    soroswapQuoteMock.mockResolvedValue(SOROSWAP_QUOTE);

    const result = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(result.source).toBe('dex');
    expect(result.destAmount).toBe('9.6');
    expect(result.path).toEqual(['native']);
    expect(result.quoteId).toBeNull();
  });

  it('falls back to the DEX when the aggregator has no route or fails', async () => {
    const { ctx } = await freshWallet();
    dexQuote.mockResolvedValue({ destAmount: '9.0', path: [] });
    soroswapQuoteMock.mockResolvedValue(null);
    expect((await handlers['swap.quote'](ctx, QUOTE_PARAMS)).source).toBe('dex');

    soroswapQuoteMock.mockRejectedValue(new Error('aggregator down'));
    const result = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(result.source).toBe('dex');
    expect(result.found).toBe(true);
  });

  it('serves aggregator-only liquidity even without a DEX route', async () => {
    const { ctx } = await freshWallet();
    dexQuote.mockResolvedValue(null);
    soroswapQuoteMock.mockResolvedValue(SOROSWAP_QUOTE);
    const result = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(result.found).toBe(true);
    expect(result.source).toBe('soroswap');
  });

  it('reports no route only when every source is empty', async () => {
    const { ctx } = await freshWallet();
    dexQuote.mockResolvedValue(null);
    soroswapQuoteMock.mockResolvedValue(null);
    const result = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(result.found).toBe(false);
  });

  it('skips the aggregator entirely when no API key is configured', async () => {
    soroswapConfigMock.mockReturnValueOnce(null as never);
    const { ctx } = await freshWallet();
    dexQuote.mockResolvedValue({ destAmount: '9.0', path: [] });
    const result = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(result.source).toBe('dex');
    expect(soroswapQuoteMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------- build + the beginner-mode exception */

async function quoteAndBuild(
  ctx: InstanceType<typeof BackgroundContext>,
): Promise<{ quoteId: string; xdr: string }> {
  dexQuote.mockResolvedValue({ destAmount: '9.0', path: [] });
  soroswapQuoteMock.mockResolvedValue(SOROSWAP_QUOTE);
  const quote = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
  if (quote.quoteId === null) throw new Error('expected a cached quote');
  const built = await handlers['tx.build'](ctx, {
    intent: {
      kind: 'swap',
      sendAssetId: QUOTE_PARAMS.sendAssetId,
      sendAmount: QUOTE_PARAMS.sendAmount,
      destAssetId: QUOTE_PARAMS.destAssetId,
      destMin: '9.4525',
      path: [],
      route: 'soroswap',
      quoteId: quote.quoteId,
    },
    accountIndex: 0,
  });
  return { quoteId: quote.quoteId, xdr: built.xdr };
}

describe('soroswap build route', () => {
  it('builds from the background-cached quote and signs once in beginner mode', async () => {
    const { ctx } = await freshWallet();
    const { xdr: builtXdr } = await quoteAndBuild(ctx);

    // Beginner mode is the default; the internal allowlist admits the swap …
    const signed = await handlers['tx.sign'](ctx, { xdr: builtXdr, accountIndex: 0 });
    expect(signed.signedXdr.length).toBeGreaterThan(0);

    // … exactly once. The same bytes a second time are an external envelope.
    await expectCode(
      handlers['tx.sign'](ctx, { xdr: builtXdr, accountIndex: 0 }),
      'DEVELOPER_MODE_REQUIRED',
    );
  });

  it('a quoteId is single-use: building twice needs a fresh quote', async () => {
    const { ctx } = await freshWallet();
    const { quoteId } = await quoteAndBuild(ctx);
    await expectCode(
      handlers['tx.build'](ctx, {
        intent: {
          kind: 'swap',
          sendAssetId: QUOTE_PARAMS.sendAssetId,
          sendAmount: QUOTE_PARAMS.sendAmount,
          destAssetId: QUOTE_PARAMS.destAssetId,
          destMin: '9.4525',
          path: [],
          route: 'soroswap',
          quoteId,
        },
        accountIndex: 0,
      }),
      'QUOTE_EXPIRED',
    );
  });

  it('rejects unknown, expired and mismatched quote ids', async () => {
    const { ctx } = await freshWallet();
    const intent = {
      kind: 'swap' as const,
      sendAssetId: QUOTE_PARAMS.sendAssetId,
      sendAmount: QUOTE_PARAMS.sendAmount,
      destAssetId: QUOTE_PARAMS.destAssetId,
      destMin: '9.4525',
      path: [],
      route: 'soroswap' as const,
    };
    // Unknown id.
    await expectCode(
      handlers['tx.build'](ctx, { intent: { ...intent, quoteId: 'nope' }, accountIndex: 0 }),
      'QUOTE_EXPIRED',
    );

    // Expired id: advance past the TTL.
    vi.useFakeTimers();
    dexQuote.mockResolvedValue(null);
    soroswapQuoteMock.mockResolvedValue(SOROSWAP_QUOTE);
    const quote = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    vi.advanceTimersByTime(61_000);
    await expectCode(
      handlers['tx.build'](ctx, {
        intent: { ...intent, quoteId: quote.quoteId ?? '' },
        accountIndex: 0,
      }),
      'QUOTE_EXPIRED',
    );
    vi.useRealTimers();

    // Mismatched terms: the cached quote is for a different amount.
    const quote2 = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    await expectCode(
      handlers['tx.build'](ctx, {
        intent: { ...intent, sendAmount: '2', quoteId: quote2.quoteId ?? '' },
        accountIndex: 0,
      }),
      'QUOTE_EXPIRED',
    );
  });

  it('still developer-gates Soroban envelopes the wallet did not build', async () => {
    const { ctx, publicKey } = await freshWallet();
    const foreign = makeSorobanTx(publicKey);
    await expectCode(
      handlers['tx.sign'](ctx, { xdr: foreign.toXDR(), accountIndex: 0 }),
      'DEVELOPER_MODE_REQUIRED',
    );
  });
});
