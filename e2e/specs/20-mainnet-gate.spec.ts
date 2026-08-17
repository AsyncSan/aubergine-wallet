/**
 * 20; The Mainnet gate (v1.2).
 *
 * Since beginners can now reach the main network, the guard rails are the
 * feature. Everything below runs against the built Chrome artifact in real
 * Chromium; only `chrome.permissions.request` is stubbed (native dialog, see
 * spec 09), so the settings write, the fail-closed fallback and the header
 * badges are all the real code.
 *
 * The property that matters most is the last test: a plain `settings.set`,
 * the shape any future migration, backup restore or buggy caller would take,
 * must NOT put the wallet on real funds.
 */
import { expect, rpc, screenshot, test } from '../support/extension';
import { createWallet, openSettings, stubPermissionRequest } from '../support/flows';

const GATE_BODY = 'Im Hauptnetzwerk bewegst du echtes Geld';

test('a beginner is offered exactly Testnet and Mainnet', async ({ popup, errors }) => {
  await createWallet(popup);
  await openSettings(popup);

  const network = popup.locator('select').nth(2);
  await expect(network).toBeVisible();
  const values = await network.locator('option').evaluateAll((nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).value),
  );
  // Futurenet and custom endpoints stay developer surfaces.
  expect(values).toEqual(['testnet', 'mainnet']);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('picking Mainnet opens the typed gate and changes nothing until it is passed', async ({
  popup,
  errors,
}) => {
  await stubPermissionRequest(popup, true);
  await popup.reload();
  await createWallet(popup);
  await openSettings(popup);

  await popup.locator('select').nth(2).selectOption('mainnet');
  await expect(popup.getByText(GATE_BODY, { exact: false })).toBeVisible();
  await screenshot(popup, '20-mainnet-gate');

  // Nothing has been written yet, and the wallet is still on Testnet.
  let settings = await rpc(popup, 'settings.get', {});
  expect(settings.result).toMatchObject({ networkId: 'testnet', mainnetAcknowledged: false });

  // The wrong word does not unlock the button.
  const accept = popup.getByRole('button', { name: 'Hauptnetzwerk aktivieren' });
  await popup.getByPlaceholder('MAINNET').fill('mainnnet');
  await expect(accept).toBeDisabled();

  // Cancelling leaves no trace.
  await popup.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(popup.getByText(GATE_BODY, { exact: false })).toHaveCount(0);
  settings = await rpc(popup, 'settings.get', {});
  expect(settings.result).toMatchObject({ networkId: 'testnet', mainnetAcknowledged: false });
  await expect(popup.locator('header').getByText('Testnetzwerk (kein echtes Geld)')).toBeVisible();
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('passing the gate switches a beginner to Mainnet, with a permanent red badge', async ({
  popup,
  errors,
}) => {
  await stubPermissionRequest(popup, true);
  await popup.reload();
  await createWallet(popup);
  await openSettings(popup);

  await popup.locator('select').nth(2).selectOption('mainnet');
  await popup.getByPlaceholder('MAINNET').fill('mainnet');
  await popup.getByRole('button', { name: 'Hauptnetzwerk aktivieren' }).click();

  const settings = await rpc(popup, 'settings.get', {});
  expect(settings.result).toMatchObject({
    networkId: 'mainnet',
    mainnetAcknowledged: true,
    // Still a beginner; the point of the change.
    mode: 'beginner',
  });

  // Badge swap: the red one appears, the Testnet one is gone. And it survives
  // a reload, because it is derived from settings, not from component state.
  const header = popup.locator('header');
  await expect(header.getByText('Hauptnetzwerk · echtes Geld')).toBeVisible();
  await expect(header.getByText('Testnetzwerk (kein echtes Geld)')).toHaveCount(0);
  await screenshot(popup, '20-mainnet-active');
  await popup.reload();
  await expect(popup.locator('header').getByText('Hauptnetzwerk · echtes Geld')).toBeVisible();
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('leaving Mainnet withdraws the acknowledgement, so coming back needs the gate again', async ({
  popup,
  errors,
}) => {
  await stubPermissionRequest(popup, true);
  await popup.reload();
  await createWallet(popup);
  await openSettings(popup);

  const network = popup.locator('select').nth(2);
  await network.selectOption('mainnet');
  await popup.getByPlaceholder('MAINNET').fill('MAINNET');
  await popup.getByRole('button', { name: 'Hauptnetzwerk aktivieren' }).click();
  await expect(popup.locator('header').getByText('Hauptnetzwerk · echtes Geld')).toBeVisible();

  await network.selectOption('testnet');
  const settings = await rpc(popup, 'settings.get', {});
  expect(settings.result).toMatchObject({ networkId: 'testnet', mainnetAcknowledged: false });
  await expect(popup.locator('header').getByText('Testnetzwerk (kein echtes Geld)')).toBeVisible();

  // Second trip: the gate is back.
  await network.selectOption('mainnet');
  await expect(popup.getByText(GATE_BODY, { exact: false })).toBeVisible();
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('a bare settings write can never put the wallet on real funds', async ({
  popup,
  errors,
}) => {
  await createWallet(popup);

  // Exactly what a migration, a restored backup or a buggy caller would do.
  const written = await rpc(popup, 'settings.set', { patch: { networkId: 'mainnet' } });
  expect(written.ok, JSON.stringify(written.error)).toBe(true);
  await popup.reload();

  // Stored preference: mainnet. Effective network: testnet. The header, the
  // thing the user actually reads, says Testnet, and says it in warn colours.
  const settings = await rpc(popup, 'settings.get', {});
  expect(settings.result).toMatchObject({ networkId: 'mainnet', mainnetAcknowledged: false });
  const header = popup.locator('header');
  await expect(header.getByText('Testnetzwerk (kein echtes Geld)')).toBeVisible();
  await expect(header.getByText('Hauptnetzwerk · echtes Geld')).toHaveCount(0);

  // And the funding button is still there, which only Testnet has.
  await expect(popup.getByRole('button', { name: 'Testguthaben anfordern' })).toBeVisible();
  expect(errors.problems, errors.format()).toHaveLength(0);
});
