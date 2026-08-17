/**
 * 2: Argon2id under the MV3 CSP (VERIFICATION.md risk 1).
 *
 * The question is not "is hash-wasm in package.json" but "does the WASM module
 * actually instantiate inside a service worker whose CSP is
 * `script-src 'self' 'wasm-unsafe-eval'`". If it does not, `kdf.ts` silently
 * falls back to PBKDF2; the keystore blob records which one won, so the blob
 * is the proof.
 *
 * The measured durations are printed; they are the answer to "is a 64 MiB
 * Argon2id fast enough in an MV3 worker".
 */
import { expect, readStorage, rpc, test } from '../support/extension';
import { TEST_PASSWORD } from '../support/flows';

interface KeystoreBlob {
  v: number;
  kdf: string;
  params: Record<string, number>;
  salt: string;
  iv: string;
  ct: string;
}

test('key derivation uses Argon2id (not the PBKDF2 fallback) and is measurably fast enough', async ({
  popup,
  errors,
}, testInfo) => {
  const createdAt = Date.now();
  const created = await rpc(popup, 'wallet.create', { password: TEST_PASSWORD, strength: 128 });
  const createMs = Date.now() - createdAt;
  expect(created.ok, JSON.stringify(created.error)).toBe(true);

  const local = await readStorage(popup, 'local');
  const keystore = local['keystore.v1'] as KeystoreBlob | undefined;
  expect(keystore, 'no keystore blob in chrome.storage.local').toBeDefined();

  // Risk 1 answered: `wasm-unsafe-eval` is enough, Argon2id really ran.
  expect(keystore?.kdf).toBe('argon2id');
  expect(keystore?.params).toMatchObject({ m: 65_536, t: 3, p: 1 });
  // v2 = the KDF header is bound into the ciphertext as AES-GCM AAD.
  expect(keystore?.v).toBe(2);

  // A single derivation: `revealRecoveryPhrase` decrypts the vault from scratch.
  const revealStart = Date.now();
  const revealed = await rpc(popup, 'wallet.revealRecoveryPhrase', { password: TEST_PASSWORD });
  const singleDerivationMs = Date.now() - revealStart;
  expect(revealed.ok, JSON.stringify(revealed.error)).toBe(true);

  // A wrong password costs the same derivation; no early exit, no oracle.
  const wrongStart = Date.now();
  const wrong = await rpc(popup, 'wallet.revealRecoveryPhrase', { password: 'not-the-password' });
  const wrongMs = Date.now() - wrongStart;
  expect(wrong.ok).toBe(false);
  expect(wrong.error?.code).toBe('BAD_PASSWORD');

  const report =
    `argon2id m=64MiB t=3 p=1; one derivation + AES-GCM decrypt: ${singleDerivationMs} ms; ` +
    `wrong password: ${wrongMs} ms; wallet.create (derive + encrypt + unlock): ${createMs} ms`;
  // eslint-disable-next-line no-console
  console.log(`[argon2id] ${report}`);
  await testInfo.attach('argon2id-timing', { body: report, contentType: 'text/plain' });

  // Not an arbitrary threshold: an unlock a user waits for should stay well
  // under the ~3 s that makes a wallet feel broken.
  expect(
    singleDerivationMs,
    `Argon2id derivation took ${singleDerivationMs} ms in the MV3 service worker`,
  ).toBeLessThan(3_000);
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('the persisted blob is ciphertext only; no plaintext key material', async ({ popup }) => {
  const created = await rpc(popup, 'wallet.create', { password: TEST_PASSWORD, strength: 128 });
  expect(created.ok).toBe(true);

  const local = await readStorage(popup, 'local');
  const keystore = local['keystore.v1'] as KeystoreBlob;
  expect(Object.keys(keystore).sort()).toEqual(['ct', 'iv', 'kdf', 'params', 'salt', 'v']);

  // The vault holds the recovery phrase; it must not be readable in the blob.
  const revealed = await rpc(popup, 'wallet.revealRecoveryPhrase', { password: TEST_PASSWORD });
  const mnemonic = (revealed.result as { mnemonic: string }).mnemonic;
  const serialised = JSON.stringify(local);
  for (const word of mnemonic.split(' ')) {
    expect(serialised.includes(` ${word} `)).toBe(false);
  }
  expect(serialised).not.toContain(mnemonic);
  expect(serialised).not.toContain(TEST_PASSWORD);
});
