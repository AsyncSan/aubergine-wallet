/**
 * Cosmetic UI progress (redesign v1.1, docs/ui-redesign-konzept.md §5).
 *
 * Backs the security checklist on Home and the onboarding completion moment.
 * Strictly presentational state: it must never gate a security decision, and
 * nothing here is sensitive (invariant 2, `storage.local` holds the keystore
 * ciphertext plus non-sensitive bookkeeping like this).
 *
 * "Phrase backed up" is only ever set by flows where the user actually saw and
 * confirmed the phrase (onboarding verify, import, Settings reveal), it is
 * recorded, not claimed (konzept §5).
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { browser } from 'wxt/browser';
import { z } from 'zod';

export const UI_PROGRESS_KEY = 'uiProgress.v1';
const QUERY_KEY = ['uiProgress'] as const;

const uiProgressSchema = z.object({
  /** The user confirmed the recovery phrase (verify step, import, or reveal). */
  backupConfirmed: z.boolean().default(false),
  /** At least one transaction was successfully submitted from this wallet. */
  firstTxDone: z.boolean().default(false),
  /** The user dismissed the completed checklist, never show it again. */
  checklistDismissed: z.boolean().default(false),
});

export type UiProgress = z.infer<typeof uiProgressSchema>;

export const DEFAULT_UI_PROGRESS: UiProgress = uiProgressSchema.parse({});

export async function readUiProgress(): Promise<UiProgress> {
  try {
    const stored = await browser.storage.local.get(UI_PROGRESS_KEY);
    const parsed = uiProgressSchema.safeParse(stored[UI_PROGRESS_KEY]);
    return parsed.success ? parsed.data : DEFAULT_UI_PROGRESS;
  } catch {
    return DEFAULT_UI_PROGRESS;
  }
}

/**
 * Serialises every mutation of the stored record.
 *
 * Read-modify-write on `storage.local` is not atomic: two overlapping
 * `markUiProgress` calls both read the same "before" value and the later write
 * silently dropped the earlier flag (finding 12); the checklist then lost e.g.
 * `firstTxDone` because a backup confirmation landed at the same moment. The
 * queue is per popup context, which is where the overlap happens.
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

/** Merge-write: flags only ever accumulate; unknown stored shapes reset cleanly. */
export async function markUiProgress(patch: Partial<UiProgress>): Promise<void> {
  return serialize(async () => {
    try {
      const current = await readUiProgress();
      await browser.storage.local.set({ [UI_PROGRESS_KEY]: { ...current, ...patch } });
    } catch {
      /* cosmetic; a failed write must never break a flow */
    }
  });
}

/** Called on wallet reset so a fresh wallet starts with a fresh checklist. */
export async function clearUiProgress(): Promise<void> {
  return serialize(async () => {
    try {
      await browser.storage.local.remove(UI_PROGRESS_KEY);
    } catch {
      /* cosmetic */
    }
  });
}

export function useUiProgress(): UseQueryResult<UiProgress> {
  return useQuery({ queryKey: QUERY_KEY, queryFn: readUiProgress, staleTime: 1_000 });
}

/** Write a progress flag and refresh every consumer (checklist ring etc.). */
export function useMarkUiProgress(): (patch: Partial<UiProgress>) => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    async (patch: Partial<UiProgress>) => {
      await markUiProgress(patch);
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    [client],
  );
}
