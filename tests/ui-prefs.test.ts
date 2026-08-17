/**
 * uiPrefs.v1; the cosmetic preference store behind undercover mode.
 *
 * Same contract as uiProgress: merge-writes, garbage in storage degrades to
 * the defaults, reset wipes the slate, and nothing here may ever gate a
 * security decision (it only changes what is *rendered*).
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

const { DEFAULT_UI_PREFS, MASKED_AMOUNT, UI_PREFS_KEY, clearUiPrefs, readUiPrefs, writeUiPrefs } =
  await import('../src/state/ui-prefs');

beforeEach(() => {
  localStore.clear();
});

describe('uiPrefs store', () => {
  it('defaults to visible balances', async () => {
    expect(await readUiPrefs()).toEqual(DEFAULT_UI_PREFS);
    expect(DEFAULT_UI_PREFS.hideBalances).toBe(false);
  });

  it('persists the hide flag and reads it back', async () => {
    await writeUiPrefs({ hideBalances: true });
    expect((await readUiPrefs()).hideBalances).toBe(true);
  });

  it('toggles back to visible through a merge-write', async () => {
    await writeUiPrefs({ hideBalances: true });
    await writeUiPrefs({ hideBalances: false });
    expect((await readUiPrefs()).hideBalances).toBe(false);
  });

  it('degrades garbage in storage to the defaults instead of crashing', async () => {
    localStore.set(UI_PREFS_KEY, { hideBalances: 'yes please' });
    expect(await readUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it('clearUiPrefs removes the stored value', async () => {
    await writeUiPrefs({ hideBalances: true });
    await clearUiPrefs();
    expect(localStore.has(UI_PREFS_KEY)).toBe(false);
    expect(await readUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it('masks with bullets, never with a fake number', () => {
    expect(MASKED_AMOUNT).not.toMatch(/\d/u);
  });
});
