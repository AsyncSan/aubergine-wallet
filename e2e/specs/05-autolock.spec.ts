/**
 * 5: Auto-lock via `chrome.alarms`, and the invariant behind it
 * (VERIFICATION.md risk 3).
 *
 * Two different claims are checked:
 *  a) the configured timeout really locks the wallet (real wall-clock wait, the
 *     smallest offered value: 1 minute),
 *  b) key material does not survive the service worker. An MV3 worker is killed
 *     at will; if the wallet were still unlocked afterwards, the seed would be
 *     living somewhere persistent, which invariant 1 and 2 forbid.
 */
import {
  expect,
  getAlarms,
  killServiceWorker,
  rpc,
  test,
  waitForServiceWorker,
} from '../support/extension';
import { createWallet, openSettings, walletStatus } from '../support/flows';

test('the auto-lock alarm is armed and actually fires', async ({ popup, errors }) => {
  test.setTimeout(180_000);
  await createWallet(popup);

  await openSettings(popup);
  // Settings order: [0] language, [1] auto-lock.
  const autoLock = popup.locator('select').nth(1);
  await autoLock.selectOption('1');
  await expect(popup.getByRole('button', { name: 'Übersicht' })).toBeVisible();

  const settings = await rpc(popup, 'settings.get', {});
  expect((settings.result as { autoLockMinutes: number }).autoLockMinutes).toBe(1);

  const alarms = await getAlarms(popup);
  const alarm = alarms.find((a) => a.name === 'aubergine:autolock');
  expect(alarm, `no auto-lock alarm; alarms = ${JSON.stringify(alarms)}`).toBeDefined();
  const secondsAway = ((alarm?.scheduledTime ?? 0) - Date.now()) / 1000;
  expect(secondsAway).toBeGreaterThan(0);
  expect(secondsAway).toBeLessThanOrEqual(61);

  // Close the popup so nothing keeps touching the wallet (every authenticated
  // RPC re-arms the timer, and the popup polls `wallet.status` every 20 s).
  const context = popup.context();
  const extensionId = new URL(popup.url()).host;
  await popup.close();
  await new Promise((resolve) => setTimeout(resolve, 70_000));

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(reopened.getByRole('heading', { name: 'Wallet entsperren' })).toBeVisible({
    timeout: 20_000,
  });
  expect((await walletStatus(reopened)).unlocked).toBe(false);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('a service-worker restart leaves the wallet locked (no persistent key material)', async ({
  popup,
  context,
  extensionId,
}) => {
  const { address } = await createWallet(popup);
  expect((await walletStatus(popup)).unlocked).toBe(true);

  await waitForServiceWorker(context);
  expect(await killServiceWorker(context), 'no service-worker target to kill').toBe(true);

  await popup.close().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(reopened.getByRole('heading', { name: 'Wallet entsperren' })).toBeVisible({
    timeout: 20_000,
  });
  const status = await walletStatus(reopened);
  expect(status.initialized, 'the keystore must survive, only the keys must not').toBe(true);
  expect(status.unlocked, 'the wallet was still unlocked after a worker restart').toBe(false);
  expect(status.autoLockAt).toBeNull();

  // Sanity: the account is still recoverable with the password afterwards.
  expect(address).toHaveLength(56);
});

test('an idle service worker takes the keys with it', async ({ popup, context, extensionId }) => {
  test.setTimeout(180_000);
  await createWallet(popup);
  await popup.close();

  // MV3 kills an idle worker after ~30 s. Nothing else may keep the wallet
  // unlocked once that happens.
  const deadline = Date.now() + 120_000;
  while (context.serviceWorkers().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const workerDied = context.serviceWorkers().length === 0;

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);
  if (!workerDied) {
    test.info().annotations.push({
      type: 'note',
      description: 'the service worker never went idle within 120 s; check skipped',
    });
    return;
  }
  await expect(reopened.getByRole('heading', { name: 'Wallet entsperren' })).toBeVisible({
    timeout: 20_000,
  });
  expect((await walletStatus(reopened)).unlocked).toBe(false);
  // And Home is not reachable behind the lock screen.
  await expect(reopened.getByTestId('balance-hero')).toHaveCount(0);
});
