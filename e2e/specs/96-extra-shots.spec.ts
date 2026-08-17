/**
 * Companion to 99-screenshots: captures the states that spec cannot reach in
 * one session, Onboarding welcome, Unlock and the empty history. Run via:
 *   npx playwright test -c e2e/playwright.config.ts 96-extra-shots
 */
import { expect, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';

test('capture onboarding, unlock and empty history', async ({ popup }) => {
  await popup.emulateMedia({ colorScheme: 'dark' });
  await expect(popup.getByRole('button', { name: /Neue Wallet|Wallet erstellen/ })).toBeVisible();
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: 'e2e-shots/onboarding-dark.png', animations: 'disabled' });

  // Deliberately unfunded: an account with no operations keeps the history
  // empty, which is exactly the state the hourglass prop exists for.
  await createWallet(popup);
  await reloadPopup(popup);
  await expect(popup.getByTestId('balance-hero')).toBeVisible();
  await popup.emulateMedia({ colorScheme: 'dark' });

  // Empty history behind the frosted dock.
  await popup.getByTestId('tab-history').click();
  await expect(popup.getByText('Noch keine Vorgänge.')).toBeVisible();
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: 'e2e-shots/history-empty-dark.png', animations: 'disabled' });

  // Lock → the Unlock screen with the 3D hero.
  await popup.getByTestId('tab-home').click();
  await popup.getByRole('button', { name: 'Sperren' }).click();
  await expect(popup.getByLabel('Passwort')).toBeVisible();
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: 'e2e-shots/unlock-dark.png', animations: 'disabled' });
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: 'e2e-shots/unlock-light.png', animations: 'disabled' });
});
