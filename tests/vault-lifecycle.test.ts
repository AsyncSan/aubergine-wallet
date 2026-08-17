/**
 * Regressions around the vault: brute-force throttling under concurrency, the
 * lock-during-signature race, zeroization, and the "unreadable keystore" case
 * that used to route the user straight into an overwrite.
 *
 * Every one of these was green before the fix; the suite asserted the
 * *sequential* throttle, `isUnlocked === false` after lock (never the buffer),
 * and never exercised a keystore it could not parse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ stubs */

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

/**
 * Keep a reference to the seed the keyring is handed, so invariant 6
 * ("lock() zeroizes every buffer it holds") can actually be asserted instead of
 * being taken on trust.
 */
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
const { AppError } = await import('../src/core/errors');
const { Keyring } = await import('../src/core/keyring/keyring');
const { readSettings } = await import('../src/background/storage');
const { encryptJson } = await import('../src/core/crypto/keystore');
const { generateMnemonic } = await import('../src/core/crypto/mnemonic');

const PASSWORD = 'correct horse battery';
const KEYSTORE_KEY = 'keystore.v1';
const GUARD_KEY = 'unlockGuard.v1';
const SETTINGS_KEY = 'settings.v1';

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

function guardState(): { failures: number; lockedUntil: number | null } {
  return (localStore.get(GUARD_KEY) as { failures: number; lockedUntil: number | null }) ?? {
    failures: 0,
    lockedUntil: null,
  };
}

/* ------------------------------------------------------- brute-force guard */

describe('unlock throttling under concurrency', () => {
  it('counts parallel wrong passwords one by one and trips the lockout', async () => {
    const ctx = await freshWallet();
    await handlers['wallet.lock'](ctx, {});

    // Six simultaneous guesses. Before the fix these cost ~2 counted failures
    // and no lockout at all, because assertAllowed → KDF → registerFailure is
    // a check-then-act over shared storage.
    const attempts = Array.from({ length: 6 }, (_unused, i) =>
      handlers['wallet.unlock'](ctx, { password: `wrong-${i}` }).catch((err: unknown) => err),
    );
    const results = await Promise.all(attempts);

    // Five counted failures is the lockout point (4 free + 1); the sixth
    // attempt is refused by the lockout and correctly costs nothing. Before the
    // fix the whole burst cost about two and tripped no lockout whatsoever.
    expect(guardState().failures).toBe(5);
    expect(guardState().lockedUntil).not.toBeNull();
    // Every attempt fails: a plain BadPasswordError while attempts are free,
    // and an AppError('UNLOCK_THROTTLED') once the lockout is in force.
    for (const result of results) expect(result).toBeInstanceOf(Error);
    const throttled = results.filter(
      (r) => r instanceof AppError && r.code === 'UNLOCK_THROTTLED',
    );
    expect(throttled.length).toBeGreaterThan(0);

    // And the lockout really holds, even for the right password.
    await expect(handlers['wallet.unlock'](ctx, { password: PASSWORD })).rejects.toMatchObject({
      code: 'UNLOCK_THROTTLED',
    });
  });

  it('does not spend an attempt on a failure that is not a wrong password', async () => {
    const ctx = await freshWallet();
    await handlers['wallet.lock'](ctx, {});
    const keystore = localStore.get(KEYSTORE_KEY) as Record<string, unknown>;
    // Decrypts perfectly, but the plaintext is not a vault. That is a
    // structural failure, not a wrong password, so the attempt is given back.
    localStore.set(KEYSTORE_KEY, await encryptJson({ not: 'a vault' }, PASSWORD));

    await expect(handlers['wallet.unlock'](ctx, { password: PASSWORD })).rejects.toBeDefined();
    expect(guardState().failures).toBe(0);

    localStore.set(KEYSTORE_KEY, keystore);
    await expect(handlers['wallet.unlock'](ctx, { password: PASSWORD })).resolves.toBeDefined();
  });

  it('classifies a corrupt (non-base64) blob as unreadable, not as a bad password', async () => {
    await freshWallet();
    const keystore = localStore.get(KEYSTORE_KEY) as Record<string, unknown>;
    localStore.set(KEYSTORE_KEY, { ...keystore, ct: 'not-base64-at-all!!' });
    const fresh = new BackgroundContext();
    await expect(handlers['wallet.unlock'](fresh, { password: PASSWORD })).rejects.toMatchObject({
      code: 'KEYSTORE_UNREADABLE',
    });
    expect(guardState().failures).toBe(0);
  });
});

/* ------------------------------------------------------------ lock races */

describe('keyring lock races', () => {
  it('never signs with a zeroized seed when a lock lands mid-derivation', async () => {
    const ctx = await freshWallet();
    const keyring = ctx.keyring;
    const { TransactionBuilder, Account, Operation, Asset, Networks, BASE_FEE } = await import(
      '@stellar/stellar-sdk'
    );
    const publicKey = keyring.publicKeyOf(0);
    const tx = new TransactionBuilder(new Account(publicKey, '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: publicKey, asset: Asset.native(), amount: '1' }),
      )
      .setTimeout(180)
      .build();

    const signing = keyring.signTransaction(tx, 0);
    keyring.lock(); // the auto-lock alarm, a second unlock, another popup …
    await expect(signing).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    // The envelope must carry no signature at all; the old behaviour returned
    // a plausible-looking one made with the all-zero seed.
    expect(tx.signatures).toHaveLength(0);
  });

  it('zeroizes the seed on lock (invariant 6)', async () => {
    const ctx = await freshWallet();
    expect(seenSeeds.length).toBeGreaterThan(0);
    const seed = seenSeeds[seenSeeds.length - 1];
    if (seed === undefined) throw new Error('no seed captured');
    expect(seed.some((byte) => byte !== 0)).toBe(true);

    ctx.keyring.lock();
    expect(seed.every((byte) => byte === 0)).toBe(true);
  });

  it('zeroizes the seed when a derivation fails during unlock', async () => {
    const keyring = new Keyring();
    const mnemonic = generateMnemonic(128);
    await expect(
      keyring.unlock({
        version: 1,
        mnemonic,
        // A non-integer index makes SEP-0005 derivation throw after the seed
        // has already been produced.
        accounts: [{ index: 1.5, label: '' }],
      }),
    ).rejects.toBeDefined();
    const seed = seenSeeds[seenSeeds.length - 1];
    if (seed === undefined) throw new Error('no seed captured');
    expect(seed.every((byte) => byte === 0)).toBe(true);
  });
});

/* ------------------------------------------------- unreadable keystore */

describe('an unreadable keystore is never mistaken for "no wallet"', () => {
  it('reports the wallet as present and refuses to overwrite it', async () => {
    const ctx = await freshWallet();
    const original = localStore.get(KEYSTORE_KEY) as Record<string, unknown>;
    // Exactly the shape a newer build (or a rollback) would leave behind.
    // v1 and v2 are the readable versions today, so "the future" starts at 3.
    localStore.set(KEYSTORE_KEY, { ...original, v: 3 });

    const fresh = new BackgroundContext();
    const status = await handlers['wallet.status'](fresh, {});
    expect(status.initialized).toBe(true); // NOT the onboarding screen

    await expect(
      handlers['wallet.create'](fresh, { password: 'a different password', strength: 128 }),
    ).rejects.toMatchObject({ code: 'KEYSTORE_UNREADABLE' });
    await expect(
      handlers['wallet.importMnemonic'](fresh, {
        mnemonic: generateMnemonic(128),
        password: 'a different password',
      }),
    ).rejects.toMatchObject({ code: 'KEYSTORE_UNREADABLE' });

    // The ciphertext is untouched: the recovery phrase is still recoverable by
    // an older build or after a fix.
    expect((localStore.get(KEYSTORE_KEY) as { ct: string }).ct).toBe(original['ct']);
    void ctx;
  });

  it('tells the user what happened instead of "wrong password"', async () => {
    await freshWallet();
    const original = localStore.get(KEYSTORE_KEY) as Record<string, unknown>;
    localStore.set(KEYSTORE_KEY, { ...original, kdf: 'scrypt-from-the-future' });
    const fresh = new BackgroundContext();
    await expect(handlers['wallet.unlock'](fresh, { password: PASSWORD })).rejects.toMatchObject({
      code: 'KEYSTORE_UNREADABLE',
    });
    // No attempt was spent either.
    expect(guardState().failures).toBe(0);
  });

  it('still treats an absent keystore as "no wallet"', async () => {
    const fresh = new BackgroundContext();
    const status = await handlers['wallet.status'](fresh, {});
    expect(status.initialized).toBe(false);
    await expect(handlers['wallet.unlock'](fresh, { password: PASSWORD })).rejects.toMatchObject({
      code: 'NO_WALLET',
    });
  });
});

/* --------------------------------------------------------- stored settings */

describe('stored settings survive one bad field', () => {
  it('keeps every valid key and defaults only the broken one', async () => {
    syncStore.set(SETTINGS_KEY, {
      mode: 'developer',
      locale: 'en',
      selectedAccountIndex: 3,
      allowedOrigins: ['https://good.example'],
      autoLockMinutes: 'fifteen', // ← written by a newer build, or hand-edited
    });
    const settings = await readSettings();
    expect(settings.mode).toBe('developer');
    expect(settings.locale).toBe('en');
    expect(settings.selectedAccountIndex).toBe(3);
    // Security grants never replicate over sync (see settings-sync.test.ts),
    // a valid list in the sync record is deliberately not honoured.
    expect(settings.allowedOrigins).toEqual([]);
    expect(typeof settings.autoLockMinutes).toBe('number'); // the default
  });

  it('ignores an unknown key without discarding the record', async () => {
    syncStore.set(SETTINGS_KEY, { mode: 'developer', theme: 'midnight' });
    expect((await readSettings()).mode).toBe('developer');
  });
});

/* ------------------------------------------------------- keystore upgrade */

describe('legacy v1 keystores upgrade on unlock', () => {
  it('re-encrypts a v1 blob as v2 the moment the password is proven', async () => {
    const { LEGACY_KEYSTORE_VERSION, KEYSTORE_VERSION, IV_BYTES, toBase64 } = await import(
      '../src/core/crypto/keystore'
    );
    const { KDF_ARGON2ID, SALT_BYTES, deriveKey, randomBytes } = await import(
      '../src/core/crypto/kdf'
    );

    // A vault encrypted exactly as the shipped v1 code did it: same envelope,
    // no `additionalData` on the GCM encrypt.
    const mnemonic = generateMnemonic(128);
    const vault = { version: 1, mnemonic, accounts: [{ index: 0, label: '' }] };
    const spec = { kdf: KDF_ARGON2ID, params: { m: 1024, t: 1, p: 1 } } as const;
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const dk = await deriveKey(PASSWORD, salt, spec);
    const key = await crypto.subtle.importKey(
      'raw',
      dk as unknown as BufferSource,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        new TextEncoder().encode(JSON.stringify(vault)) as unknown as BufferSource,
      ),
    );
    localStore.set(KEYSTORE_KEY, {
      v: LEGACY_KEYSTORE_VERSION,
      kdf: spec.kdf,
      params: spec.params,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ct: toBase64(ct),
    });

    const ctx = new BackgroundContext();
    const res = await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    expect(res.accounts).toHaveLength(1);

    // The stored blob is now current-format and still opens with the password.
    const upgraded = localStore.get(KEYSTORE_KEY) as { v: number };
    expect(upgraded.v).toBe(KEYSTORE_VERSION);
    await handlers['wallet.lock'](ctx, {});
    const again = await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    expect(again.accounts).toHaveLength(1);
  });
});

/* ------------------------------------------------------- keystore hardening */

describe('keystore header bounds', () => {
  it('refuses absurd KDF parameters instead of allocating a terabyte', async () => {
    const keystore = await encryptJson({ hello: 'world' }, PASSWORD);
    const hostile = { ...keystore, params: { m: 2 ** 30, t: 3, p: 1 } };
    localStore.set(KEYSTORE_KEY, hostile);
    const fresh = new BackgroundContext();
    // Unparseable header → the wallet says so, and does not try to derive.
    await expect(handlers['wallet.unlock'](fresh, { password: PASSWORD })).rejects.toMatchObject({
      code: 'KEYSTORE_UNREADABLE',
    });
  });
});
