/**
 * 18: Swap (v1.2): strict-send path payment to yourself via the DEX.
 *
 * What is being proven: the fourth action button opens the swap screen, the
 * quote comes from Horizon's strict-send path finder, the minimum-received
 * floor honours the slippage choice, the confirmation renders the operation in
 * plain language, and the envelope that actually reaches the network is a
 * pathPaymentStrictSend back to the user's own account with exactly that
 * floor. Plus the two honest edge cases: no route, and only one asset held.
 */
import { Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { expect, screenshot, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

test('swaps XLM into USDC through the DEX path finder', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer: USDC_ISSUER, balance: '25.0000000' }],
  });
  horizon.pathRate = 0.5; // 1 XLM -> 0.5 USDC, flat
  await reloadPopup(popup);

  await popup.getByTestId('action-swap').click();
  await expect(popup.getByRole('heading', { name: 'Swap' })).toBeVisible();

  // Defaults: XLM out, USDC in. Type the amount; the quote arrives live.
  await popup.getByLabel('Betrag').fill('10');
  const quoteCard = popup.getByTestId('swap-quote');
  await expect(quoteCard).toContainText('5');
  // 0.5 % default slippage on a 5 USDC quote -> floor of 4.975.
  await expect(popup.getByTestId('swap-dest-min')).toContainText('4,975');
  await screenshot(popup, '18-swap-quote');

  // The slippage disclosure is genuinely usable: it opens with room for its
  // chips, and picking one immediately moves the guaranteed minimum.
  await popup.getByRole('button', { name: /Maximale Kursabweichung/u }).click();
  await popup.getByRole('button', { name: '1 %', exact: true }).click();
  await expect(popup.getByTestId('swap-dest-min')).toContainText('4,95');
  await popup.waitForTimeout(150);
  await screenshot(popup, '18-swap-slippage-open');
  await popup.getByRole('button', { name: '0,5 %' }).click();
  await expect(popup.getByTestId('swap-dest-min')).toContainText('4,975');

  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();

  // Plain-language confirmation of the path payment (§5), plus the receipt
  // card: bold pay/receive amounts, rate, slippage and the network fee.
  await expect(popup.getByText('Bitte bestätigen')).toBeVisible();
  const summary = popup.getByTestId('swap-summary');
  await expect(summary).toContainText('Du gibst');
  await expect(summary).toContainText(/10\s?XLM/u);
  await expect(summary).toContainText('Du erhältst mindestens');
  await expect(summary).toContainText(/4,975\s?USDC/u);
  await expect(summary).toContainText(/0,5\s?%/u);
  await expect(summary).toContainText(/0,00001\s?XLM/u);
  // The confirmation renders the exact on-chain values, not display-rounded ones.
  await expect(popup.getByText(/10\.0000000 XLM senden/u)).toBeVisible();
  await expect(popup.getByText(/mindestens 4\.9750000 USDC/u)).toBeVisible();
  // No slippage warning: the fresh describe-time quote matches the accepted one.
  await expect(popup.getByText('Kursabweichung', { exact: false })).toHaveCount(1); // only the receipt row
  await screenshot(popup, '18-swap-confirm');

  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();
  await expect(popup.getByText('Getauscht.')).toBeVisible({ timeout: 20_000 });
  // The success screen repeats the receipt, network fee included.
  const receipt = popup.getByTestId('swap-receipt');
  await expect(receipt).toContainText(/4,975\s?USDC/u);
  await expect(receipt).toContainText(/0,00001\s?XLM/u);
  await screenshot(popup, '18-swap-done');

  // The envelope on the wire is the swap the user approved: strict-send back
  // to their own account, with the displayed floor as destMin.
  expect(horizon.submitted).toHaveLength(1);
  const tx = TransactionBuilder.fromXDR(horizon.submitted[0] ?? '', Networks.TESTNET);
  if (!(tx instanceof Transaction)) throw new Error('expected a plain transaction');
  const op = tx.operations[0];
  expect(op?.type).toBe('pathPaymentStrictSend');
  if (op?.type === 'pathPaymentStrictSend') {
    expect(op.destination).toBe(address);
    expect(op.sendAsset.isNative()).toBe(true);
    expect(op.sendAmount).toBe('10.0000000');
    expect(op.destAsset.code).toBe('USDC');
    expect(op.destMin).toBe('4.9750000');
  }

  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('says so plainly when the order books offer no route', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer: USDC_ISSUER, balance: '25.0000000' }],
  });
  horizon.pathRate = null; // empty order book
  await reloadPopup(popup);

  await popup.getByTestId('action-swap').click();
  await popup.getByLabel('Betrag').fill('10');
  await expect(popup.getByText(/keinen Handelsweg/u)).toBeVisible();
  await expect(
    popup.getByRole('button', { name: 'Weiter zur Bestätigung' }),
  ).toBeDisabled();

  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('with a single asset it explains and routes to "add asset"', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  await reloadPopup(popup);

  await popup.getByTestId('action-swap').click();
  await expect(popup.getByText(/mindestens zwei freigegebene Assets/u)).toBeVisible();
  await popup.getByRole('button', { name: 'Asset hinzufügen' }).click();
  await expect(popup.getByRole('heading', { name: 'Asset hinzufügen' })).toBeVisible();

  expect(errors.problems, errors.format()).toHaveLength(0);
});
