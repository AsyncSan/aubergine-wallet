/**
 * Hardware accounts, end to end, without hardware.
 *
 * Everything here runs the real background code path — Argon2id, AES-GCM,
 * SEP-0005 derivation, the vault round trip — with two substitutions:
 * `wxt/browser` and Horizon are stubbed, exactly as in `dapp-flow.test.ts`,
 * and the device is `FakeLedgerDevice`, which produces real ed25519
 * signatures over the transaction hash the way the Stellar app does.
 *
 * The properties under test are the ones that would cost money if wrong:
 *
 *  1. the v1 -> v2 vault migration does not move a single account key,
 *  2. a hardware account can never be signed by the keyring, even though the
 *     seed would happily derive *a* key for the same path,
 *  3. a hardware signature is only attached after it verifies under the key
 *     recorded at enrolment,
 *  4. an authorisation is single use and does not survive a lock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, Asset, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

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
    fetchFeeStats: async () => null,
    fetchAccount: async (_network: unknown, accountId: string) => ({
      ...EMPTY_SNAPSHOT,
      accountId,
    }),
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { AppError } = await import('../src/core/errors');
const { Keyring } = await import('../src/core/keyring/keyring');
const { vaultSchema } = await import('../src/core/keyring/account');
const { FakeLedgerDevice } = await import('./support/fake-ledger');
const { ledgerAccountPath } = await import('../src/core/ledger/device');

const PASSWORD = 'correct horse battery';
const OTHER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const SEED_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';

type Ctx = InstanceType<typeof BackgroundContext>;

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

async function freshWallet(): Promise<{ ctx: Ctx; publicKey: string }> {
  localStore.clear();
  syncStore.clear();
  const ctx = new BackgroundContext();
  const created = await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const publicKey = created.accounts[0]?.publicKey ?? '';
  expect(publicKey).not.toBe('');
  return { ctx, publicKey };
}

/** Enrol path `derivationIndex` from `device` and return the new account. */
async function enrol(
  ctx: Ctx,
  device: InstanceType<typeof FakeLedgerDevice>,
  derivationIndex = 0,
  label = 'Ledger',
): Promise<{ index: number; publicKey: string }> {
  const publicKey = await device.getPublicKey(derivationIndex, true);
  const { account } = await handlers['ledger.addAccount'](ctx, {
    password: PASSWORD,
    derivationIndex,
    publicKey,
    label,
  });
  return { index: account.index, publicKey: account.publicKey };
}

/** The whole ceremony: authorise, ask the device, attach. */
async function signWithDevice(
  ctx: Ctx,
  device: InstanceType<typeof FakeLedgerDevice>,
  xdr: string,
  accountIndex: number,
): Promise<string> {
  const request = await handlers['ledger.beginSign'](ctx, { xdr, accountIndex });
  const signature = await device.signTransaction(
    request.derivationIndex,
    Buffer.from(request.signatureBase, 'base64'),
  );
  const { signedXdr } = await handlers['ledger.completeSign'](ctx, {
    requestId: request.requestId,
    signature: Buffer.from(signature).toString('base64'),
  });
  return signedXdr;
}

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

/* ------------------------------------------------------------ migration */

describe('vault v1 -> v2 migration', () => {
  /**
   * The only migration property that can lose money: an account must keep the
   * key it had. v1 derived from `index`, so v2 must set `derivationIndex` to
   * exactly that, and this test pins it against keys derived independently.
   */
  it('leaves every account on the key it already had', async () => {
    const legacy = vaultSchema.parse({
      version: 1,
      mnemonic: SEED_MNEMONIC,
      accounts: [
        { index: 0, label: 'first' },
        { index: 1, label: 'second' },
        { index: 7, label: 'gap' },
      ],
    });

    const migrated = new Keyring();
    await migrated.unlock(legacy);

    // Independently derived, straight from the mnemonic, no migration involved.
    const { deriveStellarPublicKey, mnemonicToSeed } = await import(
      '../src/core/crypto/mnemonic'
    );
    const seed = await mnemonicToSeed(SEED_MNEMONIC);
    for (const index of [0, 1, 7]) {
      expect(migrated.publicKeyOf(index)).toBe(await deriveStellarPublicKey(seed, index));
    }
  });

  it('marks migrated accounts as seed accounts and keeps their labels', () => {
    const migrated = vaultSchema.parse({
      version: 1,
      mnemonic: SEED_MNEMONIC,
      accounts: [{ index: 3, label: 'kept' }],
    });
    expect(migrated.version).toBe(2);
    expect(migrated.accounts[0]).toEqual({
      index: 3,
      label: 'kept',
      source: 'seed',
      derivationIndex: 3,
    });
  });

  it('passes a v2 vault through untouched', () => {
    const v2 = {
      version: 2 as const,
      mnemonic: SEED_MNEMONIC,
      accounts: [
        { index: 0, label: '', source: 'seed' as const, derivationIndex: 0 },
        {
          index: 1,
          label: 'device',
          source: 'ledger' as const,
          derivationIndex: 0,
          publicKey: OTHER,
        },
      ],
    };
    expect(vaultSchema.parse(v2)).toEqual(v2);
  });
});

/* ------------------------------------------------------------ the ladders */

describe('slot ids and derivation paths', () => {
  it('keeps the seed ladder contiguous when a device account sits between', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();

    await enrol(ctx, device, 0);
    const { account: seedAccount } = await handlers['account.add'](ctx, {
      label: 'second seed',
      password: PASSWORD,
    });

    /**
     * The point: the Ledger account took slot 1, but it must not push the
     * second seed account off `m/44'/148'/1'`. If it did, the recovery phrase
     * would no longer restore this wallet's accounts in any other wallet —
     * the phrase is unchanged, but the wallet would be looking at a different
     * rung of the ladder.
     */
    expect(seedAccount.index).toBe(2);
    expect(seedAccount.derivationIndex).toBe(1);
    expect(seedAccount.path).toBe("m/44'/148'/1'");
  });

  it('uses the BIP form without the m/ prefix for the device', () => {
    // The device rejects `m/…`; `stellarAccountPath` produces it for display.
    expect(ledgerAccountPath(3)).toBe("44'/148'/3'");
  });

  it('refuses to enrol the same device key twice', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    await enrol(ctx, device, 0);
    await expect(enrol(ctx, device, 0, 'again')).rejects.toBeInstanceOf(AppError);
  });
});

/* ------------------------------------------------------------ the refusal */

describe('a hardware account never signs in software', () => {
  /**
   * The trap worth a test of its own: the seed *can* derive a key for
   * `m/44'/148'/0'`, and that key is not the device's. Without the refusal in
   * `Keyring.signTransaction` the wallet would produce a valid signature by
   * the wrong key, report success, and fail on chain with `tx_bad_auth`.
   */
  it('refuses in the keyring even though the seed could derive the path', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);

    const keyring = ctx.requireUnlocked();
    const { deriveStellarPublicKey, mnemonicToSeed } = await import(
      '../src/core/crypto/mnemonic'
    );
    const vault = await ctx.loadVault(PASSWORD);
    const seedKeyForSamePath = await deriveStellarPublicKey(
      await mnemonicToSeed(vault.mnemonic),
      0,
    );
    // Same path, genuinely different key. This is what makes the refusal load-bearing.
    expect(seedKeyForSamePath).not.toBe(publicKey);

    const tx = TransactionBuilder.fromXDR(paymentXdr(publicKey), Networks.TESTNET);
    await expect(
      keyring.signTransaction(tx as never, index),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUIRED' });
  });

  it('refuses through tx.sign, which is the route the popup takes', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);
    await expect(
      handlers['tx.sign'](ctx, { xdr: paymentXdr(publicKey), accountIndex: index }),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUIRED' });
  });

  it('refuses a dApp signature request before the user is prompted', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);
    await handlers['settings.set'](ctx, {
      patch: {
        mode: 'developer',
        developerModeAcknowledged: true,
        allowedOrigins: ['https://dapp.example'],
      },
    });
    await handlers['account.select'](ctx, { index });

    await expect(
      handlers['dapp.signXdr'](ctx, {
        origin: 'https://dapp.example',
        xdr: paymentXdr(publicKey),
      }),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUIRED' });
    // No prompt was queued: the user was never asked to approve the impossible.
    expect(ctx.prompts.size).toBe(0);
  });
});

/* ------------------------------------------------------------ the ceremony */

describe('begin / complete', () => {
  it('produces an envelope the network would accept', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);

    const signedXdr = await signWithDevice(ctx, device, paymentXdr(publicKey), index);

    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    if ('innerTransaction' in signed) throw new Error('unexpected fee bump');
    expect(signed.signatures).toHaveLength(1);
    // The real check: the signature verifies under the enrolled key.
    const { Keypair } = await import('@stellar/stellar-sdk');
    const kp = Keypair.fromPublicKey(publicKey);
    expect(kp.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });

  it('hands the device the signature base, not the envelope', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);

    const xdr = paymentXdr(publicKey);
    const request = await handlers['ledger.beginSign'](ctx, { xdr, accountIndex: index });
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    if ('innerTransaction' in tx) throw new Error('unexpected fee bump');
    expect(Buffer.from(request.signatureBase, 'base64').equals(tx.signatureBase())).toBe(true);
    expect(request.publicKey).toBe(publicKey);
  });

  it('rejects a signature from a different device', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);

    const request = await handlers['ledger.beginSign'](ctx, {
      xdr: paymentXdr(publicKey),
      accountIndex: index,
    });
    // A second device: answers everything, plausibly, with the wrong key.
    const impostor = new FakeLedgerDevice(
      {},
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
    );
    const signature = await impostor.signTransaction(
      request.derivationIndex,
      Buffer.from(request.signatureBase, 'base64'),
    );
    await expect(
      handlers['ledger.completeSign'](ctx, {
        requestId: request.requestId,
        signature: Buffer.from(signature).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'LEDGER_WRONG_DEVICE' });
  });

  it('rejects a signature that is merely well-formed', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice({ corruptSignature: true });
    const good = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, good, 0);

    const request = await handlers['ledger.beginSign'](ctx, {
      xdr: paymentXdr(publicKey),
      accountIndex: index,
    });
    const signature = await device.signTransaction(
      request.derivationIndex,
      Buffer.from(request.signatureBase, 'base64'),
    );
    expect(signature).toHaveLength(64);
    await expect(
      handlers['ledger.completeSign'](ctx, {
        requestId: request.requestId,
        signature: Buffer.from(signature).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'LEDGER_WRONG_DEVICE' });
  });

  it('authorises exactly one signature per request', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);

    const request = await handlers['ledger.beginSign'](ctx, {
      xdr: paymentXdr(publicKey),
      accountIndex: index,
    });
    const signature = Buffer.from(
      await device.signTransaction(
        request.derivationIndex,
        Buffer.from(request.signatureBase, 'base64'),
      ),
    ).toString('base64');

    await handlers['ledger.completeSign'](ctx, { requestId: request.requestId, signature });
    // The same approval must not yield a second envelope.
    await expect(
      handlers['ledger.completeSign'](ctx, { requestId: request.requestId, signature }),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUEST_EXPIRED' });
  });

  it('drops open requests when the wallet locks', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);

    const request = await handlers['ledger.beginSign'](ctx, {
      xdr: paymentXdr(publicKey),
      accountIndex: index,
    });
    await handlers['wallet.lock'](ctx, {});
    await handlers['wallet.unlock'](ctx, { password: PASSWORD });

    const signature = Buffer.from(
      await device.signTransaction(
        request.derivationIndex,
        Buffer.from(request.signatureBase, 'base64'),
      ),
    ).toString('base64');
    await expect(
      handlers['ledger.completeSign'](ctx, { requestId: request.requestId, signature }),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUEST_EXPIRED' });
  });

  it('refuses to open a request for a software account', async () => {
    const { ctx, publicKey } = await freshWallet();
    await expect(
      handlers['ledger.beginSign'](ctx, { xdr: paymentXdr(publicKey), accountIndex: 0 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * Not a limitation to paper over: the Stellar app cannot render a contract
   * call, so signing one means confirming a bare hash on the device. Refusing
   * is the same decision §5 makes everywhere else.
   */
  it('refuses a contract call rather than asking for blind signing', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 0);
    await handlers['settings.set'](ctx, {
      patch: { mode: 'developer', developerModeAcknowledged: true },
    });
    await expect(
      handlers['ledger.beginSign'](ctx, { xdr: contractCallXdr(publicKey), accountIndex: index }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

/* ------------------------------------------------------------ persistence */

describe('enrolment survives a lock', () => {
  it('restores the device account from the vault without the device present', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const { index, publicKey } = await enrol(ctx, device, 2, 'Nano');

    await handlers['wallet.lock'](ctx, {});
    const reopened = await handlers['wallet.unlock'](ctx, { password: PASSWORD });

    const restored = reopened.accounts.find((a) => a.index === index);
    expect(restored).toMatchObject({
      source: 'ledger',
      derivationIndex: 2,
      publicKey,
      label: 'Nano',
      path: "m/44'/148'/2'",
    });
  });

  it('rolls the account back when the vault cannot be written', async () => {
    const { ctx } = await freshWallet();
    const device = new FakeLedgerDevice();
    const publicKey = await device.getPublicKey(0, true);

    const before = (await handlers['account.list'](ctx, {})).accounts.length;
    await expect(
      handlers['ledger.addAccount'](ctx, {
        password: 'wrong password entirely',
        derivationIndex: 0,
        publicKey,
        label: '',
      }),
    ).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect((await handlers['account.list'](ctx, {})).accounts).toHaveLength(before);
  });
});
