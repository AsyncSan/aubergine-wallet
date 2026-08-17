/**
 * 14: Receive (redesign v1.1, P2): the QR code is the hero of the screen.
 *
 * What is being proven: the QR screen shows the wallet's own address (not just
 * any G… string), the copy pill gives visible feedback, and the share button
 * exists with a working copy fallback where the browser has no native share
 * sheet (the normal case on desktop Linux/Chromium).
 */
import { expect, screenshot, test } from '../support/extension';
import { createWallet, expectHome } from '../support/flows';

test('receive: QR hero, the wallet address, copy and share feedback', async ({
  popup,
  errors,
}) => {
  const { address } = await createWallet(popup);

  await popup.getByTestId('action-receive').click();
  await expect(popup.getByRole('heading', { name: 'Empfangen' })).toBeVisible();

  // QR hero, generated locally and labelled for screen readers.
  await expect(popup.getByTestId('receive-qr')).toBeVisible();
  await expect(popup.getByTestId('receive-qr')).toHaveAttribute(
    'aria-label',
    'QR-Code deiner Adresse',
  );

  // The address below the QR is exactly the wallet's own address.
  await expect(popup.getByText(address)).toBeVisible();

  // Testnet guard rail stays on the redesigned screen.
  await expect(popup.getByText(/Testnetzwerk/u).last()).toBeVisible();

  await screenshot(popup, '14-receive');

  // Copy pill: visible feedback after the click.
  await popup.getByText('Kopieren', { exact: true }).click();
  await expect(popup.getByText('Kopiert', { exact: true })).toBeVisible();

  // Share: with no navigator.share (desktop Linux), the fallback copies and
  // says so on the button itself.
  const hasNativeShare = await popup.evaluate(() => typeof navigator.share === 'function');
  const shareButton = popup.getByRole('button', { name: 'Adresse teilen' });
  await expect(shareButton).toBeVisible();
  if (!hasNativeShare) {
    await shareButton.click();
    // `exact` matters: the copy pill above may still be in its own transient
    // "Kopiert" state, and a substring match would then hit two buttons.
    await expect(popup.getByRole('button', { name: 'Kopiert', exact: true })).toBeVisible();
  }

  // Back to Home via the header.
  await popup.getByRole('button', { name: 'Zurück' }).click();
  await expectHome(popup);

  expect(errors.problems, errors.format()).toHaveLength(0);
});
