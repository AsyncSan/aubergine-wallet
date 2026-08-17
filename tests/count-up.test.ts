/**
 * Count-up animation helper (redesign v1.1, P2 "Micro-Interactions").
 *
 * The animation itself is exercised in the browser (E2E); what must hold
 * everywhere is the pure decimal rule: intermediate frames use exactly the
 * decimals the *target* has, so an integer balance never flickers through
 * fake cents and a 7-decimal balance never gets visually truncated mid-count.
 */
import { describe, expect, it } from 'vitest';
import { countUpDecimals } from '../src/ui/components/primitives';

describe('countUpDecimals()', () => {
  it('holds zero decimals for integer balances', () => {
    expect(countUpDecimals(0)).toBe(0);
    expect(countUpDecimals(250)).toBe(0);
    expect(countUpDecimals(-3)).toBe(0);
  });

  it('mirrors the decimals of fractional balances', () => {
    expect(countUpDecimals(120.5)).toBe(1);
    expect(countUpDecimals(0.25)).toBe(2);
    expect(countUpDecimals(1234.5678901)).toBe(7);
  });

  it('caps at the 7 decimals a stroop allows', () => {
    // A float can print more digits than Stellar amounts ever carry.
    expect(countUpDecimals(0.1 + 0.2)).toBe(7);
  });

  it('treats non-finite input as integer-like instead of crashing', () => {
    expect(countUpDecimals(Number.NaN)).toBe(0);
    expect(countUpDecimals(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
