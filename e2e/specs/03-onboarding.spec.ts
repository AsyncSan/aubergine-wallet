/**
 * 3: Onboarding: create a wallet, see the recovery phrase, pass the
 * verification step, land on an unlocked Home with a valid Stellar address.
 *
 * The address is checked with `StrKey` in the *test* process, so the checksum
 * verdict does not come from the same code that produced it.
 */
import { readFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { expect, readStorage, rpc, screenshot, test } from '../support/extension';
import {
  answerVerifyQuiz,
  createWallet,
  readHomeAddress,
  readQuizPositions,
  TEST_PASSWORD,
} from '../support/flows';

test('create a wallet: phrase, verification, unlocked Home with a valid address', async ({
  popup,
  errors,
}) => {
  await popup.getByRole('button', { name: 'Neue Wallet erstellen' }).click();
  await popup.getByRole('heading', { name: 'Passwort festlegen' }).waitFor();

  // The form refuses a short password and a mismatched repeat.
  const passwords = popup.locator('input[type="password"]');
  await passwords.nth(0).fill('short');
  await expect(popup.getByText('Mindestens 8 Zeichen.')).toBeVisible();
  await passwords.nth(0).fill(TEST_PASSWORD);
  await passwords.nth(1).fill('something-else');
  await expect(popup.getByText('Die Passwörter stimmen nicht überein.')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled();
  await passwords.nth(1).fill(TEST_PASSWORD);
  await screenshot(popup, '02-onboarding-password');
  await popup.getByRole('button', { name: 'Weiter', exact: true }).click();

  // Phrase screen: hidden until the user asks, 12 words, BIP-39 vocabulary.
  await expect(popup.getByText('Dein Wiederherstellungssatz')).toBeVisible({ timeout: 30_000 });
  await expect(popup.locator('ol li')).toHaveCount(0);
  await popup.getByText('Wörter anzeigen').click();
  const items = popup.locator('ol li');
  await expect(items).toHaveCount(12);
  const words = (await items.allInnerTexts()).map((t) => t.trim().replace(/^\d+\s*/u, ''));
  for (const word of words) expect(wordlist).toContain(word);
  await screenshot(popup, '03-onboarding-phrase');

  // The optional file backup. Two clicks by design: the first only opens the
  // warning, the second writes the file — and the file has to actually arrive,
  // which is the part no unit test can prove (blob URL + `<a download>` under
  // the popup's `default-src 'self'` CSP).
  await popup.getByRole('button', { name: 'Stattdessen als Datei speichern' }).click();
  await expect(popup.getByText(/Eine Datei ist bequem/u)).toBeVisible();

  // The name is announced *before* the download, so it survives a browser that
  // closes the popup the moment a file starts saving.
  const announced = (await popup.getByText(/Die Datei wird/u).innerText())
    .match(/[0-9bcdfghjkmnpqrstvwxz]{16}\.txt/u)?.[0];
  expect(announced, 'the warning does not name the file').toBeTruthy();
  await screenshot(popup, '03b-onboarding-phrase-file');

  const [download] = await Promise.all([
    popup.waitForEvent('download', { timeout: 15_000 }),
    popup.getByRole('button', { name: 'Risiko verstanden, herunterladen' }).click(),
  ]);

  // What was promised is what gets saved, and the file carries the phrase and
  // its warnings.
  const suggested = download.suggestedFilename();
  expect(suggested).toBe(announced);
  const contents = readFileSync(await download.path(), 'utf8');
  for (const word of words) expect(contents).toContain(word);
  expect(contents).toContain(words.join(' '));
  expect(contents).toContain('Wiederherstellungssatz');
  expect(contents.replace(/\s+/gu, ' ')).toContain(
    'Wer diese Wörter liest, kann über das gesamte Guthaben verfügen.',
  );
  // The screen names the file again afterwards, because a random name is
  // otherwise unfindable.
  const saved = popup.getByText(suggested, { exact: false });
  await expect(saved).toBeVisible();
  await saved.scrollIntoViewIfNeeded();
  await screenshot(popup, '03c-onboarding-phrase-saved');

  await popup.getByRole('button', { name: 'Ich habe die Wörter aufgeschrieben' }).click();

  // Verification (redesign v1.1): the word-chip quiz asks for three positions
  // in order; a wrong chip is rejected, the right ones complete the quiz.
  await expect(popup.getByText('Kurz überprüfen')).toBeVisible();
  const positions = await readQuizPositions(popup);
  expect(positions).toHaveLength(3);
  for (const p of positions) expect(p).toBeGreaterThanOrEqual(1);
  // Ascending order and all twelve words offered as chips.
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  const chips = popup.getByTestId('quiz-chip');
  await expect(chips).toHaveCount(12);
  const chipTexts = (await chips.allInnerTexts()).map((t) => t.trim());
  expect([...chipTexts].sort()).toEqual([...words].sort());

  // A wrong first tap shows the error and fills no slot.
  const firstExpected = words[(positions[0] ?? 1) - 1] ?? '';
  const wrong = chipTexts.find((t) => t !== firstExpected);
  if (wrong) {
    await popup.getByTestId('quiz-chips').getByRole('button', { name: wrong, exact: true }).first().click();
    await expect(
      popup.getByText('Das war nicht das richtige Wort. Bitte noch einmal.'),
    ).toBeVisible();
  }
  await screenshot(popup, '04-onboarding-verify');
  await answerVerifyQuiz(popup, words);

  // Completion moment: drawn check, then on to Home.
  await expect(popup.getByRole('heading', { name: 'Deine Wallet ist bereit' })).toBeVisible();
  await screenshot(popup, '04b-onboarding-done');
  await popup.getByRole('button', { name: 'Zur Übersicht', exact: true }).click();

  const address = await readHomeAddress(popup);
  expect(StrKey.isValidEd25519PublicKey(address), `invalid address ${address}`).toBe(true);
  expect(address).toHaveLength(56);
  expect(address.startsWith('G')).toBe(true);

  // The wallet is genuinely unlocked, not just showing Home.
  const status = await rpc(popup, 'wallet.status', {});
  expect(status.result).toMatchObject({ initialized: true, unlocked: true });

  await screenshot(popup, '05-home-unfunded');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('Home shows the unfunded state and funds via the mocked friendbot', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address } = await createWallet(popup);

  await expect(popup.getByText('Dieses Konto existiert im Netzwerk noch nicht.')).toBeVisible();
  const fundButton = popup.getByRole('button', { name: 'Testguthaben anfordern' });
  await expect(fundButton).toBeVisible();
  await fundButton.click();

  // useFundAccount waits 3 s for a ledger to close before refetching.
  // 10 000 XLM funded minus the 1 XLM base reserve = 9 999 spendable (de-DE).
  await expect(popup.getByText('9.999 XLM')).toBeVisible({ timeout: 30_000 });
  await expect(popup.getByText('Dieses Konto existiert im Netzwerk noch nicht.')).toHaveCount(0);
  expect(horizon.requestsMatching('friendbot').length).toBeGreaterThan(0);
  expect(horizon.accounts.has(address)).toBe(true);
  await screenshot(popup, '06-home-funded');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('importing a recovery phrase restores the very same address', async ({ popup, context, extensionId }) => {
  const { words, address } = await createWallet(popup);

  // Wipe and restore in the same profile.
  const reset = await rpc(popup, 'wallet.reset', { confirm: true });
  expect(reset.ok).toBe(true);
  const local = await readStorage(popup, 'local');
  expect(local['keystore.v1']).toBeUndefined();

  const imported = await rpc(popup, 'wallet.importMnemonic', {
    password: TEST_PASSWORD,
    mnemonic: words.join(' '),
  });
  expect(imported.ok, JSON.stringify(imported.error)).toBe(true);
  const accounts = (imported.result as { accounts: Array<{ publicKey: string }> }).accounts;
  expect(accounts[0]?.publicKey).toBe(address);

  const fresh = await context.newPage();
  await fresh.goto(`chrome-extension://${extensionId}/popup.html`);
  expect(await readHomeAddress(fresh)).toBe(address);
});
