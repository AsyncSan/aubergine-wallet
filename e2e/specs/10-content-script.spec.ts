/**
 * 10: Invariant 7: the content script exists only while developer mode is on.
 *
 * Runs against the `pregranted` artefact (see `makePreGrantedExtension`),
 * because the connector's host access is an *optional* permission and its
 * native grant dialog cannot be answered in headless automation. The mode
 * switch itself, the registration and the deregistration are all the real code.
 */
import { expect, rpc, test } from '../support/extension';
import {
  createWallet,
  enableDeveloperMode,
  openSettings,
  registeredScripts,
  writeSyncedSettings,
} from '../support/flows';
import { startTestPageServer, type TestPageServer } from '../support/test-page';

test.use({ hostAccess: 'pregranted' });

let server: TestPageServer;

test.beforeAll(async () => {
  server = await startTestPageServer();
});

test.afterAll(async () => {
  await server.close();
});

async function providerPresent(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    () => (globalThis as unknown as Record<string, unknown>)['aubergine'] !== undefined,
  );
}

test('no provider in beginner mode, provider in developer mode, gone again after', async ({
  popup,
  context,
  errors,
}) => {
  await createWallet(popup);

  const site = await context.newPage();
  await site.goto(server.origin);

  // ---- beginner: nothing at all -------------------------------------
  expect(await providerPresent(site)).toBe(false);
  expect(await registeredScripts(popup)).toEqual([]);
  // The page cannot reach the extension directly either (no
  // externally_connectable is declared).
  expect(
    await site.evaluate(() => {
      const c = (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome;
      return c?.runtime !== undefined;
    }),
  ).toBe(false);

  // ---- developer: the provider appears ------------------------------
  await openSettings(popup);
  await enableDeveloperMode(popup);
  await expect
    .poll(() => registeredScripts(popup), { timeout: 10_000 })
    .toEqual(['aubergine-dapp-connector']);

  await site.reload();
  await expect.poll(() => providerPresent(site), { timeout: 10_000 }).toBe(true);
  const shape = await site.evaluate(() => {
    const provider = (globalThis as unknown as Record<string, Record<string, unknown>>)[
      'aubergine'
    ] as Record<string, unknown>;
    return {
      marker: provider['isAubergine'],
      methods: Object.keys(provider).sort(),
      frozen: Object.isFrozen(provider),
    };
  });
  expect(shape.marker).toBe(true);
  expect(shape.methods).toEqual([
    'getNetwork',
    'getPublicKey',
    'isAubergine',
    'isConnected',
    'signTransaction',
  ]);
  expect(shape.frozen).toBe(true);

  // ---- back to beginner: the registration is removed ----------------
  await popup.getByRole('button', { name: 'Einsteiger', exact: true }).click();
  await expect.poll(() => registeredScripts(popup), { timeout: 10_000 }).toEqual([]);

  const after = await context.newPage();
  await after.goto(server.origin);
  expect(await providerPresent(after)).toBe(false);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

/**
 * The settings cache used to live for the whole worker lifetime, which made
 * `chrome.storage.sync`; the whole point of putting the mode there (§4),
 * effectively dead. The listener has to notice the change *and* stay
 * fail-closed about the permission it does not have.
 */
test('a settings change arriving through storage is picked up and registers the script', async ({
  popup,
  context,
}) => {
  await createWallet(popup);
  expect(await registeredScripts(popup)).toEqual([]);

  // Write the mode the way another profile's sync would, bypassing settings.set.
  await writeSyncedSettings(popup, { mode: 'developer' });

  // The worker re-read its settings and acted on them, without a restart.
  await expect.poll(() => registeredScripts(popup), { timeout: 10_000 }).toEqual([
    'aubergine-dapp-connector',
  ]);
  const site = await context.newPage();
  await site.goto(server.origin);
  await expect.poll(() => providerPresent(site), { timeout: 10_000 }).toBe(true);

  // And the same route back off again.
  await writeSyncedSettings(popup, { mode: 'beginner' });
  await expect.poll(() => registeredScripts(popup), { timeout: 10_000 }).toEqual([]);
});

test.describe('without the connector host permission', () => {
  test.use({ hostAccess: 'default' });

  test('a synced mode change never registers a content script', async ({ popup, context }) => {
    await createWallet(popup);
    await writeSyncedSettings(popup, { mode: 'developer' });

    // The mode arrives …
    await expect
      .poll(async () => (await rpc(popup, 'settings.get', {})).result as { mode: string }, {
        timeout: 10_000,
      })
      .toMatchObject({ mode: 'developer' });

    // … but web access is not something a sync message can grant.
    await popup.waitForTimeout(2_000);
    expect(await registeredScripts(popup)).toEqual([]);
    const site = await context.newPage();
    await site.goto(server.origin);
    expect(await providerPresent(site)).toBe(false);
  });
});

test('the registration survives a service-worker restart in developer mode', async ({
  popup,
  context,
}) => {
  await createWallet(popup);
  await rpc(popup, 'settings.set', { patch: { mode: 'developer' } });

  await expect
    .poll(() => registeredScripts(popup), { timeout: 10_000 })
    .toEqual(['aubergine-dapp-connector']);

  const site = await context.newPage();
  await site.goto(server.origin);
  expect(await providerPresent(site)).toBe(true);
});
