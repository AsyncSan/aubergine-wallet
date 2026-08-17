/**
 * 16: Bottom sheets and the Home head (redesign v1.1, P3 + Mockup-Reste).
 *
 * What is being proven: the address pill copies and gives feedback, asset
 * rows open a details sheet whose issuer is the real issuer key, and sheets
 * close on X, backdrop and Escape. The reserve sheet's beginner/developer
 * split lives in 08-modes.spec.ts. (The "Mehr" sheet left in v1.2, its slot
 * is the Swap button, covered in 18-swap.spec.ts.)
 */
import { expect, screenshot, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

test('address pill and asset details sheet', async ({ popup, horizon, errors }) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer: USDC_ISSUER, balance: '25.0000000' }],
  });
  await reloadPopup(popup);

  // Home head: identicon pill with the shortened own address, copy on click.
  const pill = popup.getByTestId('address-pill');
  await expect(pill).toContainText(`${address.slice(0, 4)}…${address.slice(-4)}`);
  await pill.click();
  await expect(pill).toContainText('Kopiert');

  // Asset details for the native asset: name and balance, closed via X.
  await popup.getByTestId('token-native').click();
  const assetSheet = popup.getByTestId('asset-sheet');
  await expect(assetSheet).toBeVisible();
  await expect(assetSheet.getByText('Stellar Lumens')).toBeVisible();
  await expect(assetSheet.getByText('Bestand')).toBeVisible();
  await expect(assetSheet.getByText(/250\s?XLM/u)).toBeVisible();
  await popup.waitForTimeout(400);
  await screenshot(popup, '16-asset-sheet-native');
  await assetSheet.getByRole('button', { name: 'Schließen' }).last().click();
  await expect(assetSheet).toHaveCount(0);

  // Asset details for USDC: the full, real issuer key is on the sheet.
  await popup.getByText('USDC', { exact: true }).click();
  await expect(assetSheet).toBeVisible();
  await expect(assetSheet.getByText('Herausgeber')).toBeVisible();
  await expect(assetSheet.getByText(USDC_ISSUER)).toBeVisible();
  await popup.waitForTimeout(400);
  await screenshot(popup, '16-asset-sheet-usdc');

  // Backdrop click closes (the backdrop is the first "Schließen" control).
  await assetSheet.getByRole('button', { name: 'Schließen' }).first().click({
    position: { x: 20, y: 20 },
  });
  await expect(assetSheet).toHaveCount(0);

  // Escape closes too.
  await popup.getByTestId('reserve-info').click();
  await expect(popup.getByTestId('reserve-sheet')).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(popup.getByTestId('reserve-sheet')).toHaveCount(0);

  expect(errors.problems, errors.format()).toHaveLength(0);
});
