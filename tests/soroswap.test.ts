/**
 * Soroswap aggregator integration, client unit tests.
 *
 * Everything here runs against stubs: the amount conversions, the asset→SAC
 * mapping, the quote parsing (mocked `fetch`) and, most security-relevant,
 * `verifySoroswapEnvelope`, which is the gate between "the aggregator said so"
 * and "we offer it for signing".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { AppError } from '../src/core/errors';
import { TESTNET, MAINNET } from '../src/core/stellar/networks';
import {
  amountToStroops,
  assetIdToContract,
  fetchSoroswapQuote,
  soroswapNetworkFor,
  stroopsToAmount,
  verifySoroswapEnvelope,
  MAX_SOROSWAP_FEE_STROOPS,
  SOROSWAP_ENTRY_CONTRACTS,
  type SoroswapConfig,
} from '../src/core/stellar/soroswap';

const CONFIG: SoroswapConfig = { apiUrl: 'https://api.example.test', apiKey: 'sk_test' };
const SOURCE = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';
const OTHER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

/* ------------------------------------------------------------ conversions */

describe('stroop conversions', () => {
  it('round-trips whole and fractional amounts', () => {
    expect(amountToStroops('1')).toBe('10000000');
    expect(amountToStroops('12.3456789')).toBe('123456789');
    expect(amountToStroops('0.0000001')).toBe('1');
    expect(stroopsToAmount('123456789')).toBe('12.3456789');
    expect(stroopsToAmount('10000000')).toBe('1');
    expect(stroopsToAmount('1')).toBe('0.0000001');
  });

  it('rejects malformed amounts, like the chain would', () => {
    for (const bad of ['', '1.12345678', '-1', '1,5', 'abc', '1e7']) {
      expect(() => amountToStroops(bad), bad).toThrow(AppError);
    }
    expect(() => stroopsToAmount('1.5')).toThrow(AppError);
  });

  it('survives amounts beyond Number precision', () => {
    expect(amountToStroops('922337203685.4775807')).toBe('9223372036854775807');
    expect(stroopsToAmount('9223372036854775807')).toBe('922337203685.4775807');
  });
});

/* ------------------------------------------------------- asset → contract */

describe('assetIdToContract', () => {
  it('maps native and classic assets to their SAC ids, per network', () => {
    const nativeTest = assetIdToContract('native', TESTNET.passphrase);
    const nativeMain = assetIdToContract('native', MAINNET.passphrase);
    expect(nativeTest).toMatch(/^C[A-Z2-7]{55}$/u);
    expect(nativeMain).toMatch(/^C[A-Z2-7]{55}$/u);
    // The SAC id is derived from the passphrase; the two networks differ.
    expect(nativeTest).not.toBe(nativeMain);
    expect(assetIdToContract(`USDC:${OTHER}`, TESTNET.passphrase)).toMatch(/^C[A-Z2-7]{55}$/u);
  });

  it('matches the SDK derivation exactly', () => {
    expect(assetIdToContract('native', TESTNET.passphrase)).toBe(
      Asset.native().contractId(TESTNET.passphrase),
    );
  });
});

describe('soroswapNetworkFor', () => {
  it('serves exactly the two public networks', () => {
    expect(soroswapNetworkFor(TESTNET)).toBe('testnet');
    expect(soroswapNetworkFor(MAINNET)).toBe('mainnet');
    expect(
      soroswapNetworkFor({ ...TESTNET, id: 'futurenet' }),
    ).toBeNull();
    expect(soroswapNetworkFor({ ...TESTNET, id: 'custom' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ quote */

function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

const QUOTE_BODY = {
  amountIn: '10000000',
  amountOut: '95000000',
  otherAmountThreshold: '94525000',
  tradeType: 'EXACT_IN',
  platform: 'soroswap',
  priceImpactPct: '0.12',
  routePlan: [{ swapInfo: { protocol: 'soroswap' } }],
};

describe('fetchSoroswapQuote', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a quote and converts stroops to decimal amounts', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, QUOTE_BODY));
    const quote = await fetchSoroswapQuote(CONFIG, TESTNET, 'native', '1', `USDC:${OTHER}`, 50);
    expect(quote).not.toBeNull();
    expect(quote?.destAmount).toBe('9.5');
    expect(quote?.minReceived).toBe('9.4525');
    expect(quote?.platform).toBe('soroswap');
    // The verbatim payload survives for /quote/build.
    expect(quote?.raw['routePlan']).toEqual(QUOTE_BODY.routePlan);
  });

  it('sends the request the API expects', async () => {
    const spy = fetchReturning(200, QUOTE_BODY);
    vi.stubGlobal('fetch', spy);
    await fetchSoroswapQuote(CONFIG, TESTNET, 'native', '2.5', `USDC:${OTHER}`, 100);
    const [url, init] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.example.test/quote?network=testnet');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_test');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['amount']).toBe('25000000');
    expect(body['tradeType']).toBe('EXACT_IN');
    expect(body['slippageBps']).toBe(100);
    expect(body['assetIn']).toBe(Asset.native().contractId(TESTNET.passphrase));
  });

  it('fails open to null: HTTP errors, malformed bodies, zero output, custom networks', async () => {
    vi.stubGlobal('fetch', fetchReturning(500, {}));
    expect(await fetchSoroswapQuote(CONFIG, TESTNET, 'native', '1', `USDC:${OTHER}`, 50)).toBeNull();

    vi.stubGlobal('fetch', fetchReturning(200, { nonsense: true }));
    expect(await fetchSoroswapQuote(CONFIG, TESTNET, 'native', '1', `USDC:${OTHER}`, 50)).toBeNull();

    vi.stubGlobal('fetch', fetchReturning(200, { ...QUOTE_BODY, amountOut: '0' }));
    expect(await fetchSoroswapQuote(CONFIG, TESTNET, 'native', '1', `USDC:${OTHER}`, 50)).toBeNull();

    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', offline);
    expect(await fetchSoroswapQuote(CONFIG, TESTNET, 'native', '1', `USDC:${OTHER}`, 50)).toBeNull();

    expect(
      await fetchSoroswapQuote(CONFIG, { ...TESTNET, id: 'custom' }, 'native', '1', 'X:' + OTHER, 50),
    ).toBeNull();
    // The custom-network refusal happens before any fetch.
    expect(offline).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------- envelope checks */

export function sorobanEnvelope(options: {
  source?: string;
  opSource?: string;
  fee?: string;
  extraPayment?: boolean;
} = {}): Transaction {
  const account = new Account(options.source ?? SOURCE, '100');
  // The entry contract is pinned against the published Soroswap deployment, so
  // this fixture has to enter through it. It used to be the XLM SAC, which is
  // not a router and would now (correctly) be refused as an unknown entry.
  const contract = SOROSWAP_ENTRY_CONTRACTS.get(TESTNET.passphrase)?.[0] ?? '';
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: 'swap',
      args: [],
    }),
  );
  let builder = new TransactionBuilder(account, {
    fee: options.fee ?? '1000000',
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.invokeHostFunction({
      func,
      auth: [],
      ...(options.opSource === undefined ? {} : { source: options.opSource }),
    }),
  );
  if (options.extraPayment === true) {
    builder = builder.addOperation(
      Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' }),
    );
  }
  return builder.setTimeout(180).build();
}

describe('verifySoroswapEnvelope', () => {
  it('accepts a clean single-invocation envelope from the right source', () => {
    const tx = sorobanEnvelope();
    const verified = verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE);
    expect(verified.source).toBe(SOURCE);
  });

  const cases: Array<[string, () => string, string]> = [
    ['foreign tx source', () => sorobanEnvelope({ source: OTHER }).toXDR(), 'BAD_REQUEST'],
    ['foreign op source', () => sorobanEnvelope({ opSource: OTHER }).toXDR(), 'BAD_REQUEST'],
    [
      'smuggled classic operation',
      () => sorobanEnvelope({ extraPayment: true }).toXDR(),
      'BAD_REQUEST',
    ],
    [
      'excessive fee',
      () => sorobanEnvelope({ fee: (MAX_SOROSWAP_FEE_STROOPS + 1n).toString() }).toXDR(),
      'BAD_REQUEST',
    ],
    ['garbage instead of XDR', () => 'not-an-envelope', 'NETWORK_ERROR'],
  ];

  it.each(cases)('rejects: %s', (_label, make, code) => {
    try {
      verifySoroswapEnvelope(make(), TESTNET, SOURCE);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(code);
    }
  });

  it('rejects an envelope whose fee is below the network minimum', () => {
    // BASE_FEE itself is fine …
    expect(() =>
      verifySoroswapEnvelope(sorobanEnvelope({ fee: BASE_FEE }).toXDR(), TESTNET, SOURCE),
    ).not.toThrow();
    // … anything under it is not. (This branch used to be unreachable: the test
    // only ever asserted the accepting half, so neutralising the floor in
    // soroswap.ts left the whole suite green.)
    try {
      verifySoroswapEnvelope(sorobanEnvelope({ fee: '1' }).toXDR(), TESTNET, SOURCE);
      expect.unreachable('a one-stroop fee should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('BAD_REQUEST');
    }
  });
});
