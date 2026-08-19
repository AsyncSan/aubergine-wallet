/**
 * `core/crypto/random`: the CSPRNG helpers the onboarding backup quiz uses in
 * place of `Math.random`.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomInt, shuffled } from '../src/core/crypto/random';

describe('randomInt', () => {
  it('stays inside [0, bound)', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = randomInt(12);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(12);
    }
  });

  it('has no choice to make for a bound of one', () => {
    expect(randomInt(1)).toBe(0);
  });

  it('refuses a bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => randomInt(bad)).toThrow(RangeError);
    }
  });

  it('reaches every value in the range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i += 1) seen.add(randomInt(12));
    expect(seen.size).toBe(12);
  });

  /**
   * The reason for rejection sampling rather than `% bound`. A draw at or
   * above the largest multiple of `bound` that fits in a uint32 must be
   * discarded, not folded back onto a low value.
   */
  it('discards a draw from the biased tail instead of folding it in', () => {
    const bound = 12;
    const limit = 2 ** 32 - (2 ** 32 % bound);
    // Both rejects stay inside uint32 range so the Uint32Array does not wrap
    // them back down into the accepted band.
    const draws = [limit, limit + 3, 7]; // two rejects, then an accept
    let call = 0;
    const spy = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(buf: T): T => {
        (buf as unknown as Uint32Array)[0] = draws[call] ?? 0;
        call += 1;
        return buf;
      });

    expect(randomInt(bound)).toBe(7);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

describe('shuffled', () => {
  it('is a permutation and leaves the input alone', () => {
    const input = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const out = shuffled(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual([...input]);
    expect(input).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('handles the degenerate lengths', () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(['only'])).toEqual(['only']);
  });

  it('actually moves things', () => {
    const input = Array.from({ length: 12 }, (_, i) => i);
    // A correct shuffle returning identity 20 times running is ~1 in 12!^20.
    const anyReordered = Array.from({ length: 20 }, () => shuffled(input)).some(
      (out) => out.some((value, i) => value !== input[i]),
    );
    expect(anyReordered).toBe(true);
  });

  it('does not lean on Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    shuffled(Array.from({ length: 12 }, (_, i) => i));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
