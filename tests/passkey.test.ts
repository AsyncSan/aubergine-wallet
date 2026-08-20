/**
 * Passkey unlock, end to end through the background handlers.
 *
 * The WebAuthn ceremony itself is not simulated: it produces 32 bytes and this
 * suite supplies them directly, which is exactly the boundary
 * `src/ui/passkey.ts` sits on. What is worth testing is everything *after*
 * those bytes — that the wrong ones open nothing, that a vault mutation does
 * not silently leave the passkey copy behind, and that the password path is
 * untouched by any of it.
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
    alarms: { clear: async () => true, create: async () => undefined },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
    permissions: { contains: async () => true },
  },
}));

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { toBase64, fromBase64 } = await import('../src/core/crypto/keystore');
const {
  PRF_SALT_BYTES,
  passkeyRecordSchema,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPrf,
  generateVaultKey,
  sealVault,
  openVault,
  PasskeyUnwrapError,
} = await import('../src/core/crypto/passkey');

const PASSWORD = 'correct horse battery';
const KEYSTORE_KEY = 'keystore.v1';
const PASSKEY_KEY = 'passkey.v1';

/** Stand-in for what an authenticator would return. Deterministic on purpose. */
const PRF = toBase64(new Uint8Array(32).fill(7));
const OTHER_PRF = toBase64(new Uint8Array(32).fill(8));
const CREDENTIAL_ID = toBase64(new Uint8Array(16).fill(3));

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

async function walletWithPasskey(): Promise<InstanceType<typeof BackgroundContext>> {
  const ctx = new BackgroundContext();
  await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const { prfSalt } = await handlers['passkey.prepare'](ctx, {});
  await handlers['passkey.enable'](ctx, {
    password: PASSWORD,
    credentialId: CREDENTIAL_ID,
    prfSalt,
    prfOutput: PRF,
  });
  return ctx;
}

function record(): Record<string, unknown> {
  return localStore.get(PASSKEY_KEY) as Record<string, unknown>;
}

describe('the wrapper on its own', () => {
  it('round-trips a vault key through a PRF output', async () => {
    const vaultKey = generateVaultKey();
    const prf = fromBase64(PRF);
    const wrapped = await wrapVaultKeyWithPrf(vaultKey, prf, CREDENTIAL_ID, 'c2FsdA==');
    const back = await unwrapVaultKeyWithPrf(wrapped, prf, CREDENTIAL_ID, 'c2FsdA==');
    expect(Array.from(back)).toEqual(Array.from(vaultKey));
  });

  it('refuses a different PRF output', async () => {
    const wrapped = await wrapVaultKeyWithPrf(
      generateVaultKey(),
      fromBase64(PRF),
      CREDENTIAL_ID,
      'c2FsdA==',
    );
    await expect(
      unwrapVaultKeyWithPrf(wrapped, fromBase64(OTHER_PRF), CREDENTIAL_ID, 'c2FsdA=='),
    ).rejects.toBeInstanceOf(PasskeyUnwrapError);
  });

  /**
   * The AAD is the point of binding the credential id and the salt into the
   * ciphertext: swapping either one has to fail the tag check, not decrypt
   * into something that merely looks wrong later.
   */
  it('refuses a wrapper re-labelled with another credential id', async () => {
    const wrapped = await wrapVaultKeyWithPrf(
      generateVaultKey(),
      fromBase64(PRF),
      CREDENTIAL_ID,
      'c2FsdA==',
    );
    await expect(
      unwrapVaultKeyWithPrf(wrapped, fromBase64(PRF), toBase64(new Uint8Array(16)), 'c2FsdA=='),
    ).rejects.toBeInstanceOf(PasskeyUnwrapError);
  });

  it('refuses a wrapper re-labelled with another PRF salt', async () => {
    const wrapped = await wrapVaultKeyWithPrf(
      generateVaultKey(),
      fromBase64(PRF),
      CREDENTIAL_ID,
      'c2FsdA==',
    );
    await expect(
      unwrapVaultKeyWithPrf(wrapped, fromBase64(PRF), CREDENTIAL_ID, 'b3RoZXI='),
    ).rejects.toBeInstanceOf(PasskeyUnwrapError);
  });

  it('seals and opens the vault under the vault key', async () => {
    const vaultKey = generateVaultKey();
    const plaintext = new TextEncoder().encode('{"mnemonic":"x"}');
    const sealed = await sealVault(plaintext, vaultKey);
    expect(new TextDecoder().decode(await openVault(sealed, vaultKey))).toBe('{"mnemonic":"x"}');
    await expect(openVault(sealed, generateVaultKey())).rejects.toBeInstanceOf(
      PasskeyUnwrapError,
    );
  });
});

describe('enrolment', () => {
  it('needs the password, and stores nothing when it is wrong', async () => {
    const ctx = new BackgroundContext();
    await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
    const { prfSalt } = await handlers['passkey.prepare'](ctx, {});
    await expect(
      handlers['passkey.enable'](ctx, {
        password: 'not the password',
        credentialId: CREDENTIAL_ID,
        prfSalt,
        prfOutput: PRF,
      }),
    ).rejects.toBeDefined();
    expect(localStore.has(PASSKEY_KEY)).toBe(false);
  });

  it('hands out a fresh salt that is not stored until enrolment succeeds', async () => {
    const ctx = new BackgroundContext();
    await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
    const a = await handlers['passkey.prepare'](ctx, {});
    const b = await handlers['passkey.prepare'](ctx, {});
    expect(a.prfSalt).not.toBe(b.prfSalt);
    expect(fromBase64(a.prfSalt).length).toBe(PRF_SALT_BYTES);
    expect(localStore.has(PASSKEY_KEY)).toBe(false);
  });

  it('writes a record in the documented shape and leaves the keystore alone', async () => {
    const ctx = new BackgroundContext();
    await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
    const before = JSON.stringify(localStore.get(KEYSTORE_KEY));
    const { prfSalt } = await handlers['passkey.prepare'](ctx, {});
    await handlers['passkey.enable'](ctx, {
      password: PASSWORD,
      credentialId: CREDENTIAL_ID,
      prfSalt,
      prfOutput: PRF,
    });
    expect(passkeyRecordSchema.safeParse(record()).success).toBe(true);
    // The whole point of the additive design: the password path is byte-identical.
    expect(JSON.stringify(localStore.get(KEYSTORE_KEY))).toBe(before);
  });
});

describe('unlocking', () => {
  it('opens the wallet with the right PRF output', async () => {
    const ctx = await walletWithPasskey();
    await handlers['wallet.lock'](ctx, {});
    expect(ctx.keyring.isUnlocked).toBe(false);

    const result = await handlers['passkey.unlock'](ctx, { prfOutput: PRF });
    expect(ctx.keyring.isUnlocked).toBe(true);
    expect(result.accounts).toHaveLength(1);
  });

  it('derives the same account as the password path', async () => {
    const ctx = await walletWithPasskey();
    const viaPassword = await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    await handlers['wallet.lock'](ctx, {});
    const viaPasskey = await handlers['passkey.unlock'](ctx, { prfOutput: PRF });
    expect(viaPasskey.accounts[0]?.publicKey).toBe(viaPassword.accounts[0]?.publicKey);
  });

  it('refuses a foreign PRF output as PASSKEY_FAILED, not as a bad password', async () => {
    const ctx = await walletWithPasskey();
    await handlers['wallet.lock'](ctx, {});
    await expect(
      handlers['passkey.unlock'](ctx, { prfOutput: OTHER_PRF }),
    ).rejects.toMatchObject({ code: 'PASSKEY_FAILED' });
    expect(ctx.keyring.isUnlocked).toBe(false);
  });

  /**
   * The throttle exists to make *guessing* expensive. A 32-byte PRF output is
   * not guessable, and counting failures here would let a stale record eat the
   * attempts the user needs for the password, which is the path that works.
   */
  it('does not spend an unlock attempt on a failed passkey', async () => {
    const ctx = await walletWithPasskey();
    await handlers['wallet.lock'](ctx, {});
    for (let i = 0; i < 8; i++) {
      await handlers['passkey.unlock'](ctx, { prfOutput: OTHER_PRF }).catch(() => undefined);
    }
    // Still not throttled: the password goes straight through.
    await expect(handlers['wallet.unlock'](ctx, { password: PASSWORD })).resolves.toBeDefined();
  });

  it('says PASSKEY_NOT_ENROLLED rather than failing obscurely', async () => {
    const ctx = new BackgroundContext();
    await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
    await expect(handlers['passkey.unlock'](ctx, { prfOutput: PRF })).rejects.toMatchObject({
      code: 'PASSKEY_NOT_ENROLLED',
    });
  });
});

describe('staying in step with the vault', () => {
  /**
   * The regression this design exists to prevent: adding an account writes a
   * new vault, and a passkey copy that is not rewritten would unlock into a
   * wallet missing that account — silently, and only for the passkey user.
   */
  it('carries a newly added account into the passkey copy', async () => {
    const ctx = await walletWithPasskey();
    await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    await handlers['account.add'](ctx, { label: 'second', password: PASSWORD });

    await handlers['wallet.lock'](ctx, {});
    const viaPasskey = await handlers['passkey.unlock'](ctx, { prfOutput: PRF });
    expect(viaPasskey.accounts).toHaveLength(2);
    expect(viaPasskey.accounts[1]?.label).toBe('second');
  });

  it('removes the passkey copy on wallet.reset', async () => {
    const ctx = await walletWithPasskey();
    await handlers['wallet.reset'](ctx, { confirm: true });
    expect(localStore.has(PASSKEY_KEY)).toBe(false);
    expect(localStore.has(KEYSTORE_KEY)).toBe(false);
  });

  it('removes it on passkey.disable and reports the status honestly', async () => {
    const ctx = await walletWithPasskey();
    expect((await handlers['passkey.status'](ctx, {})).enrolled).toBe(true);
    await handlers['passkey.disable'](ctx, {});
    expect((await handlers['passkey.status'](ctx, {})).enrolled).toBe(false);
    expect(localStore.has(PASSKEY_KEY)).toBe(false);
  });

  /**
   * A record we cannot parse is a passkey that stopped working, not a broken
   * wallet. It must degrade to "no passkey offered" and leave the password
   * path completely alone.
   */
  it('treats a corrupt record as no passkey, never as a broken wallet', async () => {
    const ctx = await walletWithPasskey();
    localStore.set(PASSKEY_KEY, { v: 1, credentialId: 'not base64 !!' });
    await handlers['wallet.lock'](ctx, {});

    expect((await handlers['passkey.status'](ctx, {})).enrolled).toBe(false);
    await expect(handlers['passkey.unlock'](ctx, { prfOutput: PRF })).rejects.toMatchObject({
      code: 'PASSKEY_NOT_ENROLLED',
    });
    await expect(handlers['wallet.unlock'](ctx, { password: PASSWORD })).resolves.toBeDefined();
  });
});
