/**
 * The user's own Soroban RPC endpoint must never reach `chrome.storage.sync`.
 *
 * This is not a preference, it is a credential: the endpoint format that
 * motivated the feature carries the API key in the URL path
 * (`https://stellar-mainnet.g.alchemy.com/v2/<key>`). Syncing it would copy a
 * paid key into every profile the user is signed into, over a channel neither
 * they nor we control, invariant 2 keeps secrets out of `storage.sync`, and a
 * key in a URL is still a key.
 *
 * The read direction matters just as much: if a sync record could carry the
 * field, a foreign or hand-edited record would decide which host this wallet's
 * Soroban traffic goes to.
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
  browser: { storage: { local: area(localStore), sync: area(syncStore) } },
}));

const { readSettings, writeSettings, SETTINGS_KEY } = await import(
  '../src/background/storage'
);
const { DEFAULT_SETTINGS } = await import('../src/core/settings');

const OWN_ENDPOINT = 'https://stellar-mainnet.g.alchemy.com/v2/super-secret-key';

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

describe('sorobanRpcOverride', () => {
  it('is written to local but stripped from sync', async () => {
    await writeSettings({
      ...DEFAULT_SETTINGS,
      mode: 'developer',
      sorobanRpcOverride: OWN_ENDPOINT,
    });

    const local = localStore.get(SETTINGS_KEY) as Record<string, unknown>;
    expect(local['sorobanRpcOverride']).toBe(OWN_ENDPOINT);

    const sync = syncStore.get(SETTINGS_KEY) as Record<string, unknown>;
    expect('sorobanRpcOverride' in sync).toBe(false);
    // Nothing else in the synced record may carry the key either.
    expect(JSON.stringify(sync)).not.toContain('super-secret-key');
    // Preferences still sync; the strip must be surgical, not a blanket veto.
    expect(sync['mode']).toBe('developer');
  });

  it('round-trips through local storage', async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, sorobanRpcOverride: OWN_ENDPOINT });
    expect((await readSettings()).sorobanRpcOverride).toBe(OWN_ENDPOINT);
  });

  it('is ignored when it arrives from sync alone', async () => {
    // What a pre-fix build, another profile, or a hand-edited sync store would
    // replicate in. Honouring it would let a foreign record redirect this
    // wallet's Soroban traffic.
    syncStore.set(SETTINGS_KEY, {
      ...DEFAULT_SETTINGS,
      mode: 'developer',
      sorobanRpcOverride: 'https://stellar-mainnet.g.alchemy.com/v2/attacker-key',
    });
    const settings = await readSettings();
    expect(settings.sorobanRpcOverride).toBeNull();
    expect(settings.mode).toBe('developer'); // the preference still arrives
  });

  it('cannot be overwritten from sync when a local value exists', async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, sorobanRpcOverride: OWN_ENDPOINT });
    syncStore.set(SETTINGS_KEY, {
      ...DEFAULT_SETTINGS,
      sorobanRpcOverride: 'https://stellar-testnet.g.alchemy.com/v2/attacker-key',
    });
    expect((await readSettings()).sorobanRpcOverride).toBe(OWN_ENDPOINT);
  });

  it('drops an http: value stored by some other writer', async () => {
    // `parseSettingsRecord` validates key by key, so a bad endpoint falls back
    // to the default instead of being handed to the RPC client.
    localStore.set(SETTINGS_KEY, {
      ...DEFAULT_SETTINGS,
      sorobanRpcOverride: 'http://stellar-mainnet.g.alchemy.com/v2/k',
    });
    expect((await readSettings()).sorobanRpcOverride).toBeNull();
  });

  it('clears cleanly', async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, sorobanRpcOverride: OWN_ENDPOINT });
    await writeSettings({ ...DEFAULT_SETTINGS, sorobanRpcOverride: null });
    expect((await readSettings()).sorobanRpcOverride).toBeNull();
    expect(JSON.stringify(localStore.get(SETTINGS_KEY))).not.toContain('super-secret-key');
  });
});
