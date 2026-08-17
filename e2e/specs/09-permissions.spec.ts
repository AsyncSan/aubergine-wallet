/**
 * 9: Optional host permissions, and specifically the *declined* branch.
 *
 * `chrome.permissions.request()` opens a native dialog that headless Chromium
 * never answers (the call simply never settles, verified). So the user's answer
 * is stubbed at the `chrome.permissions.request` boundary and everything
 * downstream is the real code: `ensureOrigins`, the settings write, the
 * content-script registration and what the UI says afterwards.
 */
import { expect, rpc, screenshot, test } from '../support/extension';
import {
  createWallet,
  enableDeveloperMode,
  openSettings,
  permissionRequests,
  registeredScripts,
  stubPermissionRequest,
} from '../support/flows';

test('declining the dApp permission leaves a consistent state, not a half switch', async ({
  popup,
  errors,
}) => {
  await stubPermissionRequest(popup, false);
  await popup.reload();
  await createWallet(popup);
  await openSettings(popup);
  await enableDeveloperMode(popup);

  // What was asked for is exactly the connector's two wildcards.
  expect(await permissionRequests(popup)).toEqual([
    { origins: ['http://*/*', 'https://*/*'] },
  ]);

  // The declined branch is visible, in words, and not silent.
  await expect(
    popup.getByText(
      'Der Entwickler-Modus ist an, aber ohne Zugriff auf Webseiten bleibt der Connector für Web-Anwendungen aus.',
      { exact: false },
    ),
  ).toBeVisible();
  await screenshot(popup, '18-permission-declined');

  // State check: developer mode really is on (badge + settings), and the
  // connector really is off (no registered content script). That is the
  // documented contract; a half-flipped state would be either mode=beginner
  // with a badge, or a registered script without permission.
  await expect(popup.locator('header').getByText('Entwickler-Modus')).toBeVisible();
  const settings = await rpc(popup, 'settings.get', {});
  expect(settings.result).toMatchObject({ mode: 'developer', developerModeAcknowledged: true });
  expect(await registeredScripts(popup)).toEqual([]);

  // And the developer-only RPCs now answer, because the *mode* is what gates
  // them; the missing permission only costs the page connector. The origin is
  // pre-approved so the call returns instead of opening a blocking prompt.
  await rpc(popup, 'settings.set', { patch: { allowedOrigins: ['https://dapp.example'] } });
  const connect = await rpc(popup, 'dapp.requestConnect', { origin: 'https://dapp.example' });
  expect(connect.ok, JSON.stringify(connect.error)).toBe(true);
  expect((connect.result as { approved: boolean }).approved).toBe(true);

  // Turning it back off is clean too.
  await popup.getByRole('button', { name: 'Einsteiger', exact: true }).click();
  await expect(popup.locator('header').getByText('Entwickler-Modus')).toHaveCount(0);
  expect(await registeredScripts(popup)).toEqual([]);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('declining the network permission leaves the network unchanged', async ({
  popup,
  errors,
}) => {
  await stubPermissionRequest(popup, false);
  await popup.reload();
  await createWallet(popup);
  // Get into developer mode without touching the permission stub's counter.
  await rpc(popup, 'settings.set', { patch: { mode: 'developer' } });
  await popup.reload();
  await openSettings(popup);

  const network = popup.locator('select').nth(2);
  await network.selectOption('mainnet');

  // v1.2: Mainnet goes through the typed gate first; the permission is only
  // requested once the user has confirmed, so that is where the decline lands.
  await popup.getByPlaceholder('MAINNET').fill('MAINNET');
  await popup.getByRole('button', { name: 'Hauptnetzwerk aktivieren' }).click();

  await expect(
    popup.getByText(
      'Ohne Zugriff auf die Endpunkte dieses Netzwerks kann die Wallet nicht dorthin wechseln.',
      { exact: false },
    ),
  ).toBeVisible();
  const settings = await rpc(popup, 'settings.get', {});
  expect((settings.result as { networkId: string }).networkId).toBe('testnet');
  await expect(popup.locator('header').getByText('Testnetzwerk (kein echtes Geld)')).toBeVisible();
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('granting the permission switches the network and asks only for that network', async ({
  popup,
}) => {
  await stubPermissionRequest(popup, true);
  await popup.reload();
  await createWallet(popup);
  await rpc(popup, 'settings.set', { patch: { mode: 'developer' } });
  await popup.reload();
  await openSettings(popup);

  await popup.locator('select').nth(2).selectOption('futurenet');
  await expect(popup.getByText('Ohne Zugriff auf die Endpunkte', { exact: false })).toHaveCount(0);
  const settings = await rpc(popup, 'settings.get', {});
  expect((settings.result as { networkId: string }).networkId).toBe('futurenet');
  expect(await permissionRequests(popup)).toEqual([
    {
      origins: [
        'https://horizon-futurenet.stellar.org/*',
        'https://rpc-futurenet.stellar.org/*',
        'https://friendbot-futurenet.stellar.org/*',
      ],
    },
  ]);
});
