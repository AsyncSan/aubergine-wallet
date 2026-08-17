/**
 * Debounced mirror of a fast-changing value.
 *
 * Exists for the swap quote (finding 5): the raw amount string is part of the
 * `swap.quote` query key, so every keystroke fired a Horizon path search *and*
 * a Soroswap POST. Debouncing before the value enters the key collapses a
 * typed "12.5" into one request instead of four.
 *
 * The screen compares the raw and the debounced value to know it is still
 * waiting; a quote for the previous amount must never be presented as if it
 * belonged to the current one.
 */
import { useEffect, useState } from 'react';

/** Long enough to swallow ordinary typing, short enough to feel immediate. */
export const DEFAULT_DEBOUNCE_MS = 400;

export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);

  return debounced;
}
