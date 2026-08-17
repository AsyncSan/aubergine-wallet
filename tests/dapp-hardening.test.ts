/**
 * The dApp boundary, plus three guards that were only ever asserted by the
 * comment above them: the settings write after a prompt, the mainnet gate on
 * `settings.set`, and the fee-bump refusal in both signing paths.
 *
 * Deliberately mock-free where it counts; these drive the real handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

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
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => undefined,
      unregisterContentScripts: async () => undefined,
    },
  },
}));

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
      accountId,
      exists: true,
      sequence: '100',
      balances: [],
      reserves: {
        baseReserveXlm: '0.5',
        subentryCount: 0,
        numSponsoring: 0,
        numSponsored: 0,
        totalReservedXlm: '1.0000000',
        spendableXlm: '100.0000000',
        maxSendableXlm: '100.0000000',
      },
      signers: [],
      thresholds: { low: 0, medium: 0, high: 0 },
      subentryCount: 0,
      memoRequired: false,
    }),
  };
});

const { BackgroundContext, handlers } = await import('../src/background/handlers');
const { MAX_PENDING_TOTAL } = await import('../src/background/dapp');
const { memoRequiredFromData } = await import('../src/core/stellar/horizon');

const PASSWORD = 'correct horse battery';
const ORIGIN = 'https://good.example';
const EVIL = 'https://evil.example';
const OTHER_KEY = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

beforeEach(() => {
  localStore.clear();
  syncStore.clear();
});

async function walletInDeveloperMode(): Promise<{
  ctx: InstanceType<typeof BackgroundContext>;
  publicKey: string;
}> {
  const ctx = new BackgroundContext();
  const created = await handlers['wallet.create'](ctx, { password: PASSWORD, strength: 128 });
  const first = created.accounts[0];
  if (first === undefined) throw new Error('no account');
  await handlers['settings.set'](ctx, {
    patch: { mode: 'developer', allowedOrigins: [ORIGIN] },
  });
  return { ctx, publicKey: first.publicKey };
}

function paymentXdr(source: string, destination = source): string {
  return new TransactionBuilder(new Account(source, '100'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' }))
    .setTimeout(180)
    .build()
    .toXDR();
}

function feeBumpXdr(source: string): string {
  const inner = new TransactionBuilder(new Account(source, '100'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: source, asset: Asset.native(), amount: '1' }))
    .setTimeout(180)
    .build();
  return TransactionBuilder.buildFeeBumpTransaction(
    source,
    '2000',
    inner,
    Networks.TESTNET,
  ).toXDR();
}

/** Wait until a prompt is queued, then answer it. */
async function answerPrompt(
  ctx: InstanceType<typeof BackgroundContext>,
  approved: boolean,
): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const pending = ctx.prompts.pending;
    if (pending !== null) {
      ctx.prompts.resolve(pending.requestId, approved);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no prompt appeared');
}

/* ------------------------------------------------- connect ↔ settings race */

describe('approving a connect prompt does not roll back the settings', () => {
  it('keeps a revocation the user made while the prompt was open', async () => {
    const { ctx } = await walletInDeveloperMode();
    const connecting = handlers['dapp.requestConnect'](ctx, { origin: EVIL });

    // The user revokes the other origin and tightens the auto-lock *while*
    // evil.example's prompt is waiting.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handlers['settings.set'](ctx, { patch: { allowedOrigins: [], autoLockMinutes: 1 } });

    await answerPrompt(ctx, true);
    await connecting;

    const settings = await handlers['settings.get'](ctx, {});
    // The approval adds evil.example and nothing else: the revocation stands
    // and the tightened auto-lock survives.
    expect(settings.allowedOrigins).toEqual([EVIL]);
    expect(settings.autoLockMinutes).toBe(1);
  });

  it('refuses to grant if developer mode was switched off during the prompt', async () => {
    const { ctx } = await walletInDeveloperMode();
    const connecting = handlers['dapp.requestConnect'](ctx, { origin: EVIL });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handlers['settings.set'](ctx, { patch: { mode: 'beginner' } });
    await answerPrompt(ctx, true);

    await expect(connecting).rejects.toMatchObject({ code: 'DEVELOPER_MODE_REQUIRED' });
    expect((await handlers['settings.get'](ctx, {})).allowedOrigins).not.toContain(EVIL);
  });
});

/* -------------------------------------------------------- the mainnet gate */

describe('settings.set can never reach real money', () => {
  it('ignores mainnetAcknowledged in a generic patch', async () => {
    const { ctx } = await walletInDeveloperMode();
    // Exactly the shape a restored backup or a migration would replay.
    const next = await handlers['settings.set'](ctx, {
      patch: { networkId: 'mainnet', mainnetAcknowledged: true },
    });
    expect(next.mainnetAcknowledged).toBe(false);
    expect((await ctx.network()).isMainnet).toBe(false);
  });

  it('still lets the acknowledged flag through the dedicated path', async () => {
    const { ctx } = await walletInDeveloperMode();
    await handlers['settings.acknowledgeMainnet'](ctx, { confirmation: 'MAINNET' });
    await handlers['settings.set'](ctx, { patch: { networkId: 'mainnet' } });
    expect((await ctx.network()).isMainnet).toBe(true);
  });
});

/* ------------------------------------------------------------- auto-lock */

describe('polling does not keep an expired session alive', () => {
  it('locks on the balance poll instead of refreshing the deadline', async () => {
    const { ctx } = await walletInDeveloperMode();
    ctx.autoLock.setMinutes(1);
    await ctx.autoLock.touch();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000);
      // The popup's 30 s balance poll used to revive the session here, because
      // `touch()` ran before the expiry check.
      await expect(handlers['account.balances'](ctx, {})).rejects.toMatchObject({
        code: 'WALLET_LOCKED',
      });
      expect(ctx.keyring.isUnlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ---------------------------------------------------------- prompt flood */

describe('prompt flooding', () => {
  it('caps the total queue across origins, not just per origin', async () => {
    const { ctx } = await walletInDeveloperMode();
    const pending: Array<Promise<unknown>> = [];
    // Subdomains are separate origins, so the per-origin cap alone let a
    // hostile site keep the popup permanently occupied.
    for (let i = 0; i < MAX_PENDING_TOTAL + 3; i += 1) {
      pending.push(
        handlers['dapp.requestConnect'](ctx, { origin: `https://sub${i}.evil.example` }).catch(
          (err: unknown) => err,
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.prompts.size).toBeLessThanOrEqual(MAX_PENDING_TOTAL);
    ctx.prompts.rejectAll();
    const results = await Promise.all(pending);
    const refused = results.filter(
      (r) => r instanceof Error && (r as { code?: string }).code === 'TOO_MANY_REQUESTS',
    );
    expect(refused.length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------- the signing account */

describe('the sign prompt names the account it will use', () => {
  it('carries the signer index so the description is computed for that account', async () => {
    const { ctx, publicKey } = await walletInDeveloperMode();
    const { account: second } = await handlers['account.add'](ctx, {
      password: PASSWORD,
      label: 'second',
    });

    const signing = handlers['dapp.signXdr'](ctx, {
      origin: ORIGIN,
      xdr: paymentXdr(second.publicKey, publicKey),
      accountToSign: second.publicKey,
    }).catch((err: unknown) => err);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const prompt = await handlers['dapp.pendingPrompt'](ctx, {});
    expect(prompt?.signerPublicKey).toBe(second.publicKey);
    expect(prompt?.signerAccountIndex).toBe(1);
    expect(prompt?.signerIsSelected).toBe(false);

    ctx.prompts.rejectAll();
    await signing;
  });

  it('does not disclose which addresses the wallet holds', async () => {
    const { ctx, publicKey } = await walletInDeveloperMode();
    await expect(
      handlers['dapp.signXdr'](ctx, {
        origin: ORIGIN,
        xdr: paymentXdr(publicKey),
        accountToSign: OTHER_KEY,
      }),
    ).rejects.toMatchObject({ code: 'USER_REJECTED' });
    expect(await handlers['dapp.pendingPrompt'](ctx, {})).toBeNull();
  });
});

/* ------------------------------------------------------------- fee bumps */

describe('fee-bump envelopes are refused in both signing paths', () => {
  it('tx.sign refuses one', async () => {
    const { ctx, publicKey } = await walletInDeveloperMode();
    await expect(
      handlers['tx.sign'](ctx, { xdr: feeBumpXdr(publicKey), accountIndex: 0 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('dapp.signXdr refuses one before any prompt is created', async () => {
    const { ctx, publicKey } = await walletInDeveloperMode();
    await expect(
      handlers['dapp.signXdr'](ctx, { origin: ORIGIN, xdr: feeBumpXdr(publicKey) }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(await handlers['dapp.pendingPrompt'](ctx, {})).toBeNull();
  });
});

/* ------------------------------------------------------------ SEP-29 */

describe('SEP-29 memo flag comes from the real Horizon encoding', () => {
  it('reads the base64 "1" that Horizon actually serves', () => {
    // The only test for this used to synthesise the flag itself, so a change
    // to the parsing would not have been noticed by anything.
    expect(memoRequiredFromData({ 'config.memo_required': 'MQ==' })).toBe(true);
    expect(memoRequiredFromData({ 'config.memo_required': 'MA==' })).toBe(false);
    expect(memoRequiredFromData({ other: 'MQ==' })).toBe(false);
    expect(memoRequiredFromData(undefined)).toBe(false);
    expect(memoRequiredFromData({})).toBe(false);
  });
});
