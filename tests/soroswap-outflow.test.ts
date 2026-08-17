/**
 * The authorised-outflow invariant.
 *
 * Until v1.3 `scanScVal` collected only *account* (`G…`) addresses and threw
 * contract (`C…`) addresses away, so the envelope check could only ever ask
 * "does a stranger's account appear here?". Both published attack variants used
 * a contract as the recipient and sailed straight through:
 *
 *   A  swap(victim, attackerContract, amountIn, minOut) on an attacker contract
 *   B  a harmless root call with an auth sub-invocation
 *      transfer(victim, attackerContract, amountIn) under SourceAccount
 *      credentials
 *
 * The fix does not try to enumerate legitimate counterparties, the route's
 * pools and adapters are unknowable up front, and `/quote` comes from the same
 * server we are defending against. Instead it holds the envelope to an
 * address-free claim derived from the quote:
 *
 *   the signing account authorises EXACTLY ONE outflow, and it moves EXACTLY
 *   `amountInStroops` of the SAC of the asset the quote says is being sold.
 *
 * plus a second, redeploy-fragile layer: the top-level contract must be a
 * published Soroswap entry point.
 */
import { describe, expect, it } from 'vitest';
import {
  Account,
  Address,
  Asset,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { AppError } from '../src/core/errors';
import { BUILTIN_NETWORKS } from '../src/core/stellar/networks';
import {
  SOROSWAP_ENTRIES,
  SOROSWAP_ENTRY_CONTRACTS,
  verifySoroswapEnvelope,
  type SoroswapExpectation,
} from '../src/core/stellar/soroswap';

const TESTNET = BUILTIN_NETWORKS.testnet;
const SOURCE = 'GDB2Z44TRLYIVANCEWUAW5X2HWFXRL27HHDROCGWBQRVKHJLP2NSWJLD';
const ATTACKER_G = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC_ISSUER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

/** The published Soroswap testnet entry points: [aggregator, AMM router]. */
const ENTRIES = SOROSWAP_ENTRY_CONTRACTS.get(TESTNET.passphrase) ?? [];
const AGGREGATOR = ENTRIES[0] ?? '';
const AMM_ROUTER = ENTRIES[1] ?? '';
const MAINNET_ENTRIES = SOROSWAP_ENTRY_CONTRACTS.get(Networks.PUBLIC) ?? [];

/** Token contracts. The SACs are derived exactly the way the wallet does it. */
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);
const USDC_SAC = new Asset('USDC', USDC_ISSUER).contractId(TESTNET.passphrase);

/** A pool the route legitimately touches, never allowlisted, never checked. */
const POOL = 'CBY6WKJ2V2PSBZG5RVRSGC2VCZFFVZKHCGYXBLJ2HEOZJNXJ3SI7TOZB';
/** The attacker's own contract: a `C…`, which is what used to be invisible. */
const ATTACKER_C = 'CBQBQXFQAQ5BQH5RATLBVYE5OTRJFRFPC6WBQNPENI22UODKPL2BZZB5';

/** 100 XLM in → 250 USDC out, 0,5 % slippage → at least 248,75 USDC. */
const AMOUNT_IN = 1_000_000_000n;
const AMOUNT_OUT = 2_500_000_000n;
const MIN_OUT = 2_487_500_000n;

/** Selling XLM for USDC. */
const SELL_XLM: SoroswapExpectation = {
  amountInStroops: AMOUNT_IN.toString(),
  amountOutStroops: AMOUNT_OUT.toString(),
  minOutStroops: MIN_OUT.toString(),
  sendAssetContract: XLM_SAC,
  destAssetContract: USDC_SAC,
};

/** Selling USDC for XLM; the same numbers, the two SACs the other way round. */
const SELL_USDC: SoroswapExpectation = {
  ...SELL_XLM,
  sendAssetContract: USDC_SAC,
  destAssetContract: XLM_SAC,
};

const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'i128' });
const u32 = (value: number): xdr.ScVal => nativeToScVal(value, { type: 'u32' });
const u64 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'u64' });
const sym = (value: string): xdr.ScVal => nativeToScVal(value, { type: 'symbol' });
const addr = (value: string): xdr.ScVal => new Address(value).toScVal();

/* --------------------------------------------------------------- builders */

function invocation(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations,
  });
}

/** `SorobanCredentials::SourceAccount`, exactly what attack variant B uses. */
function sourceAuth(root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
}

const transfer = (
  token: string,
  to: string,
  amount: bigint,
  from: string = SOURCE,
): xdr.SorobanAuthorizedInvocation =>
  invocation(token, 'transfer', [addr(from), addr(to), i128(amount)]);

/** The auth tree a genuine swap produces: the debit hangs under the root call. */
const honestAuth = (
  token: string,
  amount: bigint = AMOUNT_IN,
): xdr.SorobanAuthorizationEntry =>
  sourceAuth(
    invocation(AGGREGATOR, 'swap_exact_tokens_for_tokens', [], [transfer(token, POOL, amount)]),
  );

/**
 * One `DexDistribution` as the aggregator declares it: a struct, i.e. an ScVal
 * map with symbol keys, carrying a nested `Vec<Address>` route. This is the one
 * argument that legitimately contains contract addresses the wallet cannot
 * know, which is why nothing in it is allowlisted.
 */
const dexDistribution = (hops: xdr.ScVal[]): xdr.ScVal =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym('parts'), val: u32(1) }),
    new xdr.ScMapEntry({ key: sym('path'), val: xdr.ScVal.scvVec(hops) }),
    new xdr.ScMapEntry({ key: sym('protocol_id'), val: sym('Soroswap') }),
  ]);

/**
 * Top-level arguments of a genuine aggregator call, in the published order
 * (soroswap/aggregator, contracts/aggregator/src/lib.rs):
 *
 *   swap_exact_tokens_for_tokens(env, token_in, token_out, amount_in,
 *                                amount_out_min, distribution, to, deadline)
 */
const honestArgs = (
  expected: SoroswapExpectation = SELL_XLM,
  overrides: { to?: xdr.ScVal; distribution?: xdr.ScVal } = {},
): xdr.ScVal[] => [
  addr(expected.sendAssetContract),
  addr(expected.destAssetContract),
  i128(BigInt(expected.amountInStroops)),
  i128(BigInt(expected.minOutStroops)),
  overrides.distribution ??
    xdr.ScVal.scvVec([
      dexDistribution([addr(expected.sendAssetContract), addr(expected.destAssetContract)]),
    ]),
  overrides.to ?? addr(SOURCE),
  u64(1_900_000_000n), // deadline
];

/**
 * The AMM router's own signature (soroswap/core, contracts/router/src/lib.rs):
 *
 *   swap_exact_tokens_for_tokens(e, amount_in, amount_out_min, path, to, deadline)
 */
const honestRouterArgs = (overrides: { to?: xdr.ScVal; path?: xdr.ScVal } = {}): xdr.ScVal[] => [
  i128(AMOUNT_IN),
  i128(MIN_OUT),
  overrides.path ?? xdr.ScVal.scvVec([addr(XLM_SAC), addr(USDC_SAC)]),
  overrides.to ?? addr(SOURCE),
  u64(1_900_000_000n),
];

function envelope(options: {
  entry?: string;
  functionName?: string;
  args?: xdr.ScVal[];
  auth?: xdr.SorobanAuthorizationEntry[];
  /** Attach a Soroban resource footprint, i.e. mimic a *prepared* envelope. */
  prepared?: boolean;
}): Transaction {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(options.entry ?? AGGREGATOR).toScAddress(),
      functionName: options.functionName ?? 'swap_exact_tokens_for_tokens',
      args: options.args ?? honestArgs(),
    }),
  );
  let builder = new TransactionBuilder(new Account(SOURCE, '100'), {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: options.auth ?? [] }))
    .setTimeout(180);
  if (options.prepared === true) {
    builder = builder.setSorobanData(new SorobanDataBuilder().build());
  }
  return builder.build();
}

function verify(tx: Transaction, expected: SoroswapExpectation = SELL_XLM): Transaction {
  return verifySoroswapEnvelope(tx.toXDR(), TESTNET, SOURCE, expected);
}

function expectRejected(
  tx: Transaction,
  needle: string,
  expected: SoroswapExpectation = SELL_XLM,
): void {
  try {
    verify(tx, expected);
    expect.unreachable('the envelope should have been refused');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SWAP_ENVELOPE_MISMATCH');
    expect((err as AppError).detail ?? '').toContain(needle);
  }
}

/* ---------------------------------------------------------------- fixture */

describe('pinned entry contracts', () => {
  it('carries two published testnet ids, both valid contract strkeys', () => {
    expect(ENTRIES).toHaveLength(2);
    for (const id of ENTRIES) expect(id).toMatch(/^C[A-Z2-7]{55}$/u);
    expect(MAINNET_ENTRIES).toHaveLength(2);
    // Custom / futurenet have no published deployment: nothing to pin against.
    expect(SOROSWAP_ENTRY_CONTRACTS.get('Some Custom Passphrase')).toBeUndefined();
  });

  /**
   * Shape and length are not identity: swapping the mainnet and testnet lists
   * leaves both of them two valid `C…` strkeys long, so every check above stays
   * green while the wallet pins the wrong deployment on the network that has
   * real money on it. The ids are therefore nailed down as literals, verified
   * 2026-08-17 against the upstream deployment manifests:
   *
   *   soroswap/aggregator public/{mainnet,testnet}.contracts.json → ids.aggregator
   *   soroswap/core       public/{mainnet,testnet}.contracts.json → ids.router
   */
  it('pins the four published ids verbatim, per network', () => {
    expect(MAINNET_ENTRIES).toEqual([
      'CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO',
      'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
    ]);
    expect(ENTRIES).toEqual([
      'CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA',
      'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
    ]);
  });

  it('keeps the two networks disjoint; no testnet id is valid on mainnet', () => {
    for (const id of ENTRIES) expect(MAINNET_ENTRIES).not.toContain(id);
    for (const id of MAINNET_ENTRIES) expect(ENTRIES).not.toContain(id);
  });

  it('knows which entry is the aggregator and which is the AMM router', () => {
    // The role decides where the recipient argument sits, so it may not drift.
    expect(SOROSWAP_ENTRIES.get(TESTNET.passphrase)?.map((e) => e.role)).toEqual([
      'aggregator',
      'router',
    ]);
    expect(SOROSWAP_ENTRIES.get(Networks.PUBLIC)?.map((e) => e.role)).toEqual([
      'aggregator',
      'router',
    ]);
  });

  /**
   * The "second line of defence" the module claims is only real if it fires. A
   * network with no pinned deployment must be refused, not waved through: an
   * `assertPinnedEntryContract` that returns silently on an unknown passphrase
   * leaves the whole pin useless and no test used to notice.
   */
  it('refuses an envelope on a network with no pinned deployment', () => {
    const foreign = { ...TESTNET, passphrase: Networks.FUTURENET };
    const tx = new TransactionBuilder(new Account(SOURCE, '100'), {
      fee: '1000000',
      networkPassphrase: Networks.FUTURENET,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(AGGREGATOR).toScAddress(),
              functionName: 'swap_exact_tokens_for_tokens',
              args: honestArgs(),
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(180)
      .build();
    try {
      verifySoroswapEnvelope(tx.toXDR(), foreign, SOURCE, SELL_XLM);
      expect.unreachable('an unpinned network should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('SWAP_ENVELOPE_MISMATCH');
      expect((err as AppError).detail ?? '').toContain('no published Soroswap deployment');
    }
  });
});

/* ------------------------------------------------------------- positives */

describe('legitimate swaps still pass', () => {
  it('XLM → USDC, unprepared: no auth entries yet, no footprint', () => {
    // What `/quote/build` returns before the RPC has seen it. It cannot debit
    // anything (no auth entry to satisfy `require_auth`) and cannot even be
    // submitted (no footprint), so it is accepted provisionally and re-checked
    // after preparation.
    expect(verify(envelope({})).source).toBe(SOURCE);
  });

  it('XLM → USDC, prepared: one transfer of exactly amountIn on the XLM SAC', () => {
    const tx = envelope({ prepared: true, auth: [honestAuth(XLM_SAC)] });
    expect(verify(tx).source).toBe(SOURCE);
  });

  it('USDC → XLM, prepared: the same shape on the USDC SAC', () => {
    const tx = envelope({
      prepared: true,
      args: honestArgs(SELL_USDC),
      auth: [honestAuth(USDC_SAC)],
    });
    expect(verify(tx, SELL_USDC).source).toBe(SOURCE);
  });

  it('accepts the AMM router as an entry contract too, not just the aggregator', () => {
    // Different contract, different signature: `to` sits at argument 3 here,
    // and the two tokens are the first and last hop of `path`.
    const tx = envelope({
      entry: AMM_ROUTER,
      args: honestRouterArgs(),
      prepared: true,
      auth: [honestAuth(XLM_SAC)],
    });
    expect(verify(tx).source).toBe(SOURCE);
  });

  it('accepts a multi-hop route through tokens the wallet has never heard of', () => {
    // The price of the recipient check must not be paid by real routes: the
    // intermediate hops are contract addresses nobody can allowlist, and they
    // stay deliberately unchecked.
    const tx = envelope({
      prepared: true,
      args: honestArgs(SELL_XLM, {
        distribution: xdr.ScVal.scvVec([
          dexDistribution([addr(XLM_SAC), addr(POOL), addr(ATTACKER_C), addr(USDC_SAC)]),
        ]),
      }),
      auth: [honestAuth(XLM_SAC)],
    });
    expect(verify(tx).source).toBe(SOURCE);
  });

  it('accepts a debit nested several sub-invocations deep', () => {
    const deep = sourceAuth(
      invocation(
        AGGREGATOR,
        'swap_exact_tokens_for_tokens',
        [],
        [invocation(POOL, 'swap', [], [transfer(XLM_SAC, POOL, AMOUNT_IN)])],
      ),
    );
    expect(verify(envelope({ prepared: true, auth: [deep] })).source).toBe(SOURCE);
  });

  it('accepts auth entries that authorise nothing the user pays for', () => {
    // A contract-credentials entry for a pool: it debits the pool, not us.
    const poolAuth = sourceAuth(
      invocation(
        AGGREGATOR,
        'swap_exact_tokens_for_tokens',
        [],
        [
          transfer(XLM_SAC, POOL, AMOUNT_IN),
          // pool → user payout: `from` is the pool, so it is not our outflow.
          transfer(USDC_SAC, SOURCE, MIN_OUT, POOL),
        ],
      ),
    );
    expect(verify(envelope({ prepared: true, auth: [poolAuth] })).source).toBe(SOURCE);
  });
});

/* --------------------------------------------------- attack variant A */

describe('variant A; the whole call runs on an attacker contract', () => {
  it('refuses swap(victim, attackerContract, amountIn, minOut) on a foreign contract', () => {
    const tx = envelope({
      entry: ATTACKER_C,
      functionName: 'swap',
      args: [addr(SOURCE), addr(ATTACKER_C), i128(AMOUNT_IN), i128(MIN_OUT)],
    });
    expectRejected(tx, 'unknown swap entry contract');
  });

  it('refuses it even when the auth tree is impeccable', () => {
    const tx = envelope({
      entry: ATTACKER_C,
      prepared: true,
      auth: [honestAuth(XLM_SAC)],
    });
    expectRejected(tx, 'unknown swap entry contract');
  });

  it('refuses a host function that is not a contract invocation at all', () => {
    const func = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from([1, 2, 3]));
    const tx = new TransactionBuilder(new Account(SOURCE, '100'), {
      fee: '1000000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
      .setTimeout(180)
      .build();
    expectRejected(tx, 'instead of a contract');
  });
});

/* --------------------------------------------------- attack variant B */

describe('variant B; the drain hides in the auth tree', () => {
  it('refuses a second, hidden outflow next to the honest one', () => {
    // The realistic drain: the swap happens *and* the attacker takes a cut.
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [transfer(XLM_SAC, POOL, AMOUNT_IN), transfer(XLM_SAC, ATTACKER_C, AMOUNT_IN)],
          ),
        ),
      ],
    });
    expectRejected(tx, 'authorises 2 outflows');
  });

  it('refuses an outflow on a token the quote never mentioned', () => {
    // Selling XLM, but the auth tree debits the user's USDC to a contract.
    const tx = envelope({
      prepared: true,
      auth: [sourceAuth(transfer(USDC_SAC, ATTACKER_C, AMOUNT_IN))],
    });
    expectRejected(tx, 'not the expected token contract');
  });

  it('refuses an outflow whose amount is not exactly the quoted input', () => {
    const tx = envelope({
      prepared: true,
      auth: [sourceAuth(transfer(XLM_SAC, ATTACKER_C, AMOUNT_IN - 1n))],
    });
    expectRejected(tx, `instead of the quoted ${AMOUNT_IN}`);
  });

  it('refuses an inflated outflow even below the value-scan ceiling', () => {
    // `AMOUNT_OUT` is the old ceiling (output > input here), so the flat amount
    // check would wave this through; it is 2.5x the input the user approved.
    const tx = envelope({
      prepared: true,
      auth: [sourceAuth(transfer(XLM_SAC, POOL, AMOUNT_OUT))],
    });
    expectRejected(tx, `instead of the quoted ${AMOUNT_IN}`);
  });

  it('refuses a prepared envelope whose auth tree debits nobody', () => {
    // A drain hidden behind a function name this wallet does not model: zero
    // recognised outflows with auth present is a rejection, not a pass.
    const tx = envelope({
      prepared: true,
      auth: [sourceAuth(invocation(ATTACKER_C, 'drain', [addr(SOURCE), i128(AMOUNT_IN)]))],
    });
    expectRejected(tx, 'authorises no outflow');
  });

  it('refuses a prepared envelope with no auth entries at all', () => {
    expectRejected(envelope({ prepared: true }), 'authorises nothing');
  });
});

/* ------------------------------------------- the rest of the SEP-41 surface */

describe('every SEP-41 function that moves value out of the holder', () => {
  const cases: Array<[string, xdr.SorobanAuthorizedInvocation]> = [
    // transfer_from(spender, from, to, amount), `from` is argument 1.
    [
      'transfer_from',
      invocation(XLM_SAC, 'transfer_from', [
        addr(ATTACKER_C),
        addr(SOURCE),
        addr(ATTACKER_C),
        i128(AMOUNT_IN * 2n),
      ]),
    ],
    // approve(from, spender, amount, live_until_ledger), a deferred drain.
    [
      'approve',
      invocation(XLM_SAC, 'approve', [
        addr(SOURCE),
        addr(ATTACKER_C),
        i128(AMOUNT_IN * 2n),
        u32(999_999),
      ]),
    ],
    // burn(from, amount)
    ['burn', invocation(XLM_SAC, 'burn', [addr(SOURCE), i128(AMOUNT_IN * 2n)])],
    // burn_from(spender, from, amount), `from` is argument 1.
    [
      'burn_from',
      invocation(XLM_SAC, 'burn_from', [addr(ATTACKER_C), addr(SOURCE), i128(AMOUNT_IN * 2n)]),
    ],
  ];

  it.each(cases)('recognises %s as an outflow of the signing account', (_name, inv) => {
    expectRejected(envelope({ prepared: true, auth: [sourceAuth(inv)] }), 'instead of the quoted');
  });

  it('counts an approve next to the swap transfer as a second outflow', () => {
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [
              transfer(XLM_SAC, POOL, AMOUNT_IN),
              invocation(XLM_SAC, 'approve', [
                addr(SOURCE),
                addr(ATTACKER_C),
                i128(AMOUNT_IN),
                u32(999_999),
              ]),
            ],
          ),
        ),
      ],
    });
    expectRejected(tx, 'authorises 2 outflows');
  });

  it('ignores a transfer that debits somebody else', () => {
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [transfer(XLM_SAC, POOL, AMOUNT_IN), transfer(USDC_SAC, ATTACKER_C, AMOUNT_IN, POOL)],
          ),
        ),
      ],
    });
    expect(verify(tx).source).toBe(SOURCE);
  });

  it('refuses an outflow whose amount argument is not an integer', () => {
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(XLM_SAC, 'transfer', [
            addr(SOURCE),
            addr(ATTACKER_C),
            nativeToScVal('lots', { type: 'symbol' }),
          ]),
        ),
      ],
    });
    expectRejected(tx, 'unreadable amount');
  });
});

/* ----------------------------------------------------- addresses, revisited */

describe('address handling', () => {
  it('still refuses a foreign account address anywhere in the call', () => {
    // Nested three levels deep (vec → struct map → path vec) inside the one
    // argument the wallet cannot allowlist. The positional checks all pass; if
    // the recursive scan stopped at the top level this would sail through.
    const tx = envelope({
      args: honestArgs(SELL_XLM, {
        distribution: xdr.ScVal.scvVec([
          dexDistribution([addr(XLM_SAC), addr(ATTACKER_G), addr(USDC_SAC)]),
        ]),
      }),
    });
    expectRejected(tx, ATTACKER_G);
  });

  it('refuses a muxed address, which used to be dropped silently', () => {
    // A muxed `M…` renders as its own strkey, so the `G…` loop never saw the
    // foreign account underneath it, and the old scanner discarded the value
    // entirely. Nothing in an aggregator swap needs one.
    const muxed = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeMuxedAccount(
        new xdr.MuxedEd25519Account({
          id: xdr.Uint64.fromString('42'),
          ed25519: StrKey.decodeEd25519PublicKey(ATTACKER_G),
        }),
      ),
    );
    const tx = envelope({
      args: honestArgs(SELL_XLM, {
        distribution: xdr.ScVal.scvVec([dexDistribution([addr(XLM_SAC), muxed, addr(USDC_SAC)])]),
      }),
    });
    expectRejected(tx, 'unsupported address in swap call');
  });

  it('refuses a muxed account in the recipient position outright', () => {
    const muxed = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeMuxedAccount(
        new xdr.MuxedEd25519Account({
          id: xdr.Uint64.fromString('42'),
          ed25519: StrKey.decodeEd25519PublicKey(SOURCE),
        }),
      ),
    );
    // Even the *user's own* key behind a muxed wrapper is not the signing
    // account, and `to` is compared by strkey, so this cannot be waved through.
    const tx = envelope({ args: honestArgs(SELL_XLM, { to: muxed }) });
    expectRejected(tx, 'instead of the signing account');
  });
});

/* ------------------------------------------- the proceeds side (P1) */

describe('the recipient of the proceeds', () => {
  it('refuses an entry call that pays the proceeds to an attacker contract', () => {
    // The reported bypass: real pinned aggregator, exactly one honest outflow of
    // exactly `amountIn` on the correct SAC, and `to` is the attacker's own
    // contract. Everything the outflow invariant looks at is impeccable.
    const tx = envelope({
      prepared: true,
      args: honestArgs(SELL_XLM, { to: addr(ATTACKER_C) }),
      auth: [honestAuth(XLM_SAC)],
    });
    expectRejected(tx, `directed at ${ATTACKER_C}`);
  });

  it('refuses an entry call that pays the proceeds to a foreign account', () => {
    const tx = envelope({
      prepared: true,
      args: honestArgs(SELL_XLM, { to: addr(ATTACKER_G) }),
      auth: [honestAuth(XLM_SAC)],
    });
    expectRejected(tx, ATTACKER_G);
  });

  it('refuses a recipient argument that is not an address at all', () => {
    const tx = envelope({ args: honestArgs(SELL_XLM, { to: i128(1n) }) });
    expectRejected(tx, 'not an address');
  });

  it('refuses the same trick on the AMM router, where `to` sits elsewhere', () => {
    // Argument 3 for the router, argument 5 for the aggregator: reading the
    // wrong position would have made this look honest.
    const tx = envelope({
      entry: AMM_ROUTER,
      prepared: true,
      args: honestRouterArgs({ to: addr(ATTACKER_C) }),
      auth: [honestAuth(XLM_SAC)],
    });
    expectRejected(tx, `directed at ${ATTACKER_C}`);
  });

  it('refuses proceeds denominated in a token the quote never promised', () => {
    const tx = envelope({ args: honestArgs(SELL_XLM, {}).with(1, addr(ATTACKER_C)) });
    expectRejected(tx, `pays out ${ATTACKER_C}`);
  });

  it('refuses an entry call that sells a different token than the quote', () => {
    const tx = envelope({ args: honestArgs(SELL_XLM, {}).with(0, addr(USDC_SAC)) });
    expectRejected(tx, `sells ${USDC_SAC}`);
  });

  it('refuses a router route whose last hop is not the promised token', () => {
    const tx = envelope({
      entry: AMM_ROUTER,
      args: honestRouterArgs({ path: xdr.ScVal.scvVec([addr(XLM_SAC), addr(ATTACKER_C)]) }),
    });
    expectRejected(tx, `pays out ${ATTACKER_C}`);
  });

  it('refuses a router route with fewer than two hops', () => {
    const tx = envelope({
      entry: AMM_ROUTER,
      args: honestRouterArgs({ path: xdr.ScVal.scvVec([addr(XLM_SAC)]) }),
    });
    expectRejected(tx, 'fewer than two hops');
  });

  it('refuses an entry call that spends more than the quote', () => {
    const tx = envelope({ args: honestArgs(SELL_XLM, {}).with(2, i128(AMOUNT_IN * 2n)) });
    expectRejected(tx, `instead of the quoted ${AMOUNT_IN}`);
  });

  it('refuses an entry call that lowers the guaranteed minimum', () => {
    const tx = envelope({ args: honestArgs(SELL_XLM, {}).with(3, i128(MIN_OUT - 1n)) });
    expectRejected(tx, `instead of the promised minimum ${MIN_OUT}`);
  });

  it('accepts a guaranteed minimum above the promise; that is strictly better', () => {
    const tx = envelope({
      prepared: true,
      args: honestArgs(SELL_XLM, {}).with(3, i128(MIN_OUT + 1n)),
      auth: [honestAuth(XLM_SAC)],
    });
    expect(verify(tx).source).toBe(SOURCE);
  });
});

describe('the entry function itself is a positive list', () => {
  it('refuses a function name the pinned signature does not cover', () => {
    // The wallet only ever asks for EXACT_IN, so this is the only entry call a
    // quote of ours can produce. Anything else means we do not know where `to`
    // sits, and "we do not know" must not read as "it is fine".
    const tx = envelope({
      functionName: 'swap_tokens_for_exact_tokens',
      args: honestArgs(),
    });
    expectRejected(tx, 'not as the quoted swap_exact_tokens_for_tokens');
  });

  it('refuses an argument count that is not the pinned signature', () => {
    const tx = envelope({ args: honestArgs().slice(0, 4) });
    expectRejected(tx, 'takes 7 arguments');
  });

  it('refuses an administrative call on the pinned contract', () => {
    const tx = envelope({ functionName: 'set_pause', args: [sym('Soroswap'), u32(1)] });
    expectRejected(tx, 'is called as set_pause');
  });
});

/* --------------------------------------------------- P3: allowance ≠ payment */

describe('an allowance never pays for a swap', () => {
  it('refuses approve(user, attacker, amountIn) as the only authorised outflow', () => {
    // Word for word the invariant: exactly one outflow, correct SAC, exactly
    // `amountIn`. It still moves nothing; it hands the attacker the right to
    // take the tokens later, and the swap never happens.
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(XLM_SAC, 'approve', [
            addr(SOURCE),
            addr(ATTACKER_C),
            i128(AMOUNT_IN),
            u32(999_999),
          ]),
        ),
      ],
    });
    expectRejected(tx, 'authorises approve, not a transfer');
  });

  it('refuses a correctly sized burn as the only authorised outflow', () => {
    const tx = envelope({
      prepared: true,
      auth: [sourceAuth(invocation(XLM_SAC, 'burn', [addr(SOURCE), i128(AMOUNT_IN)]))],
    });
    expectRejected(tx, 'authorises burn, not a transfer');
  });

  it('refuses a correctly sized transfer_from as the only authorised outflow', () => {
    // Spending an allowance the wallet never granted is not this swap either.
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(XLM_SAC, 'transfer_from', [
            addr(ATTACKER_C),
            addr(SOURCE),
            addr(POOL),
            i128(AMOUNT_IN),
          ]),
        ),
      ],
    });
    expectRejected(tx, 'authorises transfer_from, not a transfer');
  });
});

/* ------------------------------- P4: unmodelled functions on a quoted token */

describe('only transfer may touch a quoted token on our behalf', () => {
  const strays: Array<[string, xdr.ScVal[]]> = [
    ['set_authorized', [addr(SOURCE), addr(SOURCE), xdr.ScVal.scvBool(false)]],
    ['clawback', [addr(SOURCE), i128(AMOUNT_IN)]],
    ['set_admin', [addr(ATTACKER_C), addr(SOURCE)]],
    ['mint', [addr(SOURCE), i128(AMOUNT_IN)]],
    ['drain_it_all', [addr(SOURCE)]],
  ];

  it.each(strays)('refuses %s riding along next to an honest transfer', (name, args) => {
    // The old rule only fired when there was *no* recognised outflow at all, so
    // an honest transfer made anything unmodelled next to it invisible.
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [transfer(XLM_SAC, POOL, AMOUNT_IN), invocation(XLM_SAC, name, args)],
          ),
        ),
      ],
    });
    expectRejected(tx, `authorises ${name} on the token contract ${XLM_SAC}`);
  });

  it('refuses an unmodelled call on the SAC of the asset being bought, too', () => {
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [
              transfer(XLM_SAC, POOL, AMOUNT_IN),
              invocation(USDC_SAC, 'clawback', [addr(SOURCE), i128(AMOUNT_IN)]),
            ],
          ),
        ),
      ],
    });
    expectRejected(tx, `authorises clawback on the token contract ${USDC_SAC}`);
  });

  it('leaves an adapter approving a pool out of its own balance alone', () => {
    // The positive list is scoped to calls that name *us*. Mid-route plumbing
    // between adapter and pool is none of our business, and refusing it would
    // break real routes.
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [
              transfer(XLM_SAC, POOL, AMOUNT_IN),
              invocation(XLM_SAC, 'approve', [addr(POOL), addr(ATTACKER_C), i128(1n), u32(9)]),
            ],
          ),
        ),
      ],
    });
    expect(verify(tx).source).toBe(SOURCE);
  });
});

/* ------------------------------------------------- what is NOT covered yet */

describe('documented residual gap', () => {
  it('does NOT catch a single, correctly sized outflow sent to an unknown contract', () => {
    // This pins a known blind spot rather than a guarantee. The invariant fixes
    // the *token* and the *amount* of what leaves the account, deliberately not
    // the recipient of the debit: pools and adapters are route-dependent, and
    // `/quote` comes from the very server we are defending against, so there is
    // no independent source for "who may receive this".
    //
    // What has changed is the other side. The entry call is pinned by contract,
    // function, `to`, both tokens and both amounts, and the pinned aggregator
    // itself measures `to`'s `token_out` balance across the whole distribution
    // and reverts below `amount_out_min`. So this envelope can only *execute*
    // if the user still receives the promised minimum of the promised asset;
    // what stays unverifiable off-chain is the path the input takes on the way.
    // Closing even that needs on-chain simulation of the balance delta; see the
    // report.
    const tx = envelope({
      prepared: true,
      auth: [
        sourceAuth(
          invocation(
            AGGREGATOR,
            'swap_exact_tokens_for_tokens',
            [],
            [transfer(XLM_SAC, ATTACKER_C, AMOUNT_IN)],
          ),
        ),
      ],
    });
    expect(verify(tx).source).toBe(SOURCE);
  });
});
