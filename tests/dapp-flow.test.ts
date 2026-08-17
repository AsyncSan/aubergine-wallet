/**
 * Background integration tests for the findings that live *between* modules:
 *
 *  - finding 5: the network a dApp declares travels dApp -> prompt -> popup ->
 *    `tx.describe`, so the NETWORK_MISMATCH warning is actually reachable,
 *  - finding 10: `account.add` re-encrypts the vault and survives a lock,
 *  - §4 row 3: contract calls are refused in beginner mode and signable in
 *    developer mode.
 *
 * `wxt/browser` and Horizon are stubbed; everything else is the real code path,
 * including Argon2id, AES-GCM and SEP-0005 derivation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Asset,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';

/* ------------------------------------------------------------- stubs */

interface Area {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function area(store: Map<string, unknown>): Area {
  return {
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
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
    // No `scripting`: registration is a no-op in this environment.
    permissions: { contains: async () => true },
  },
}));

const EMPTY_SNAPSHOT = {
  accountId: '',
  exists: false,
  sequence: '0',
  balances: [],
  reserves: {
    baseReserveXlm: '0.5',
    subentryCount: 0,
    numSponsoring: 0,
    numSponsored: 0,
    totalReservedXlm: '1.0000000',
    spendableXlm: '0.0000000',
    maxSendableXlm: '0.0000000',
  },
  signers: [],
  thresholds: { low: 0, medium: 0, high: 0 },
  subentryCount: 0,
};

vi.mock('../src/core/stellar/horizon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/stellar/horizon')>();
  return {
    ...actual,
    /**
     * The fee strategy calls this on every build. Stubbed to "unavailable" so
     * this suite stays offline and exercises the fail-open path (BASE_FEE);
     * the strategy itself is covered in tests/fee-strategy.test.ts.
     */
    fetchFeeStats: async () => null,
    fetchAccount: async (_network: unknown, accountId: string) => ({
      ...EMPTY_SNAPSHOT,
      accountId,
    }),
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { AppError } = await import('../src/core/errors');

const PASSWORD = 'correct horse battery';
const OTHER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ORIGIN = 'https://dapp.example';

function paymentXdr(source: string): string {
  return new TransactionBuilder(new Account(source, '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' }))
    .setTimeout(180)
    .build()
    .toXDR();
}

/** A contract call: `invokeHostFunction`, unprepared (no resource footprint). */
function contractCallXdr(source: string): string {
  return new TransactionBuilder(new Account(source, '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        function: 'transfer',
        args: [],
      }),
    )
    .setTimeout(180)
    .build()
    .toXDR();
}

async function freshWallet(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  publicKey: string;
}> {
  localStore.clear();
  syncStore.clear();
  const ctx = new BackgroundContext();
  const created = await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const publicKey = created.accounts[0]?.publicKey ?? '';
  expect(publicKey).not.toBe('');
  return { ctx, publicKey };
}

/** The handler awaits settings/keyring before it queues the prompt. */
async function awaitPrompt(
  ctx: InstanceType<typeof BackgroundContext>,
): Promise<NonNullable<Awaited<ReturnType<(typeof handlers)['dapp.pendingPrompt']>>>> {
  for (let i = 0; i < 200; i++) {
    const prompt = await handlers['dapp.pendingPrompt'](ctx, {});
    if (prompt !== null) return prompt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no prompt appeared');
}

async function setDeveloperMode(
  ctx: InstanceType<typeof BackgroundContext>,
  patch: Record<string, unknown> = {},
): Promise<void> {
  await handlers['settings.set'](ctx, {
    patch: { mode: 'developer', developerModeAcknowledged: true, ...patch },
  });
}

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

/* ------------------------------------------------- finding 5: plumbing */

describe('declared network passphrase (finding 5)', () => {
  it('carries the dApp-declared passphrase into the confirmation prompt', async () => {
    const { ctx, publicKey } = await freshWallet();
    await setDeveloperMode(ctx, { allowedOrigins: [ORIGIN] });

    const signing = handlers['dapp.signXdr'](ctx, {
      origin: ORIGIN,
      xdr: paymentXdr(publicKey),
      // The page claims this is a *Mainnet* transaction while the wallet is on
      // Testnet, precisely the case the warning exists for.
      networkPassphrase: Networks.PUBLIC,
    });

    const prompt = await awaitPrompt(ctx);
    expect(prompt.kind).toBe('sign');
    expect(prompt.declaredNetworkPassphrase).toBe(Networks.PUBLIC);

    await handlers['dapp.resolvePrompt'](ctx, {
      requestId: prompt.requestId,
      approved: true,
    });
    const signed = await signing;
    expect(signed.signedXdr.length).toBeGreaterThan(0);
  });

  it('records null when the page declares no network', async () => {
    const { ctx, publicKey } = await freshWallet();
    await setDeveloperMode(ctx, { allowedOrigins: [ORIGIN] });

    const signing = handlers['dapp.signXdr'](ctx, {
      origin: ORIGIN,
      xdr: paymentXdr(publicKey),
    });
    const prompt = await awaitPrompt(ctx);
    expect(prompt.declaredNetworkPassphrase).toBeNull();
    await handlers['dapp.resolvePrompt'](ctx, {
      requestId: prompt.requestId,
      approved: false,
    });
    await expect(signing).rejects.toBeInstanceOf(AppError);
  });

  it('raises NETWORK_MISMATCH from tx.describe when the passphrase is passed through', async () => {
    const { ctx, publicKey } = await freshWallet();
    const xdr = paymentXdr(publicKey);

    const withDeclared = await handlers['tx.describe'](ctx, {
      xdr,
      declaredNetworkPassphrase: Networks.PUBLIC,
    });
    expect(withDeclared.warnings.map((w) => w.code)).toContain('NETWORK_MISMATCH');
    const mismatch = withDeclared.warnings.find((w) => w.code === 'NETWORK_MISMATCH');
    expect(mismatch?.severity).toBe('danger');

    const withoutDeclared = await handlers['tx.describe'](ctx, { xdr });
    expect(withoutDeclared.warnings.map((w) => w.code)).not.toContain('NETWORK_MISMATCH');

    // Matching passphrase: no warning either.
    const matching = await handlers['tx.describe'](ctx, {
      xdr,
      declaredNetworkPassphrase: Networks.TESTNET,
    });
    expect(matching.warnings.map((w) => w.code)).not.toContain('NETWORK_MISMATCH');
  });

  it('always reports the network name so the dialog can show it', async () => {
    const { ctx, publicKey } = await freshWallet();
    const described = await handlers['tx.describe'](ctx, { xdr: paymentXdr(publicKey) });
    expect(described.meta.networkName).toBe('testnet');
    expect(described.meta.network).toBe(Networks.TESTNET);
  });
});

/* -------------------------------------- P2: accountToSign visibility */

describe('signing account in the prompt (P2)', () => {
  it('carries the resolved signer into the prompt (default: selected account)', async () => {
    const { ctx, publicKey } = await freshWallet();
    await setDeveloperMode(ctx, { allowedOrigins: [ORIGIN] });

    const signing = handlers['dapp.signXdr'](ctx, {
      origin: ORIGIN,
      xdr: paymentXdr(publicKey),
    });
    const prompt = await awaitPrompt(ctx);
    expect(prompt.signerPublicKey).toBe(publicKey);
    expect(prompt.signerIsSelected).toBe(true);
    await handlers['dapp.resolvePrompt'](ctx, { requestId: prompt.requestId, approved: false });
    await expect(signing).rejects.toBeInstanceOf(AppError);
  });

  it('flags a page-requested non-active account so the UI can warn', async () => {
    const { ctx, publicKey } = await freshWallet();
    const added = await handlers['account.add'](ctx, { label: 'Second', password: PASSWORD });
    await setDeveloperMode(ctx, { allowedOrigins: [ORIGIN] });

    const signing = handlers['dapp.signXdr'](ctx, {
      origin: ORIGIN,
      xdr: paymentXdr(publicKey),
      accountToSign: added.account.publicKey,
    });
    const prompt = await awaitPrompt(ctx);
    expect(prompt.signerPublicKey).toBe(added.account.publicKey);
    expect(prompt.signerIsSelected).toBe(false);
    await handlers['dapp.resolvePrompt'](ctx, { requestId: prompt.requestId, approved: false });
    await expect(signing).rejects.toBeInstanceOf(AppError);
  });

  it('answers an unknown accountToSign like a rejection, with no prompt', async () => {
    const { ctx, publicKey } = await freshWallet();
    await setDeveloperMode(ctx, { allowedOrigins: [ORIGIN] });

    await expect(
      handlers['dapp.signXdr'](ctx, {
        origin: ORIGIN,
        xdr: paymentXdr(publicKey),
        accountToSign: OTHER, // a valid G-address the wallet does not hold
      }),
      // USER_REJECTED, deliberately: "unknown public key" let an approved dApp
      // enumerate which addresses this wallet controls, for free and silently.
    ).rejects.toMatchObject({ code: 'USER_REJECTED' });
    // Fail-fast: the user was never asked to approve anything.
    expect(await handlers['dapp.pendingPrompt'](ctx, {})).toBeNull();
  });
});

/* ------------------------------------------- finding 10: account.add */

describe('account.add persistence (finding 10)', () => {
  it('survives a lock because the vault is re-encrypted', async () => {
    const { ctx } = await freshWallet();
    const added = await handlers['account.add'](ctx, { label: 'Savings', password: PASSWORD });
    expect(added.account.index).toBe(1);

    await handlers['wallet.lock'](ctx, {});
    const reopened = await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    expect(reopened.accounts).toHaveLength(2);
    expect(reopened.accounts[1]?.publicKey).toBe(added.account.publicKey);
    expect(reopened.accounts[1]?.label).toBe('Savings');
  });

  it('refuses a wrong password and adds nothing', async () => {
    const { ctx } = await freshWallet();
    await expect(
      handlers['account.add'](ctx, { label: 'Nope', password: 'wrong password' }),
    ).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    const list = await handlers['account.list'](ctx, {});
    expect(list.accounts).toHaveLength(1);
  });

  it('keeps the recovery phrase out of the keyring across the whole flow', async () => {
    const { ctx } = await freshWallet();
    const revealed = await handlers['wallet.revealRecoveryPhrase'](ctx, {
      password: PASSWORD,
    });
    await handlers['account.add'](ctx, { label: '', password: PASSWORD });
    expect(JSON.stringify(await handlers['account.list'](ctx, {}))).not.toContain(
      revealed.mnemonic,
    );
    expect(revealed.bip39Passphrase).toBeNull();
  });
});

/* ---------------------------------------------- §4 row 3: Soroban gate */

describe('Soroban contract calls (§4 row 3, finding 4)', () => {
  it('is refused in beginner mode, in the background and not just in the UI', async () => {
    const { ctx, publicKey } = await freshWallet();
    const xdr = contractCallXdr(publicKey);
    await expect(handlers['tx.sign'](ctx, { xdr })).rejects.toMatchObject({
      code: 'DEVELOPER_MODE_REQUIRED',
    });
  });

  it('is signable in developer mode', async () => {
    const { ctx, publicKey } = await freshWallet();
    await setDeveloperMode(ctx);
    const signed = await handlers['tx.sign'](ctx, { xdr: contractCallXdr(publicKey) });
    const parsed = TransactionBuilder.fromXDR(signed.signedXdr, Networks.TESTNET) as Transaction;
    expect(parsed.signatures).toHaveLength(1);
    expect(parsed.operations[0]?.type).toBe('invokeHostFunction');
  });

  it('still allows an ordinary payment in beginner mode', async () => {
    const { ctx, publicKey } = await freshWallet();
    const signed = await handlers['tx.sign'](ctx, { xdr: paymentXdr(publicKey) });
    expect(signed.signedXdr.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------- finding 7: BIP-39 passphrase */

describe('imported BIP-39 passphrase (finding 7)', () => {
  const MNEMONIC =
    'cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube';
  const WITH_PASSPHRASE = 'GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ';

  it('is honoured by the derivation and survives a lock', async () => {
    localStore.clear();
    syncStore.clear();
    const ctx = new BackgroundContext();
    const imported = await handlers['wallet.importMnemonic'](ctx, {
      password: PASSWORD,
      mnemonic: MNEMONIC,
      bip39Passphrase: 'p4ssphr4se',
    });
    expect(imported.accounts[0]?.publicKey).toBe(WITH_PASSPHRASE);

    await handlers['wallet.lock'](ctx, {});
    const reopened = await handlers['wallet.unlock'](ctx, { password: PASSWORD });
    expect(reopened.accounts[0]?.publicKey).toBe(WITH_PASSPHRASE);

    const revealed = await handlers['wallet.revealRecoveryPhrase'](ctx, {
      password: PASSWORD,
    });
    expect(revealed.bip39Passphrase).toBe('p4ssphr4se');
  });

  it('derives a different wallet without it', async () => {
    localStore.clear();
    syncStore.clear();
    const ctx = new BackgroundContext();
    const imported = await handlers['wallet.importMnemonic'](ctx, {
      password: PASSWORD,
      mnemonic: MNEMONIC,
    });
    expect(imported.accounts[0]?.publicKey).not.toBe(WITH_PASSPHRASE);
  });
});
