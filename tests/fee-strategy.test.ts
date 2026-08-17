/**
 * The fee strategy: parsing `/fee_stats`, choosing a fee from it, caching the
 * answer, and failing *open* when Horizon does not answer at all.
 *
 * Why this file exists: all three builders used to hard-code `BASE_FEE` (100
 * stroops) and nothing in the production code ever called `/fee_stats`. On
 * Mainnet under surge pricing that is either `tx_insufficient_fee` or, more
 * often, no inclusion at all and `tx_too_late` after 180 s. The tests below
 * pin the four properties that make the fix safe rather than merely present:
 *
 *  1. a hostile or broken payload cannot produce a fee at all (parse), and
 *     cannot produce an unbounded one (cap),
 *  2. a calm market still yields exactly 100; the fee this wallet shipped
 *     with, so nothing about the everyday case changed,
 *  3. an unreachable `/fee_stats` never blocks a build (fail-open),
 *  4. the fee is a *per operation* quantity and the envelope's total is
 *     per-operation × operation count. Those two are easy to confuse and the
 *     ceiling is expressed in the first one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_FEE, Horizon } from '@stellar/stellar-sdk';
import {
  CONGESTION_THRESHOLD,
  FEE_STATS_TTL_MS,
  MAX_FEE_PER_OPERATION_STROOPS,
  SURGE_HEADROOM,
  chooseFee,
  fetchFeeStats,
  parseFeeStats,
  resetFeeStatsCache,
  type FeeStats,
} from '../src/core/stellar/horizon';
import { MAINNET, TESTNET } from '../src/core/stellar/networks';
import { RateLimiter, limited, withTimeout } from '../src/core/net/limiter';
import { AppError } from '../src/core/errors';

/* --------------------------------------------------------------- fixtures */

/** The shape Horizon actually returns; every value a string. */
function rawFeeStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    last_ledger: '1234567',
    last_ledger_base_fee: '100',
    ledger_capacity_usage: '0.03',
    fee_charged: {
      max: '100',
      min: '100',
      mode: '100',
      p10: '100',
      p20: '100',
      p30: '100',
      p40: '100',
      p50: '100',
      p60: '100',
      p70: '100',
      p80: '100',
      p90: '100',
      p95: '100',
      p99: '100',
    },
    max_fee: {
      max: '100000',
      min: '100',
      mode: '100',
      p50: '100',
      p90: '5000',
      p95: '10000',
      p99: '100000',
    },
    ...overrides,
  };
}

function stats(overrides: Partial<FeeStats> = {}): FeeStats {
  const parsed = parseFeeStats(rawFeeStats());
  if (parsed === null) throw new Error('fixture did not parse');
  return { ...parsed, ...overrides };
}

function distribution(overrides: Partial<FeeStats['feeCharged']> = {}): FeeStats['feeCharged'] {
  return {
    min: null,
    mode: null,
    p50: null,
    p90: null,
    p95: null,
    p99: null,
    max: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetFeeStatsCache();
});

/* ------------------------------------------------------------- 1. parsing */

describe('parseFeeStats', () => {
  it('reads the documented Horizon shape, strings and all', () => {
    const parsed = parseFeeStats(rawFeeStats());
    expect(parsed).not.toBeNull();
    expect(parsed?.lastLedgerBaseFee).toBe(100);
    expect(parsed?.ledgerCapacityUsage).toBeCloseTo(0.03);
    expect(parsed?.feeCharged.max).toBe(100);
    expect(parsed?.feeCharged.p95).toBe(100);
    // `max_fee` is parsed but deliberately not used for the choice.
    expect(parsed?.maxFee.p95).toBe(10_000);
    expect(parsed?.maxFee.p99).toBe(100_000);
  });

  it('survives a payload with whole sections missing', () => {
    const parsed = parseFeeStats({ last_ledger_base_fee: '100' });
    expect(parsed).not.toBeNull();
    expect(parsed?.lastLedgerBaseFee).toBe(100);
    expect(parsed?.ledgerCapacityUsage).toBeNull();
    expect(parsed?.feeCharged.max).toBeNull();
    expect(parsed?.maxFee.p95).toBeNull();
  });

  it('turns nonsense into null instead of into a number', () => {
    const parsed = parseFeeStats(
      rawFeeStats({
        last_ledger_base_fee: 'not a number',
        ledger_capacity_usage: '7', // outside 0…1
        fee_charged: {
          max: '-500',
          min: '',
          mode: null,
          p50: 'NaN',
          p90: {},
          p95: Infinity,
          p99: '0',
        },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.lastLedgerBaseFee).toBeNull();
    expect(parsed?.ledgerCapacityUsage).toBeNull();
    expect(parsed?.feeCharged).toEqual(distribution());
  });

  it('accepts numbers as well as strings; a variant Horizon proxy is still usable', () => {
    const parsed = parseFeeStats(
      rawFeeStats({ last_ledger_base_fee: 100, fee_charged: { max: 4200 } }),
    );
    expect(parsed?.lastLedgerBaseFee).toBe(100);
    expect(parsed?.feeCharged.max).toBe(4200);
  });

  it('rejects anything that is not a Horizon object at all', () => {
    expect(parseFeeStats(null)).toBeNull();
    expect(parseFeeStats(undefined)).toBeNull();
    expect(parseFeeStats('<html>502 Bad Gateway</html>')).toBeNull();
    expect(parseFeeStats([1, 2, 3])).toBeNull();
    expect(parseFeeStats(42)).toBeNull();
  });
});

/* ----------------------------------------------------------- 2. the choice */

describe('chooseFee', () => {
  it('is BASE_FEE when there are no stats at all (fail-open)', () => {
    const plan = chooseFee(null);
    expect(plan.perOperationStroops).toBe(BASE_FEE);
    expect(plan.source).toBe('base');
    expect(plan.surge).toBe(false);
  });

  it('is BASE_FEE when the stats contain nothing usable', () => {
    const empty: FeeStats = {
      lastLedgerBaseFee: null,
      ledgerCapacityUsage: null,
      feeCharged: distribution(),
      maxFee: distribution(),
    };
    expect(chooseFee(empty).perOperationStroops).toBe('100');
    expect(chooseFee(empty).source).toBe('base');
  });

  it('leaves a calm market at exactly 100; the fee the wallet always used', () => {
    const plan = chooseFee(stats());
    expect(plan.perOperationStroops).toBe('100');
    expect(plan.totalStroops).toBe('100');
    expect(plan.surge).toBe(false);
  });

  it('follows the price the network actually charged during a surge', () => {
    const plan = chooseFee(
      stats({
        ledgerCapacityUsage: 0.98,
        feeCharged: distribution({ mode: 2000, p95: 6000, max: 8000 }),
      }),
    );
    // congested -> observed clearing price × headroom
    expect(plan.perOperationStroops).toBe(String(8000 * SURGE_HEADROOM));
    expect(plan.source).toBe('network');
    expect(plan.surge).toBe(true);
  });

  it('adds no headroom while the ledger is not contended', () => {
    const plan = chooseFee(
      stats({
        ledgerCapacityUsage: CONGESTION_THRESHOLD - 0.01,
        feeCharged: distribution({ max: 8000 }),
      }),
    );
    expect(plan.perOperationStroops).toBe('8000');
    expect(plan.surge).toBe(true);
  });

  it('falls back through the percentiles when `max` is missing', () => {
    expect(
      chooseFee(stats({ feeCharged: distribution({ p95: 700 }) })).perOperationStroops,
    ).toBe('700');
    expect(
      chooseFee(stats({ feeCharged: distribution({ mode: 300 }) })).perOperationStroops,
    ).toBe('300');
    // Nothing in fee_charged at all: the last ledger's base fee is the floor.
    expect(
      chooseFee(stats({ feeCharged: distribution(), lastLedgerBaseFee: 250 }))
        .perOperationStroops,
    ).toBe('250');
  });

  it('never goes below BASE_FEE, however low the network reports', () => {
    const plan = chooseFee(
      stats({ lastLedgerBaseFee: 1, feeCharged: distribution({ max: 1, p95: 1 }) }),
    );
    expect(plan.perOperationStroops).toBe('100');
  });

  it('caps an absurd, or hostile, answer at the ceiling', () => {
    for (const absurd of [1_000_000, 2_147_483_647, 999_999_999_999]) {
      const plan = chooseFee(stats({ feeCharged: distribution({ max: absurd }) }));
      expect(plan.perOperationStroops).toBe(String(MAX_FEE_PER_OPERATION_STROOPS));
      expect(plan.source).toBe('capped');
      expect(plan.surge).toBe(true);
    }
  });

  it('applies the cap to the headroom, not only to the raw reading', () => {
    // 50_000 × 4 = 200_000, which is over the ceiling.
    const plan = chooseFee(
      stats({ ledgerCapacityUsage: 0.9, feeCharged: distribution({ max: 50_000 }) }),
    );
    expect(plan.perOperationStroops).toBe(String(MAX_FEE_PER_OPERATION_STROOPS));
    expect(plan.source).toBe('capped');
  });

  it('caps per operation and reports the total separately', () => {
    const plan = chooseFee(stats({ feeCharged: distribution({ max: 999_999_999 }) }), 4);
    expect(plan.perOperationStroops).toBe(String(MAX_FEE_PER_OPERATION_STROOPS));
    expect(plan.totalStroops).toBe(String(MAX_FEE_PER_OPERATION_STROOPS * 4));
    // The worst case for a whole envelope stays bounded: even at Stellar's
    // protocol maximum of 100 operations the ceiling is 1 XLM.
    expect(Number(chooseFee(null, 100).totalStroops)).toBe(10_000);
    expect(
      Number(chooseFee(stats({ feeCharged: distribution({ max: 1e12 }) }), 100).totalStroops),
    ).toBe(10_000_000);
  });

  it('treats a nonsensical operation count as one operation', () => {
    for (const count of [0, -3, Number.NaN, 0.5]) {
      expect(chooseFee(stats(), count).totalStroops).toBe('100');
    }
  });
});

/* -------------------------------------------------------- 3. fetch + cache */

/** Intercepts exactly the SDK call `fetchFeeStats` makes, no network. */
function stubFeeStats(impl: () => Promise<unknown>) {
  return vi
    .spyOn(Horizon.Server.prototype, 'feeStats')
    .mockImplementation(impl as () => Promise<Horizon.HorizonApi.FeeStatsResponse>);
}

describe('fetchFeeStats', () => {
  it('parses what the SDK hands back', async () => {
    stubFeeStats(async () => rawFeeStats());
    const result = await fetchFeeStats(TESTNET);
    expect(result?.feeCharged.max).toBe(100);
  });

  it('answers from cache inside the TTL and refetches after it', async () => {
    const spy = stubFeeStats(async () => rawFeeStats());
    // `now` is injected rather than mocked: the token bucket in
    // `core/net/limiter.ts` is a process-wide singleton that remembers the
    // last start time, so winding the real clock forward and back again would
    // make every later request in this file sleep for the difference.
    const t0 = Date.now();
    await fetchFeeStats(TESTNET, t0);
    await fetchFeeStats(TESTNET, t0 + 1);
    await fetchFeeStats(TESTNET, t0 + FEE_STATS_TTL_MS - 1);
    expect(spy).toHaveBeenCalledTimes(1);

    await fetchFeeStats(TESTNET, t0 + FEE_STATS_TTL_MS + 1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps one entry per network, testnet levels never price a mainnet fee', async () => {
    const spy = stubFeeStats(async () => rawFeeStats());
    await fetchFeeStats(TESTNET);
    await fetchFeeStats(MAINNET);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(TESTNET.horizonUrl).not.toBe(MAINNET.horizonUrl);
  });

  it('forgets everything on demand (settings change / test seam)', async () => {
    const spy = stubFeeStats(async () => rawFeeStats());
    await fetchFeeStats(TESTNET);
    resetFeeStatsCache();
    await fetchFeeStats(TESTNET);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fails open: an unreachable endpoint is `null`, not an exception', async () => {
    stubFeeStats(async () => {
      throw new AppError('NETWORK_ERROR', 'timeout after 20000 ms');
    });
    await expect(fetchFeeStats(TESTNET)).resolves.toBeNull();
    // …and a build on top of that answer still gets a usable fee.
    expect(chooseFee(await fetchFeeStats(TESTNET)).perOperationStroops).toBe(BASE_FEE);
  });

  it('fails open on a non-JSON answer (captive portal, proxy error page)', async () => {
    stubFeeStats(async () => '<html>503</html>');
    await expect(fetchFeeStats(TESTNET)).resolves.toBeNull();
  });

  it('caches the failure too, so a dead endpoint costs one timeout per window', async () => {
    const spy = stubFeeStats(async () => {
      throw new Error('fetch failed');
    });
    await fetchFeeStats(TESTNET);
    await fetchFeeStats(TESTNET);
    await fetchFeeStats(TESTNET);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------------------------------- 4. the shared limiter */

describe('the request budget lives in one place', () => {
  it('never lets more than `maxConcurrent` requests run at once', async () => {
    const bucket = new RateLimiter(2, 5);
    let inFlight = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      const release = await bucket.acquire();
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      release();
    };
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });

  it('keeps successive starts at least one interval apart', async () => {
    // The guarantee the bucket actually provides. Two acquires that *wait*
    // concurrently can still wake in the same tick, see the report; this
    // pins the sequential case, which is the popup's normal traffic shape.
    const bucket = new RateLimiter(1, 25);
    const starts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const release = await bucket.acquire();
      starts.push(Date.now());
      release();
    }
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(24);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(24);
  });

  it('rejects with the caller-supplied error after the deadline', async () => {
    class Marker extends Error {}
    await expect(
      withTimeout(new Promise(() => {}), 5, () => new Marker('gave up')),
    ).rejects.toBeInstanceOf(Marker);
    // Default: the typed NETWORK_ERROR the wallet already knows how to show.
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(AppError);
  });

  it('releases the slot even when the call throws', async () => {
    await expect(
      limited(async () => {
        throw new Error('boom');
      }, 1_000),
    ).rejects.toThrow('boom');
    await expect(limited(async () => 'ok', 1_000)).resolves.toBe('ok');
  });
});
