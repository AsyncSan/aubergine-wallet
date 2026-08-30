/**
 * 12: Invariant 1, exercised rather than reasoned about: call *every* method
 * of the §6 protocol from the popup context and check no answer contains key
 * material; then read the entire `chrome.storage` in the unlocked state and
 * check the same there.
 *
 * The permitted exceptions are `wallet.revealRecoveryPhrase` and
 * `wallet.revealSecretKey`, and the test asserts that they are the *only* two;
 * a new leaking method would fail here even if nobody remembered to update this
 * file, because the method list is taken from the protocol itself.
 */
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { RPC_METHODS } from '../../src/messaging/protocol';
import { expect, readStorage, rpc, test, type RpcEnvelope } from '../support/extension';
import { createWallet, reloadPopup, TEST_PASSWORD } from '../support/flows';

const SEQUENCE = '4611686044486139904';
const DAPP_ORIGIN = 'https://dapp.example';
/** A Stellar secret seed, the thing that must never appear. */
const SECRET_KEY_RE = /S[A-Z2-7]{55}/u;

function leaksIn(text: string, mnemonic: string, password: string): string[] {
  const problems: string[] = [];
  if (SECRET_KEY_RE.test(text)) problems.push('contains something shaped like a secret seed');
  if (text.includes(mnemonic)) problems.push('contains the full recovery phrase');
  if (text.includes(password)) problems.push('contains the password');
  const words = mnemonic.split(' ');
  for (let i = 0; i + 3 < words.length; i += 1) {
    const run = words.slice(i, i + 4).join(' ');
    if (text.includes(run)) problems.push(`contains four consecutive phrase words: "${run}"`);
  }
  return problems;
}

test('no protocol method outside the two audited exceptions returns key material', async ({
  popup,
  horizon,
  errors,
}) => {
  const { address, words } = await createWallet(popup);
  const mnemonic = words.join(' ');
  horizon.fund(address, { xlm: '250.0000000' });
  const destination = Keypair.random().publicKey();
  horizon.fund(destination, { xlm: '5.0000000' });
  await reloadPopup(popup);

  const built = await rpc(popup, 'tx.build', {
    intent: { kind: 'payment', destination, assetId: 'native', amount: '1' },
  });
  const xdr = (built.result as { xdr: string }).xdr;
  const signed = await rpc(popup, 'tx.sign', { xdr });
  const signedXdr = (signed.result as { signedXdr: string }).signedXdr;

  const dappXdr = new TransactionBuilder(new Account(address, SEQUENCE), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '4611686044486139999' }))
    .setTimeout(180)
    .build()
    .toXDR();

  const answers = new Map<string, RpcEnvelope>();
  const record = async (method: string, params: unknown): Promise<RpcEnvelope> => {
    const response = await rpc(popup, method, params);
    answers.set(method, response);
    return response;
  };

  // Read-only and build-side surface.
  await record('wallet.status', {});
  await record('settings.get', {});
  await record('settings.set', { patch: { mode: 'developer', allowedOrigins: [DAPP_ORIGIN] } });
  await record('settings.acknowledgeMainnet', { confirmation: 'MAINNET' });
  // Undo it: the rest of this spec expects a Testnet wallet.
  await rpc(popup, 'settings.set', { patch: { networkId: 'testnet', mainnetAcknowledged: false } });
  await record('account.list', {});
  await record('account.add', { label: 'second', password: TEST_PASSWORD });
  await record('account.select', { index: 0 });
  await record('account.balances', {});
  await record('account.history', {});
  await record('account.fund', {});
  await record('tx.build', {
    intent: { kind: 'payment', destination, assetId: 'native', amount: '1' },
  });
  await record('swap.quote', {
    sendAssetId: 'native',
    sendAmount: '1',
    destAssetId: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  });
  await record('tx.describe', { xdr });
  await record('tx.sign', { xdr });
  await record('tx.submit', { signedXdr });
  // The two halves of the "outcome unknown" resolution. Neither returns key
  // material, and this file is the guard that keeps it that way.
  await record('tx.pendingSubmission', {});
  await record('tx.status', { hash: 'ab'.repeat(32) });
  await record('dapp.pendingPrompt', {});
  await record('dapp.requestConnect', { origin: DAPP_ORIGIN });
  await record('dapp.resolvePrompt', { requestId: 'does-not-exist', approved: false });
  await record('wallet.create', { password: TEST_PASSWORD }); // must fail: WALLET_EXISTS

  // The signing prompt has to be answered, so it gets its own dance.
  await reloadPopup(popup);
  const signPending = rpc(popup, 'dapp.signXdr', { origin: DAPP_ORIGIN, xdr: dappXdr });
  signPending.catch(() => undefined);
  await expect(popup.getByRole('heading', { name: 'Anfrage einer Webseite' })).toBeVisible({
    timeout: 20_000,
  });
  await popup.getByRole('button', { name: 'Jetzt bestätigen' }).click();
  answers.set('dapp.signXdr', await signPending);

  // Lock/unlock last, they change the state everything else needs.
  await record('wallet.lock', {});
  await record('wallet.unlock', { password: TEST_PASSWORD });

  // Passkey unlock. Headless Chromium has no authenticator, so the ceremony is
  // replaced by a fixed 32-byte PRF output; everything the background does with
  // it (wrap the vault key, store it, unwrap it again) is the real code path,
  // and that is what has to be checked for leaks. The enrolment is removed
  // again at the end so the rest of the spec sees the state it expects.
  const PRF_OUTPUT = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
  const prepared = await record('passkey.prepare', {});
  const prfSalt = (prepared.result as { prfSalt: string }).prfSalt;
  await record('passkey.enable', {
    password: TEST_PASSWORD,
    credentialId: Buffer.from(new Uint8Array(16).fill(3)).toString('base64'),
    prfSalt,
    prfOutput: PRF_OUTPUT,
  });
  const status = await record('passkey.status', {});
  expect((status.result as { enrolled: boolean }).enrolled, 'passkey enrolment failed').toBe(true);
  await rpc(popup, 'wallet.lock', {});
  const passkeyUnlock = await record('passkey.unlock', { prfOutput: PRF_OUTPUT });
  expect(
    (passkeyUnlock.result as { accounts: unknown[] } | undefined)?.accounts?.length ?? 0,
    'passkey.unlock did not open the wallet, so the leak check below proves nothing',
  ).toBeGreaterThan(0);
  await record('passkey.disable', {});

  /**
   * Hardware accounts. Enrolled this late on purpose: the account is added to
   * the vault, and everything above expects a wallet of seed accounts only.
   * None of these five methods can leak a key, because the wallet never has
   * one for a device account — which is the claim, so it gets checked.
   */
  const DEVICE_KEY = Keypair.random().publicKey();
  await record('ledger.addAccount', {
    password: TEST_PASSWORD,
    derivationIndex: 0,
    publicKey: DEVICE_KEY,
    label: 'Ledger',
  });
  // Refused: the selected account signs here, not on a device. The refusal is
  // what gets checked for leaks, same as any answer.
  await record('ledger.beginSign', { xdr });
  await record('ledger.signRequest', { requestId: 'does-not-exist' });
  await record('ledger.completeSign', {
    requestId: 'does-not-exist',
    signature: Buffer.from(new Uint8Array(64).fill(9)).toString('base64'),
  });
  await record('ledger.cancelSign', { requestId: 'does-not-exist' });

  // The declared exceptions, and the reset/import pair afterwards.
  const revealed = await record('wallet.revealRecoveryPhrase', { password: TEST_PASSWORD });
  const revealedKey = await record('wallet.revealSecretKey', {
    password: TEST_PASSWORD,
    accountIndex: 0,
  });
  await record('wallet.reset', { confirm: true });
  await record('wallet.importMnemonic', { password: TEST_PASSWORD, mnemonic });

  // Only the declared exceptions may carry key material. Asserted *before* the
  // coverage check below: this is the verdict the file exists for, and a
  // newly added, still-unexercised method must not hide it.
  const leaking: string[] = [];
  const details: string[] = [];
  for (const [method, response] of answers) {
    const problems = leaksIn(JSON.stringify(response), mnemonic, TEST_PASSWORD);
    if (problems.length > 0) {
      leaking.push(method);
      details.push(`${method}: ${problems.join(', ')}`);
    }
  }
  expect(leaking.sort(), details.join('\n')).toEqual([
    'wallet.revealRecoveryPhrase',
    'wallet.revealSecretKey',
  ]);
  expect((revealed.result as { mnemonic: string }).mnemonic).toBe(mnemonic);
  // The secret really is this account's, checked with the SDK in the test
  // process rather than against the value the wallet just produced.
  const secretKey = (revealedKey.result as { secretKey: string }).secretKey;
  expect(Keypair.fromSecret(secretKey).publicKey()).toBe(address);

  // Every method in the protocol must have been exercised: a new one added to
  // §6 without a leak check here fails this assertion.
  expect([...answers.keys()].sort()).toEqual([...RPC_METHODS].sort());
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('revealRecoveryPhrase needs the password every single time', async ({ popup }) => {
  const { words } = await createWallet(popup);

  const wrong = await rpc(popup, 'wallet.revealRecoveryPhrase', { password: 'wrong-password' });
  expect(wrong.ok).toBe(false);
  expect(wrong.error?.code).toBe('BAD_PASSWORD');

  const right = await rpc(popup, 'wallet.revealRecoveryPhrase', { password: TEST_PASSWORD });
  expect((right.result as { mnemonic: string }).mnemonic).toBe(words.join(' '));

  // It is password-gated even while the wallet is unlocked, the handler
  // decrypts the keystore from scratch instead of reading the live keyring.
  const status = await rpc(popup, 'wallet.status', {});
  expect((status.result as { unlocked: boolean }).unlocked).toBe(true);
  const stillWrong = await rpc(popup, 'wallet.revealRecoveryPhrase', { password: '' });
  expect(stillWrong.ok).toBe(false);
});

test('the whole of chrome.storage holds no key material while unlocked', async ({
  popup,
  horizon,
}) => {
  const { address, words } = await createWallet(popup);
  const mnemonic = words.join(' ');
  horizon.fund(address, { xlm: '250.0000000' });
  await reloadPopup(popup);
  // Touch every part of the app that writes something.
  await rpc(popup, 'settings.set', { patch: { mode: 'developer' } });
  await rpc(popup, 'account.balances', {});
  await rpc(popup, 'account.history', {});

  const local = await readStorage(popup, 'local');
  const sync = await readStorage(popup, 'sync');
  for (const [area, contents] of [
    ['local', local],
    ['sync', sync],
  ] as const) {
    const problems = leaksIn(JSON.stringify(contents), mnemonic, TEST_PASSWORD);
    expect(problems, `chrome.storage.${area} leaks: ${problems.join(', ')}`).toEqual([]);
  }

  // Nothing is squirrelled away outside chrome.storage either.
  const webStorage = await popup.evaluate(() => ({
    local: JSON.stringify(globalThis.localStorage),
    session: JSON.stringify(globalThis.sessionStorage),
    databases: typeof indexedDB.databases === 'function',
  }));
  expect(webStorage.local).toBe('{}');
  expect(webStorage.session).toBe('{}');
  const dbs = await popup.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name ?? ''),
  );
  expect(dbs).toEqual([]);
  const sessionArea = await popup.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const area = (chrome.storage as unknown as Record<string, chrome.storage.StorageArea>)[
          'session'
        ];
        if (!area) {
          resolve({});
          return;
        }
        area.get(null, (items) => resolve(items));
      }),
  );
  expect(sessionArea).toEqual({});
});
