/**
 * 13: Security checklist (redesign v1.1, P1) and its uiProgress.v1 store.
 *
 * After onboarding the checklist stands at 2/3 (created + phrase confirmed via
 * the word-chip quiz); it survives a popup reload because the flags live in
 * `chrome.storage.local`; a successful payment completes it; dismissing the
 * completed card is permanent.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { expect, readStorage, screenshot, test } from '../support/extension';
import { createWallet, expectHome, reloadPopup } from '../support/flows';

const RECIPIENT = Keypair.random().publicKey();

test('checklist: 2/3 after onboarding, 3/3 after the first payment, dismissable', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);

  // 2/3 out of the box: wallet created + phrase confirmed in the quiz.
  const checklist = popup.getByTestId('security-checklist');
  await expect(checklist).toBeVisible();
  await expect(popup.getByTestId('progress-ring-count')).toHaveText('2/3');

  // Expand: the two done items are marked, the first transaction is open.
  await checklist.getByRole('button', { name: 'Deine Wallet absichern' }).click();
  await expect(popup.getByTestId('checklist-created')).toContainText('Wallet erstellt');
  await expect(popup.getByTestId('checklist-backup')).toContainText(
    'Wiederherstellungssatz bestätigt',
  );
  await expect(popup.getByTestId('checklist-firsttx')).toContainText('Erste Transaktion');
  await screenshot(popup, '13-checklist-open');

  // "Los" deep-links into the send flow.
  await popup.getByTestId('checklist-firsttx').getByRole('button', { name: 'Los' }).click();
  await expect(popup.getByRole('heading', { name: 'Senden' })).toBeVisible();
  await popup.getByRole('button', { name: 'Zurück' }).click();

  // The flags are persisted, not React state: a fresh popup shows 2/3 again.
  const stored = await readStorage(popup, 'local');
  expect(stored['uiProgress.v1']).toMatchObject({ backupConfirmed: true, firstTxDone: false });
  await reloadPopup(popup);
  await expect(popup.getByTestId('progress-ring-count')).toHaveText('2/3');

  // Complete the last step with a real (mocked-Horizon) payment.
  horizon.fund(address, { xlm: '250.0000000' });
  horizon.fund(RECIPIENT, { xlm: '10.0000000' });
  await reloadPopup(popup);
  await popup.getByRole('button', { name: 'Senden' }).click();
  await popup.getByRole('textbox').first().fill(RECIPIENT);
  await popup.locator('input[inputmode="decimal"]').fill('25');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();
  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();
  await expect(popup.getByRole('heading', { name: 'Gesendet.' })).toBeVisible({
    timeout: 30_000,
  });
  await popup.getByRole('button', { name: 'Schließen' }).click();

  // 3/3, the completion line, and a dismiss control.
  await expect(popup.getByTestId('progress-ring-count')).toHaveText('3/3');
  await expect(popup.getByText('Alles erledigt — stark!')).toBeVisible();
  await screenshot(popup, '13-checklist-done');
  await popup.getByRole('button', { name: 'Ausblenden' }).click();
  await expect(popup.getByTestId('security-checklist')).toHaveCount(0);

  // Dismissal is permanent across popups.
  await reloadPopup(popup);
  await expect(popup.getByTestId('security-checklist')).toHaveCount(0);
  await expectHome(popup);

  expect(errors.problems, errors.format()).toHaveLength(0);
});
