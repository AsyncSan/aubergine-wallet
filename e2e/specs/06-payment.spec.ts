/**
 * 6: Sending a payment, end to end through the UI.
 *
 * The confirmation dialog is the product's core claim (§5), so the assertions
 * are about what a human actually reads: a plain-language sentence, the network
 * name, the fee. The signed envelope that leaves the wallet is parsed and its
 * signature verified in the test process, proof that the background really
 * signed with the account's key, not that a button was clickable.
 */
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { expect, rpc, screenshot, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';

const RECIPIENT = Keypair.random().publicKey();

test('payment: confirm dialog, submission, and a verifiable signature', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  horizon.fund(RECIPIENT, { xlm: '10.0000000' });
  await reloadPopup(popup);

  await popup.getByRole('button', { name: 'Senden' }).click();
  await popup.getByRole('textbox').first().fill(RECIPIENT);
  await popup.locator('input[inputmode="decimal"]').fill('25');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();

  // ---- the plain-language preview (§5) --------------------------------
  await expect(popup.getByRole('heading', { name: 'Bitte bestätigen' })).toBeVisible();
  await expect(popup.getByText('Das passiert')).toBeVisible();
  const summary = await popup.locator('section').first().innerText();
  expect(summary).toContain('25.0000000 XLM');
  expect(summary).toContain(`${RECIPIENT.slice(0, 4)}`);
  expect(summary).toMatch(/senden/u);

  // The network has to be on screen, in words, before anyone signs anything.
  const details = await popup.getByText('Details').locator('..').innerText();
  expect(details).toContain('Testnetzwerk');
  expect(details).toContain('Netzwerkgebühr');
  expect(details).toContain('0.00001 XLM');

  // Beginner mode: no raw XDR anywhere (§4 row 2).
  await expect(popup.getByText('Technische Ansicht (XDR)')).toHaveCount(0);
  await screenshot(popup, '08-confirm-payment');

  // ---- rejecting goes back to the form, submits nothing ---------------
  await popup.getByRole('button', { name: 'Ablehnen' }).click();
  await expect(popup.getByRole('heading', { name: 'Senden' })).toBeVisible();
  expect(horizon.submitted).toHaveLength(0);

  // ---- confirming submits exactly one signed envelope -----------------
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();
  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();
  await expect(popup.getByRole('heading', { name: 'Gesendet.' })).toBeVisible({ timeout: 30_000 });

  expect(horizon.submitted).toHaveLength(1);
  const envelope = TransactionBuilder.fromXDR(horizon.submitted[0] ?? '', Networks.TESTNET);
  if ('innerTransaction' in envelope) throw new Error('unexpected fee-bump envelope');
  /**
   * The receipt shows the hash of the envelope that actually went out. It used
   * to be compared against a constant the mock made up, which hid the fact that
   * the wallet took the endpoint's word for which transaction it had just sent:
   * `submitTransactionXdr` now reports its own hash and refuses to call an
   * answer given under any other hash a success.
   */
  await expect(popup.getByText(envelope.hash().toString('hex'))).toBeVisible();
  await screenshot(popup, '09-payment-sent');
  expect(envelope.source).toBe(address);
  expect(envelope.operations).toHaveLength(1);
  const op = envelope.operations[0];
  expect(op?.type).toBe('payment');
  expect((op as { destination: string }).destination).toBe(RECIPIENT);
  expect((op as { amount: string }).amount).toBe('25.0000000');
  expect(envelope.signatures).toHaveLength(1);
  const signature = envelope.signatures[0]?.signature();
  expect(
    Keypair.fromPublicKey(address).verify(envelope.hash(), signature as Buffer),
    'the submitted envelope is not signed by the wallet account',
  ).toBe(true);

  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('a rejected submission surfaces the result code, not a raw exception', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  horizon.fund(RECIPIENT, { xlm: '10.0000000' });
  horizon.submitMode = { kind: 'failure', transactionCode: 'tx_insufficient_balance' };
  await reloadPopup(popup);

  await popup.getByRole('button', { name: 'Senden' }).click();
  await popup.getByRole('textbox').first().fill(RECIPIENT);
  await popup.locator('input[inputmode="decimal"]').fill('25');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();
  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();

  // Seit den uebersetzten Ergebniscodes (K4) steht hier die Erklaerung zum
  // Code, nicht mehr die Sammelmeldung mit dem rohen Code in Klammern.
  await expect(
    popup.getByText(
      'Dein XLM-Guthaben reicht nicht einmal für die Netzwerkgebühr, ohne den reservierten Kontobetrag anzutasten. Lade etwas XLM nach.',
    ),
  ).toBeVisible({ timeout: 30_000 });
  // Still on the confirmation screen, nothing pretends to have succeeded.
  await expect(popup.getByRole('heading', { name: 'Gesendet.' })).toHaveCount(0);
  await screenshot(popup, '10-payment-failed');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

/**
 * A 5xx on submission is *not* a failure: the envelope may already be on its
 * way into a ledger, and it stays valid for another 180 s. The screen that
 * used to say "the network cannot be reached", and offered a way straight
 * back to the form, is the reason a user could pay twice.
 */
test('a submission without an answer becomes "outcome open", not "failed"', async ({
  popup,
  horizon,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  horizon.fund(RECIPIENT, { xlm: '10.0000000' });
  horizon.submitMode = { kind: 'network-error' };
  // Horizon has not ingested the transaction: the honest "not yet" answer.
  horizon.txLookupMode = 'not-found';
  await reloadPopup(popup);

  await popup.getByRole('button', { name: 'Senden' }).click();
  await popup.getByRole('textbox').first().fill(RECIPIENT);
  await popup.locator('input[inputmode="decimal"]').fill('25');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();
  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();

  await expect(popup.getByRole('heading', { name: 'Ausgang noch offen' })).toBeVisible({
    timeout: 30_000,
  });
  // The old message claimed an outcome the wallet does not have.
  await expect(popup.getByText('Das Netzwerk ist gerade nicht erreichbar.')).toHaveCount(0);
  // The hash is on screen; the only handle on a payment nobody can confirm.
  await expect(popup.locator('[data-testid="pending-hash"]')).toHaveText(/^[0-9a-f]{64}$/u);

  // And, the point of the whole exercise: no route to a second transaction.
  await expect(popup.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Weitere Zahlung' })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Zurück' })).toHaveCount(0);
  expect(horizon.submitted).toHaveLength(1);

  // Even the background refuses: `tx.build` fetches a fresh sequence number,
  // which is exactly what would make both payments valid.
  const rebuilt = await rpc(popup, 'tx.build', {
    intent: { kind: 'payment', destination: RECIPIENT, assetId: 'native', amount: '25' },
  });
  expect(rebuilt.ok).toBe(false);
  expect((rebuilt.error as { code?: string } | undefined)?.code).toBe('SUBMIT_OUTCOME_UNKNOWN');
  expect(horizon.submitted).toHaveLength(1);
});

test('the form refuses an invalid address and an amount above the spendable balance', async ({
  popup,
  horizon,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '10.0000000' });
  await reloadPopup(popup);

  await popup.getByRole('button', { name: 'Senden' }).click();
  const recipient = popup.getByRole('textbox').first();
  await recipient.fill('GTHIS-IS-NOT-AN-ADDRESS');
  await expect(popup.getByText('Diese Adresse ist ungültig.')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Weiter zur Bestätigung' })).toBeDisabled();

  await recipient.fill(RECIPIENT);
  await popup.locator('input[inputmode="decimal"]').fill('9999');
  await expect(popup.getByText('Dein verfügbares Guthaben reicht nicht aus.')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Weiter zur Bestätigung' })).toBeDisabled();

  // Nothing was ever built, so nothing could have been signed.
  const built = await rpc(popup, 'tx.build', {
    intent: { kind: 'payment', destination: RECIPIENT, assetId: 'native', amount: '9999' },
  });
  expect(built.ok).toBe(true); // the background builds; the *network* would reject it
  expect(horizon.submitted).toHaveLength(0);
});
