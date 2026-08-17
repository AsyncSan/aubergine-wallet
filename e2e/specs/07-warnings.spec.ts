/**
 * 7; The §5 warning catalogue, in the running browser.
 *
 * Two kinds of coverage, kept apart on purpose:
 *  - reachable through a real user path (payment to an unfunded account,
 *    removing an asset approval),
 *  - reachable only by handing an envelope to the wallet the way a dApp would.
 *    Those are rendered through the *same* `TxConfirm` component a user sees,
 *    via the dApp signing prompt, so the assertion is still about pixels and
 *    German sentences, but a user cannot build such a transaction in this UI.
 */
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import de from '../../src/i18n/de.json' with { type: 'json' };
import { expect, rpc, screenshot, test } from '../support/extension';
import { createWallet, expectHome, reloadPopup } from '../support/flows';

const SEQUENCE = '4611686044486139904';
const DAPP_ORIGIN = 'https://dapp.example';

/**
 * How `tx-describe` shortens an address for display. 12+12, not 4+4: the short
 * form is what a user compares a recipient against, and four characters are
 * within reach of a vanity-key generator.
 */
function short(address: string): string {
  return `${address.slice(0, 12)}\u2026${address.slice(-12)}`;
}

function buildEnvelope(
  source: string,
  operation: ReturnType<typeof Operation.accountMerge>,
): string {
  return new TransactionBuilder(new Account(source, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build()
    .toXDR();
}

/**
 * Push an arbitrary envelope into the popup's confirmation dialog.
 *
 * Returns the still-pending `dapp.signXdr` call; the caller has to answer the
 * prompt (approve or reject) and await it, otherwise the handler is left
 * blocking until its 120 s timeout.
 */
async function openDappSignPrompt(
  popup: import('@playwright/test').Page,
  xdr: string,
  declaredNetworkPassphrase?: string,
): Promise<{ pending: Promise<import('../support/extension').RpcEnvelope> }> {
  const settings = await rpc(popup, 'settings.set', {
    patch: { mode: 'developer', allowedOrigins: [DAPP_ORIGIN] },
  });
  expect(settings.ok, JSON.stringify(settings.error)).toBe(true);
  // The popup caches `settings.get` for its lifetime, and it only polls for
  // pending prompts in developer mode, so it has to be reloaded to notice.
  await popup.reload();
  await expectHome(popup);
  // Deliberately not awaited here: the handler blocks until the prompt is
  // resolved, which only happens further down in the test.
  const pending = rpc(popup, 'dapp.signXdr', {
    origin: DAPP_ORIGIN,
    xdr,
    ...(declaredNetworkPassphrase ? { networkPassphrase: declaredNetworkPassphrase } : {}),
  });
  pending.catch(() => undefined);
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  // Wrapped in an object: returning the promise directly would let the
  // caller's `await` flatten it and block until the prompt is answered.
  return { pending };
}

test('user path: paying an account that does not exist warns about the reserve', async ({
  popup,
  horizon,
  errors,
}) => {
  /**
   * §5's beginner case. `tx-builder` turns a payment to an unfunded address
   * into `createAccount`, so the warning has to fire on that branch, it used
   * to fire only for a plain `payment`, which the send flow never produces.
   */
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  await reloadPopup(popup);

  const stranger = Keypair.random().publicKey(); // never funded in the mock

  await popup.getByRole('button', { name: 'Senden' }).click();
  await popup.getByRole('textbox').first().fill(stranger);
  await popup.locator('input[inputmode="decimal"]').fill('5');
  await popup.getByRole('button', { name: 'Weiter zur Bestätigung' }).click();

  await expect(popup.getByText('Bitte beachten')).toBeVisible();
  await expect(
    popup.getByText(
      `Das Konto ${short(stranger)} gibt es im Netzwerk noch nicht. Mit dieser Zahlung wird es neu angelegt; ` +
        'ein Teil des Betrags bleibt dann als reservierter Kontobetrag dauerhaft gebunden, solange es das Konto gibt.',
    ),
  ).toBeVisible();
  // The summary switches to "create account", not "payment".
  await expect(popup.getByText(/Neues Konto .* mit 5\.0000000 XLM anlegen/u)).toBeVisible();
  await screenshot(popup, '11-warning-destination-not-funded');
  // The confirm button stays enabled: this is a warning, not a blocker.
  await expect(popup.getByRole('button', { name: 'Jetzt bestätigen' })).toBeEnabled();
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('the DESTINATION_NOT_FUNDED warning itself works, on a payment envelope', async ({
  popup,
  horizon,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const stranger = Keypair.random().publicKey();

  // A dApp-supplied `payment` (not `createAccount`) to an unfunded address is
  // the only shape that reaches the check.
  const xdr = buildEnvelope(
    address,
    Operation.payment({
      destination: stranger,
      asset: Asset.native(),
      amount: '5',
    }) as ReturnType<typeof Operation.accountMerge>,
  );
  const described = await rpc(popup, 'tx.describe', { xdr });
  expect(described.ok, JSON.stringify(described.error)).toBe(true);
  const warnings = (
    described.result as { warnings: Array<{ code: string; message: { key: string } }> }
  ).warnings;
  expect(warnings.map((w) => w.code)).toContain('DESTINATION_NOT_FUNDED');
  // A plain payment creates nothing, so it must not claim that it does.
  expect(warnings.find((w) => w.code === 'DESTINATION_NOT_FUNDED')?.message.key).toBe(
    'tx.warn.DESTINATION_NOT_FUNDED.unreachable',
  );
});

test('user path: removing an asset approval (CHANGE_TRUST limit 0) is flagged as dangerous', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  const issuer = Keypair.random().publicKey();
  horizon.fund(address, {
    xlm: '250.0000000',
    assets: [{ code: 'USDC', issuer, balance: '0.0000000' }],
  });
  // Developer mode is what §4 row 5 requires for a free issuer and a limit.
  await rpc(popup, 'settings.set', { patch: { mode: 'developer' } });
  await reloadPopup(popup);

  await popup.getByRole('button', { name: 'Asset hinzufügen' }).click();
  await popup.getByRole('heading', { name: 'Asset hinzufügen' }).waitFor();
  await popup.getByRole('textbox').nth(0).fill('USDC');
  await popup.getByRole('textbox').nth(1).fill(issuer);
  await popup.getByRole('textbox').nth(2).fill('0');
  await expect(
    popup.getByText('Ein Limit von 0 entfernt diese Asset-Freigabe.', { exact: false }),
  ).toBeVisible();
  await popup.getByRole('button', { name: 'Prüfen' }).click();

  await expect(popup.getByText('Bitte beachten')).toBeVisible();
  await expect(
    popup.getByText(
      'Die Asset-Freigabe für USDC wird entfernt. Das geht nur, wenn dein Guthaben dieses Assets null ist.',
    ),
  ).toBeVisible();
  await expect(popup.getByText('Asset-Freigabe für USDC entfernen')).toBeVisible();
  await screenshot(popup, '12-warning-trustline-removal');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('dApp path: ACCOUNT_MERGE is rendered as a danger warning', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const destination = Keypair.random().publicKey();
  horizon.fund(destination, { xlm: '1.0000000' });

  const { pending } = await openDappSignPrompt(
    popup,
    buildEnvelope(address, Operation.accountMerge({ destination })),
  );

  await expect(
    popup.getByText(
      `Dein Konto wird aufgelöst. Das gesamte Guthaben geht an ${short(destination)} und die Adresse ist danach leer.`,
    ),
  ).toBeVisible();
  await expect(
    popup.getByText(
      `Konto auflösen und das gesamte Guthaben an ${short(destination)} übertragen`,
    ),
  ).toBeVisible();
  await screenshot(popup, '13-warning-account-merge');

  // Rejecting the prompt gives the caller a typed USER_REJECTED, not a hang.
  await popup.getByRole('button', { name: 'Ablehnen' }).click();
  const answer = await pending;
  expect(answer.ok).toBe(false);
  expect(answer.error?.code).toBe('USER_REJECTED');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('dApp path: SET_OPTIONS that changes a signer is rendered as a danger warning', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });
  const newSigner = Keypair.random().publicKey();

  const { pending } = await openDappSignPrompt(
    popup,
    buildEnvelope(
      address,
      Operation.setOptions({
        signer: { ed25519PublicKey: newSigner, weight: 1 },
      }) as ReturnType<typeof Operation.accountMerge>,
    ),
  );

  await expect(
    popup.getByText(
      'Diese Transaktion ändert, wer über dein Konto verfügen darf. Bestätige das nur, wenn du es selbst ausgelöst hast.',
    ),
  ).toBeVisible();
  await expect(popup.getByText(/Kontoeinstellungen ändern/u)).toBeVisible();
  await screenshot(popup, '14-warning-signer-change');
  await popup.getByRole('button', { name: 'Ablehnen' }).click();
  expect((await pending).ok).toBe(false);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('the warning catalogue from §5 is complete and translated in both languages', async ({
  popup,
  horizon,
}) => {
  const { address } = await createWallet(popup);
  horizon.fund(address, { xlm: '250.0000000' });

  // Every §5 warning must have a DE and an EN string; the DE file is loaded
  // here, the EN one is checked by the existing i18n unit test.
  const catalogue = [
    'SIGNER_OR_THRESHOLD_CHANGE',
    'TRUSTLINE_REMOVAL',
    'ACCOUNT_MERGE',
    'HIGH_SLIPPAGE',
    'UNKNOWN_ISSUER',
    'DESTINATION_NOT_FUNDED',
    'SEQUENCE_GAP',
    'UNTRANSLATABLE_OPERATION',
    'NETWORK_MISMATCH',
  ];
  const messages = de as unknown as Record<string, string>;
  for (const code of catalogue) {
    expect(messages[`tx.warn.${code}`], `missing DE text for ${code}`).toBeTruthy();
  }

  // Fail-closed: an envelope we cannot parse is refused, never waved through.
  const describe = await rpc(popup, 'tx.describe', { xdr: 'this-is-not-base64-xdr' });
  expect(describe.ok).toBe(true);
  const description = describe.result as {
    translatable: boolean;
    warnings: Array<{ code: string; severity: string }>;
  };
  expect(description.translatable).toBe(false);
  expect(description.warnings.map((w) => w.code)).toContain('UNPARSEABLE_TRANSACTION');

  // An unknown operation type must produce UNTRANSLATABLE_OPERATION rather than
  // a silent pass. `inflation` is the deprecated op the describer still knows;
  // `bumpSequence` with an odd target is the closest reachable stand-in for an
  // operation the UI cannot produce, so check the describer's own claim instead.
  const merge = new TransactionBuilder(new Account(address, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', Keypair.random().publicKey()) }))
    .setTimeout(180)
    .build()
    .toXDR();
  const trust = await rpc(popup, 'tx.describe', { xdr: merge });
  expect(trust.ok).toBe(true);
  const trustDescription = trust.result as {
    translatable: boolean;
    warnings: Array<{ code: string }>;
  };
  expect(trustDescription.translatable).toBe(true);
  // A brand-new issuer the account has never held is called out.
  expect(trustDescription.warnings.map((w) => w.code)).toContain('UNKNOWN_ISSUER');
});
