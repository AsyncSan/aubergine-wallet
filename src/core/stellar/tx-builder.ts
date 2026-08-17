/**
 * Transaction assembly. Pure with respect to the network: the caller supplies
 * the source account snapshot, so this module stays unit-testable.
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { AppError } from '../errors';
import type { NetworkConfig } from './networks';
import { assetFromId } from './horizon';
import { MEMO_TEXT_MAX_BYTES, isValidMemoText, memoTextByteLength } from './memo';

export const DEFAULT_TIMEOUT_SECONDS = 180;

export interface PaymentIntent {
  readonly destination: string;
  /** `native` or `CODE:ISSUER`. */
  readonly assetId: string;
  readonly amount: string;
  readonly memo?: string;
  /**
   * Fee in stroops **per operation**, as `TransactionBuilder` means it, the
   * envelope's total is this × the number of operations (one, here).
   *
   * Two callers, one field: the developer-mode manual override (§4) and, since
   * the fee strategy landed, the value `handlers.feeForBuild` derived from
   * Horizon's `/fee_stats`. `BASE_FEE` stays the last-resort default so this
   * module keeps building a valid envelope on its own.
   */
  readonly feeStroops?: string;
  /** True when the destination has no account yet -> createAccount instead. */
  readonly destinationExists: boolean;
}

export function assertValidAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidMed25519PublicKey(address)) {
    throw new AppError('INVALID_ADDRESS', address);
  }
}

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/u;

export function assertValidAmount(amount: string): void {
  if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    throw new AppError('INVALID_AMOUNT', amount);
  }
}

/** Minimum starting balance for a brand-new account: 1 XLM (2 × base reserve). */
export const MIN_STARTING_BALANCE = 1;

export function buildPaymentTransaction(
  network: NetworkConfig,
  sourcePublicKey: string,
  sourceSequence: string,
  intent: PaymentIntent,
): string {
  assertValidAddress(intent.destination);
  assertValidAmount(intent.amount);

  const asset = assetFromId(intent.assetId);
  const account = new Account(sourcePublicKey, sourceSequence);
  let builder = new TransactionBuilder(account, {
    fee: intent.feeStroops ?? BASE_FEE,
    networkPassphrase: network.passphrase,
  });

  if (!intent.destinationExists) {
    if (!asset.isNative()) {
      // A non-existent account cannot hold a non-native asset yet.
      throw new AppError('ACCOUNT_NOT_FOUND', intent.destination);
    }
    if (Number(intent.amount) < MIN_STARTING_BALANCE) {
      throw new AppError('INVALID_AMOUNT', `below minimum starting balance`);
    }
    builder = builder.addOperation(
      Operation.createAccount({
        destination: intent.destination,
        startingBalance: intent.amount,
      }),
    );
  } else {
    builder = builder.addOperation(
      Operation.payment({
        destination: intent.destination,
        asset,
        amount: intent.amount,
      }),
    );
  }

  if (intent.memo && intent.memo.length > 0) {
    // Defence in depth behind the Zod schema: MEMO_TEXT is a 28-*byte* XDR
    // field, so a multi-byte memo must fail here with a typed error instead of
    // an untranslated SDK exception (P2 fix).
    if (!isValidMemoText(intent.memo)) {
      throw new AppError(
        'INVALID_MEMO',
        `memo is ${memoTextByteLength(intent.memo)} bytes, limit is ${MEMO_TEXT_MAX_BYTES}`,
      );
    }
    builder = builder.addMemo(Memo.text(intent.memo));
  }

  return builder.setTimeout(DEFAULT_TIMEOUT_SECONDS).build().toXDR();
}

export interface SwapIntent {
  /** `native` or `CODE:ISSUER`. */
  readonly sendAssetId: string;
  readonly sendAmount: string;
  readonly destAssetId: string;
  /** Slippage floor: the swap fails on-chain rather than yield less than this. */
  readonly destMin: string;
  /** Intermediate hops from the quote, as asset ids. */
  readonly path: readonly string[];
  /** Stroops per operation, see {@link PaymentIntent.feeStroops}. */
  readonly feeStroops?: string;
}

/**
 * A swap is a path payment to yourself: send `sendAmount` of one asset, receive
 * at least `destMin` of another on the same account. `destMin` is the safety
 * rail, if the order books moved past the user's slippage tolerance between
 * quote and submission, the network rejects the whole operation instead of
 * filling it at a worse rate.
 */
export function buildSwapTransaction(
  network: NetworkConfig,
  sourcePublicKey: string,
  sourceSequence: string,
  intent: SwapIntent,
): string {
  assertValidAmount(intent.sendAmount);
  assertValidAmount(intent.destMin);
  if (intent.sendAssetId === intent.destAssetId) {
    throw new AppError('BAD_REQUEST', 'cannot swap an asset into itself');
  }

  const account = new Account(sourcePublicKey, sourceSequence);
  return new TransactionBuilder(account, {
    fee: intent.feeStroops ?? BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: assetFromId(intent.sendAssetId),
        sendAmount: intent.sendAmount,
        destination: sourcePublicKey,
        destAsset: assetFromId(intent.destAssetId),
        destMin: intent.destMin,
        path: intent.path.map(assetFromId),
      }),
    )
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
    .build()
    .toXDR();
}

export interface TrustlineIntent {
  readonly assetCode: string;
  readonly issuer: string;
  /** Omitted -> SDK maximum; `0` removes the trustline. */
  readonly limit?: string;
  /** Stroops per operation, see {@link PaymentIntent.feeStroops}. */
  readonly feeStroops?: string;
}

export function buildChangeTrustTransaction(
  network: NetworkConfig,
  sourcePublicKey: string,
  sourceSequence: string,
  intent: TrustlineIntent,
): string {
  assertValidAddress(intent.issuer);
  const asset = new Asset(intent.assetCode, intent.issuer);
  const account = new Account(sourcePublicKey, sourceSequence);
  const changeTrustOptions: { asset: Asset; limit?: string } =
    intent.limit === undefined ? { asset } : { asset, limit: intent.limit };
  const op: xdr.Operation = Operation.changeTrust(changeTrustOptions);
  return new TransactionBuilder(account, {
    fee: intent.feeStroops ?? BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(op)
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
    .build()
    .toXDR();
}
