/**
 * Plain-language transaction preview, ARCHITECTURE.md §5.
 *
 * Pure function, no network side effects: everything the description depends on
 * (does the destination exist? which issuers do we trust? what is the current
 * sequence?) is handed in through {@link DescribeContext}. That keeps the whole
 * module unit-testable and makes the confirmation dialog deterministic.
 *
 * Fail-closed rule: an operation we cannot translate produces an explicit
 * warning ("we cannot translate this operation into plain language") and flips
 * `translatable` to false, never a silent pass-through.
 */
import {
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  type Memo,
  type MemoType,
} from '@stellar/stellar-sdk';

/**
 * The discriminated union of *decoded* operations. `Operation` at the package
 * root is the builder namespace, so the union is taken from where it is
 * actually produced.
 */
export type SdkOperation = Transaction['operations'][number];

/** A translation key plus its interpolation parameters. */
export interface I18nMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export const WARNING_CODES = [
  'SIGNER_OR_THRESHOLD_CHANGE',
  'TRUSTLINE_REMOVAL',
  'ACCOUNT_MERGE',
  'HIGH_SLIPPAGE',
  'SLIPPAGE_UNKNOWN',
  'UNKNOWN_ISSUER',
  'DESTINATION_NOT_FUNDED',
  'SEQUENCE_GAP',
  'UNTRANSLATABLE_OPERATION',
  'UNPARSEABLE_TRANSACTION',
  'NETWORK_MISMATCH',
  'FOREIGN_SOURCE_ACCOUNT',
  'SOROBAN_INVOCATION',
  'MAINNET_REAL_FUNDS',
  'MEMO_REQUIRED',
  'HIGH_FEE',
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export type Severity = 'info' | 'warn' | 'danger';

export interface Warning {
  readonly code: WarningCode;
  readonly severity: Severity;
  readonly message: I18nMessage;
  /** Index of the operation that triggered it, if operation-scoped. */
  readonly opIndex?: number;
}

export interface Effect {
  readonly opIndex: number;
  /** SDK operation type, or `unknown` when we could not translate it. */
  readonly opType: string;
  readonly message: I18nMessage;
}

export interface TxMeta {
  readonly network: string;
  readonly networkName: string;
  readonly source: string;
  /**
   * The envelope's own fee field: the **total** for the transaction, i.e.
   * per-operation fee × operation count (plus the resource fee on a Soroban
   * envelope). This is the number the confirmation dialog renders as
   * `confirm.feeMax`. It is an *upper bound*, not a price: Stellar charges
   * every transaction in a ledger the same market-clearing price, so what the
   * user pays is at most this, which is why the label says so.
   */
  readonly feeStroops: string;
  readonly feeXlm: string;
  /**
   * `feeStroops / operationCount`; the quantity `TransactionBuilder({ fee })`
   * takes and the quantity the wallet's fee ceiling
   * (`MAX_FEE_PER_OPERATION_STROOPS`) is expressed in. Published so the two
   * cannot be confused with each other; for the single-operation envelopes
   * this wallet builds it equals `feeStroops`. On a Soroban envelope it is
   * *not* a per-operation inclusion fee; the resource fee is baked into the
   * total, which is exactly why the wallet does not price those itself.
   */
  readonly feePerOperationStroops: string;
  readonly sequence: string;
  readonly operationCount: number;
  readonly memo: { readonly type: string; readonly value: string } | null;
  readonly timeBounds: { readonly minTime: string; readonly maxTime: string } | null;
  readonly isFeeBump: boolean;
}

export interface TxDescription {
  readonly summary: I18nMessage;
  readonly effects: readonly Effect[];
  readonly warnings: readonly Warning[];
  /** Original base64 XDR, shown in the developer-mode disclosure (§4). */
  readonly raw: string;
  readonly meta: TxMeta;
  /** False when at least one operation could not be rendered in plain language. */
  readonly translatable: boolean;
}

/** Slippage quote the wallet obtained itself, per operation index. */
export interface PathPaymentQuote {
  readonly opIndex: number;
  /** Destination amount the path finder expected, in units. */
  readonly expectedDestAmount?: string;
  /** Send amount the path finder expected, in units. */
  readonly expectedSendAmount?: string;
}

export interface DescribeContext {
  readonly networkPassphrase: string;
  /** Human name of the configured network, e.g. "testnet". */
  readonly networkName?: string;
  /** Account we are about to sign with. */
  readonly accountId?: string;
  /** Issuer account ids the user already trusts. */
  readonly trustedIssuers?: readonly string[];
  /** Assets the account already holds, as `native` or `CODE:ISSUER`. */
  readonly knownAssets?: readonly string[];
  /** Known existence of accounts referenced by the transaction. */
  readonly accountExists?: Readonly<Record<string, boolean>>;
  /** Accounts carrying the SEP-29 `config.memo_required` flag. */
  readonly memoRequiredAccounts?: readonly string[];
  /** Current on-chain sequence of the source account. */
  readonly currentSequence?: string;
  /** Slippage tolerance as a fraction. §5 requires a warning above 2 %. */
  readonly slippageThreshold?: number;
  readonly pathPaymentQuotes?: readonly PathPaymentQuote[];
  readonly isMainnet?: boolean;
  /**
   * Network passphrase the *requester* claims this envelope is for (a dApp via
   * `dapp.signXdr`). The envelope itself does not carry one, so a mismatch can
   * only be detected against a declared value.
   */
  readonly declaredNetworkPassphrase?: string;
}

const DEFAULT_SLIPPAGE_THRESHOLD = 0.02;
const STROOPS_PER_XLM = 10_000_000;

export function assetId(asset: Asset): string {
  return asset.isNative() ? 'native' : `${asset.getCode() ?? ''}:${asset.getIssuer() ?? ''}`;
}

export function assetLabel(asset: Asset): string {
  return asset.isNative() ? 'XLM' : (asset.getCode() ?? '');
}

function isAsset(value: unknown): value is Asset {
  return value instanceof Asset;
}

/**
 * Undo the multiplication `TransactionBuilder.build()` performs
 * (`fee × operations.length`). Integer division on purpose, an envelope built
 * by someone else may carry a total that is not a multiple of its operation
 * count, and rounding *down* keeps this a lower bound rather than a claim.
 */
/**
 * Multiple of `BASE_FEE` at which the fee stops being background noise and
 * becomes something to look at.
 *
 * Ten is not arbitrary: it is the same factor `horizon.ts` already uses for
 * `SURGE_NOTICE_FACTOR`, i.e. the point at which the wallet itself considers
 * its own choice remarkable, 1000 stroops, 0.0001 XLM. Below that sits every
 * calm-market envelope this wallet builds (100 stroops) and the whole ordinary
 * range of `/fee_stats`. Above it sit two things worth a sentence: a genuine
 * surge, and a developer-mode override with too many zeros. Severity `warn`,
 * not `danger`: a high fee is money lost, not a stolen account, and the
 * confirmation must keep `danger` for what can actually cost the balance.
 *
 * The check runs on the *envelope*, so it covers the fee whoever chose it,
 * the strategy, a manual override, or a dApp that built the transaction.
 */
export const HIGH_FEE_FACTOR = 10;

function perOperationFee(totalStroops: string, operationCount: number): string {
  if (operationCount <= 0) return totalStroops;
  try {
    return (BigInt(totalStroops) / BigInt(operationCount)).toString();
  } catch {
    return totalStroops;
  }
}

function stroopsToXlm(stroops: string): string {
  const n = Number(stroops);
  if (!Number.isFinite(n)) return stroops;
  return (n / STROOPS_PER_XLM).toFixed(7).replace(/0+$/u, '').replace(/\.$/u, '');
}

/**
 * Truncation for the confirmation dialog. Four leading characters (one of which
 * is always `G`) plus four trailing ones leave about 35 bits, a vanity-key
 * generator collides with that in roughly an hour on one GPU, which is exactly
 * the check a user performs against a clipboard-swapping attacker. Twelve and
 * twelve leaves ~110 bits and still fits the 360 px popup when wrapped.
 */
const ADDRESS_PREFIX = 12;
const ADDRESS_SUFFIX = 12;

function shortAddress(address: string): string {
  if (address.length <= ADDRESS_PREFIX + ADDRESS_SUFFIX + 1) return address;
  return `${address.slice(0, ADDRESS_PREFIX)}…${address.slice(-ADDRESS_SUFFIX)}`;
}

/**
 * Separator for a parameter that carries a *list* of term keys.
 * Mirrors `TERM_LIST_SEPARATOR` in `src/i18n`; duplicated rather than imported
 * so `core/` keeps no dependency on the UI layer.
 */
const TERM_LIST_SEPARATOR = '\u001f';

/**
 * `core/` must not contain user-visible prose (§8). Where an operation line
 * needs a technical distinction inside a sentence ("set" vs. "delete", which
 * account setting was touched, which network), the describer emits an i18n key
 * as the parameter value and the renderer resolves it. Interpolating the raw
 * SDK identifier instead is what produced "Datenfeld config set" and
 * "…als dem eingestellten (testnet)".
 */
function termList(keys: readonly string[]): string {
  return keys.join(TERM_LIST_SEPARATOR);
}

/** Known network ids get their translated name; anything else stays verbatim. */
function networkTerm(name: string | undefined, fallback: string): string {
  const id = name ?? '';
  return (['testnet', 'futurenet', 'mainnet', 'custom'] as const).includes(
    id as 'testnet' | 'futurenet' | 'mainnet' | 'custom',
  )
    ? `settings.network.${id}`
    : (name ?? fallback);
}

class DescriptionBuilder {
  readonly effects: Effect[] = [];
  readonly warnings: Warning[] = [];
  private readonly seenWarnings = new Set<string>();
  translatable = true;

  effect(opIndex: number, opType: string, key: string, params?: I18nMessage['params']): void {
    this.effects.push({
      opIndex,
      opType,
      message: params === undefined ? { key } : { key, params },
    });
  }

  warn(
    code: WarningCode,
    severity: Severity,
    key: string,
    params?: I18nMessage['params'],
    opIndex?: number,
  ): void {
    const dedupeKey = `${code}|${opIndex ?? '-'}|${JSON.stringify(params ?? {})}`;
    if (this.seenWarnings.has(dedupeKey)) return;
    this.seenWarnings.add(dedupeKey);
    const message: I18nMessage = params === undefined ? { key } : { key, params };
    this.warnings.push(
      opIndex === undefined
        ? { code, severity, message }
        : { code, severity, message, opIndex },
    );
  }
}

function checkIssuer(
  b: DescriptionBuilder,
  ctx: DescribeContext,
  asset: Asset,
  opIndex: number,
): void {
  if (asset.isNative()) return;
  const issuer = asset.getIssuer() ?? '';
  const id = assetId(asset);
  const trusted =
    (ctx.trustedIssuers?.includes(issuer) ?? false) || (ctx.knownAssets?.includes(id) ?? false);
  if (!trusted) {
    b.warn(
      'UNKNOWN_ISSUER',
      'warn',
      'tx.warn.UNKNOWN_ISSUER',
      { code: asset.getCode() ?? '', issuer: shortAddress(issuer) },
      opIndex,
    );
  }
}

/**
 * §5: "recipient account does not exist -> minimum reserve becomes due".
 *
 * Two genuinely different situations share the one warning code, so they get
 * two texts. `createAccount` really does create the account, and the reserve
 * stays locked for as long as it exists; that is the case a beginner meets,
 * because `tx-builder` turns a payment to an unfunded address into exactly this
 * operation. A plain `payment` to an unfunded address creates nothing; it fails
 * on the network, and saying "it will be created" there would be wrong.
 */
function checkDestinationFunded(
  b: DescriptionBuilder,
  ctx: DescribeContext,
  destination: string,
  opIndex: number,
  variant: 'creates' | 'requires',
): void {
  const exists = ctx.accountExists?.[destination];
  if (exists === false) {
    b.warn(
      'DESTINATION_NOT_FUNDED',
      'warn',
      variant === 'creates'
        ? 'tx.warn.DESTINATION_NOT_FUNDED'
        : 'tx.warn.DESTINATION_NOT_FUNDED.unreachable',
      { destination: shortAddress(destination) },
      opIndex,
    );
  }
}

function checkSlippage(
  b: DescriptionBuilder,
  ctx: DescribeContext,
  opIndex: number,
  variant: 'strictSend' | 'strictReceive',
  sendAsset: Asset,
  destAsset: Asset,
  sendBound: string,
  destBound: string,
): void {
  const threshold = ctx.slippageThreshold ?? DEFAULT_SLIPPAGE_THRESHOLD;
  const quote = ctx.pathPaymentQuotes?.find((q) => q.opIndex === opIndex);

  let expected: number | undefined;
  let bound: number | undefined;

  if (variant === 'strictSend') {
    bound = Number(destBound); // destMin
    if (quote?.expectedDestAmount !== undefined) expected = Number(quote.expectedDestAmount);
    else if (assetId(sendAsset) === assetId(destAsset)) expected = Number(sendBound);
  } else {
    bound = Number(sendBound); // sendMax
    if (quote?.expectedSendAmount !== undefined) expected = Number(quote.expectedSendAmount);
    else if (assetId(sendAsset) === assetId(destAsset)) expected = Number(destBound);
  }

  if (expected === undefined || !Number.isFinite(expected) || expected <= 0) {
    b.warn('SLIPPAGE_UNKNOWN', 'info', 'tx.warn.SLIPPAGE_UNKNOWN', undefined, opIndex);
    return;
  }
  if (bound === undefined || !Number.isFinite(bound)) return;

  const slippage =
    variant === 'strictSend' ? (expected - bound) / expected : (bound - expected) / expected;

  if (slippage > threshold) {
    b.warn(
      'HIGH_SLIPPAGE',
      'warn',
      'tx.warn.HIGH_SLIPPAGE',
      {
        percent: (slippage * 100).toFixed(2),
        threshold: (threshold * 100).toFixed(2),
      },
      opIndex,
    );
  }
}

/** Explicit, so a missing key is a compile-time gap and not a leaked identifier. */
const SPONSORSHIP_TERMS: Readonly<Record<string, string>> = {
  revokeAccountSponsorship: 'tx.term.sponsorship.account',
  revokeTrustlineSponsorship: 'tx.term.sponsorship.trustline',
  revokeOfferSponsorship: 'tx.term.sponsorship.offer',
  revokeDataSponsorship: 'tx.term.sponsorship.data',
  revokeClaimableBalanceSponsorship: 'tx.term.sponsorship.claimableBalance',
  revokeLiquidityPoolSponsorship: 'tx.term.sponsorship.liquidityPool',
  revokeSignerSponsorship: 'tx.term.sponsorship.signer',
};

function describeSetOptions(
  b: DescriptionBuilder,
  op: Extract<SdkOperation, { type: 'setOptions' }>,
  index: number,
): void {
  const changes: string[] = [];
  if (op.signer) changes.push('tx.term.setOptions.signer');
  if (op.masterWeight !== undefined) changes.push('tx.term.setOptions.masterWeight');
  if (op.lowThreshold !== undefined) changes.push('tx.term.setOptions.lowThreshold');
  if (op.medThreshold !== undefined) changes.push('tx.term.setOptions.medThreshold');
  if (op.highThreshold !== undefined) changes.push('tx.term.setOptions.highThreshold');
  if (op.homeDomain !== undefined) changes.push('tx.term.setOptions.homeDomain');
  if (op.inflationDest !== undefined) changes.push('tx.term.setOptions.inflationDest');
  if (op.setFlags !== undefined) changes.push('tx.term.setOptions.setFlags');
  if (op.clearFlags !== undefined) changes.push('tx.term.setOptions.clearFlags');

  b.effect(index, 'setOptions', 'tx.op.setOptions', {
    fields: termList(changes.length > 0 ? changes : ['tx.term.setOptions.none']),
  });

  const touchesAuthority =
    op.signer !== undefined ||
    op.masterWeight !== undefined ||
    op.lowThreshold !== undefined ||
    op.medThreshold !== undefined ||
    op.highThreshold !== undefined;

  if (touchesAuthority) {
    b.warn(
      'SIGNER_OR_THRESHOLD_CHANGE',
      'danger',
      'tx.warn.SIGNER_OR_THRESHOLD_CHANGE',
      undefined,
      index,
    );
  }
}

function describeOperation(
  b: DescriptionBuilder,
  ctx: DescribeContext,
  op: SdkOperation,
  index: number,
): void {
  switch (op.type) {
    case 'createAccount': {
      // §5: this is *the* beginner case for the reserve warning, the send
      // flow turns a payment to an unfunded address into a createAccount.
      checkDestinationFunded(b, ctx, op.destination, index, 'creates');
      b.effect(index, op.type, 'tx.op.createAccount', {
        destination: shortAddress(op.destination),
        amount: op.startingBalance,
      });
      return;
    }
    case 'payment': {
      checkIssuer(b, ctx, op.asset, index);
      checkDestinationFunded(b, ctx, op.destination, index, 'requires');
      b.effect(index, op.type, 'tx.op.payment', {
        amount: op.amount,
        asset: assetLabel(op.asset),
        destination: shortAddress(op.destination),
      });
      return;
    }
    case 'pathPaymentStrictSend': {
      checkIssuer(b, ctx, op.sendAsset, index);
      checkIssuer(b, ctx, op.destAsset, index);
      checkDestinationFunded(b, ctx, op.destination, index, 'requires');
      checkSlippage(
        b,
        ctx,
        index,
        'strictSend',
        op.sendAsset,
        op.destAsset,
        op.sendAmount,
        op.destMin,
      );
      b.effect(index, op.type, 'tx.op.pathPaymentStrictSend', {
        sendAmount: op.sendAmount,
        sendAsset: assetLabel(op.sendAsset),
        destMin: op.destMin,
        destAsset: assetLabel(op.destAsset),
        destination: shortAddress(op.destination),
      });
      return;
    }
    case 'pathPaymentStrictReceive': {
      checkIssuer(b, ctx, op.sendAsset, index);
      checkIssuer(b, ctx, op.destAsset, index);
      checkDestinationFunded(b, ctx, op.destination, index, 'requires');
      checkSlippage(
        b,
        ctx,
        index,
        'strictReceive',
        op.sendAsset,
        op.destAsset,
        op.sendMax,
        op.destAmount,
      );
      b.effect(index, op.type, 'tx.op.pathPaymentStrictReceive', {
        sendMax: op.sendMax,
        sendAsset: assetLabel(op.sendAsset),
        destAmount: op.destAmount,
        destAsset: assetLabel(op.destAsset),
        destination: shortAddress(op.destination),
      });
      return;
    }
    case 'changeTrust': {
      const line = op.line;
      if (isAsset(line)) {
        checkIssuer(b, ctx, line, index);
        if (op.limit === '0' || Number(op.limit) === 0) {
          b.warn(
            'TRUSTLINE_REMOVAL',
            'danger',
            'tx.warn.TRUSTLINE_REMOVAL',
            { asset: line.getCode() ?? '' },
            index,
          );
          b.effect(index, op.type, 'tx.op.changeTrust.remove', {
            asset: line.getCode() ?? '',
          });
        } else {
          b.effect(index, op.type, 'tx.op.changeTrust.add', {
            asset: line.getCode() ?? '',
            issuer: shortAddress(line.getIssuer() ?? ''),
            limit: op.limit,
          });
        }
      } else {
        // Liquidity pool share trustline.
        if (op.limit === '0' || Number(op.limit) === 0) {
          b.warn(
          'TRUSTLINE_REMOVAL',
          'danger',
          'tx.warn.TRUSTLINE_REMOVAL',
          { asset: 'tx.term.liquidityPool' },
          index,
        );
        }
        b.effect(index, op.type, 'tx.op.changeTrust.pool', { limit: op.limit });
      }
      return;
    }
    case 'accountMerge': {
      b.warn(
        'ACCOUNT_MERGE',
        'danger',
        'tx.warn.ACCOUNT_MERGE',
        { destination: shortAddress(op.destination) },
        index,
      );
      b.effect(index, op.type, 'tx.op.accountMerge', {
        destination: shortAddress(op.destination),
      });
      return;
    }
    case 'setOptions': {
      describeSetOptions(b, op, index);
      return;
    }
    case 'manageSellOffer': {
      checkIssuer(b, ctx, op.selling, index);
      checkIssuer(b, ctx, op.buying, index);
      b.effect(index, op.type, 'tx.op.manageSellOffer', {
        amount: op.amount,
        selling: assetLabel(op.selling),
        buying: assetLabel(op.buying),
        price: op.price,
      });
      return;
    }
    case 'manageBuyOffer': {
      checkIssuer(b, ctx, op.selling, index);
      checkIssuer(b, ctx, op.buying, index);
      b.effect(index, op.type, 'tx.op.manageBuyOffer', {
        amount: op.buyAmount,
        buying: assetLabel(op.buying),
        selling: assetLabel(op.selling),
        price: op.price,
      });
      return;
    }
    case 'createPassiveSellOffer': {
      checkIssuer(b, ctx, op.selling, index);
      checkIssuer(b, ctx, op.buying, index);
      b.effect(index, op.type, 'tx.op.createPassiveSellOffer', {
        amount: op.amount,
        selling: assetLabel(op.selling),
        buying: assetLabel(op.buying),
        price: op.price,
      });
      return;
    }
    case 'allowTrust': {
      b.effect(index, op.type, 'tx.op.allowTrust', {
        trustor: shortAddress(op.trustor),
        asset: op.assetCode,
        authorize: op.authorize
          ? 'tx.term.allowTrust.authorize'
          : 'tx.term.allowTrust.revoke',
      });
      return;
    }
    case 'setTrustLineFlags': {
      checkIssuer(b, ctx, op.asset, index);
      b.effect(index, op.type, 'tx.op.setTrustLineFlags', {
        trustor: shortAddress(op.trustor),
        asset: assetLabel(op.asset),
      });
      return;
    }
    case 'manageData': {
      b.effect(index, op.type, 'tx.op.manageData', {
        name: op.name,
        action:
          op.value === undefined || op.value === null
            ? 'tx.term.manageData.delete'
            : 'tx.term.manageData.set',
      });
      return;
    }
    case 'bumpSequence': {
      b.effect(index, op.type, 'tx.op.bumpSequence', { bumpTo: op.bumpTo });
      return;
    }
    case 'createClaimableBalance': {
      checkIssuer(b, ctx, op.asset, index);
      b.effect(index, op.type, 'tx.op.createClaimableBalance', {
        amount: op.amount,
        asset: assetLabel(op.asset),
        claimants: op.claimants.length,
      });
      return;
    }
    case 'claimClaimableBalance': {
      b.effect(index, op.type, 'tx.op.claimClaimableBalance', {
        balanceId: shortAddress(op.balanceId),
      });
      return;
    }
    case 'beginSponsoringFutureReserves': {
      b.effect(index, op.type, 'tx.op.beginSponsoringFutureReserves', {
        sponsored: shortAddress(op.sponsoredId),
      });
      return;
    }
    case 'endSponsoringFutureReserves': {
      b.effect(index, op.type, 'tx.op.endSponsoringFutureReserves');
      return;
    }
    case 'revokeAccountSponsorship':
    case 'revokeTrustlineSponsorship':
    case 'revokeOfferSponsorship':
    case 'revokeDataSponsorship':
    case 'revokeClaimableBalanceSponsorship':
    case 'revokeLiquidityPoolSponsorship':
    case 'revokeSignerSponsorship': {
      b.effect(index, op.type, 'tx.op.revokeSponsorship', {
        kind: SPONSORSHIP_TERMS[op.type] ?? 'tx.term.sponsorship.unknown',
      });
      return;
    }
    case 'clawback': {
      checkIssuer(b, ctx, op.asset, index);
      b.effect(index, op.type, 'tx.op.clawback', {
        amount: op.amount,
        asset: assetLabel(op.asset),
        from: shortAddress(op.from),
      });
      return;
    }
    case 'clawbackClaimableBalance': {
      b.effect(index, op.type, 'tx.op.clawbackClaimableBalance', {
        balanceId: shortAddress(op.balanceId),
      });
      return;
    }
    case 'liquidityPoolDeposit': {
      b.effect(index, op.type, 'tx.op.liquidityPoolDeposit', {
        maxAmountA: op.maxAmountA,
        maxAmountB: op.maxAmountB,
      });
      return;
    }
    case 'liquidityPoolWithdraw': {
      b.effect(index, op.type, 'tx.op.liquidityPoolWithdraw', { amount: op.amount });
      return;
    }
    case 'inflation': {
      b.effect(index, op.type, 'tx.op.inflation');
      return;
    }
    case 'invokeHostFunction': {
      b.warn('SOROBAN_INVOCATION', 'warn', 'tx.warn.SOROBAN_INVOCATION', undefined, index);
      b.effect(index, op.type, 'tx.op.invokeHostFunction', {
        kind: describeHostFunctionKind(op),
      });
      return;
    }
    case 'extendFootprintTtl': {
      b.effect(index, op.type, 'tx.op.extendFootprintTtl', { extendTo: op.extendTo });
      return;
    }
    case 'restoreFootprint': {
      b.effect(index, op.type, 'tx.op.restoreFootprint');
      return;
    }
    default: {
      // Fail-closed (§5): never let an unknown operation pass silently.
      const unknownType = (op as { type?: unknown }).type;
      b.translatable = false;
      b.effect(index, 'unknown', 'tx.op.unknown', { type: String(unknownType ?? 'unknown') });
      b.warn(
        'UNTRANSLATABLE_OPERATION',
        'danger',
        'tx.warn.UNTRANSLATABLE_OPERATION',
        { type: String(unknownType ?? 'unknown') },
        index,
      );
    }
  }
}

/**
 * Describe a bare list of operations. Exported so the fail-closed path can be
 * unit-tested with a synthetic operation the SDK could never decode today.
 */
export function describeOperations(
  ops: readonly SdkOperation[],
  ctx: DescribeContext,
): { effects: readonly Effect[]; warnings: readonly Warning[]; translatable: boolean } {
  const b = new DescriptionBuilder();
  ops.forEach((op, index) => describeOperation(b, ctx, op, index));
  return { effects: b.effects, warnings: b.warnings, translatable: b.translatable };
}

const HOST_FUNCTION_TERMS: Readonly<Record<string, string>> = {
  hostFunctionTypeInvokeContract: 'tx.term.hostFunction.invokeContract',
  hostFunctionTypeCreateContract: 'tx.term.hostFunction.createContract',
  hostFunctionTypeCreateContractV2: 'tx.term.hostFunction.createContract',
  hostFunctionTypeUploadContractWasm: 'tx.term.hostFunction.uploadWasm',
};

function describeHostFunctionKind(
  op: Extract<SdkOperation, { type: 'invokeHostFunction' }>,
): string {
  try {
    return HOST_FUNCTION_TERMS[op.func.switch().name] ?? 'tx.term.hostFunction.unknown';
  } catch {
    return 'tx.term.hostFunction.unknown';
  }
}

function memoOf(memo: Memo<MemoType>): TxMeta['memo'] {
  if (!memo || memo.type === 'none') return null;
  const value: unknown = memo.value;
  let printable: string;
  if (value === null || value === undefined) {
    printable = '';
  } else if (typeof value === 'string') {
    printable = value;
  } else if (value instanceof Uint8Array) {
    // MEMO_TEXT arrives as raw bytes; hashes stay hex so they are comparable.
    printable =
      memo.type === 'text'
        ? new TextDecoder().decode(value)
        : Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } else {
    printable = String(value);
  }
  return { type: String(memo.type), value: printable };
}

function summarize(
  effects: readonly Effect[],
  warnings: readonly Warning[],
  isFeeBump: boolean,
): I18nMessage {
  if (isFeeBump) return { key: 'tx.summary.feeBump' };
  if (effects.length === 0) return { key: 'tx.summary.empty' };
  if (effects.length > 1) return { key: 'tx.summary.multi', params: { count: effects.length } };
  const only = effects[0];
  if (!only) return { key: 'tx.summary.empty' };
  if (warnings.some((w) => w.code === 'UNTRANSLATABLE_OPERATION')) {
    return { key: 'tx.summary.unknown' };
  }
  return only.message;
}

function unparseable(xdr: string, ctx: DescribeContext, detail: string): TxDescription {
  return {
    summary: { key: 'tx.summary.unparseable' },
    effects: [],
    warnings: [
      {
        code: 'UNPARSEABLE_TRANSACTION',
        severity: 'danger',
        message: { key: 'tx.warn.UNPARSEABLE_TRANSACTION', params: { detail } },
      },
    ],
    raw: xdr,
    translatable: false,
    meta: {
      network: ctx.networkPassphrase,
      networkName: ctx.networkName ?? '',
      source: '',
      feeStroops: '0',
      feeXlm: '0',
      feePerOperationStroops: '0',
      sequence: '0',
      operationCount: 0,
      memo: null,
      timeBounds: null,
      isFeeBump: false,
    },
  };
}

/**
 * Translate a base64 transaction envelope into a plain-language description.
 *
 * Never throws: a malformed envelope produces an `UNPARSEABLE_TRANSACTION`
 * description with `translatable: false`, so the confirmation dialog can refuse
 * to present a "looks fine" screen for something it did not understand.
 */
export function describeTransaction(xdr: string, ctx: DescribeContext): TxDescription {
  let envelope: Transaction | FeeBumpTransaction;
  try {
    envelope = TransactionBuilder.fromXDR(xdr, ctx.networkPassphrase);
  } catch (err) {
    return unparseable(xdr, ctx, err instanceof Error ? err.message : String(err));
  }

  const b = new DescriptionBuilder();
  const isFeeBump = envelope instanceof FeeBumpTransaction;
  const inner: Transaction = isFeeBump
    ? (envelope as FeeBumpTransaction).innerTransaction
    : (envelope as Transaction);

  if (ctx.isMainnet) {
    b.warn('MAINNET_REAL_FUNDS', 'warn', 'tx.warn.MAINNET_REAL_FUNDS');
  }

  if (
    ctx.declaredNetworkPassphrase !== undefined &&
    ctx.declaredNetworkPassphrase !== ctx.networkPassphrase
  ) {
    b.warn('NETWORK_MISMATCH', 'danger', 'tx.warn.NETWORK_MISMATCH', {
      expected: networkTerm(ctx.networkName, ctx.networkPassphrase),
    });
  }

  if (ctx.accountId && inner.source !== ctx.accountId) {
    b.warn('FOREIGN_SOURCE_ACCOUNT', 'warn', 'tx.warn.FOREIGN_SOURCE_ACCOUNT', {
      source: shortAddress(inner.source),
    });
  }

  if (ctx.currentSequence !== undefined) {
    try {
      const expected = BigInt(ctx.currentSequence) + 1n;
      const actual = BigInt(inner.sequence);
      if (actual !== expected) {
        b.warn('SEQUENCE_GAP', 'warn', 'tx.warn.SEQUENCE_GAP', {
          expected: expected.toString(),
          actual: actual.toString(),
        });
      }
    } catch {
      /* non-numeric sequence: covered by the parse guard above */
    }
  }

  inner.operations.forEach((op, index) => {
    describeOperation(b, ctx, op, index);
  });

  // SEP-29: a payment-like operation towards an account that has declared
  // `config.memo_required`, in a transaction that carries no memo, is the
  // classic "deposit to an exchange without a memo" loss scenario.
  const hasMemo = inner.memo !== undefined && inner.memo.type !== 'none';
  if (!hasMemo && ctx.memoRequiredAccounts !== undefined && ctx.memoRequiredAccounts.length > 0) {
    inner.operations.forEach((op, index) => {
      if (
        'destination' in op &&
        typeof op.destination === 'string' &&
        ctx.memoRequiredAccounts?.includes(op.destination)
      ) {
        b.warn(
          'MEMO_REQUIRED',
          'danger',
          'tx.warn.MEMO_REQUIRED',
          { destination: shortAddress(op.destination) },
          index,
        );
      }
    });
  }

  const feeStroops = isFeeBump ? (envelope as FeeBumpTransaction).fee : inner.fee;
  const tb = inner.timeBounds ?? null;
  const operationCount = inner.operations.length;

  /**
   * Fee warning, measured per operation so that a legitimately large
   * multi-operation envelope is not flagged just for being large. Soroban
   * envelopes are exempt: their `fee` field is inclusion fee *plus* the
   * resource fee the simulation sets, so comparing it to `BASE_FEE` would
   * warn about every single contract call, which is noise, not a signal.
   */
  const perOp = Number(perOperationFee(String(feeStroops), operationCount));
  const isSoroban = inner.operations.some(
    (op) =>
      op.type === 'invokeHostFunction' ||
      op.type === 'extendFootprintTtl' ||
      op.type === 'restoreFootprint',
  );
  if (!isSoroban && Number.isFinite(perOp) && perOp >= Number(BASE_FEE) * HIGH_FEE_FACTOR) {
    b.warn('HIGH_FEE', 'warn', 'tx.warn.HIGH_FEE', {
      feeXlm: stroopsToXlm(String(feeStroops)),
      factor: Math.round(perOp / Number(BASE_FEE)),
    });
  }

  return {
    summary: summarize(b.effects, b.warnings, isFeeBump),
    effects: b.effects,
    warnings: b.warnings,
    raw: xdr,
    translatable: b.translatable,
    meta: {
      network: ctx.networkPassphrase,
      networkName: ctx.networkName ?? '',
      source: inner.source,
      feeStroops: String(feeStroops),
      feeXlm: stroopsToXlm(String(feeStroops)),
      feePerOperationStroops: perOperationFee(String(feeStroops), operationCount),
      sequence: inner.sequence,
      operationCount,
      memo: memoOf(inner.memo),
      timeBounds: tb ? { minTime: String(tb.minTime), maxTime: String(tb.maxTime) } : null,
      isFeeBump,
    },
  };
}

/** Highest severity present, for the confirmation dialog's banner colour. */
export function highestSeverity(description: TxDescription): Severity | null {
  if (description.warnings.some((w) => w.severity === 'danger')) return 'danger';
  if (description.warnings.some((w) => w.severity === 'warn')) return 'warn';
  if (description.warnings.length > 0) return 'info';
  return null;
}
