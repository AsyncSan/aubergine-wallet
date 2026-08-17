/**
 * Finding 12: `uiProgress` and `uiPrefs` do a read-modify-write on
 * `storage.local`, which is not atomic. Two overlapping calls used to read the
 * same "before" value, and the later write silently dropped the earlier flag,
 * a checklist item that vanished for no visible reason.
 *
 * The storage mock here deliberately has *latency*, because that is the whole
 * bug: without a gap between read and write the race cannot happen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStore = new Map<string, unknown>();

/** Every storage round trip yields to the event loop, like the real one. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => {
          await tick();
          return localStore.has(key) ? { [key]: localStore.get(key) } : {};
        },
        set: async (items: Record<string, unknown>) => {
          await tick();
          for (const [k, v] of Object.entries(items)) localStore.set(k, v);
        },
        remove: async (key: string) => {
          await tick();
          localStore.delete(key);
        },
      },
    },
  },
}));

const { UI_PROGRESS_KEY, clearUiProgress, markUiProgress, readUiProgress } = await import(
  '../src/state/ui-progress'
);
const { UI_PREFS_KEY, readUiPrefs, writeUiPrefs } = await import('../src/state/ui-prefs');

beforeEach(() => {
  localStore.clear();
});

describe('uiProgress writes are serialised', () => {
  it('keeps both flags when two marks overlap', async () => {
    await Promise.all([
      markUiProgress({ backupConfirmed: true }),
      markUiProgress({ firstTxDone: true }),
    ]);
    const progress = await readUiProgress();
    expect(progress.backupConfirmed).toBe(true);
    expect(progress.firstTxDone).toBe(true);
  });

  it('keeps every flag when three marks overlap', async () => {
    await Promise.all([
      markUiProgress({ backupConfirmed: true }),
      markUiProgress({ firstTxDone: true }),
      markUiProgress({ checklistDismissed: true }),
    ]);
    expect(await readUiProgress()).toEqual({
      backupConfirmed: true,
      firstTxDone: true,
      checklistDismissed: true,
    });
  });

  it('orders a clear against a concurrent mark instead of interleaving it', async () => {
    await markUiProgress({ backupConfirmed: true });
    await Promise.all([clearUiProgress(), markUiProgress({ firstTxDone: true })]);
    // Whatever the order, the result is a consistent record, never a merge of
    // a wiped and a stale read.
    const progress = await readUiProgress();
    expect(progress.backupConfirmed).toBe(false);
    expect(localStore.has(UI_PROGRESS_KEY)).toBe(progress.firstTxDone);
  });

  it('does not let one failing write poison the queue', async () => {
    const set = vi
      .spyOn((await import('wxt/browser')).browser.storage.local, 'set')
      .mockRejectedValueOnce(new Error('quota'));
    await markUiProgress({ backupConfirmed: true });
    set.mockRestore();
    await markUiProgress({ firstTxDone: true });
    expect((await readUiProgress()).firstTxDone).toBe(true);
  });
});

describe('uiPrefs writes are serialised', () => {
  it('does not lose a write when two overlap', async () => {
    await Promise.all([writeUiPrefs({ hideBalances: true }), writeUiPrefs({})]);
    expect((await readUiPrefs()).hideBalances).toBe(true);
    expect(localStore.has(UI_PREFS_KEY)).toBe(true);
  });

  it('applies overlapping toggles in call order', async () => {
    await Promise.all([
      writeUiPrefs({ hideBalances: true }),
      writeUiPrefs({ hideBalances: false }),
    ]);
    expect((await readUiPrefs()).hideBalances).toBe(false);
  });
});
