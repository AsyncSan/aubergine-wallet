/**
 * uiProgress.v1 (redesign v1.1); the cosmetic checklist store.
 *
 * The properties that matter: flags accumulate through merge-writes, garbage
 * in storage degrades to the defaults instead of crashing the popup, and a
 * reset wipes the slate. Nothing here is security-relevant by design.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStore = new Map<string, unknown>();

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) =>
          localStore.has(key) ? { [key]: localStore.get(key) } : {},
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) localStore.set(k, v);
        },
        remove: async (key: string) => {
          localStore.delete(key);
        },
      },
    },
  },
}));

const {
  DEFAULT_UI_PROGRESS,
  UI_PROGRESS_KEY,
  clearUiProgress,
  markUiProgress,
  readUiProgress,
} = await import('../src/state/ui-progress');

beforeEach(() => {
  localStore.clear();
});

describe('readUiProgress', () => {
  it('returns all-false defaults on a fresh install', async () => {
    expect(await readUiProgress()).toEqual({
      backupConfirmed: false,
      firstTxDone: false,
      checklistDismissed: false,
    });
  });

  it('falls back to the defaults when storage holds garbage', async () => {
    localStore.set(UI_PROGRESS_KEY, 'not-an-object');
    expect(await readUiProgress()).toEqual(DEFAULT_UI_PROGRESS);
    localStore.set(UI_PROGRESS_KEY, { backupConfirmed: 'yes' });
    expect(await readUiProgress()).toEqual(DEFAULT_UI_PROGRESS);
  });

  it('fills in missing flags from a partial (older) record', async () => {
    localStore.set(UI_PROGRESS_KEY, { backupConfirmed: true });
    expect(await readUiProgress()).toEqual({
      backupConfirmed: true,
      firstTxDone: false,
      checklistDismissed: false,
    });
  });
});

describe('markUiProgress', () => {
  it('merges: later flags do not erase earlier ones', async () => {
    await markUiProgress({ backupConfirmed: true });
    await markUiProgress({ firstTxDone: true });
    expect(await readUiProgress()).toEqual({
      backupConfirmed: true,
      firstTxDone: true,
      checklistDismissed: false,
    });
  });

  it('stores booleans only; nothing sensitive can end up in the record', async () => {
    await markUiProgress({ backupConfirmed: true });
    const stored = localStore.get(UI_PROGRESS_KEY) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'backupConfirmed',
      'checklistDismissed',
      'firstTxDone',
    ]);
    for (const value of Object.values(stored)) expect(typeof value).toBe('boolean');
  });
});

describe('clearUiProgress', () => {
  it('removes the record so a new wallet starts from zero', async () => {
    await markUiProgress({ backupConfirmed: true, firstTxDone: true });
    await clearUiProgress();
    expect(localStore.has(UI_PROGRESS_KEY)).toBe(false);
    expect(await readUiProgress()).toEqual(DEFAULT_UI_PROGRESS);
  });
});
