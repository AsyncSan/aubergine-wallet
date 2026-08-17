/**
 * Zeroization helpers.
 *
 * ARCHITECTURE.md §3, invariant 6: key material lives in `Uint8Array` and is
 * overwritten with `.fill(0)` as soon as it is no longer needed. It must never
 * be parked in JS strings, which the GC may copy around uncontrollably.
 */

/** Overwrite every provided buffer in place. Safe to call with undefined slots. */
export function zeroize(...buffers: Array<Uint8Array | undefined | null>): void {
  for (const buf of buffers) {
    if (buf) buf.fill(0);
  }
}

/**
 * Run `fn` and zeroize `buffers` afterwards, whether it resolves or throws.
 */
export async function withZeroized<T>(
  buffers: Uint8Array[],
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    zeroize(...buffers);
  }
}

const encoder = new TextEncoder();

/**
 * UTF-8 encode a secret string into a zeroizable buffer.
 *
 * The source string still exists (it came from a DOM input), but from this
 * point on the pipeline only handles bytes we control.
 */
export function secretToBytes(secret: string): Uint8Array {
  return encoder.encode(secret.normalize('NFKD'));
}
