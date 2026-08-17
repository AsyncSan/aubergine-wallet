/**
 * 4: Keystore round-trip through the real `chrome.storage.local`.
 *
 * What is being proven: the wallet that comes back after a lock is the *same*
 * wallet (same address), a wrong password is refused with a translated message
 * and no access, and the ciphertext survived a real browser storage write/read
 * rather than an in-memory stub.
 */
import { expect, readStorage, rpc, screenshot, test } from '../support/extension';
import { createWallet, readHomeAddress, TEST_PASSWORD, unlock, walletStatus } from '../support/flows';

test('lock, wrong password, right password, same address', async ({
  popup,
  context,
  extensionId,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });

  await popup.getByRole('button', { name: 'Sperren' }).click();
  await expect(popup.getByRole('heading', { name: 'Wallet entsperren' })).toBeVisible();
  expect((await walletStatus(popup)).unlocked).toBe(false);

  // Wrong password: a translated message, and still no access.
  await unlock(popup, 'definitely-not-the-password');
  await expect(popup.getByText('Das Passwort ist falsch.')).toBeVisible();
  expect((await walletStatus(popup)).unlocked).toBe(false);
  const blocked = await rpc(popup, 'account.list', {});
  expect(blocked.ok).toBe(false);
  expect(blocked.error?.code).toBe('WALLET_LOCKED');
  await screenshot(popup, '07-unlock-wrong-password');

  // Right password: the very same account comes back out of the keystore.
  await unlock(popup, TEST_PASSWORD);
  expect(await readHomeAddress(popup)).toBe(address);

  // And it survives closing the popup entirely and opening a new one.
  await popup.close();
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);
  expect(await readHomeAddress(reopened)).toBe(address);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('closing the popup does not lock; the keyring lives in the worker', async ({
  popup,
  context,
  extensionId,
}) => {
  const { address } = await createWallet(popup);
  await popup.close();

  // Documented behaviour, not a bug: §3 keeps the keyring in the service
  // worker's RAM and locks on the auto-lock timer, not on popup close. The
  // popup itself holds nothing (invariant 1), so reopening finds it unlocked.
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);
  expect(await readHomeAddress(reopened)).toBe(address);
  expect((await walletStatus(reopened)).unlocked).toBe(true);
});

test('the keystore in storage.local is the only persisted artefact', async ({ popup }) => {
  const { address } = await createWallet(popup);

  // A fresh install writes only the keystore; settings are persisted the first
  // time they change, so provoke that write before looking at the storage.
  const written = await rpc(popup, 'settings.set', { patch: { locale: 'de' } });
  expect(written.ok).toBe(true);

  const local = await readStorage(popup, 'local');
  const sync = await readStorage(popup, 'sync');
  // uiProgress.v1 (redesign v1.1): cosmetic checklist flags, booleans only.
  expect(Object.keys(local).sort()).toEqual(['keystore.v1', 'settings.v1', 'uiProgress.v1']);
  expect(Object.keys(sync)).toEqual(['settings.v1']);
  const uiProgress = local['uiProgress.v1'] as Record<string, unknown>;
  for (const value of Object.values(uiProgress)) expect(typeof value).toBe('boolean');

  // Settings are non-sensitive; the address is public, but nothing else leaks.
  const settings = local['settings.v1'] as Record<string, unknown>;
  expect(Object.keys(settings).sort()).toEqual([
    'allowedOrigins',
    'autoLockMinutes',
    'customNetwork',
    'developerModeAcknowledged',
    'locale',
    'mainnetAcknowledged',
    'mode',
    'networkId',
    'selectedAccountIndex',
    'sorobanRpcOverride',
    'theme',
  ]);
  expect(JSON.stringify(local)).not.toContain(address.slice(0, 20));
});
