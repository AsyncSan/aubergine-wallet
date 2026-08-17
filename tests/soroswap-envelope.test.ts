/**
 * The aggregator route signs a contract call the wallet did not build. Until
 * v1.2 the only checks were "source account, operation type, fee ceiling",
 * which a `transfer(victim, attacker, i128::MAX)` passes without effort, while
 * the swap screen keeps promising "you receive at least X".
 *
 * These tests pin the three claims `verifySoroswapEnvelope` now enforces
 * against the cached quote: no foreign payout account, no amount above the
 * quote, and the promised minimum present in the signed bytes. The hostile
 * envelopes below are built with the real SDK, so they are exactly the shape a
 * compromised `/quote/build` could return.
 */
import { describe, expect, it } from 'vitest';
import {
  Account,
  Address,
  Asset,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { AppError } from '../src/core/errors';
import {
  SOROSWAP_ENTRY_CONTRACTS,
  expectationOf,
  thresholdIsConsistent,
  verifySoroswapEnvelope,
  type SoroswapExpectation,
  type SoroswapQuote,
} from '../src/core/stellar/soroswap';
import { BUILTIN_NETWORKS } from '../src/core/stellar/networks';

const TESTNET = BUILTIN_NETWORKS.testnet;
const SOURCE = 'GDB2Z44TRLYIVANCEWUAW5X2HWFXRL27HHDROCGWBQRVKHJLP2NSWJLD';
const ATTACKER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
/**
 * The top-level contract is pinned now, so the envelopes here have to enter
 * through the published Soroswap testnet aggregator, otherwise every case
 * below would be rejected for the entry contract instead of for the claim it is
 * meant to pin. (It used to be the XLM SAC, which was never a router at all.)
 */
const ROUTER = SOROSWAP_ENTRY_CONTRACTS.get(TESTNET.passphrase)?.[0] ?? '';
/** The SAC of the asset being sold; the only contract allowed to debit us. */
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);
/** The SAC of the asset being bought; the token the proceeds must be in. */
const USDC_SAC = new Asset(
  'USDC',
  'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
).contractId(TESTNET.passphrase);

/** 100 XLM in → 250 USDC out, 0,5 % slippage → at least 248,75 USDC. */
const AMOUNT_IN = 1_000_000_000n;
const AMOUNT_OUT = 2_500_000_000n;
const MIN_OUT = 2_487_500_000n;

const EXPECTED: SoroswapExpectation = {
  amountInStroops: AMOUNT_IN.toString(),
  amountOutStroops: AMOUNT_OUT.toString(),
  minOutStroops: MIN_OUT.toString(),
  sendAssetContract: XLM_SAC,
  destAssetContract: USDC_SAC,
};

const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'i128' });
const addr = (value: string): xdr.ScVal => new Address(value).toScVal();

function envelope(options: {
  functionName?: string;
  args?: xdr.ScVal[];
  auth?: xdr.SorobanAuthorizationEntry[];
}): Transaction {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(ROUTER).toScAddress(),
      functionName: options.functionName ?? 'swap_exact_tokens_for_tokens',
      args: options.args ?? [],
    }),
  );
  return new TransactionBuilder(new Account(SOURCE, '100'), {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: options.auth ?? [] }))
    .setTimeout(180)
    .build();
}

/** An authorization entry whose sub-invocation hides the real transfer. */
function authEntry(args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(ROUTER).toScAddress(),
        functionName: 'transfer',
        args,
      }),
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ROUTER).toScAddress(),
          functionName: 'swap_exact_tokens_for_tokens',
          args: [],
        }),
      ),
      subInvocations: [invocation.subInvocations().length === 0 ? invocation : invocation],
    }),
  });
}

/**
 * The shape a genuine aggregator swap has. Verbatim the published signature
 * (soroswap/aggregator, contracts/aggregator/src/lib.rs), `env` excluded:
 *
 *   swap_exact_tokens_for_tokens(token_in, token_out, amount_in,
 *                                amount_out_min, distribution, to, deadline)
 *
 * The fixture used to be a four-argument invention, which meant every case
 * below was checked against a call shape that cannot occur.
 */
const honestArgs = (distribution?: xdr.ScVal): xdr.ScVal[] => [
  addr(XLM_SAC),
  addr(USDC_SAC),
  i128(AMOUNT_IN),
  i128(MIN_OUT),
  distribution ?? xdr.ScVal.scvVec([xdr.ScVal.scvVec([addr(XLM_SAC), addr(USDC_SAC)])]),
  addr(SOURCE),
  nativeToScVal(1_900_000_000n, { type: 'u64' }), // deadline, not an amount
];

function expectRejected(tx: Transaction, needle: string): void {
  try {
    verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE, EXPECTED);
    expect.unreachable('the envelope should have been refused');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SWAP_ENVELOPE_MISMATCH');
    expect((err as AppError).detail ?? '').toContain(needle);
  }
}

describe('verifySoroswapEnvelope: checked against the quote', () => {
  it('accepts the swap the quote describes', () => {
    const tx = envelope({ args: honestArgs() });
    expect(verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE, EXPECTED).source).toBe(SOURCE);
  });

  /**
   * The route argument is a `Vec<DexDistribution>`, i.e. a vector of structs
   * each holding a nested vector of hop addresses. The scanner has to reach all
   * the way in.
   */
  const nestedDistribution = (hops: xdr.ScVal[]): xdr.ScVal =>
    xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: nativeToScVal('parts', { type: 'symbol' }), val: i128(1n) }),
        new xdr.ScMapEntry({
          key: nativeToScVal('path', { type: 'symbol' }),
          val: xdr.ScVal.scvVec([xdr.ScVal.scvVec(hops)]),
        }),
      ]),
    ]);

  it('finds the amounts and addresses inside nested vectors and maps', () => {
    const tx = envelope({ args: honestArgs(nestedDistribution([addr(XLM_SAC), addr(USDC_SAC)])) });
    expect(() => verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE, EXPECTED)).not.toThrow();
  });

  it('counter-probe: a foreign account four levels deep is still caught', () => {
    // The positive case above passes just as happily if the recursion is
    // neutralised, so on its own it proves nothing. This is the half that does.
    const tx = envelope({
      args: honestArgs(nestedDistribution([addr(XLM_SAC), addr(ATTACKER), addr(USDC_SAC)])),
    });
    expectRejected(tx, ATTACKER);
  });

  it('counter-probe: an oversized amount buried in the route is still caught', () => {
    const tx = envelope({
      args: honestArgs(
        xdr.ScVal.scvVec([
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: nativeToScVal('parts', { type: 'symbol' }),
              val: xdr.ScVal.scvVec([i128(AMOUNT_OUT * 3n)]),
            }),
          ]),
        ]),
      ),
    });
    expectRejected(tx, 'exceeds the quote');
  });

  /**
   * The deliberate other half of the counter-probe: a *contract* address nested
   * in the same place is accepted, and that is a decision, not an oversight. The
   * hops of a multi-hop route are contract ids only the aggregator knows, so a
   * rule that refused unknown `C…` here would refuse every real multi-hop swap.
   * The proceeds are pinned positionally instead (`to`, `token_out`,
   * `amount_out_min`), which is what the aggregator enforces on-chain.
   */
  it('accepts an unknown contract address nested in the route, by decision', () => {
    const stranger = 'CBQBQXFQAQ5BQH5RATLBVYE5OTRJFRFPC6WBQNPENI22UODKPL2BZZB5';
    const tx = envelope({
      args: honestArgs(nestedDistribution([addr(XLM_SAC), addr(stranger), addr(USDC_SAC)])),
    });
    expect(() => verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE, EXPECTED)).not.toThrow();
  });

  it('refuses the drain: transfer(victim, attacker, i128::MAX)', () => {
    const max = (1n << 127n) - 1n;
    const tx = envelope({
      functionName: 'transfer',
      args: [addr(SOURCE), addr(ATTACKER), i128(max)],
    });
    // `transfer` is not on the pinned entry's positive function list, so the
    // envelope is refused before its arguments even matter.
    expectRejected(tx, 'is called as transfer');
  });

  it('refuses a payout to a foreign account even with honest amounts', () => {
    const tx = envelope({ args: honestArgs().with(5, addr(ATTACKER)) });
    expectRejected(tx, ATTACKER);
  });

  it('refuses an input larger than the quote', () => {
    const tx = envelope({ args: honestArgs().with(2, i128(AMOUNT_IN * 10n)) });
    expectRejected(tx, `instead of the quoted ${AMOUNT_IN}`);
  });

  it('refuses an envelope that drops the guaranteed minimum', () => {
    const tx = envelope({ args: honestArgs().with(3, i128(1n)) });
    expectRejected(tx, `instead of the promised minimum ${MIN_OUT}`);
  });

  it('refuses a hostile transfer smuggled into an authorization entry', () => {
    // Top-level args look perfect; the drain hides in the auth tree that the
    // transaction signature would also cover.
    const tx = envelope({
      args: honestArgs(),
      auth: [authEntry([addr(SOURCE), addr(ATTACKER), i128(AMOUNT_IN)])],
    });
    expectRejected(tx, ATTACKER);
  });

  it('still allows a swap whose output is numerically larger than its input', () => {
    // 1 XLM -> 5 of a token: the output legitimately exceeds the input.
    const expectation: SoroswapExpectation = {
      amountInStroops: '10000000',
      amountOutStroops: '50000000',
      minOutStroops: '49750000',
      sendAssetContract: XLM_SAC,
      destAssetContract: USDC_SAC,
    };
    const tx = envelope({
      args: honestArgs().with(2, i128(10_000_000n)).with(3, i128(49_750_000n)),
    });
    expect(() => verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE, expectation)).not.toThrow();
  });

  it('expectationOf carries the quote numbers verbatim', () => {
    const quote: SoroswapQuote = {
      destAmount: '250',
      minReceived: '248.75',
      priceImpactPct: null,
      platform: null,
      amountInStroops: AMOUNT_IN.toString(),
      amountOutStroops: AMOUNT_OUT.toString(),
      minOutStroops: MIN_OUT.toString(),
      sendAssetContract: XLM_SAC,
      destAssetContract: USDC_SAC,
      raw: {},
    };
    expect(expectationOf(quote)).toEqual(EXPECTED);
  });
});

describe('thresholdIsConsistent', () => {
  it('accepts a threshold that matches the requested slippage', () => {
    expect(thresholdIsConsistent('2500000000', '2487500000', 50)).toBe(true);
    expect(thresholdIsConsistent('2500000000', '2500000000', 0)).toBe(true);
  });

  it('rejects the "at least 0,0000001" quote', () => {
    // The exact payload that used to parse and render a 100 % slippage promise.
    expect(thresholdIsConsistent('2500000000', '1', 50)).toBe(false);
  });

  it('rejects a threshold above the quoted output, and nonsense input', () => {
    expect(thresholdIsConsistent('2500000000', '2500000001', 50)).toBe(false);
    expect(thresholdIsConsistent('0', '0', 50)).toBe(false);
    expect(thresholdIsConsistent('abc', '1', 50)).toBe(false);
  });

  it('tolerates the floor-division remainder but nothing beyond it', () => {
    expect(thresholdIsConsistent('1000000007', '995000006', 50)).toBe(true);
    expect(thresholdIsConsistent('1000000007', '995000000', 50)).toBe(false);
  });
});
