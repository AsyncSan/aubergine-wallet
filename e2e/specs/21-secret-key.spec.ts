/**
 * 21: exporting one account's secret key from Settings.
 *
 * The unit tests prove the handler derives the right key; this proves the part
 * only a browser can: that the screen asks for the password, that a wrong one
 * shows up as a wrong password rather than as nothing, that the key on display
 * belongs to the account named above it, and that closing the card actually
 * takes it off the screen.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { expect, screenshot, test } from '../support/extension';
import { createWallet, openSettings, readHomeAddress, TEST_PASSWORD } from '../support/flows';

const SECRET_RE = /^S[A-Z2-7]{55}$/u;

test('Settings shows the selected account key, password-gated', async ({ popup, errors }) => {
  await createWallet(popup);
  const address = await readHomeAddress(popup);
  await openSettings(popup);

  await popup.getByRole('button', { name: 'Geheimen Schlüssel anzeigen' }).click();
  // The warning is part of the offer, not a footnote after it.
  await expect(popup.getByText(/Wer diesen Schlüssel hat/u)).toBeVisible();
  await screenshot(popup, '21-secret-key-form');

  const password = popup.locator('input[type="password"]').last();
  await password.fill('not-the-password');
  await popup.getByRole('button', { name: 'Bestätigen', exact: true }).last().click();
  await expect(popup.getByText('Das Passwort ist falsch.')).toBeVisible();
  // …and nothing was shown.
  await expect(popup.getByText(SECRET_RE)).toHaveCount(0);

  await password.fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: 'Bestätigen', exact: true }).last().click();

  const shown = popup.getByText(SECRET_RE);
  await expect(shown).toBeVisible();
  const secret = (await shown.innerText()).trim();
  // The verdict comes from the SDK in the test process: this key must be the
  // key of the account the wallet shows on Home.
  expect(Keypair.fromSecret(secret).publicKey()).toBe(address);
  // The public key is on screen next to it, which is the user's own check.
  // `.last()`: the accounts list above shows the same address.
  await expect(popup.getByText(address, { exact: false }).last()).toBeVisible();
  await screenshot(popup, '21-secret-key-shown');

  await popup.getByRole('button', { name: 'Schließen' }).click();
  await expect(popup.getByText(SECRET_RE)).toHaveCount(0);
  expect(errors.problems, errors.format()).toHaveLength(0);
});
