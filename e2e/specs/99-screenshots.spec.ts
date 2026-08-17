/**
 * Not a test of behaviour, captures redesign screenshots from the real
 * extension in real Chromium. Kept as a spec so it reuses the extension
 * fixture and mocked Horizon. Run explicitly via:
 *   npx playwright test -c e2e/playwright.config.ts 99-screenshots
 */
import { Keypair } from '@stellar/stellar-sdk';
import { expect, test } from '../support/extension';
import { createWallet, reloadPopup } from '../support/flows';

test('capture redesign screenshots', async ({ popup, horizon }) => {
  const { address } = await createWallet(popup);
  // Fund with XLM + two assets so the TokenRow list (P0) is on screen:
  // one curated (USDC testnet issuer -> readable name) and one unknown.
  horizon.fund(address, {
    xlm: '1234.5678901',
    assets: [
      {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        balance: '250.0000000',
      },
      {
        code: 'yXLM',
        issuer: Keypair.random().publicKey(),
        balance: '80.0000000',
      },
    ],
  });
  await reloadPopup(popup);
  await expect(popup.getByTestId('balance-hero')).toBeVisible();
  await expect(popup.getByTestId('token-native')).toBeVisible();
  // Curated assets show their vetted name, not the raw issuer key.
  await expect(popup.getByText('Circle USD (Testnet)')).toBeVisible();
  await popup.emulateMedia({ colorScheme: 'dark' });
  // 500 ms: the balance count-up is rAF-driven (400 ms), which
  // animations:'disabled' cannot fast-forward.
  await popup.waitForTimeout(500);
  await popup.screenshot({ path: 'e2e-shots/home-dark.png', animations: 'disabled' });

  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.waitForTimeout(500);
  await popup.screenshot({ path: 'e2e-shots/home-light.png', animations: 'disabled' });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.waitForTimeout(200);

  // Action row navigates without the old nav entries.
  await popup.getByTestId('action-send').click();
  await expect(popup.getByRole('heading', { name: 'Senden' })).toBeVisible();
  // Amount-as-hero (P1): recipient check pops in, amount input is the hero.
  await popup.getByRole('textbox').first().fill(Keypair.random().publicKey());
  await popup.locator('input[inputmode="decimal"]').fill('25');
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: 'e2e-shots/send-dark.png', animations: 'disabled' });
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.waitForTimeout(200);
  await popup.screenshot({ path: 'e2e-shots/send-light.png', animations: 'disabled' });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.waitForTimeout(200);
  await popup.getByRole('button', { name: 'Zurück' }).click();

  // Receive (P2): QR hero + copy pill + share.
  await popup.getByTestId('action-receive').click();
  await expect(popup.getByTestId('receive-qr')).toBeVisible();
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: 'e2e-shots/receive-dark.png', animations: 'disabled' });
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.waitForTimeout(200);
  await popup.screenshot({ path: 'e2e-shots/receive-light.png', animations: 'disabled' });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.waitForTimeout(200);
  await popup.getByRole('button', { name: 'Zurück' }).click();

  await popup.getByTestId('action-buy').click();
  await expect(popup.getByText(/bald verfügbar/u)).toBeVisible();
  await popup.screenshot({ path: 'e2e-shots/home-buy-notice.png', animations: 'disabled' });

  await popup.getByTestId('tab-settings').click();
  await expect(popup.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  // The frosted overlay bars make compositing lag a frame or two behind the
  // DOM right after a navigation; without this the capture can be stale.
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: 'e2e-shots/settings-dark.png', animations: 'disabled' });
});
