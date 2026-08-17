/**
 * 8; The §4 mode table, row by row, in the running browser, plus active
 * attempts to reach developer surfaces from beginner mode.
 *
 * A hidden button proves nothing on its own, so every row that has a security
 * or money consequence (fee, Soroban, dApp methods) is also probed through the
 * §6 messaging channel, which is what a tampered popup would use.
 */
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  Operation,
} from '@stellar/stellar-sdk';
import { expect, rpc, screenshot, test } from '../support/extension';
import {
  createWallet,
  expectHome,
  openSettings,
  registeredScripts,
  reloadPopup,
  writeSyncedSettings,
} from '../support/flows';

const SEQUENCE = '4611686044486139904';

/** A minimal Soroban invocation; the §4 row 3 subject. */
function sorobanEnvelope(source: string): string {
  const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
  return new TransactionBuilder(new Account(source, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract, function: 'transfer', args: [] }),
    )
    .setTimeout(180)
    .build()
    .toXDR();
}

async function setMode(page: import('@playwright/test').Page, mode: string): Promise<void> {
  const response = await rpc(page, 'settings.set', { patch: { mode } });
  expect(response.ok, JSON.stringify(response.error)).toBe(true);
  await reloadPopup(page);
}

test('rows 1, 5, 6, 7, 8: beginner hides the developer surfaces', async ({ popup, horizon }) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const recipient = Keypair.random().publicKey();
  horizon.fund(recipient, { xlm: '5.0000000' });
  await reloadPopup(popup);

  // Row 8, reserves are explained, never itemised. Since P3 the explanation
  // lives behind the ⓘ line in a bottom sheet; even with the sheet OPEN a
  // beginner never sees the itemised breakdown.
  await popup.getByTestId('reserve-info').click();
  await expect(popup.getByTestId('reserve-sheet')).toBeVisible();
  await expect(
    popup.getByText(
      'Ein kleiner Teil deines Guthabens ist für dein Konto reserviert und kann nicht gesendet werden.',
    ),
  ).toBeVisible();
  await expect(popup.getByText('Gesamt reserviert')).toHaveCount(0);
  await popup.waitForTimeout(400); // slide-up settled
  await screenshot(popup, '16-reserve-sheet-beginner');
  await popup.getByRole('button', { name: 'Schließen' }).last().click();
  await expect(popup.getByTestId('reserve-sheet')).toHaveCount(0);

  // Row 1 (v1.2); the picker exists for beginners now, but only offers the
  // two networks a beginner may be on. Futurenet and custom endpoints stay
  // developer surfaces, and Mainnet is behind the typed gate (spec 20).
  await openSettings(popup);
  await expect(popup.getByText('Netzwerk', { exact: true })).toBeVisible();
  const networkOptions = await popup
    .locator('select')
    .nth(2)
    .locator('option')
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(networkOptions).toEqual(['testnet', 'mainnet']);
  await expect(popup.getByText('Verbundene Webseiten')).toHaveCount(0);
  await screenshot(popup, '15-settings-beginner');

  // Row 5; the curated list only, no free issuer and no limit field.
  await popup.getByRole('button', { name: 'Übersicht' }).click();
  await popup.getByRole('button', { name: 'Asset hinzufügen' }).first().click();
  await expect(popup.getByText('Vorgeschlagene Assets')).toBeVisible();
  await expect(popup.getByText('Beliebiger Herausgeber')).toHaveCount(0);
  await expect(popup.getByText('Limit', { exact: false })).toHaveCount(0);

  // Rows 2, 6, 7, on the confirmation dialog.
  await popup.getByRole('button', { name: 'Übersicht' }).click();
  await popup.getByRole('button', { name: 'Senden' }).click();
  await expect(popup.getByText('Gebühr manuell festlegen (Stroops)')).toHaveCount(0); // row 7
  await popup.getByRole('textbox').first().fill(recipient);
  await popup.locator('input[inputmode="decimal"]').fill('5');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();
  await expect(popup.getByRole('heading', { name: 'Bitte bestätigen' })).toBeVisible();
  await expect(popup.getByText('Technische Ansicht (XDR)')).toHaveCount(0); // row 2
  await expect(popup.getByRole('heading', { name: 'Unterschriftsberechtigte' })).toHaveCount(0); // row 6
  await expect(popup.getByText('Sequenznummer')).toHaveCount(0);
  await expect(
    popup.getByRole('heading', { name: 'Reservierter Kontobetrag' }),
  ).toHaveCount(0); // row 8
});

test('rows 1, 2, 5, 6, 7, 8: developer mode exposes exactly those surfaces', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const recipient = Keypair.random().publicKey();
  horizon.fund(recipient, { xlm: '5.0000000' });
  await setMode(popup, 'developer');

  // The badge from §4 is permanent, and both badges have to fit the fixed
  // 360 px popup without wrapping inside a pill or overflowing the header.
  const header = popup.locator('header');
  await expect(header.getByText('Entwickler-Modus')).toBeVisible();
  const badges = header.locator('span.rounded-full');
  await expect(badges).toHaveCount(2);
  const headerBox = await header.boundingBox();
  for (let i = 0; i < 2; i += 1) {
    const box = await badges.nth(i).boundingBox();
    expect(box, 'badge has no box').not.toBeNull();
    // One text line at 10 px plus padding; a wrapped pill is ~2× as tall.
    expect(box?.height ?? 0, 'a badge wrapped onto a second line').toBeLessThan(22);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (headerBox?.x ?? 0) + (headerBox?.width ?? 0) + 1,
    );
  }
  await screenshot(popup, '22-header-both-badges');

  // Row 8, numeric breakdown, since P3 inside the reserve sheet.
  await popup.getByTestId('reserve-info').click();
  await expect(popup.getByText('Gesamt reserviert')).toBeVisible();
  await expect(popup.getByText('1.0000000 XLM', { exact: true })).toBeVisible();
  await expect(popup.getByText('Einträge', { exact: true })).toBeVisible();
  await popup.waitForTimeout(400);
  await screenshot(popup, '16-reserve-sheet-developer');
  await popup.getByRole('button', { name: 'Schließen' }).last().click();
  await expect(popup.getByTestId('reserve-sheet')).toHaveCount(0);

  // Row 1, network picker with the three built-in networks (Custom is
  // filtered out; that gap is a known limitation, see the README).
  await openSettings(popup);
  const network = popup.locator('select').nth(2);
  await expect(network).toBeVisible();
  const options = await network.locator('option').allInnerTexts();
  expect(options).toEqual(['Testnetzwerk', 'Futurenet', 'Hauptnetzwerk']);
  await expect(popup.getByText('Verbundene Webseiten')).toBeVisible();
  await screenshot(popup, '16-settings-developer');

  // Row 5, free issuer and limit.
  await popup.getByRole('button', { name: 'Übersicht' }).click();
  await popup.getByRole('button', { name: 'Asset hinzufügen' }).first().click();
  await expect(popup.getByText('Beliebiger Herausgeber')).toBeVisible();
  await expect(popup.getByText('Höchstbetrag, den du halten möchtest.', { exact: false })).toBeVisible();

  // Rows 2, 6, 7.
  await popup.getByRole('button', { name: 'Übersicht' }).click();
  await popup.getByRole('button', { name: 'Senden' }).click();
  await expect(popup.getByText('Gebühr manuell festlegen (Stroops)')).toBeVisible(); // row 7
  await popup.getByRole('textbox').first().fill(recipient);
  await popup.locator('input[inputmode="decimal"]').fill('5');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();
  await expect(popup.getByText('Sequenznummer')).toBeVisible();
  await expect(popup.getByRole('heading', { name: 'Unterschriftsberechtigte' })).toBeVisible(); // row 6
  await expect(
    popup.getByRole('heading', { name: 'Reservierter Kontobetrag' }),
  ).toBeVisible(); // row 8
  await popup.getByRole('button', { name: 'Technische Ansicht (XDR)' }).click(); // row 2
  const xdrBlock = popup.locator('pre');
  await expect(xdrBlock).toBeVisible();
  expect((await xdrBlock.innerText()).length).toBeGreaterThan(100);
  await screenshot(popup, '17-confirm-developer-xdr');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('row 3 (Soroban): the background refuses a contract call in beginner mode', async ({
  popup,
  horizon,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const xdr = sorobanEnvelope(address);

  // The describer flags it …
  const described = await rpc(popup, 'tx.describe', { xdr });
  expect(described.ok, JSON.stringify(described.error)).toBe(true);
  const warnings = (described.result as { warnings: Array<{ code: string }> }).warnings;
  expect(warnings.map((w) => w.code)).toContain('SOROBAN_INVOCATION');

  // … and the background refuses to sign it, not just the UI.
  const signed = await rpc(popup, 'tx.sign', { xdr });
  expect(signed.ok).toBe(false);
  expect(signed.error?.code).toBe('DEVELOPER_MODE_REQUIRED');

  // In developer mode the same envelope is signable.
  await setMode(popup, 'developer');
  const signedDev = await rpc(popup, 'tx.sign', { xdr });
  expect(signedDev.ok, JSON.stringify(signedDev.error)).toBe(true);
});

test('row 7 (fee): a manual fee sent from beginner mode is ignored by the background', async ({
  popup,
  horizon,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const destination = Keypair.random().publicKey();
  horizon.fund(destination, { xlm: '5.0000000' });

  const intent = {
    kind: 'payment',
    destination,
    assetId: 'native',
    amount: '1',
    feeStroops: '54321',
  };

  const beginner = await rpc(popup, 'tx.build', { intent });
  expect(beginner.ok, JSON.stringify(beginner.error)).toBe(true);
  const beginnerTx = TransactionBuilder.fromXDR(
    (beginner.result as { xdr: string }).xdr,
    Networks.TESTNET,
  );
  expect(beginnerTx.fee, 'beginner mode must not be able to set a fee').toBe('100');

  await setMode(popup, 'developer');
  const developer = await rpc(popup, 'tx.build', { intent });
  const developerTx = TransactionBuilder.fromXDR(
    (developer.result as { xdr: string }).xdr,
    Networks.TESTNET,
  );
  expect(developerTx.fee).toBe('54321');
});

test('bypass attempts from beginner mode all fail', async ({ popup, horizon, extensionId }) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });

  // 1. The dApp methods, called straight from the popup context.
  const connect = await rpc(popup, 'dapp.requestConnect', { origin: 'https://evil.example' });
  expect(connect.ok).toBe(false);
  expect(connect.error?.code).toBe('DEVELOPER_MODE_REQUIRED');

  const sign = await rpc(popup, 'dapp.signXdr', {
    origin: 'https://evil.example',
    xdr: sorobanEnvelope(address),
  });
  expect(sign.ok).toBe(false);
  expect(sign.error?.code).toBe('DEVELOPER_MODE_REQUIRED');

  // 2. Direct navigation. The popup routes through a store, not the URL, so a
  //    fragment or a query string cannot select a screen, verified rather than
  //    assumed, because "there are no routes" is exactly the kind of claim that
  //    silently stops being true.
  for (const suffix of ['#settings', '?screen=settings', '#/addAsset']) {
    await popup.goto(`chrome-extension://${extensionId}/popup.html${suffix}`);
    await expectHome(popup);
    await expect(popup.locator('header').getByText('Entwickler-Modus')).toHaveCount(0);
  }

  // 3. A settings change that arrives through storage (another profile syncing
  //    the mode) *is* picked up; that is what the storage.onChanged listener
  //    is for, but it must not hand out any capability the user did not grant.
  //    Without the optional host permission the connector stays off.
  await writeSyncedSettings(popup, { mode: 'developer' });
  await expect
    .poll(async () => (await rpc(popup, 'settings.get', {})).result as { mode: string }, {
      timeout: 10_000,
    })
    .toMatchObject({ mode: 'developer' });
  expect(
    await registeredScripts(popup),
    'a synced mode change must not register a content script',
  ).toEqual([]);
});

test('the mode switch is a deliberate act and is never flipped automatically', async ({
  popup,
}) => {
  await createWallet(popup);
  await openSettings(popup);

  // The warning must be acknowledged; cancelling leaves beginner mode intact.
  await popup.getByRole('button', { name: 'Entwickler', exact: true }).click();
  await expect(popup.getByText('Entwickler-Modus einschalten?')).toBeVisible();
  await popup.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(popup.getByText('Entwickler-Modus einschalten?')).toHaveCount(0);
  const settings = await rpc(popup, 'settings.get', {});
  expect((settings.result as { mode: string }).mode).toBe('beginner');
  expect((settings.result as { developerModeAcknowledged: boolean }).developerModeAcknowledged).toBe(
    false,
  );
});
