import { describe, expect, it } from 'vitest';
import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import {
  HIGH_FEE_FACTOR,
  describeOperations,
  describeTransaction,
  highestSeverity,
  type DescribeContext,
  type SdkOperation,
  type WarningCode,
} from '../src/core/stellar/tx-describe';
import { translate } from '../src/i18n';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const DEST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ISSUER = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';
const USDC = new Asset('USDC', ISSUER);
const EURC = new Asset('EURC', ISSUER);

const baseCtx: DescribeContext = {
  networkPassphrase: Networks.TESTNET,
  networkName: 'testnet',
  accountId: SOURCE,
  currentSequence: '100',
  trustedIssuers: [ISSUER],
};

function build(
  ops: xdr.Operation[],
  opts?: { sequence?: string; memo?: Memo; fee?: string },
): string {
  const account = new Account(SOURCE, opts?.sequence ?? '100');
  let builder = new TransactionBuilder(account, {
    fee: opts?.fee ?? '100',
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(180);
  for (const op of ops) builder = builder.addOperation(op);
  if (opts?.memo) builder = builder.addMemo(opts.memo);
  return builder.build().toXDR();
}

function codes(warnings: readonly { code: WarningCode }[]): WarningCode[] {
  return warnings.map((w) => w.code);
}

describe('describeTransaction: metadata', () => {
  it('extracts source, fee, sequence, memo and operation count', () => {
    const xdrStr = build(
      [Operation.payment({ destination: DEST, asset: Asset.native(), amount: '12.5' })],
      { memo: Memo.text('rent'), fee: '250' },
    );
    const d = describeTransaction(xdrStr, baseCtx);
    expect(d.meta.source).toBe(SOURCE);
    expect(d.meta.feeStroops).toBe('250');
    expect(d.meta.feeXlm).toBe('0.000025');
    expect(d.meta.sequence).toBe('101');
    expect(d.meta.operationCount).toBe(1);
    expect(d.meta.memo).toEqual({ type: 'text', value: 'rent' });
    expect(d.meta.isFeeBump).toBe(false);
    expect(d.raw).toBe(xdrStr);
    expect(d.translatable).toBe(true);
  });

  it('reports no memo as null', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      baseCtx,
    );
    expect(d.meta.memo).toBeNull();
  });

  it('is fail-closed on a malformed envelope and never throws', () => {
    const d = describeTransaction('not-a-valid-xdr', baseCtx);
    expect(d.translatable).toBe(false);
    expect(codes(d.warnings)).toContain('UNPARSEABLE_TRANSACTION');
    expect(d.summary.key).toBe('tx.summary.unparseable');
    expect(d.effects).toHaveLength(0);
  });

  it('describes a fee-bump transaction via its inner transaction', () => {
    const inner = TransactionBuilder.fromXDR(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      Networks.TESTNET,
    );
    const kp = Keypair.random();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      kp.publicKey(),
      '2000',
      inner as never,
      Networks.TESTNET,
    );
    const d = describeTransaction(feeBump.toXDR(), baseCtx);
    expect(d.meta.isFeeBump).toBe(true);
    expect(d.summary.key).toBe('tx.summary.feeBump');
    expect(d.effects).toHaveLength(1);
    expect(d.effects[0]?.opType).toBe('payment');
  });
});

describe('describeTransaction: per-operation plain language', () => {
  it('payment', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '10' })]),
      baseCtx,
    );
    expect(d.effects[0]?.message).toEqual({
      key: 'tx.op.payment',
      // 12+12, not 4+4: a four-character preview is within reach of a vanity
      // key generator, and this is the line the user checks the recipient on.
      params: {
        amount: '10.0000000',
        asset: 'XLM',
        destination: 'GBAW5XGWORWV…Q562Q2W2GJQX',
      },
    });
    expect(d.warnings).toHaveLength(0);
    expect(d.summary.key).toBe('tx.op.payment');
  });

  it('createAccount', () => {
    const d = describeTransaction(
      build([Operation.createAccount({ destination: DEST, startingBalance: '5' })]),
      baseCtx,
    );
    expect(d.effects[0]?.opType).toBe('createAccount');
    expect(d.effects[0]?.message.key).toBe('tx.op.createAccount');
  });

  it('changeTrust (add)', () => {
    const d = describeTransaction(
      build([Operation.changeTrust({ asset: USDC, limit: '1000' })]),
      baseCtx,
    );
    expect(d.effects[0]?.message.key).toBe('tx.op.changeTrust.add');
    expect(codes(d.warnings)).not.toContain('TRUSTLINE_REMOVAL');
  });

  it('manageSellOffer', () => {
    const d = describeTransaction(
      build([
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: USDC,
          amount: '100',
          price: '0.5',
        }),
      ]),
      baseCtx,
    );
    expect(d.effects[0]?.message.key).toBe('tx.op.manageSellOffer');
  });

  it('manageBuyOffer', () => {
    const d = describeTransaction(
      build([
        Operation.manageBuyOffer({
          selling: Asset.native(),
          buying: USDC,
          buyAmount: '100',
          price: '0.5',
        }),
      ]),
      baseCtx,
    );
    expect(d.effects[0]?.message.key).toBe('tx.op.manageBuyOffer');
  });

  it('createPassiveSellOffer', () => {
    const d = describeTransaction(
      build([
        Operation.createPassiveSellOffer({
          selling: Asset.native(),
          buying: USDC,
          amount: '1',
          price: '1',
        }),
      ]),
      baseCtx,
    );
    expect(d.effects[0]?.message.key).toBe('tx.op.createPassiveSellOffer');
  });

  it('manageData', () => {
    const d = describeTransaction(
      build([Operation.manageData({ name: 'config', value: 'x' })]),
      baseCtx,
    );
    // The action is emitted as a term key, not as the raw English word, so
    // the German line reads "Datenfeld config setzen" and not "… config set".
    expect(d.effects[0]?.message).toEqual({
      key: 'tx.op.manageData',
      params: { name: 'config', action: 'tx.term.manageData.set' },
    });
    const message = d.effects[0]?.message;
    expect(translate('de', message?.key ?? '', message?.params)).toBe('Datenfeld config setzen');
    expect(translate('en', message?.key ?? '', message?.params)).toBe('Set the data field config');
  });

  it('bumpSequence', () => {
    const d = describeTransaction(
      build([Operation.bumpSequence({ bumpTo: '5000' })]),
      baseCtx,
    );
    expect(d.effects[0]?.message.key).toBe('tx.op.bumpSequence');
  });

  it('createClaimableBalance and claimClaimableBalance', () => {
    const create = describeTransaction(
      build([
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: '3',
          claimants: [new Claimant(DEST)],
        }),
      ]),
      baseCtx,
    );
    expect(create.effects[0]?.message.key).toBe('tx.op.createClaimableBalance');

    const claim = describeTransaction(
      build([
        Operation.claimClaimableBalance({
          balanceId:
            '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be',
        }),
      ]),
      baseCtx,
    );
    expect(claim.effects[0]?.message.key).toBe('tx.op.claimClaimableBalance');
  });

  it('sponsorship begin/end and revoke', () => {
    const d = describeTransaction(
      build([
        Operation.beginSponsoringFutureReserves({ sponsoredId: DEST }),
        Operation.endSponsoringFutureReserves({}),
        Operation.revokeAccountSponsorship({ account: DEST }),
      ]),
      baseCtx,
    );
    expect(d.effects.map((e) => e.message.key)).toEqual([
      'tx.op.beginSponsoringFutureReserves',
      'tx.op.endSponsoringFutureReserves',
      'tx.op.revokeSponsorship',
    ]);
    expect(d.summary).toEqual({ key: 'tx.summary.multi', params: { count: 3 } });
  });

  it('clawback and setTrustLineFlags', () => {
    const d = describeTransaction(
      build([
        Operation.clawback({ asset: USDC, amount: '1', from: DEST }),
        Operation.setTrustLineFlags({
          trustor: DEST,
          asset: USDC,
          flags: { authorized: true },
        }),
      ]),
      baseCtx,
    );
    expect(d.effects.map((e) => e.message.key)).toEqual([
      'tx.op.clawback',
      'tx.op.setTrustLineFlags',
    ]);
  });

  it('liquidity pool deposit and withdraw', () => {
    const poolId = 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7';
    const d = describeTransaction(
      build([
        Operation.liquidityPoolDeposit({
          liquidityPoolId: poolId,
          maxAmountA: '10',
          maxAmountB: '20',
          minPrice: '0.4',
          maxPrice: '0.6',
        }),
        Operation.liquidityPoolWithdraw({
          liquidityPoolId: poolId,
          amount: '5',
          minAmountA: '1',
          minAmountB: '2',
        }),
      ]),
      baseCtx,
    );
    expect(d.effects.map((e) => e.message.key)).toEqual([
      'tx.op.liquidityPoolDeposit',
      'tx.op.liquidityPoolWithdraw',
    ]);
  });

  it('allowTrust', () => {
    const d = describeTransaction(
      build([Operation.allowTrust({ trustor: DEST, assetCode: 'USDC', authorize: true })]),
      baseCtx,
    );
    expect(d.effects[0]?.message.key).toBe('tx.op.allowTrust');
  });
});

describe('describeTransaction: required warnings (§5)', () => {
  it('warns when SET_OPTIONS changes a signer', () => {
    const d = describeTransaction(
      build([
        Operation.setOptions({ signer: { ed25519PublicKey: DEST, weight: 1 } }),
      ]),
      baseCtx,
    );
    expect(codes(d.warnings)).toContain('SIGNER_OR_THRESHOLD_CHANGE');
    expect(highestSeverity(d)).toBe('danger');
  });

  it('warns when SET_OPTIONS changes thresholds', () => {
    const d = describeTransaction(
      build([Operation.setOptions({ medThreshold: 2, highThreshold: 3 })]),
      baseCtx,
    );
    expect(codes(d.warnings)).toContain('SIGNER_OR_THRESHOLD_CHANGE');
  });

  it('does not warn for a harmless SET_OPTIONS home domain change', () => {
    const d = describeTransaction(
      build([Operation.setOptions({ homeDomain: 'example.org' })]),
      baseCtx,
    );
    expect(codes(d.warnings)).not.toContain('SIGNER_OR_THRESHOLD_CHANGE');
    expect(d.effects[0]?.message.params?.fields).toBe('tx.term.setOptions.homeDomain');
    const setOptions = d.effects[0]?.message;
    expect(translate('de', setOptions?.key ?? '', setOptions?.params)).toBe(
      'Kontoeinstellungen ändern (Webadresse des Kontos)',
    );
  });

  it('warns on CHANGE_TRUST with limit 0 (trustline removal)', () => {
    const d = describeTransaction(
      build([Operation.changeTrust({ asset: USDC, limit: '0' })]),
      baseCtx,
    );
    expect(codes(d.warnings)).toContain('TRUSTLINE_REMOVAL');
    expect(d.effects[0]?.message.key).toBe('tx.op.changeTrust.remove');
  });

  it('warns on ACCOUNT_MERGE', () => {
    const d = describeTransaction(
      build([Operation.accountMerge({ destination: DEST })]),
      baseCtx,
    );
    expect(codes(d.warnings)).toContain('ACCOUNT_MERGE');
    expect(highestSeverity(d)).toBe('danger');
  });

  it('warns on path payment with more than 2 % slippage', () => {
    const d = describeTransaction(
      build([
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '100',
          destination: DEST,
          destAsset: USDC,
          destMin: '90',
          path: [],
        }),
      ]),
      { ...baseCtx, pathPaymentQuotes: [{ opIndex: 0, expectedDestAmount: '100' }] },
    );
    expect(codes(d.warnings)).toContain('HIGH_SLIPPAGE');
    const w = d.warnings.find((x) => x.code === 'HIGH_SLIPPAGE');
    expect(w?.message.params?.percent).toBe('10.00');
  });

  it('does not warn below the slippage threshold', () => {
    const d = describeTransaction(
      build([
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '100',
          destination: DEST,
          destAsset: USDC,
          destMin: '99',
          path: [],
        }),
      ]),
      { ...baseCtx, pathPaymentQuotes: [{ opIndex: 0, expectedDestAmount: '100' }] },
    );
    expect(codes(d.warnings)).not.toContain('HIGH_SLIPPAGE');
  });

  it('warns on strict-receive slippage above the threshold', () => {
    const d = describeTransaction(
      build([
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: '120',
          destination: DEST,
          destAsset: USDC,
          destAmount: '100',
          path: [],
        }),
      ]),
      { ...baseCtx, pathPaymentQuotes: [{ opIndex: 0, expectedSendAmount: '100' }] },
    );
    expect(codes(d.warnings)).toContain('HIGH_SLIPPAGE');
  });

  it('flags slippage as unknown when no quote is available', () => {
    const d = describeTransaction(
      build([
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '100',
          destination: DEST,
          destAsset: USDC,
          destMin: '90',
          path: [],
        }),
      ]),
      baseCtx,
    );
    expect(codes(d.warnings)).toContain('SLIPPAGE_UNKNOWN');
  });

  it('warns about an unknown asset issuer', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: EURC, amount: '1' })]),
      { ...baseCtx, trustedIssuers: [] },
    );
    expect(codes(d.warnings)).toContain('UNKNOWN_ISSUER');
  });

  it('accepts an issuer that is already trusted via knownAssets', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: EURC, amount: '1' })]),
      { ...baseCtx, trustedIssuers: [], knownAssets: [`EURC:${ISSUER}`] },
    );
    expect(codes(d.warnings)).not.toContain('UNKNOWN_ISSUER');
  });

  it('never warns about the native asset issuer', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, trustedIssuers: [] },
    );
    expect(codes(d.warnings)).not.toContain('UNKNOWN_ISSUER');
  });

  it('warns about the reserve when createAccount funds a new account', () => {
    // §5's beginner case: the send flow turns a payment to an unfunded address
    // into createAccount, so the warning has to fire on *that* branch.
    const d = describeTransaction(
      build([Operation.createAccount({ destination: DEST, startingBalance: '5' })]),
      { ...baseCtx, accountExists: { [DEST]: false } },
    );
    expect(codes(d.warnings)).toContain('DESTINATION_NOT_FUNDED');
    const warning = d.warnings.find((w) => w.code === 'DESTINATION_NOT_FUNDED');
    expect(warning?.message.key).toBe('tx.warn.DESTINATION_NOT_FUNDED');
    for (const locale of ['de', 'en'] as const) {
      const text = translate(locale, warning?.message.key ?? '', warning?.message.params);
      expect(text).not.toContain('{');
      expect(text.toLowerCase()).toContain(locale === 'de' ? 'reservierter' : 'reserved');
    }
  });

  it('tells a plain payment to an unfunded account that it will not arrive', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, accountExists: { [DEST]: false } },
    );
    const warning = d.warnings.find((w) => w.code === 'DESTINATION_NOT_FUNDED');
    // A payment does not create anything, so it must not claim that it does.
    expect(warning?.message.key).toBe('tx.warn.DESTINATION_NOT_FUNDED.unreachable');
  });

  it('warns when the destination account does not exist yet', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, accountExists: { [DEST]: false } },
    );
    expect(codes(d.warnings)).toContain('DESTINATION_NOT_FUNDED');
  });

  it('stays quiet when the destination is known to exist', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, accountExists: { [DEST]: true } },
    );
    expect(codes(d.warnings)).not.toContain('DESTINATION_NOT_FUNDED');
  });

  it('warns on a sequence jump', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })], {
        sequence: '500',
      }),
      baseCtx, // currentSequence 100 -> expects 101, gets 501
    );
    expect(codes(d.warnings)).toContain('SEQUENCE_GAP');
    const w = d.warnings.find((x) => x.code === 'SEQUENCE_GAP');
    expect(w?.message.params).toEqual({ expected: '101', actual: '501' });
  });

  it('does not warn on a contiguous sequence', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      baseCtx,
    );
    expect(codes(d.warnings)).not.toContain('SEQUENCE_GAP');
  });

  it('warns on a network passphrase mismatch', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, declaredNetworkPassphrase: Networks.PUBLIC },
    );
    // The envelope carries no passphrase, so a mismatch is only detectable
    // against what the requesting dApp declared.
    expect(codes(d.warnings)).toContain('NETWORK_MISMATCH');
    // …and the network is named in the user's language, not as "testnet".
    const warning = d.warnings.find((w) => w.code === 'NETWORK_MISMATCH');
    expect(warning?.message.params?.expected).toBe('settings.network.testnet');
    expect(translate('de', warning?.message.key ?? '', warning?.message.params)).toContain(
      'Testnetzwerk',
    );
    expect(translate('en', warning?.message.key ?? '', warning?.message.params)).toContain(
      'Test network',
    );
  });

  it('stays quiet when the declared network matches', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, declaredNetworkPassphrase: Networks.TESTNET },
    );
    expect(codes(d.warnings)).not.toContain('NETWORK_MISMATCH');
  });

  it('warns when the source account is not ours', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, accountId: DEST },
    );
    expect(codes(d.warnings)).toContain('FOREIGN_SOURCE_ACCOUNT');
  });

  it('warns that real funds are at stake on mainnet', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      { ...baseCtx, isMainnet: true },
    );
    expect(codes(d.warnings)).toContain('MAINNET_REAL_FUNDS');
  });

  it('flags Soroban host function invocations', () => {
    const contractId = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: 'hello',
      args: [],
    });
    const d = describeTransaction(build([op]), baseCtx);
    expect(codes(d.warnings)).toContain('SOROBAN_INVOCATION');
    expect(d.effects[0]?.message.key).toBe('tx.op.invokeHostFunction');
  });
});

describe('describeTransaction: fail-closed on unknown operations', () => {
  it('handles the inflation operation, which the network no longer accepts', () => {
    const d = describeTransaction(build([Operation.inflation({})]), baseCtx);
    expect(d.effects[0]?.message.key).toBe('tx.op.inflation');
    expect(d.translatable).toBe(true);
  });

  it('produces UNTRANSLATABLE_OPERATION for an operation type outside our switch', () => {
    // Stands in for a future protocol operation the current SDK cannot decode.
    const synthetic = { type: 'someFutureProtocolOp' } as unknown as SdkOperation;
    const result = describeOperations([synthetic], baseCtx);
    expect(result.translatable).toBe(false);
    expect(result.effects[0]?.opType).toBe('unknown');
    expect(result.warnings.map((w) => w.code)).toContain('UNTRANSLATABLE_OPERATION');
    expect(result.warnings[0]?.severity).toBe('danger');
    expect(result.warnings[0]?.message.params?.type).toBe('someFutureProtocolOp');
  });

  it('keeps known operations translatable while flagging only the unknown one', () => {
    const known = TransactionBuilder.fromXDR(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      Networks.TESTNET,
    ) as Transaction;
    const synthetic = { type: 'someFutureProtocolOp' } as unknown as SdkOperation;
    const result = describeOperations([...known.operations, synthetic], baseCtx);
    expect(result.translatable).toBe(false);
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.opType).toBe('payment');
    expect(result.effects[1]?.opType).toBe('unknown');
    expect(
      result.warnings.filter((w) => w.code === 'UNTRANSLATABLE_OPERATION'),
    ).toHaveLength(1);
  });
});

describe('describeTransaction: summaries', () => {
  it('uses the single operation message as the summary', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      baseCtx,
    );
    expect(d.summary.key).toBe('tx.op.payment');
  });

  it('uses a counted summary for multi-operation transactions', () => {
    const d = describeTransaction(
      build([
        Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' }),
        Operation.payment({ destination: DEST, asset: Asset.native(), amount: '2' }),
      ]),
      baseCtx,
    );
    expect(d.summary).toEqual({ key: 'tx.summary.multi', params: { count: 2 } });
  });

  it('ranks severities', () => {
    const clean = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })]),
      baseCtx,
    );
    expect(highestSeverity(clean)).toBeNull();

    const merged = describeTransaction(
      build([Operation.accountMerge({ destination: DEST })]),
      baseCtx,
    );
    expect(highestSeverity(merged)).toBe('danger');
  });
});

/**
 * The fee warning (task 2b).
 *
 * The number the confirmation shows is an *upper bound*: during a surge the
 * wallet bids `SURGE_HEADROOM` × the observed clearing price, and Stellar then
 * charges every transaction in the ledger the same market price. A bound the
 * user cannot judge is worth a sentence, and the same check catches the other
 * source of a large fee, a developer-mode override with three zeros too many.
 */
describe('describeTransaction: HIGH_FEE', () => {
  it('stays quiet for the everyday envelope this wallet builds', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })], {
        fee: '100',
      }),
      baseCtx,
    );
    expect(codes(d.warnings)).not.toContain('HIGH_FEE');
  });

  it('stays quiet just below the threshold and warns at it', () => {
    const at = (fee: string): WarningCode[] =>
      codes(
        describeTransaction(
          build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })], {
            fee,
          }),
          baseCtx,
        ).warnings,
      );
    expect(at('999')).not.toContain('HIGH_FEE');
    expect(at(String(100 * HIGH_FEE_FACTOR))).toContain('HIGH_FEE');
  });

  it('names the amount and the factor, and warns rather than blocks', () => {
    const d = describeTransaction(
      build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' })], {
        fee: '100000',
      }),
      baseCtx,
    );
    const warning = d.warnings.find((w) => w.code === 'HIGH_FEE');
    expect(warning?.severity).toBe('warn');
    expect(warning?.message.params).toMatchObject({ feeXlm: '0.01', factor: 1000 });
    // A costly transaction is still a transaction the user may confirm.
    expect(d.translatable).toBe(true);
    for (const locale of ['de', 'en'] as const) {
      const text = translate(locale, 'tx.warn.HIGH_FEE', warning?.message.params);
      expect(text).not.toContain('{');
      expect(text).toContain('0.01');
    }
  });

  /**
   * Measured per operation: a 20-operation envelope at `BASE_FEE` each is a
   * perfectly ordinary transaction that happens to have a large total.
   */
  it('measures per operation, not per envelope', () => {
    const ops = Array.from({ length: 20 }, () =>
      Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1' }),
    );
    const d = describeTransaction(build(ops, { fee: '100' }), baseCtx);
    expect(d.meta.feeStroops).toBe('2000');
    expect(d.meta.feePerOperationStroops).toBe('100');
    expect(codes(d.warnings)).not.toContain('HIGH_FEE');
  });
});
