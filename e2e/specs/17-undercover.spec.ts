/**
 * 17: Undercover mode and the new home of "Asset hinzufügen" (v1.2).
 *
 * What is being proven: clicking the balance hero masks every amount on Home
 * (hero, reserve line, token rows) as bullets, the state survives a popup
 * restart, clicking again unmasks, and the "add asset" entry now lives at
 * the bottom of Home and in Settings, since the "Mehr" sheet is gone.
 * Masking is purely presentational: the real balance must be back, from the
 * same cached query data, the moment the user unmasks.
 */
import { expect, screenshot, test } from '../support/extension';
import { createWallet, openSettings, reloadPopup } from '../support/flows';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MASK = '••••';

test('balance click toggles undercover mode, persistently', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer: USDC_ISSUER, balance: '25.0000000' }],
  });
  await reloadPopup(popup);

  const balance = popup.getByTestId('balance-amount');
  const reserve = popup.getByTestId('reserve-info');
  const usdcRow = popup.getByTestId(`token-USDC:${USDC_ISSUER}`);

  // Visible by default: real digits everywhere, no bullets anywhere.
  await expect(balance).toContainText(/\d/u);
  await expect(usdcRow).toContainText('25');
  await expect(popup.locator('body')).not.toContainText(MASK);

  // One click: every amount on the screen is bullets, no digits in the hero.
  await balance.click();
  await expect(balance).toContainText(MASK);
  await expect(balance).not.toContainText(/\d/u);
  await expect(reserve).toContainText(MASK);
  await expect(usdcRow).toContainText(MASK);
  await expect(usdcRow).not.toContainText('25');
  await screenshot(popup, '17-undercover-on');

  // The asset sheet keeps the secret too.
  await usdcRow.click();
  const sheet = popup.getByTestId('asset-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(MASK)).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Someone who hid their balance expects it to stay hidden after a restart.
  await reloadPopup(popup);
  await expect(popup.getByTestId('balance-amount')).toContainText(MASK);

  // Second click: the real numbers are back.
  await popup.getByTestId('balance-amount').click();
  await expect(popup.getByTestId('balance-amount')).toContainText(/\d/u);
  await expect(popup.getByTestId('balance-amount')).not.toContainText(MASK);
  await expect(popup.getByTestId(`token-USDC:${USDC_ISSUER}`)).toContainText('25');

  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('"Asset hinzufügen" lives at the bottom of Home and in Settings', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  await reloadPopup(popup);

  // Bottom of the Home asset list.
  await popup.getByTestId('home-add-asset').click();
  await expect(popup.getByRole('heading', { name: 'Asset hinzufügen' })).toBeVisible();
  await popup.getByRole('button', { name: 'Zurück' }).click();
  await expect(popup.getByTestId('balance-hero')).toBeVisible();

  // And in Settings.
  await openSettings(popup);
  await popup.getByRole('button', { name: 'Asset hinzufügen' }).click();
  await expect(popup.getByRole('heading', { name: 'Asset hinzufügen' })).toBeVisible();

  expect(errors.problems, errors.format()).toHaveLength(0);
});
