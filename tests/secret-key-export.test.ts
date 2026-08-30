/**
 * `wallet.revealSecretKey`: the per-account key export.
 *
 * This is one of only two methods in the protocol that may return key material
 * (ARCHITECTURE.md §3, invariant 1), so the tests are about the *conditions*
 * rather than the happy path: the right key for the right account, the
 * password every single time, nothing at all for an account whose key is on a
 * device, and no seed left behind in RAM.
 *
 * Stub strategy copied from `vault-lifecycle.test.ts`: `wxt/browser` is faked,
 * every crypto path is the real one including Argon2id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

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
    alarms: { clear: async () => true, create: async () => undefined },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
    permissions: { contains: async () => true },
  },
}));

/** Every seed the handler derives, so invariant 6 can be asserted. */
const seenSeeds: Uint8Array[] = [];
vi.mock('../src/core/crypto/mnemonic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/crypto/mnemonic')>();
  return {
    ...actual,
    mnemonicToSeed: async (mnemonic: string, passphrase?: string) => {
      const seed = await actual.mnemonicToSeed(mnemonic, passphrase ?? '');
      seenSeeds.push(seed);
      return seed;
    },
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');

const PASSWORD = 'correct horse battery';

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
  seenSeeds.length = 0;
});

async function freshWallet(): Promise<InstanceType<typeof BackgroundContext>> {
  const ctx = new BackgroundContext();
  await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  return ctx;
}

describe('wallet.revealSecretKey', () => {
  it('returns a strkey secret that really belongs to the account', async () => {
    const ctx = await freshWallet();
    const { accounts } = await handlers['account.list'](ctx, {});
    const account = accounts[0];
    if (!account) throw new Error('a fresh wallet has one account');

    const revealed = await handlers['wallet.revealSecretKey'](ctx, {
      password: PASSWORD,
      accountIndex: account.index,
    });

    expect(revealed.secretKey).toMatch(/^S[A-Z2-7]{55}$/u);
    // The verdict comes from the SDK, not from the derivation code under test:
    // this secret must produce the public key the wallet shows for the account.
    expect(Keypair.fromSecret(revealed.secretKey).publicKey()).toBe(account.publicKey);
    expect(revealed.publicKey).toBe(account.publicKey);
    expect(revealed.path).toBe(account.path);
  });

  it('gives each account its own key, not the first one twice', async () => {
    const ctx = await freshWallet();
    await handlers['account.add'](ctx, { password: PASSWORD, label: 'second' });
    const { accounts } = await handlers['account.list'](ctx, {});
    expect(accounts).toHaveLength(2);

    const keys = new Set<string>();
    for (const account of accounts) {
      const { secretKey } = await handlers['wallet.revealSecretKey'](ctx, {
        password: PASSWORD,
        accountIndex: account.index,
      });
      expect(Keypair.fromSecret(secretKey).publicKey()).toBe(account.publicKey);
      keys.add(secretKey);
    }
    expect(keys.size).toBe(2);
  });

  it('needs the password even while the wallet is unlocked', async () => {
    const ctx = await freshWallet();
    expect(ctx.keyring.isUnlocked).toBe(true);

    await expect(
      handlers['wallet.revealSecretKey'](ctx, { password: 'not-the-password', accountIndex: 0 }),
    ).rejects.toBeDefined();

    // …and the wallet is still open afterwards: a wrong guess here must not
    // cost the user their session.
    expect(ctx.keyring.isUnlocked).toBe(true);
  });

  it('refuses an account index that does not exist', async () => {
    const ctx = await freshWallet();
    await expect(
      handlers['wallet.revealSecretKey'](ctx, { password: PASSWORD, accountIndex: 7 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * The trap this closes: the seed would happily derive *a* key for the
   * device's path, and it is not the device's key. Answering would tell the
   * user "this is your account's key" about an account they do not control.
   */
  it('refuses a hardware account instead of deriving a wrong key for it', async () => {
    const ctx = await freshWallet();
    const device = Keypair.random().publicKey();
    await handlers['ledger.addAccount'](ctx, {
      password: PASSWORD,
      derivationIndex: 0,
      publicKey: device,
      label: 'Ledger',
    });
    const { accounts } = await handlers['account.list'](ctx, {});
    const ledgerAccount = accounts.find((a) => a.source === 'ledger');
    if (!ledgerAccount) throw new Error('the device account was not enrolled');

    await expect(
      handlers['wallet.revealSecretKey'](ctx, {
        password: PASSWORD,
        accountIndex: ledgerAccount.index,
      }),
    ).rejects.toMatchObject({ code: 'NO_SECRET_KEY' });
  });

  /** Invariant 6: the seed is the one thing in this path that can be erased. */
  it('zeroizes the seed it derived from', async () => {
    const ctx = await freshWallet();
    const before = seenSeeds.length;
    await handlers['wallet.revealSecretKey'](ctx, { password: PASSWORD, accountIndex: 0 });
    const derived = seenSeeds.slice(before);
    expect(derived.length).toBeGreaterThan(0);
    for (const seed of derived) {
      expect(seed.some((byte) => byte !== 0), 'a seed survived the reveal').toBe(false);
    }
  });
});
