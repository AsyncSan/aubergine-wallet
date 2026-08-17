/**
 * End-to-end guard for the aggregator route, with the REAL Soroswap client in
 * the loop (only `fetch` and the Soroban RPC are stubbed).
 *
 * `tests/swap-routing.test.ts` mocks `buildSoroswapSwap` away, so it proves the
 * routing decision but nothing about what the wallet actually signs. This file
 * covers the two places a hostile aggregator or a hostile Soroban RPC can hand
 * the wallet different bytes than the ones the user approved:
 *   1. the `/quote/build` response, and
 *   2. the *prepared* envelope that comes back from simulation, which carries
 *      an RPC-chosen resource fee and RPC-supplied authorization entries.
 * Both must be refused, and neither may end up on the beginner-mode allowlist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Address,
  Asset,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { SOROSWAP_ENTRY_CONTRACTS } from '../src/core/stellar/soroswap';

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
      accountId,
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
    }),
    findStrictSendPath: async () => ({ destAmount: '9.0', path: [] }),
  };
});

vi.mock('../src/core/stellar/soroswap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/soroswap')>();
  // Everything real except the build-time config, which normally comes from
  // an env var that is absent in CI.
  return {
    ...actual,
    soroswapConfigFromEnv: () => ({ apiUrl: 'https://api.example.test', apiKey: 'sk_test' }),
  };
});

/** The aggregator envelope always needs preparing here, so the RPC is in play. */
const prepareMock = vi.fn();
vi.mock('../src/core/stellar/soroban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/soroban')>();
  return {
    ...actual,
    hasSorobanFootprint: () => false,
    prepareSorobanTransaction: (...args: unknown[]) => prepareMock(...args),
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { AppError } = await import('../src/core/errors');

/* --------------------------------------------------------------- fixtures */

const PASSWORD = 'correct horse battery';
const ATTACKER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC = 'USDC:GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
/**
 * The published Soroswap testnet aggregator; the only entry contract a genuine
 * `/quote/build` envelope may use now that the top-level contract is pinned.
 * (The literal that stood here before was in fact the XLM SAC, not a router.)
 */
const ROUTER_ID = SOROSWAP_ENTRY_CONTRACTS.get(Networks.TESTNET)?.[0] ?? '';
const ROUTER = new Address(ROUTER_ID).toScAddress();
/** The SAC of XLM on testnet: the token contract the honest swap debits. */
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
/** A token contract the attacker controls; a `C…`, which used to be invisible. */
const ATTACKER_CONTRACT = 'CBQBQXFQAQ5BQH5RATLBVYE5OTRJFRFPC6WBQNPENI22UODKPL2BZZB5';

/** 1 XLM in, 9.5 USDC out, 0.5 % slippage → 9.4525 USDC guaranteed. */
const AMOUNT_IN = 10_000_000n;
const AMOUNT_OUT = 95_000_000n;
const MIN_OUT = 94_525_000n;

const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'i128' });
const addr = (value: string): xdr.ScVal => new Address(value).toScVal();

function swapEnvelope(
  source: string,
  args: xdr.ScVal[],
  options: {
    fee?: string;
    auth?: xdr.SorobanAuthorizationEntry[];
    /** Enter through a different contract, attack variant A. */
    entry?: xdr.ScAddress;
    /** Attach a resource footprint, i.e. look like a *prepared* envelope. */
    prepared?: boolean;
  } = {},
): Transaction {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: options.entry ?? ROUTER,
      functionName: 'swap_exact_tokens_for_tokens',
      args,
    }),
  );
  let builder = new TransactionBuilder(new Account(source, '100'), {
    fee: options.fee ?? '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: options.auth ?? [] }))
    .setTimeout(180);
  if (options.prepared === true) {
    builder = builder.setSorobanData(new SorobanDataBuilder().build());
  }
  return builder.build();
}

/** A `SorobanCredentials::SourceAccount` entry; what variant B rides on. */
function sourceAuth(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations,
    }),
  });
}

const transferInv = (
  token: string,
  from: string,
  to: string,
  amount: bigint,
): xdr.SorobanAuthorizedInvocation =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(token).toScAddress(),
        functionName: 'transfer',
        args: [addr(from), addr(to), i128(amount)],
      }),
    ),
    subInvocations: [],
  });

/** The SAC of the asset being bought, where the proceeds must be denominated. */
const USDC_SAC = new Asset('USDC', USDC.split(':')[1] ?? '').contractId(Networks.TESTNET);

/**
 * The real published aggregator signature, `env` excluded (soroswap/aggregator,
 * contracts/aggregator/src/lib.rs):
 *
 *   swap_exact_tokens_for_tokens(token_in, token_out, amount_in,
 *                                amount_out_min, distribution, to, deadline)
 *
 * The previous three-argument fixture was an invention, so the honest case
 * never exercised the shape a real `/quote/build` returns.
 */
const honestArgs = (source: string, to: xdr.ScVal = addr(source)): xdr.ScVal[] => [
  addr(XLM_SAC),
  addr(USDC_SAC),
  i128(AMOUNT_IN),
  i128(MIN_OUT),
  xdr.ScVal.scvVec([xdr.ScVal.scvVec([addr(XLM_SAC), addr(USDC_SAC)])]),
  to,
  nativeToScVal(1_900_000_000n, { type: 'u64' }),
];

/** What the `/quote` endpoint answers. Overridable per test. */
let quotePayload: Record<string, unknown>;
/** What `/quote/build` answers, as a function of the requesting account. */
let buildEnvelope: (source: string) => Transaction;

beforeEach(() => {
  quotePayload = {
    amountIn: AMOUNT_IN.toString(),
    amountOut: AMOUNT_OUT.toString(),
    otherAmountThreshold: MIN_OUT.toString(),
    tradeType: 'EXACT_IN',
    platform: 'aggregator',
  };
  buildEnvelope = (source) => swapEnvelope(source, honestArgs(source));
  // Honest default: preparation returns the envelope untouched.
  prepareMock.mockReset();
  prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => ({
    preparedXdr: xdrString,
    summary: { ok: true },
  }));

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/quote/build')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { from?: string };
      const source = body.from ?? '';
      return new Response(JSON.stringify({ xdr: buildEnvelope(source).toXDR() }), { status: 200 });
    }
    if (url.includes('/quote')) {
      return new Response(JSON.stringify(quotePayload), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
});

async function freshWallet(): Promise<InstanceType<typeof BackgroundContext>> {
  localStore.clear();
  syncStore.clear();
  const ctx = new BackgroundContext();
  await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  return ctx;
}

const QUOTE_PARAMS = {
  sendAssetId: 'native',
  sendAmount: '1',
  destAssetId: USDC,
  slippageBps: 50,
};

async function quoteThenBuild(
  ctx: InstanceType<typeof BackgroundContext>,
): Promise<{ xdr: string }> {
  const quote = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
  if (quote.quoteId === null) throw new Error('the aggregator quote was not cached');
  return handlers['tx.build'](ctx, {
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
}

async function expectRefused(
  ctx: InstanceType<typeof BackgroundContext>,
  code: string,
): Promise<void> {
  try {
    await quoteThenBuild(ctx);
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as InstanceType<typeof AppError>).code).toBe(code);
  }
}

/* ------------------------------------------------------------------ tests */

describe('aggregator envelope guard (real client, stubbed transport)', () => {
  it('signs the honest swap in beginner mode', async () => {
    const ctx = await freshWallet();
    const built = await quoteThenBuild(ctx);
    const signed = await handlers['tx.sign'](ctx, { xdr: built.xdr, accountIndex: 0 });
    expect(signed.signedXdr.length).toBeGreaterThan(0);
  });

  it('refuses a build response that pays out to a foreign account', async () => {
    const ctx = await freshWallet();
    buildEnvelope = (source) =>
      swapEnvelope(source, [i128(AMOUNT_IN), i128(MIN_OUT), addr(ATTACKER)]);
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses the classic drain: transfer(victim, attacker, i128::MAX)', async () => {
    const ctx = await freshWallet();
    const max = (1n << 127n) - 1n;
    buildEnvelope = (source) => swapEnvelope(source, [addr(source), addr(ATTACKER), i128(max)]);
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses a build response that drops the guaranteed minimum', async () => {
    const ctx = await freshWallet();
    buildEnvelope = (source) => swapEnvelope(source, [i128(AMOUNT_IN), i128(1n), addr(source)]);
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses a prepared envelope whose auth entries were rewritten by the RPC', async () => {
    const ctx = await freshWallet();
    // The aggregator response is clean; the *simulation* result is not.
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      const hostile = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: ROUTER,
              functionName: 'transfer',
              args: [addr(original.source), addr(ATTACKER), i128(AMOUNT_IN)],
            }),
          ),
          subInvocations: [],
        }),
      });
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          auth: [hostile],
        }).toXDR(),
        summary: { ok: true },
      };
    });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses a prepared envelope whose resource fee blows the ceiling', async () => {
    const ctx = await freshWallet();
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          fee: '900000000',
        }).toXDR(),
        summary: { ok: true },
      };
    });
    await expectRefused(ctx, 'BAD_REQUEST');
  });

  it('never allowlists a refused envelope for beginner-mode signing', async () => {
    const ctx = await freshWallet();
    let hostileXdr = '';
    buildEnvelope = (source) => {
      const tx = swapEnvelope(source, [i128(AMOUNT_IN), i128(MIN_OUT), addr(ATTACKER)]);
      hostileXdr = tx.toXDR();
      return tx;
    };
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
    // Handing the same bytes to tx.sign must hit the ordinary Soroban gate.
    try {
      await handlers['tx.sign'](ctx, { xdr: hostileXdr, accountIndex: 0 });
      expect.unreachable('a non-allowlisted Soroban envelope must not sign in beginner mode');
    } catch (err) {
      expect((err as InstanceType<typeof AppError>).code).toBe('DEVELOPER_MODE_REQUIRED');
    }
  });

  it('refuses variant A: the whole call runs on an attacker contract', async () => {
    const ctx = await freshWallet();
    // Contract recipients used to be invisible: only `G…` addresses were
    // collected, so `swap(victim, attackerContract, …)` passed every check.
    buildEnvelope = (source) =>
      swapEnvelope(source, [addr(source), addr(ATTACKER_CONTRACT), i128(AMOUNT_IN), i128(MIN_OUT)], {
        entry: new Address(ATTACKER_CONTRACT).toScAddress(),
      });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses variant B: a hidden second transfer to an attacker contract', async () => {
    const ctx = await freshWallet();
    // The aggregator response is clean; the RPC adds the honest debit *and* a
    // second one to a contract it controls. Two authorised outflows, both of
    // them `C…`-addressed, which the old flat scan could not distinguish.
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          prepared: true,
          auth: [
            sourceAuth(ROUTER_ID, 'swap_exact_tokens_for_tokens', [], [
              transferInv(XLM_SAC, original.source, ROUTER_ID, AMOUNT_IN),
              transferInv(XLM_SAC, original.source, ATTACKER_CONTRACT, AMOUNT_IN),
            ]),
          ],
        }).toXDR(),
        summary: { ok: true },
      };
    });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses a prepared envelope that debits a token the quote never named', async () => {
    const ctx = await freshWallet();
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      const usdcSac = new Asset('USDC', USDC.split(':')[1] ?? '').contractId(Networks.TESTNET);
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          prepared: true,
          auth: [
            sourceAuth(ROUTER_ID, 'swap_exact_tokens_for_tokens', [], [
              transferInv(usdcSac, original.source, ATTACKER_CONTRACT, AMOUNT_IN),
            ]),
          ],
        }).toXDR(),
        summary: { ok: true },
      };
    });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('signs a prepared envelope with exactly one honest outflow on the XLM SAC', async () => {
    const ctx = await freshWallet();
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          prepared: true,
          auth: [
            sourceAuth(ROUTER_ID, 'swap_exact_tokens_for_tokens', [], [
              transferInv(XLM_SAC, original.source, ROUTER_ID, AMOUNT_IN),
            ]),
          ],
        }).toXDR(),
        summary: { ok: true },
      };
    });
    const built = await quoteThenBuild(ctx);
    const signed = await handlers['tx.sign'](ctx, { xdr: built.xdr, accountIndex: 0 });
    expect(signed.signedXdr.length).toBeGreaterThan(0);
  });

  it('refuses the proceeds being redirected to an attacker contract (P1)', async () => {
    const ctx = await freshWallet();
    // End to end, and this is the bypass the mutation review found: real pinned
    // aggregator, exactly one honest outflow of exactly `amountIn` on the
    // correct SAC, only `to` is the attacker's contract. Every claim the guard
    // used to make holds; the user would have signed away the whole output.
    let hostileXdr = '';
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      const tx = swapEnvelope(
        original.source,
        honestArgs(original.source, addr(ATTACKER_CONTRACT)),
        {
          prepared: true,
          auth: [
            sourceAuth(ROUTER_ID, 'swap_exact_tokens_for_tokens', [], [
              transferInv(XLM_SAC, original.source, ROUTER_ID, AMOUNT_IN),
            ]),
          ],
        },
      );
      hostileXdr = tx.toXDR();
      return { preparedXdr: hostileXdr, summary: { ok: true } };
    });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
    // And the bytes must not have been allowlisted for beginner-mode signing.
    try {
      await handlers['tx.sign'](ctx, { xdr: hostileXdr, accountIndex: 0 });
      expect.unreachable('a refused envelope must not sign in beginner mode');
    } catch (err) {
      expect((err as InstanceType<typeof AppError>).code).toBe('DEVELOPER_MODE_REQUIRED');
    }
  });

  it('refuses approve(victim, attacker, amountIn) as the only outflow (P3)', async () => {
    const ctx = await freshWallet();
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          prepared: true,
          auth: [
            sourceAuth(XLM_SAC, 'approve', [
              addr(original.source),
              addr(ATTACKER_CONTRACT),
              i128(AMOUNT_IN),
              nativeToScVal(999_999, { type: 'u32' }),
            ]),
          ],
        }).toXDR(),
        summary: { ok: true },
      };
    });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('refuses an unmodelled SAC call riding along with an honest transfer (P4)', async () => {
    const ctx = await freshWallet();
    prepareMock.mockImplementation(async (_network: unknown, xdrString: string) => {
      const original = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      return {
        preparedXdr: swapEnvelope(original.source, honestArgs(original.source), {
          prepared: true,
          auth: [
            sourceAuth(ROUTER_ID, 'swap_exact_tokens_for_tokens', [], [
              transferInv(XLM_SAC, original.source, ROUTER_ID, AMOUNT_IN),
              new xdr.SorobanAuthorizedInvocation({
                function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                  new xdr.InvokeContractArgs({
                    contractAddress: new Address(XLM_SAC).toScAddress(),
                    functionName: 'set_authorized',
                    args: [addr(original.source), addr(original.source), xdr.ScVal.scvBool(false)],
                  }),
                ),
                subInvocations: [],
              }),
            ]),
          ],
        }).toXDR(),
        summary: { ok: true },
      };
    });
    await expectRefused(ctx, 'SWAP_ENVELOPE_MISMATCH');
  });

  it('drops a quote whose own threshold contradicts the requested slippage', async () => {
    const ctx = await freshWallet();
    // "You receive at least 0,0000001 USDC", used to render with no warning.
    quotePayload = { ...quotePayload, otherAmountThreshold: '1' };
    const quote = await handlers['swap.quote'](ctx, QUOTE_PARAMS);
    expect(quote.source).toBe('dex');
    expect(quote.quoteId).toBeNull();
    expect(quote.minReceived).not.toBe('0.0000001');
  });
});
