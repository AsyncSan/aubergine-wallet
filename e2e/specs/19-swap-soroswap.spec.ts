/**
 * 19: Swap via the Soroswap aggregator (v1.1 upgrade).
 *
 * What is being proven, end to end in a real Chromium:
 * 1. When the aggregator quotes better than the DEX, the screen says so
 *    (route badge + "better than DEX by" line) and uses the aggregator's own
 *    slippage floor as the guaranteed minimum.
 * 2. The envelope that reaches the network is exactly the one the background
 *    obtained from the aggregator build endpoint; a Soroban invocation,
 *    signed in BEGINNER mode (the §4 wallet-internal exception), for the
 *    user's own account.
 * 3. When the aggregator is down or worse, the DEX path keeps winning,
 *    covered by spec 18 running with the aggregator mock answering 503.
 */
import { Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { expect, rpc, screenshot, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * The aggregator source is compiled in: `soroswapConfigFromEnv()` reads
 * `WXT_SOROSWAP_API_KEY` at BUILD time, and an absent key disables Soroswap
 * entirely. The repository ships no `.env.local`, so a default checkout used to
 * run one of these tests red and the other one GREEN FOR THE WRONG REASON,
 * "the DEX wins" is indistinguishable from "the aggregator is switched off".
 *
 * So: skip loudly when the build cannot have the source, and assert inside the
 * tests that it really is live when it should be. Build with the key
 * (`WXT_SOROSWAP_API_KEY=… npm run build:chrome`) to cover this path, and do
 * that before a release, because it is the only end-to-end coverage the
 * aggregator route has.
 */
const AGGREGATOR_BUILT_IN = (process.env['WXT_SOROSWAP_API_KEY'] ?? '').length > 0;
const SKIP_REASON =
  'built without WXT_SOROSWAP_API_KEY; the Soroswap source is compiled out of this artifact';

test('routes through Soroswap when it beats the DEX, and signs in beginner mode', async ({
  popup,
  horizon,
  errors,
}) => {
  test.skip(!AGGREGATOR_BUILT_IN, SKIP_REASON);
  const { address } = await createWallet(popup);
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer: USDC_ISSUER, balance: '25.0000000' }],
  });
  horizon.pathRate = 0.5; //   DEX:      1 XLM -> 0.50 USDC
  horizon.soroswapRate = 0.6; // Soroswap: 1 XLM -> 0.60 USDC, the better route
  await reloadPopup(popup);

  await popup.getByTestId('action-swap').click();
  await expect(popup.getByRole('heading', { name: 'Swap' })).toBeVisible();

  await popup.getByLabel('Betrag').fill('10');
  const quoteCard = popup.getByTestId('swap-quote');

  // The aggregator quote (6 USDC) wins over the DEX (5 USDC); the route badge
  // says so and the comparison line shows the extra USDC.
  await expect(quoteCard).toContainText('6');
  await expect(popup.getByTestId('swap-source')).toContainText('Soroswap');
  await expect(quoteCard).toContainText('Vorteil gegenüber DEX');
  // The floor comes from the aggregator's threshold (0.5 % of 6 -> 5.97).
  await expect(popup.getByTestId('swap-dest-min')).toContainText('5,97');
  await screenshot(popup, '19-swap-soroswap-quote');

  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();

  // Confirmation: receipt card carries the aggregator route; despite the
  // Soroban warning the confirm button is enabled; this is the wallet's own
  // envelope (§4 wallet-internal exception), and the wallet stays in
  // beginner mode throughout this spec.
  await expect(popup.getByText('Bitte bestätigen')).toBeVisible();
  const summary = popup.getByTestId('swap-summary');
  await expect(summary).toContainText('Soroswap');
  await expect(summary).toContainText(/5,97\s?USDC/u);
  await screenshot(popup, '19-swap-soroswap-confirm');

  const confirm = popup.getByRole('button', { name: 'Jetzt bestätigen' });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(popup.getByRole('heading', { name: 'Getauscht.' })).toBeVisible();
  await screenshot(popup, '19-swap-soroswap-done');

  // The submitted envelope is byte-identical (modulo the added signature) to
  // what the aggregator build endpoint returned: same Soroban operation, same
  // source, and it now carries exactly one signature.
  expect(horizon.soroswapBuilt).toHaveLength(1);
  expect(horizon.submitted).toHaveLength(1);
  const submitted = TransactionBuilder.fromXDR(
    horizon.submitted[0] ?? '',
    Networks.TESTNET,
  ) as Transaction;
  const built = TransactionBuilder.fromXDR(
    horizon.soroswapBuilt[0] ?? '',
    Networks.TESTNET,
  ) as Transaction;
  expect(submitted.source).toBe(address);
  expect(submitted.operations).toHaveLength(1);
  expect(submitted.operations[0]?.type).toBe('invokeHostFunction');
  expect(submitted.signatures).toHaveLength(1);
  expect(submitted.hash().toString('hex')).toBe(built.hash().toString('hex'));

  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('falls back to the DEX quote when the aggregator quotes worse', async ({
  popup,
  horizon,
  errors,
}) => {
  test.skip(!AGGREGATOR_BUILT_IN, SKIP_REASON);
  const { address } = await createWallet(popup);
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer: USDC_ISSUER, balance: '25.0000000' }],
  });
  horizon.pathRate = 0.5; //   DEX:      1 XLM -> 0.50 USDC, the better route
  horizon.soroswapRate = 0.4; // Soroswap: 1 XLM -> 0.40 USDC
  await reloadPopup(popup);

  await popup.getByTestId('action-swap').click();
  await popup.getByLabel('Betrag').fill('10');

  await expect(popup.getByTestId('swap-quote')).toContainText('5');
  await expect(popup.getByTestId('swap-source')).toContainText('Stellar DEX');
  /**
   * And the aggregator really did answer, otherwise "the DEX wins" would pass
   * just as well with Soroswap switched off, which is exactly how this test
   * used to be green for the wrong reason.
   */
  const quote = await rpc(popup, 'swap.quote', {
    sendAssetId: 'native',
    sendAmount: '10',
    destAssetId: `USDC:${USDC_ISSUER}`,
    slippageBps: 50,
  });
  expect((quote.result as { soroswapDestAmount: string | null }).soroswapDestAmount).not.toBeNull();
  // No comparison line: the DEX simply is the route.
  await expect(popup.getByTestId('swap-quote')).not.toContainText('Vorteil gegenüber DEX');
  // DEX floor is computed locally from the user's slippage (0.5 % of 5).
  await expect(popup.getByTestId('swap-dest-min')).toContainText('4,975');

  expect(errors.problems, errors.format()).toHaveLength(0);
});
