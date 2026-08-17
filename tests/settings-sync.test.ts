/**
 * Security grants must not travel over `chrome.storage.sync`.
 *
 * `mainnetAcknowledged`, `allowedOrigins` and `developerModeAcknowledged` are
 * capabilities the user earns on ONE installation (typed MAINNET confirmation,
 * explicit origin approval, acknowledged developer warning). Before this fix
 * they were written to sync and read back with sync taking precedence, so a
 * grant earned on profile A silently applied on profile B, and §4 footnote 2's
 * "on this installation" did not hold. These tests pin the fix from both
 * directions: the writer never puts the grants into sync, and the reader
 * ignores them even when a foreign record carries them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Area = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

function area(store: Map<string, unknown>): Area {
  return {
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (values) => {
      for (const [k, v] of Object.entries(values)) store.set(k, v);
    },
    remove: async (key) => {
      store.delete(key);
    },
  };
}

const localStore = new Map<string, unknown>();
const syncStore = new Map<string, unknown>();

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: area(localStore), sync: area(syncStore) },
  },
}));

const { readSettings, writeSettings, SETTINGS_KEY } = await import(
  '../src/background/storage'
);
const { DEFAULT_SETTINGS } = await import('../src/core/settings');

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

describe('writeSettings', () => {
  it('writes the full record to local but strips the security grants from sync', async () => {
    await writeSettings({
      ...DEFAULT_SETTINGS,
      mode: 'developer',
      developerModeAcknowledged: true,
      mainnetAcknowledged: true,
      networkId: 'mainnet',
      allowedOrigins: ['https://dapp.example'],
    });

    const local = localStore.get(SETTINGS_KEY) as Record<string, unknown>;
    expect(local['mainnetAcknowledged']).toBe(true);
    expect(local['developerModeAcknowledged']).toBe(true);
    expect(local['allowedOrigins']).toEqual(['https://dapp.example']);

    const sync = syncStore.get(SETTINGS_KEY) as Record<string, unknown>;
    expect(sync['mode']).toBe('developer'); // preferences still sync
    expect('mainnetAcknowledged' in sync).toBe(false);
    expect('developerModeAcknowledged' in sync).toBe(false);
    expect('allowedOrigins' in sync).toBe(false);
  });
});

describe('readSettings', () => {
  it('ignores grants that arrive via sync only (cross-profile replication)', async () => {
    // What another profile's pre-fix build (or a hand-edited sync store) would
    // replicate in: a complete record carrying every grant.
    syncStore.set(SETTINGS_KEY, {
      ...DEFAULT_SETTINGS,
      mode: 'developer',
      developerModeAcknowledged: true,
      mainnetAcknowledged: true,
      networkId: 'mainnet',
      allowedOrigins: ['https://dapp.example'],
    });

    const settings = await readSettings();
    // The preference half replicates …
    expect(settings.mode).toBe('developer');
    expect(settings.networkId).toBe('mainnet');
    // … the capability half does not: this installation never earned it.
    expect(settings.mainnetAcknowledged).toBe(false);
    expect(settings.developerModeAcknowledged).toBe(false);
    expect(settings.allowedOrigins).toEqual([]);
  });

  it('keeps grants earned locally, with sync preferences layered on top', async () => {
    await writeSettings({
      ...DEFAULT_SETTINGS,
      mainnetAcknowledged: true,
      networkId: 'mainnet',
    });
    // A sync record from elsewhere flips a preference and (maliciously or
    // accidentally) tries to *revoke-and-regrant* the capability fields.
    syncStore.set(SETTINGS_KEY, {
      ...DEFAULT_SETTINGS,
      locale: 'en',
      mainnetAcknowledged: false,
      allowedOrigins: ['https://evil.example'],
    });

    const settings = await readSettings();
    expect(settings.locale).toBe('en');
    expect(settings.mainnetAcknowledged).toBe(true); // local grant survives
    expect(settings.allowedOrigins).toEqual([]); // sync origins never land
  });

  it('round-trips all grants through local storage', async () => {
    const written = {
      ...DEFAULT_SETTINGS,
      mode: 'developer' as const,
      developerModeAcknowledged: true,
      allowedOrigins: ['https://dapp.example'],
    };
    await writeSettings(written);
    expect(await readSettings()).toEqual(written);
  });
});
