/**
 * 11; The dApp flow from a real web page: `getPublicKey`, `signTransaction`,
 * the approval dialog, the rejection path and NETWORK_MISMATCH.
 *
 * Runs against the `pregranted` artefact for the same reason as spec 10.
 * Everything the page sees goes through `window.aubergine` → content script
 * → background, i.e. the whole §3 chain.
 */
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import type { Page } from '@playwright/test';
import { expect, rpc, screenshot, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';
import { startTestPageServer, type TestPageServer } from '../support/test-page';

test.use({ hostAccess: 'pregranted' });

const SEQUENCE = '4611686044486139904';

let server: TestPageServer;

test.beforeAll(async () => {
  server = await startTestPageServer();
});

test.afterAll(async () => {
  await server.close();
});

interface PageCall {
  ok: boolean;
  value?: unknown;
  error?: { name: string; code: unknown; message: string };
}

/** Start a provider call in the page without awaiting it. */
function callProvider(
  site: Page,
  method: 'getPublicKey' | 'signTransaction' | 'isConnected' | 'getNetwork',
  args: unknown[] = [],
): { pending: Promise<PageCall> } {
  const pending = site.evaluate(
    async ({ method: m, args: a }) => {
      const provider = (globalThis as unknown as Record<string, Record<string, unknown>>)[
        'aubergine'
      ] as Record<string, unknown>;
      const fn = provider[m] as (...rest: unknown[]) => Promise<unknown>;
      try {
        return { ok: true, value: await fn.apply(provider, a) };
      } catch (error) {
        const e = error as { name?: string; code?: unknown; message?: string };
        return {
          ok: false,
          error: { name: String(e.name), code: e.code, message: String(e.message) },
        };
      }
    },
    { method, args },
  ) as Promise<PageCall>;
  pending.catch(() => undefined);
  return { pending };
}

async function setUp(popup: Page, context: import('@playwright/test').BrowserContext) {
  const { address } = await createWallet(popup);
  await rpc(popup, 'settings.set', { patch: { mode: 'developer' } });
  await reloadPopup(popup);
  const site = await context.newPage();
  await site.goto(server.origin);
  await expect
    .poll(
      () =>
        site.evaluate(
          () => (globalThis as unknown as Record<string, unknown>)['aubergine'] !== undefined,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  return { address, site };
}

test('getPublicKey: approval hands out the address, rejection a typed error', async ({
  popup,
  context,
  horizon,
  errors,
}) => {
  const { address, site } = await setUp(popup, context);
  horizon.fund(address, { xlm: '250.0000000' });

  // ---- rejection first, so the origin is still unknown ---------------
  const rejected = callProvider(site, 'getPublicKey');
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(popup.getByText(`${server.origin} möchte deine Adresse sehen.`)).toBeVisible();
  await expect(popup.getByText('Diese Webseite kennst du noch nicht.')).toBeVisible();
  await screenshot(popup, '19-dapp-connect-prompt');
  await popup.getByRole('button', { name: 'Ablehnen' }).click();

  const rejection = await rejected.pending;
  expect(rejection.ok).toBe(false);
  // Finding 6 in VERIFICATION.md: the documented `error.code` must exist.
  expect(rejection.error?.code).toBe('USER_REJECTED');
  expect(rejection.error?.name).toBe('AubergineProviderError');
  expect(rejection.error?.message).toBe('The user rejected the request.');

  // Nothing was remembered, so the next call asks again.
  const settingsAfterReject = await rpc(popup, 'settings.get', {});
  expect((settingsAfterReject.result as { allowedOrigins: string[] }).allowedOrigins).toEqual([]);

  // ---- approval -------------------------------------------------------
  const approved = callProvider(site, 'getPublicKey');
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  await popup.getByRole('button', { name: 'Freigeben' }).click();
  const answer = await approved.pending;
  expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
  expect(answer.value).toBe(address);

  // The origin is on the allow-list afterwards and visible in Settings.
  const settings = await rpc(popup, 'settings.get', {});
  expect((settings.result as { allowedOrigins: string[] }).allowedOrigins).toEqual([
    server.origin,
  ]);

  // A second call needs no prompt at all.
  const again = await callProvider(site, 'getPublicKey').pending;
  expect(again.value).toBe(address);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('signTransaction: the dialog signs the exact envelope and the page can verify it', async ({
  popup,
  context,
  horizon,
  errors,
}) => {
  const { address, site } = await setUp(popup, context);
  horizon.fund(address, { xlm: '250.0000000' });
  const destination = Keypair.random().publicKey();
  horizon.fund(destination, { xlm: '5.0000000' });
  await rpc(popup, 'settings.set', { patch: { allowedOrigins: [server.origin] } });

  const xdr = new TransactionBuilder(new Account(address, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination, asset: (await import('@stellar/stellar-sdk')).Asset.native(), amount: '3' }),
    )
    .setTimeout(180)
    .build()
    .toXDR();

  const call = callProvider(site, 'signTransaction', [
    xdr,
    { networkPassphrase: Networks.TESTNET },
  ]);
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(popup.getByText(`${server.origin} bittet dich`, { exact: false })).toBeVisible();
  await expect(popup.getByText(/3\.0000000 XLM an .* senden/u)).toBeVisible();
  await expect(popup.getByText('Testnetzwerk', { exact: true })).toBeVisible();
  await screenshot(popup, '20-dapp-sign-prompt');

  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();
  const answer = await call.pending;
  expect(answer.ok, JSON.stringify(answer.error)).toBe(true);

  const signed = TransactionBuilder.fromXDR(String(answer.value), Networks.TESTNET);
  if ('innerTransaction' in signed) throw new Error('unexpected fee bump');
  expect(signed.signatures).toHaveLength(1);
  expect(
    Keypair.fromPublicKey(address).verify(
      signed.hash(),
      signed.signatures[0]?.signature() as Buffer,
    ),
  ).toBe(true);
  // Invariant 1: only a signature came back, never a key.
  expect(String(answer.value)).not.toMatch(/^S[A-Z2-7]{55}$/u);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('signTransaction: rejecting gives the page USER_REJECTED and signs nothing', async ({
  popup,
  context,
  horizon,
}) => {
  const { address, site } = await setUp(popup, context);
  horizon.fund(address, { xlm: '250.0000000' });
  await rpc(popup, 'settings.set', { patch: { allowedOrigins: [server.origin] } });

  const xdr = new TransactionBuilder(new Account(address, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '4611686044486139999' }))
    .setTimeout(180)
    .build()
    .toXDR();

  const call = callProvider(site, 'signTransaction', [xdr]);
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  await popup.getByRole('button', { name: 'Ablehnen' }).click();

  const answer = await call.pending;
  expect(answer.ok).toBe(false);
  expect(answer.error?.code).toBe('USER_REJECTED');
  expect(horizon.submitted).toHaveLength(0);
});

test('a page that declares a different network triggers NETWORK_MISMATCH', async ({
  popup,
  context,
  horizon,
  errors,
}) => {
  const { address, site } = await setUp(popup, context);
  horizon.fund(address, { xlm: '250.0000000' });
  const destination = Keypair.random().publicKey();
  horizon.fund(destination, { xlm: '5.0000000' });
  await rpc(popup, 'settings.set', { patch: { allowedOrigins: [server.origin] } });

  const xdr = new TransactionBuilder(new Account(address, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: (await import('@stellar/stellar-sdk')).Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(180)
    .build()
    .toXDR();

  // The page claims this envelope belongs to the public network.
  const call = callProvider(site, 'signTransaction', [
    xdr,
    { networkPassphrase: Networks.PUBLIC },
  ]);
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  // The network is named the same way here as in the details row below it.
  await expect(
    popup.getByText(
      'Die Transaktion gehört zu einem anderen Netzwerk als dem eingestellten (Testnetzwerk).',
    ),
  ).toBeVisible();
  await screenshot(popup, '21-dapp-network-mismatch');

  await popup.getByRole('button', { name: 'Ablehnen' }).click();
  expect((await call.pending).error?.code).toBe('USER_REJECTED');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('isConnected says the connector exists; getNetwork answers connected pages only', async ({
  popup,
  context,
  errors,
}) => {
  const { site } = await setUp(popup, context);

  // `isConnected` reports that the connector is available. It deliberately does
  // NOT report whether the wallet is unlocked: that was a free "wallet present
  // and unlocked" oracle for every page in the browser, with no legitimate use.
  expect((await callProvider(site, 'isConnected').pending).value).toBe(true);

  // This origin has not been approved yet, so the network stays private,
  // which network the wallet is on (and whether real money is in play) is a
  // targeting signal, and it used to be handed out to anyone who asked.
  const beforeApproval = await callProvider(site, 'getNetwork').pending;
  expect(beforeApproval.ok).toBe(false);
  expect(beforeApproval.error?.code ?? beforeApproval.error?.message).toBe('USER_REJECTED');

  // After the user approves the origin, it gets a straight answer and no prompt.
  const approving = callProvider(site, 'getPublicKey');
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  await popup.getByRole('button', { name: 'Freigeben' }).click();
  expect((await approving.pending).ok).toBe(true);

  expect((await callProvider(site, 'getNetwork').pending).value).toEqual({
    network: 'testnet',
    networkPassphrase: Networks.TESTNET,
  });

  // Locking the wallet does not change either answer; the page learns nothing
  // about the lock state.
  await popup.getByRole('button', { name: 'Sperren' }).click();
  expect((await callProvider(site, 'isConnected').pending).value).toBe(true);
  expect(errors.problems, errors.format()).toHaveLength(0);
});
