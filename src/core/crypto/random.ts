/**
 * Unbiased random integers and shuffles from the platform CSPRNG.
 *
 * Nothing in here derives key material, `@scure/bip39` does that over
 * `crypto.getRandomValues` on its own. This module exists for the places that
 * only *handle* a recovery phrase, the backup quiz above all, where
 * `Math.random()` would be adequate in practice and still wrong to have in a
 * wallet: it is the first thing an auditor greps for, and the cost of not
 * having to explain it is a dozen lines.
 *
 * Deliberately free of any `hash-wasm` import so the popup can use it without
 * pulling the Argon2 WASM blob into its bundle.
 */

/**
 * A uniform integer in `[0, bound)`.
 *
 * Rejection sampling, not `% bound`: the modulo of a 32-bit draw is biased
 * towards the low values whenever `bound` does not divide 2^32, and a shuffle
 * built on a biased index is a shuffle that favours some orderings. The bias
 * is tiny at these sizes and the fix is free, so there is no reason to carry
 * the caveat.
 */
export function randomInt(bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0) {
    throw new RangeError(`bound must be a positive integer: ${bound}`);
  }
  if (bound === 1) return 0;
  const range = 2 ** 32;
  // The largest multiple of `bound` that fits in a uint32; draws at or above
  // it are discarded rather than folded back in.
  const limit = range - (range % bound);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0] ?? 0;
    if (value < limit) return value % bound;
  }
}

/** Fisher-Yates over a copy; the input is left alone. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
