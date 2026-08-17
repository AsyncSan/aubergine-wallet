/**
 * Cosmetic UI preferences, sibling of `ui-progress.ts`.
 *
 * Currently one flag: `hideBalances`; the "undercover mode" toggled by
 * clicking the balance hero on Home. Strictly presentational: it masks what is
 * *rendered*, never what is fetched or signed, and it must never gate a
 * security decision. Nothing here is sensitive (invariant 2), and the value
 * survives popup restarts on purpose, someone who hid their balances on the
 * train expects them to stay hidden when the popup reopens.
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { browser } from 'wxt/browser';
import { z } from 'zod';

export const UI_PREFS_KEY = 'uiPrefs.v1';
const QUERY_KEY = ['uiPrefs'] as const;

const uiPrefsSchema = z.object({
  /** Render all amounts as bullets ("undercover mode"). */
  hideBalances: z.boolean().default(false),
});

export type UiPrefs = z.infer<typeof uiPrefsSchema>;

export const DEFAULT_UI_PREFS: UiPrefs = uiPrefsSchema.parse({});

/** What a masked amount renders as, everywhere it is masked. */
export const MASKED_AMOUNT = '••••';

export async function readUiPrefs(): Promise<UiPrefs> {
  try {
    const stored = await browser.storage.local.get(UI_PREFS_KEY);
    const parsed = uiPrefsSchema.safeParse(stored[UI_PREFS_KEY]);
    return parsed.success ? parsed.data : DEFAULT_UI_PREFS;
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

/**
 * Serialises every mutation, exactly as in `ui-progress.ts`: read-modify-write
 * on `storage.local` is not atomic, so two overlapping writes both read the
 * same "before" value and the later one dropped the earlier flag (finding 12).
 */
let writeQueue: Promise<void> = Promise.resolve();

function serialize(task: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(task, task);
  // Never let one rejection poison the queue for later writers.
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Merge-write; unknown stored shapes reset cleanly to the defaults. */
export async function writeUiPrefs(patch: Partial<UiPrefs>): Promise<void> {
  return serialize(async () => {
    try {
      const current = await readUiPrefs();
      await browser.storage.local.set({ [UI_PREFS_KEY]: { ...current, ...patch } });
    } catch {
      /* cosmetic; a failed write must never break a flow */
    }
  });
}

/** Called on wallet reset so a fresh wallet starts with default prefs. */
export async function clearUiPrefs(): Promise<void> {
  return serialize(async () => {
    try {
      await browser.storage.local.remove(UI_PREFS_KEY);
    } catch {
      /* cosmetic */
    }
  });
}

export function useUiPrefs(): UseQueryResult<UiPrefs> {
  return useQuery({ queryKey: QUERY_KEY, queryFn: readUiPrefs, staleTime: 1_000 });
}

/** Write a pref and refresh every consumer. */
export function useSetUiPrefs(): (patch: Partial<UiPrefs>) => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    async (patch: Partial<UiPrefs>) => {
      await writeUiPrefs(patch);
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    [client],
  );
}
