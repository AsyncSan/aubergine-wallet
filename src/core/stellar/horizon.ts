/**
 * Horizon access.
 *
 * Lives behind the background broker (ARCHITECTURE.md §3) so rate limiting
 * happens in exactly one place and the popup never talks to the network
 * directly. The default `@stellar/stellar-sdk` build is fetch-based, which is
 * what MV3 service workers support (the axios build is not).
 */
import { Asset, BASE_FEE, Horizon } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { AppError } from '../errors';
import { limited } from '../net/limiter';
import { attachCancellation } from '../net/sdk-cancel';
import type { NetworkConfig } from './networks';

export interface BalanceEntry {
  /** `native` or `CODE:ISSUER`. */
  readonly id: string;
  readonly code: string;
  readonly issuer: string | null;
  readonly balance: string;
  readonly limit: string | null;
  readonly isNative: boolean;
  readonly buyingLiabilities: string;
  readonly sellingLiabilities: string;
}

export interface ReserveBreakdown {
  readonly baseReserveXlm: string;
  readonly subentryCount: number;
  readonly numSponsoring: number;
  readonly numSponsored: number;
  /** Entries × base reserve, i.e. the amount that cannot be spent. */
  readonly totalReservedXlm: string;
  readonly spendableXlm: string;
  /** `spendableXlm` minus a fee reserve; what "Max" may actually send. */
  readonly maxSendableXlm: string;
}

export interface SignerSummary {
  readonly key: string;
  readonly weight: number;
  readonly type: string;
}

export interface AccountSnapshot {
  readonly accountId: string;
  readonly exists: boolean;
  readonly sequence: string;
  readonly balances: readonly BalanceEntry[];
  readonly reserves: ReserveBreakdown;
  readonly signers: readonly SignerSummary[];
  readonly thresholds: { readonly low: number; readonly medium: number; readonly high: number };
  readonly subentryCount: number;
  /** SEP-29: the account's `config.memo_required` data entry is set to "1". */
  readonly memoRequired: boolean;
}

/**
 * SEP-29 "account memo requirement" flag. Horizon reports data entries
 * base64-encoded; the spec's value is the string "1" (i.e. "MQ==" encoded).
 * Exchanges set this on shared deposit accounts; a payment without a memo
 * to such an account is typically unrecoverable for the user.
 */
export function memoRequiredFromData(
  data: Readonly<Record<string, string>> | undefined,
): boolean {
  const raw = data?.['config.memo_required'];
  if (raw === undefined) return false;
  try {
    return atob(raw) === '1';
  } catch {
    // Not valid base64, tolerate a raw "1" rather than silently ignoring it.
    return raw === '1';
  }
}

export interface HistoryEntry {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly successful: boolean;
  readonly transactionHash: string;
  /** Direction relative to the queried account, when it can be determined. */
  readonly direction: 'in' | 'out' | 'self' | 'other';
  readonly counterparty: string | null;
  readonly amount: string | null;
  readonly assetCode: string | null;
}

const BASE_RESERVE_XLM = 0.5;
const STROOPS_PER_XLM = 10_000_000;

/**
 * Hard ceiling for a single Horizon request. The SDK's default is `timeout: 0`
 * (i.e. none), so a black-holed endpoint (accepts the connection, never
 * answers) left the popup on a spinner forever *and* pinned all four slots of
 * the rate limiter, which then queued every later request behind it.
 */
export const HORIZON_TIMEOUT_MS = 20_000;
/** Submission is slower by nature: it waits for the transaction to be included. */
export const HORIZON_SUBMIT_TIMEOUT_MS = 60_000;

/**
 * The token bucket and the request deadline now live in `core/net/limiter.ts`,
 * shared with `soroban.ts`; §3 asks for one place, and one *file* was not it.
 * The values (4 in flight, 60 ms apart) and the error a timeout raises are
 * unchanged; only the location moved.
 */

/* ------------------------------------------------------------------- fees */

/**
 * THE UNIT, once, for everything below: every fee in this section is stroops
 * **per operation**; the same quantity `TransactionBuilder({ fee })` takes.
 * The envelope's own `fee` field, which Horizon charges against and which the
 * confirmation dialog renders, is `perOperation × operationCount`
 * (see `TransactionBuilder.build()`: `baseFee.times(operations.length)`).
 * Every envelope this wallet builds itself carries exactly one operation, so
 * today the two numbers coincide, but the cap below is a *per operation*
 * cap and `tx-describe` publishes both numbers so they cannot drift silently.
 */

/**
 * Ceiling for the fee we choose ourselves, per operation: 100,000 stroops =
 * 0.01 XLM = 1000 × `BASE_FEE`.
 *
 * The number, not a feeling: the `/fee_stats` sample this repo carries as an
 * E2E fixture tops out at `max_fee.p99 = 100000`; the 99th percentile of
 * what submitters were *willing* to bid in a congested phase. A bid above the
 * highest bid anyone else makes buys no extra inclusion probability.
 * Against the downside: at Stellar's protocol maximum of 100 operations in
 * one transaction the ceiling bounds a single envelope at 1 XLM, and for the
 * one-operation envelopes this wallet builds at 0.01 XLM (≈ 0.4 US-cent at
 * 0.40 USD/XLM, and 1/50 of a single 0.5 XLM subentry reserve). That is the
 * most a compromised, hostile or simply broken Horizon can talk this wallet
 * into paying per operation, and it is small enough that the worst case is an
 * annoyance rather than a drained account.
 */
export const MAX_FEE_PER_OPERATION_STROOPS = 100_000;

/**
 * Above this fraction of ledger capacity the network is contended and a bid at
 * the recently observed clearing price is likely to be outbid before inclusion,
 * so the choice gets headroom. 0.5 is deliberately early: `tx_too_late` after
 * 180 s costs the user a retry, an over-bid costs nothing extra as long as the
 * ledger does not actually fill (Stellar charges the market-clearing price,
 * not the bid).
 */
export const CONGESTION_THRESHOLD = 0.5;
/** Headroom applied on top of the observed price while congested. */
export const SURGE_HEADROOM = 4;
/**
 * At or above this multiple of `BASE_FEE` the chosen fee is no longer the
 * everyday case and is worth telling the user about. Reported by
 * {@link chooseFee}; the wallet does not yet *render* it, see the report.
 */
export const SURGE_NOTICE_FACTOR = 10;

/**
 * Held back from the *sendable* amount so that the fee of the transaction the
 * user is about to build still fits.
 *
 * Tied to the fee ceiling on purpose: before the fee strategy existed this was
 * 0.0001 XLM (ten operations at `BASE_FEE`), which is exactly the reserve that
 * stops covering the fee the moment a surge pushes the chosen fee above 1000
 * stroops, and "Max" would be back to failing with `op_underfunded`, the bug
 * this constant was introduced for. It now covers the worst fee this wallet
 * will ever choose for a one-operation envelope. Deliberately not subtracted
 * from `spendableXlm`, which is what the balance screen shows, "available"
 * should stay the honest number.
 */
export const FEE_RESERVE_XLM = MAX_FEE_PER_OPERATION_STROOPS / STROOPS_PER_XLM;

/** One percentile row of `/fee_stats`. `null` = absent or not a usable number. */
export interface FeeDistribution {
  readonly min: number | null;
  readonly mode: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/**
 * Horizon `GET /fee_stats`, normalised. Horizon sends every number as a
 * string; the SDK (`Horizon.Server.feeStats()`, v16.2.0) hands the payload
 * through unchanged, `CallBuilder.call()` only rewrites `_links`, and
 * `/fee_stats` has none, so the strings are ours to parse.
 */
export interface FeeStats {
  readonly lastLedgerBaseFee: number | null;
  /** 0…1. Horizon reports it as a decimal string, e.g. "0.03". */
  readonly ledgerCapacityUsage: number | null;
  /** What transactions were actually charged (the clearing price). */
  readonly feeCharged: FeeDistribution;
  /** What submitters were willing to bid. Far noisier; not used for the choice. */
  readonly maxFee: FeeDistribution;
}

/**
 * A fee value: positive and finite or nothing. `.catch(null)` rather than a
 * throw, so one nonsensical percentile cannot cost us the whole answer.
 * `null`/`""`/`undefined` all coerce to 0 or NaN and fail `positive()`.
 */
const feeValueSchema = z.coerce.number().finite().positive().nullable().catch(null);
const capacitySchema = z.coerce.number().finite().min(0).max(1).nullable().catch(null);

const EMPTY_DISTRIBUTION: FeeDistribution = {
  min: null,
  mode: null,
  p50: null,
  p90: null,
  p95: null,
  p99: null,
  max: null,
};

const distributionSchema = z
  .object({
    min: feeValueSchema,
    mode: feeValueSchema,
    p50: feeValueSchema,
    p90: feeValueSchema,
    p95: feeValueSchema,
    p99: feeValueSchema,
    max: feeValueSchema,
  })
  .catch(EMPTY_DISTRIBUTION);

const feeStatsSchema = z
  .object({
    last_ledger_base_fee: feeValueSchema,
    ledger_capacity_usage: capacitySchema,
    fee_charged: distributionSchema,
    max_fee: distributionSchema,
  })
  .catch({
    last_ledger_base_fee: null,
    ledger_capacity_usage: null,
    fee_charged: EMPTY_DISTRIBUTION,
    max_fee: EMPTY_DISTRIBUTION,
  });

/**
 * Parse a `/fee_stats` payload. Never throws: a field that is missing, empty,
 * negative or not a number at all becomes `null`, and the caller decides what
 * to do without it. Only a payload that is not an object at all is `null`
 * outright; that is not a Horizon answer, it is a proxy or an error page.
 */
export function parseFeeStats(raw: unknown): FeeStats | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const parsed = feeStatsSchema.parse(raw);
  return {
    lastLedgerBaseFee: parsed.last_ledger_base_fee,
    ledgerCapacityUsage: parsed.ledger_capacity_usage,
    feeCharged: parsed.fee_charged,
    maxFee: parsed.max_fee,
  };
}

/** How long one `/fee_stats` answer, or one failure, is reused. */
export const FEE_STATS_TTL_MS = 30_000;

interface FeeStatsCacheEntry {
  readonly stats: FeeStats | null;
  readonly expiresAt: number;
}

/**
 * Keyed by Horizon URL, so testnet and mainnet (and a custom network pointing
 * at either) can never hand each other their fee levels.
 */
const feeStatsCache = new Map<string, FeeStatsCacheEntry>();

/**
 * Test seam. Deliberately *not* wired into the settings change hook the way
 * `resetSorobanEndpointCache` is: the key is the Horizon URL itself, so
 * switching network or endpoint already misses the cache instead of reading a
 * stale entry.
 */
export function resetFeeStatsCache(): void {
  feeStatsCache.clear();
}

/**
 * `GET /fee_stats`, through the same bucket and the same deadline as every
 * other Horizon call.
 *
 * Returns `null` instead of throwing, and that is the whole point: this is an
 * *advisory* read on the mandatory path of every build. A wallet that cannot
 * assemble a payment because a fee-hint endpoint hiccupped is worse than one
 * that assembles it at `BASE_FEE`. The failure is cached for the same window
 * as a success, so a dead `/fee_stats` costs one timeout per 30 s rather than
 * one per transaction.
 *
 * `now` is a parameter for the same reason `orderedEndpoints` takes one: the
 * TTL is testable without moving the process clock, which a shared token
 * bucket does not survive.
 */
export async function fetchFeeStats(
  network: NetworkConfig,
  now: number = Date.now(),
): Promise<FeeStats | null> {
  const key = network.horizonUrl;
  const cached = feeStatsCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.stats;

  let stats: FeeStats | null = null;
  try {
    const raw = await limited(
      (signal) => horizonServer(network, signal).feeStats(),
      HORIZON_TIMEOUT_MS,
    );
    stats = parseFeeStats(raw);
  } catch {
    // Unreachable, timed out, 429, HTML error page, all the same answer here.
    stats = null;
  }
  feeStatsCache.set(key, { stats, expiresAt: now + FEE_STATS_TTL_MS });
  return stats;
}

export interface FeePlan {
  /** Stroops per operation, hand this to `TransactionBuilder({ fee })`. */
  readonly perOperationStroops: string;
  /** `perOperation × operationCount`: what the envelope's `fee` field will read. */
  readonly totalStroops: string;
  /**
   * `base`   : no usable stats, the `BASE_FEE` fallback (fail-open);
   * `network`: derived from `/fee_stats`;
   * `capped` : derived, then clamped at {@link MAX_FEE_PER_OPERATION_STROOPS}.
   */
  readonly source: 'base' | 'network' | 'capped';
  /** True when the choice is at least {@link SURGE_NOTICE_FACTOR} × `BASE_FEE`. */
  readonly surge: boolean;
}

function firstUsable(...values: ReadonlyArray<number | null>): number | null {
  for (const value of values) {
    if (value !== null && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Choose the fee for one classic (non-Soroban) envelope. Pure: hand it the
 * stats and the operation count, get the fee back.
 *
 * The rule, in one line: pay the highest price the network recently *charged*
 * (`fee_charged.max`, falling back to p95 / mode / `last_ledger_base_fee`),
 * never below `BASE_FEE`, times {@link SURGE_HEADROOM} while the ledger is
 * more than {@link CONGESTION_THRESHOLD} full, and never above
 * {@link MAX_FEE_PER_OPERATION_STROOPS}.
 *
 * Why `fee_charged` and not `max_fee`: Stellar's surge pricing charges every
 * included transaction the same market-clearing price, so `fee_charged` is
 * what inclusion actually cost, while `max_fee` is a distribution of bids that
 * routinely contains bots bidding 0.01 XLM for no reason. Following the bids
 * would make the wallet quote a fee an order of magnitude above what it ends
 * up paying, and the confirmation dialog shows this number to the user.
 *
 * In a calm market every input is 100, so the result is 100, bit-for-bit the
 * envelope this wallet built before the strategy existed.
 */
export function chooseFee(stats: FeeStats | null, operationCount = 1): FeePlan {
  const base = Number(BASE_FEE);
  const ops = Number.isFinite(operationCount) ? Math.max(1, Math.floor(operationCount)) : 1;
  const plan = (perOp: number, source: FeePlan['source']): FeePlan => ({
    perOperationStroops: String(perOp),
    totalStroops: String(perOp * ops),
    source,
    surge: perOp >= base * SURGE_NOTICE_FACTOR,
  });

  if (stats === null) return plan(base, 'base');

  const observed = firstUsable(
    stats.feeCharged.max,
    stats.feeCharged.p95,
    stats.feeCharged.mode,
    stats.lastLedgerBaseFee,
  );
  const floor = firstUsable(stats.lastLedgerBaseFee) ?? base;
  // Nothing in the payload was usable, treat it exactly like no payload.
  if (observed === null && stats.lastLedgerBaseFee === null && stats.ledgerCapacityUsage === null) {
    return plan(base, 'base');
  }

  const congested = (stats.ledgerCapacityUsage ?? 0) >= CONGESTION_THRESHOLD;
  const headroom = congested ? SURGE_HEADROOM : 1;
  const wanted = Math.ceil(Math.max(base, floor, observed ?? base) * headroom);

  if (wanted > MAX_FEE_PER_OPERATION_STROOPS) {
    return plan(MAX_FEE_PER_OPERATION_STROOPS, 'capped');
  }
  return plan(Math.max(base, wanted), 'network');
}

function isNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || (err as { name?: string })?.name === 'NotFoundError';
}

export function horizonServer(network: NetworkConfig, signal?: AbortSignal): Horizon.Server {
  const server = new Horizon.Server(network.horizonUrl, { allowHttp: false });
  // The deadline's signal, routed into the SDK client's cancel-token channel,
  // the only hook `CallBuilder.call()` leaves open. See `net/sdk-cancel.ts`.
  if (signal !== undefined) attachCancellation(server, signal);
  return server;
}

function toBalanceEntry(
  raw: Horizon.HorizonApi.BalanceLine,
): BalanceEntry | null {
  if (raw.asset_type === 'native') {
    return {
      id: 'native',
      code: 'XLM',
      issuer: null,
      balance: raw.balance,
      limit: null,
      isNative: true,
      buyingLiabilities: raw.buying_liabilities,
      sellingLiabilities: raw.selling_liabilities,
    };
  }
  if (raw.asset_type === 'credit_alphanum4' || raw.asset_type === 'credit_alphanum12') {
    return {
      id: `${raw.asset_code}:${raw.asset_issuer}`,
      code: raw.asset_code,
      issuer: raw.asset_issuer,
      balance: raw.balance,
      limit: raw.limit,
      isNative: false,
      buyingLiabilities: raw.buying_liabilities,
      sellingLiabilities: raw.selling_liabilities,
    };
  }
  // Liquidity pool shares are out of scope for phase 1.
  return null;
}

function emptySnapshot(accountId: string): AccountSnapshot {
  return {
    accountId,
    exists: false,
    sequence: '0',
    balances: [],
    reserves: {
      baseReserveXlm: BASE_RESERVE_XLM.toFixed(1),
      subentryCount: 0,
      numSponsoring: 0,
      numSponsored: 0,
      totalReservedXlm: '0',
      spendableXlm: '0',
      maxSendableXlm: '0',
    },
    signers: [],
    thresholds: { low: 0, medium: 0, high: 0 },
    subentryCount: 0,
    memoRequired: false,
  };
}

export async function fetchAccount(
  network: NetworkConfig,
  accountId: string,
): Promise<AccountSnapshot> {
  try {
    const record = await limited(
      (signal) => horizonServer(network, signal).accounts().accountId(accountId).call(),
      HORIZON_TIMEOUT_MS,
    );
    const balances = record.balances
      .map(toBalanceEntry)
      .filter((b): b is BalanceEntry => b !== null);
    const native = balances.find((b) => b.isNative);
    // Minimum balance = (2 + subentries + sponsoring - sponsored) * base reserve.
    const reserveEntries =
      2 + record.subentry_count + (record.num_sponsoring ?? 0) - (record.num_sponsored ?? 0);
    const totalReserved = Math.max(0, reserveEntries) * BASE_RESERVE_XLM;
    const nativeBalance = Number(native?.balance ?? '0');
    const sellingLiabilities = Number(native?.sellingLiabilities ?? '0');
    const spendable = Math.max(0, nativeBalance - totalReserved - sellingLiabilities);
    /**
     * The fee comes out of the same balance. Without reserving it, "Max" set the
     * amount to exactly the available balance and every such payment failed with
     * `op_underfunded`, deterministically, for any account without open sell
     * offers, i.e. essentially every beginner account.
     */
    const maxSendable = Math.max(0, spendable - FEE_RESERVE_XLM);

    return {
      accountId,
      exists: true,
      sequence: record.sequence,
      balances,
      reserves: {
        baseReserveXlm: BASE_RESERVE_XLM.toFixed(1),
        subentryCount: record.subentry_count,
        numSponsoring: record.num_sponsoring ?? 0,
        numSponsored: record.num_sponsored ?? 0,
        totalReservedXlm: totalReserved.toFixed(7),
        spendableXlm: spendable.toFixed(7),
        maxSendableXlm: maxSendable.toFixed(7),
      },
      signers: record.signers.map((s) => ({ key: s.key, weight: s.weight, type: s.type })),
      thresholds: {
        low: record.thresholds.low_threshold,
        medium: record.thresholds.med_threshold,
        high: record.thresholds.high_threshold,
      },
      subentryCount: record.subentry_count,
      memoRequired: memoRequiredFromData(
        (record as { data_attr?: Record<string, string> }).data_attr,
      ),
    };
  } catch (err) {
    if (isNotFound(err)) return emptySnapshot(accountId);
    throw new AppError('NETWORK_ERROR', err instanceof Error ? err.message : String(err));
  }
}

export async function accountExists(
  network: NetworkConfig,
  accountId: string,
): Promise<boolean> {
  return (await fetchAccount(network, accountId)).exists;
}

export async function fetchHistory(
  network: NetworkConfig,
  accountId: string,
  limit = 20,
): Promise<HistoryEntry[]> {
  try {
    const page = await limited((signal) =>
      horizonServer(network, signal)
        .operations()
        .forAccount(accountId)
        .order('desc')
        .limit(limit)
        .includeFailed(true)
        .call(),
      HORIZON_TIMEOUT_MS,
    );
    return page.records.map((record): HistoryEntry => {
      const r = record as unknown as Record<string, unknown>;
      const from = typeof r['from'] === 'string' ? (r['from'] as string) : null;
      const to = typeof r['to'] === 'string' ? (r['to'] as string) : null;
      const funder = typeof r['funder'] === 'string' ? (r['funder'] as string) : null;
      const destination =
        typeof r['account'] === 'string' && record.type === 'create_account'
          ? (r['account'] as string)
          : null;
      const sender = from ?? funder;
      const receiver = to ?? destination;
      let direction: HistoryEntry['direction'] = 'other';
      if (sender === accountId && receiver === accountId) direction = 'self';
      else if (sender === accountId) direction = 'out';
      else if (receiver === accountId) direction = 'in';
      const counterparty = direction === 'out' ? receiver : direction === 'in' ? sender : null;
      const amount =
        typeof r['amount'] === 'string'
          ? (r['amount'] as string)
          : typeof r['starting_balance'] === 'string'
            ? (r['starting_balance'] as string)
            : null;
      const assetCode =
        r['asset_type'] === 'native'
          ? 'XLM'
          : typeof r['asset_code'] === 'string'
            ? (r['asset_code'] as string)
            : record.type === 'create_account'
              ? 'XLM'
              : null;
      return {
        id: record.id,
        type: record.type,
        createdAt: record.created_at,
        successful: record.transaction_successful !== false,
        transactionHash: record.transaction_hash,
        direction,
        counterparty,
        amount,
        assetCode,
      };
    });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw new AppError('NETWORK_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Why a submission has no answer yet. Never "it failed"; that is the whole
 * point of the distinction.
 */
export type UnresolvedReason =
  /** Our own deadline fired; the request was aborted mid-flight. */
  | 'timeout'
  /** Horizon answered 5xx (504 on a ledger backlog is the everyday case). */
  | 'server_error'
  /** 429: the request was probably never forwarded, but "probably" is not "no". */
  | 'throttled'
  /** No HTTP answer at all: DNS, TLS, offline, proxy. */
  | 'transport'
  /** `200 {successful: false}`; the endpoint claims both at once. */
  | 'ambiguous';

/**
 * The outcome of a submission, and there are **three** of them, not two.
 *
 * `success` and a thrown `TX_FAILED:*` are the two the network actually tells
 * us. `unknown` is the third: the wallet stopped waiting (or Horizon stopped
 * answering) while the envelope was already on its way. The transaction stays
 * valid until its own `maxTime`, so treating this as a failure is what produced
 * the double payment: the user reads "network unreachable", goes back, and
 * `tx.build` fetches a *fresh* sequence number.
 */
export interface SubmitResult {
  readonly outcome: 'success' | 'unknown';
  /** Known before the request leaves; it survives every failure mode. */
  readonly hash: string;
  readonly successful: boolean;
  readonly ledger: number | null;
  /** Envelope `maxTime` in unix seconds; `'0'` = no upper timebound. */
  readonly maxTimeUnix: string;
  readonly reason: UnresolvedReason | null;
}

/** Hash, timebound and source of a signed envelope, without touching the network. */
export interface EnvelopeIdentity {
  readonly hash: string;
  /** Unix seconds, `'0'` when the envelope carries no upper timebound. */
  readonly maxTimeUnix: string;
  /**
   * Source account of the *inner* transaction; the account whose sequence
   * number this envelope consumes, i.e. the only account a second envelope
   * could collide with. A fee bump pays for someone else's transaction; the
   * sequence number still belongs to the inner source.
   */
  readonly sourceAccount: string;
}

export async function envelopeIdentity(
  network: NetworkConfig,
  signedXdr: string,
): Promise<EnvelopeIdentity> {
  const { TransactionBuilder } = await import('@stellar/stellar-sdk');
  const tx = TransactionBuilder.fromXDR(signedXdr, network.passphrase);
  const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
  return {
    hash: tx.hash().toString('hex'),
    // The fee-bump envelope has no timebounds of its own; the inner one does,
    // and it is the inner transaction that expires.
    maxTimeUnix: String(inner.timeBounds?.maxTime ?? '0'),
    sourceAccount: inner.source,
  };
}

function httpStatusOf(err: unknown): number | null {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Result codes from Horizon's `extras`, i.e. a *reasoned* rejection: the
 * network looked at the transaction and said no. Anything that carries one of
 * these is a real failure and must never be softened into "unknown", that
 * would turn every `op_underfunded` into a three-minute wait for nothing.
 */
function resultCodeOf(err: unknown): string | null {
  const extras = (
    err as {
      response?: {
        data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } };
      };
    }
  )?.response?.data?.extras;
  return (
    extras?.result_codes?.operations?.filter((c) => c !== 'op_success')[0] ??
    extras?.result_codes?.transaction ??
    null
  );
}

/**
 * Does this failure leave the outcome open?
 *
 * The asymmetry decides the rule: calling an unknown outcome "failed" can cost
 * the user a second real payment, calling a real failure "unknown" costs them
 * a wait until the timebound expires and then a retry. So everything without a
 * result code that could plausibly have reached the network counts as open,
 * 5xx (Horizon's own 504 on a ledger backlog explicitly means "submitted, not
 * confirmed in time"), 429, our aborted deadline, and any error without an
 * HTTP status at all. A 4xx *with* a body Horizon wrote (400 malformed, 404
 * wrong path) stays a plain failure: those never reach consensus.
 */
export function unresolvedReasonFor(err: unknown): UnresolvedReason | null {
  if (resultCodeOf(err) !== null) return null;
  if (err instanceof AppError && err.code === 'NETWORK_ERROR') {
    const detail = err.detail ?? '';
    if (detail.includes('timeout') || detail.includes('abort')) return 'timeout';
  }
  const status = httpStatusOf(err);
  if (status === null) {
    // No HTTP answer to point at. `TypeError: Failed to fetch`, an aborted
    // request, DNS, none of them tell us whether the bytes arrived.
    return 'transport';
  }
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server_error';
  return null;
}

export async function submitTransactionXdr(
  network: NetworkConfig,
  signedXdr: string,
): Promise<SubmitResult> {
  const { TransactionBuilder } = await import('@stellar/stellar-sdk');
  const tx = TransactionBuilder.fromXDR(signedXdr, network.passphrase);
  const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
  // Computed *before* the request goes out, so every branch below, including
  // the ones that never see a response, can name the transaction it is
  // talking about. Without this there was nothing to look the payment up with.
  const hash = tx.hash().toString('hex');
  const maxTimeUnix = String(inner.timeBounds?.maxTime ?? '0');
  const unresolved = (reason: UnresolvedReason): SubmitResult => ({
    outcome: 'unknown',
    hash,
    successful: false,
    ledger: null,
    maxTimeUnix,
    reason,
  });

  try {
    const res = await limited(
      (signal) => horizonServer(network, signal).submitTransaction(tx),
      HORIZON_SUBMIT_TIMEOUT_MS,
    );
    // An honest Horizon reports a failed transaction with HTTP 400, which lands
    // in the catch below. A misbehaving or hostile endpoint answering
    // `200 {successful: false}` used to render the green "sent!" screen, the
    // flag was computed and then never read anywhere. It is now what it always
    // was: an endpoint claiming success and failure in one breath, i.e. an
    // outcome we do not know. It is reported as `reason: 'ambiguous'`, not as
    // a `TX_FAILED:*` code: there is no result code to explain and nothing here
    // may claim the transaction did not happen.
    if (res.successful === false) return unresolved('ambiguous');
    /**
     * The reported hash used to be *preferred* over the one computed from the
     * bytes we sent, and the two were never compared. They can only differ if
     * the endpoint is answering about a different transaction than the one it
     * was given, in which case its "success" says nothing about ours, so the
     * outcome is exactly as open as a timeout. The locally computed hash is the
     * authoritative one either way: it is derived from the envelope in hand,
     * before anything left the process.
     */
    const reported = typeof res.hash === 'string' ? res.hash : '';
    if (reported.length > 0 && reported !== hash) return unresolved('ambiguous');
    return {
      outcome: 'success',
      hash,
      successful: res.successful,
      ledger: typeof res.ledger === 'number' ? res.ledger : null,
      maxTimeUnix,
      reason: null,
    };
  } catch (err) {
    const code = resultCodeOf(err);
    if (code) throw new AppError(`TX_FAILED:${code}`);
    const reason = unresolvedReasonFor(err);
    if (reason !== null) return unresolved(reason);
    throw new AppError('NETWORK_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/** Grace on top of `maxTime` before a 404 is read as "never included". */
export const TX_LOOKUP_GRACE_MS = 30_000;

/**
 * What `GET /transactions/{hash}` says about a submitted envelope.
 *
 * `included: false` is *not* "gone": Horizon answers 404 for a transaction it
 * has not ingested yet, which is the normal state for the first few seconds
 * after submission. Only the caller, holding the envelope's `maxTime`, can turn
 * a 404 into a final answer, see {@link resolveSubmission}.
 */
export interface TxLookup {
  readonly included: boolean;
  readonly successful: boolean | null;
  readonly ledger: number | null;
  /** Horizon's result code when the transaction was included but failed. */
  readonly resultCode: string | null;
}

export async function fetchTransactionByHash(
  network: NetworkConfig,
  hash: string,
): Promise<TxLookup> {
  try {
    const record = await limited(
      (signal) => horizonServer(network, signal).transactions().transaction(hash).call(),
      HORIZON_TIMEOUT_MS,
    );
    const raw = record as unknown as Record<string, unknown>;
    const codes = (raw['extras'] as { result_codes?: { transaction?: string } } | undefined)
      ?.result_codes;
    return {
      included: true,
      successful: record.successful !== false,
      ledger: typeof record.ledger === 'number' ? record.ledger : null,
      resultCode: typeof codes?.transaction === 'string' ? codes.transaction : null,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { included: false, successful: null, ledger: null, resultCode: null };
    }
    throw new AppError('NETWORK_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * One resolution step for a submission whose outcome is unknown.
 *
 * - `included` , Horizon has it. `successful` says which way it went.
 * - `pending`  , not there yet, and the envelope can still make it into a
 *                 ledger. Ask again later; do **not** offer a retry.
 * - `expired`  , not there, and `maxTime` (plus {@link TX_LOOKUP_GRACE_MS} for
 *                 Horizon's ingestion lag) has passed. Stellar rejects the
 *                 envelope from here on with `tx_too_late`, so this is the
 *                 first moment a 404 is a *statement*: it never landed, and
 *                 sending again is safe.
 * - `unknown`  ; the lookup itself failed. Still no answer, keep waiting.
 *
 * The deadline comes from the envelope, never from a number invented here: a
 * transaction is valid exactly as long as its own timebound says.
 */
export type ResolutionState = 'included' | 'pending' | 'expired' | 'unknown';

export interface Resolution {
  readonly state: ResolutionState;
  readonly successful: boolean | null;
  readonly ledger: number | null;
  readonly resultCode: string | null;
}

export async function resolveSubmission(
  network: NetworkConfig,
  hash: string,
  maxTimeUnix: string,
  now: number = Date.now(),
): Promise<Resolution> {
  let lookup: TxLookup;
  try {
    lookup = await fetchTransactionByHash(network, hash);
  } catch {
    return { state: 'unknown', successful: null, ledger: null, resultCode: null };
  }
  if (lookup.included) {
    return {
      state: 'included',
      successful: lookup.successful,
      ledger: lookup.ledger,
      resultCode: lookup.resultCode,
    };
  }
  const maxTime = Number(maxTimeUnix);
  // `0` is Stellar's "no upper timebound". Nothing can ever prove such an
  // envelope will not be included, so it never expires here; the UI says so
  // instead of pretending otherwise. The wallet's own builder always sets one.
  const expired =
    Number.isFinite(maxTime) && maxTime > 0 && now > maxTime * 1000 + TX_LOOKUP_GRACE_MS;
  return {
    state: expired ? 'expired' : 'pending',
    successful: null,
    ledger: null,
    resultCode: null,
  };
}

/** Testnet convenience funding (§6 friendbot button on Home). */
export async function fundWithFriendbot(
  network: NetworkConfig,
  accountId: string,
): Promise<void> {
  if (!network.friendbotUrl) {
    throw new AppError('BAD_REQUEST', 'friendbot is not available on this network');
  }
  const url = `${network.friendbotUrl}?addr=${encodeURIComponent(accountId)}`;
  // A bare `fetch` is the one call site where the deadline's signal reaches
  // the request directly, with no client in between.
  const res = await limited((signal) => fetch(url, { signal }), HORIZON_TIMEOUT_MS);
  if (!res.ok && res.status !== 400) {
    throw new AppError('NETWORK_ERROR', `friendbot responded ${res.status}`);
  }
}

/**
 * Best strict-send path across the Stellar DEX: "I send exactly `sendAmount`
 * of `sendAssetId`, how much `destAssetId` comes out?". Horizon returns the
 * candidate paths sorted best-first, so the first record is the quote we show.
 * `null` means the order books currently offer no route at all, a normal
 * answer, not an error (the UI says so in plain language).
 */
export interface StrictSendQuote {
  /** What the best path currently yields, in `destAssetId`. */
  readonly destAmount: string;
  /** Intermediate hops as asset ids (`native` / `CODE:ISSUER`), often empty. */
  readonly path: readonly string[];
}

interface PathAssetRecord {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
}

function pathAssetToId(record: PathAssetRecord): string {
  if (record.asset_type === 'native') return 'native';
  return `${record.asset_code ?? ''}:${record.asset_issuer ?? ''}`;
}

export async function findStrictSendPath(
  network: NetworkConfig,
  sendAssetId: string,
  sendAmount: string,
  destAssetId: string,
): Promise<StrictSendQuote | null> {
  try {
    const page = await limited((signal) =>
      horizonServer(network, signal)
        .strictSendPaths(assetFromId(sendAssetId), sendAmount, [assetFromId(destAssetId)])
        .call(),
      HORIZON_TIMEOUT_MS,
    );
    const best = page.records[0] as
      | { destination_amount: string; path: readonly PathAssetRecord[] }
      | undefined;
    if (!best) return null;
    return {
      destAmount: best.destination_amount,
      path: best.path.map(pathAssetToId),
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new AppError('NETWORK_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/** Assets held by the account, in the `native` / `CODE:ISSUER` form. */
export function assetIdsOf(snapshot: AccountSnapshot): string[] {
  return snapshot.balances.map((b) => b.id);
}

export function assetFromId(id: string): Asset {
  if (id === 'native') return Asset.native();
  const [code, issuer] = id.split(':');
  if (!code || !issuer) throw new AppError('BAD_REQUEST', `malformed asset id: ${id}`);
  return new Asset(code, issuer);
}
