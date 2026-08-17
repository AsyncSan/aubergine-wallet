/**
 * Keyring behaviour, i.e. invariants 1 and 6 from ARCHITECTURE.md §3.
 */
import { describe, expect, it } from 'vitest';
import { Account, Asset, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { Keyring } from '../src/core/keyring/keyring';
import { vaultSchema, type Vault } from '../src/core/keyring/account';
import { AppError } from '../src/core/errors';

const MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const ACCOUNT_0 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const ACCOUNT_1 = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const SECRET_0 = 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN';

/** SEP-0005 test 4: same phrase, different wallet once a passphrase is set. */
const PASSPHRASE_MNEMONIC =
  'cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube';
const PASSPHRASE = 'p4ssphr4se';
const PASSPHRASE_ACCOUNT_0 = 'GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ';


function vault(accounts = [{ index: 0, label: '' }]): Vault {
  return { version: 1, mnemonic: MNEMONIC, accounts };
}

function paymentTx(source: string): ReturnType<TransactionBuilder['build']> {
  return new TransactionBuilder(new Account(source, '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: ACCOUNT_1, asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(180)
    .build();
}

describe('Keyring', () => {
  it('starts locked', () => {
    expect(new Keyring().isUnlocked).toBe(false);
  });

  it('throws WALLET_LOCKED for every operation while locked', () => {
    const keyring = new Keyring();
    expect(() => keyring.listAccounts()).toThrow(AppError);
    expect(() => keyring.publicKeyOf(0)).toThrow(AppError);
    expect(() => keyring.accountMetas()).toThrow(AppError);
    try {
      keyring.listAccounts();
    } catch (err) {
      expect((err as AppError).code).toBe('WALLET_LOCKED');
    }
  });

  it('derives the SEP-0005 accounts on unlock', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault([{ index: 0, label: '' }, { index: 1, label: 'Savings' }]));
    expect(keyring.isUnlocked).toBe(true);
    const accounts = keyring.listAccounts();
    expect(accounts.map((a) => a.publicKey)).toEqual([ACCOUNT_0, ACCOUNT_1]);
    expect(accounts[0]?.path).toBe("m/44'/148'/0'");
    expect(accounts[1]?.label).toBe('Savings');
  });

  it('exposes no secret key on the public account shape (invariant 1)', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    const serialized = JSON.stringify(keyring.listAccounts());
    expect(serialized).not.toContain(SECRET_0);
    expect(serialized).not.toContain(MNEMONIC);
    for (const account of keyring.listAccounts()) {
      expect(Object.keys(account).sort()).toEqual(['index', 'label', 'path', 'publicKey']);
    }
  });

  it('signs without returning the keypair', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    const signed = await keyring.signTransaction(paymentTx(ACCOUNT_0), 0);
    expect(typeof signed).toBe('string');
    expect(signed).not.toContain(SECRET_0);
    const parsed = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
    expect(parsed.signatures.length).toBe(1);
  });

  it('produces a signature that verifies against the public key', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    const tx = paymentTx(ACCOUNT_0);
    const signed = await keyring.signTransaction(tx, 0);
    const { Keypair } = await import('@stellar/stellar-sdk');
    const parsed = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
    const signature = parsed.signatures[0];
    expect(signature).toBeDefined();
    const verified = Keypair.fromPublicKey(ACCOUNT_0).verify(
      parsed.hash(),
      signature!.signature(),
    );
    expect(verified).toBe(true);
  });

  it('refuses to sign for an unknown account index', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    await expect(keyring.signTransaction(paymentTx(ACCOUNT_0), 9)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('adds accounts at the next free SEP-0005 index', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    const added = await keyring.addAccount('Second');
    expect(added.index).toBe(1);
    expect(added.publicKey).toBe(ACCOUNT_1);
    expect(keyring.listAccounts()).toHaveLength(2);
  });

  it('maps a public key back to its index', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault([{ index: 0, label: '' }, { index: 1, label: '' }]));
    expect(keyring.indexOfPublicKey(ACCOUNT_1)).toBe(1);
    expect(() => keyring.indexOfPublicKey('GXXXX')).toThrow(AppError);
  });

  it('clears all state on lock (invariant 6)', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    keyring.lock();
    expect(keyring.isUnlocked).toBe(false);
    expect(() => keyring.publicKeyOf(0)).toThrow(AppError);
  });

  it('is idempotent when locking twice', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    keyring.lock();
    expect(() => keyring.lock()).not.toThrow();
  });

  it('rejects a vault whose recovery phrase is invalid', async () => {
    const keyring = new Keyring();
    await expect(
      keyring.unlock({ version: 1, mnemonic: 'not a real phrase', accounts: [{ index: 0, label: '' }] }),
    ).rejects.toBeInstanceOf(AppError);
    expect(keyring.isUnlocked).toBe(false);
  });

  it('hands out account metadata for re-encryption, never the phrase', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    await keyring.addAccount('Second');
    const metas = keyring.accountMetas();
    expect(metas).toHaveLength(2);
    // The caller rebuilds the vault from the decrypted copy it already holds.
    const rebuilt = { version: 1 as const, mnemonic: MNEMONIC, accounts: metas };
    expect(vaultSchema.safeParse(rebuilt).success).toBe(true);
    expect(JSON.stringify(metas)).not.toContain(MNEMONIC);
  });

  it('exposes no method that returns recovery material (invariants 1 and 6)', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(keyring) as object);
    expect(surface).not.toContain('revealRecoveryPhrase');
    expect(surface).not.toContain('exportVault');
    for (const name of surface) {
      expect(name).not.toMatch(/mnemonic|seed|secret/iu);
    }
  });

  it('rolls a derived account back when it could not be persisted', async () => {
    const keyring = new Keyring();
    await keyring.unlock(vault());
    const added = await keyring.addAccount('Second');
    keyring.removeAccount(added.index);
    expect(keyring.listAccounts()).toHaveLength(1);
    expect(() => keyring.publicKeyOf(added.index)).toThrow(AppError);
    // Index 0 is never removable.
    keyring.removeAccount(0);
    expect(keyring.listAccounts()).toHaveLength(1);
  });

  describe('BIP-39 passphrase (finding 7)', () => {
    it('derives the SEP-0005 test-4 account when the vault carries a passphrase', async () => {
      const keyring = new Keyring();
      await keyring.unlock({
        version: 1,
        mnemonic: PASSPHRASE_MNEMONIC,
        bip39Passphrase: PASSPHRASE,
        accounts: [{ index: 0, label: '' }],
      });
      expect(keyring.publicKeyOf(0)).toBe(PASSPHRASE_ACCOUNT_0);
    });

    it('derives a different wallet without the passphrase', async () => {
      const keyring = new Keyring();
      await keyring.unlock({
        version: 1,
        mnemonic: PASSPHRASE_MNEMONIC,
        accounts: [{ index: 0, label: '' }],
      });
      // This is the trap finding 7 describes: same words, silently different,
      // empty wallet. The expected key is derived here rather than hardcoded.
      const { deriveStellarPublicKey, mnemonicToSeed } = await import(
        '../src/core/crypto/mnemonic'
      );
      const expected = await deriveStellarPublicKey(
        await mnemonicToSeed(PASSPHRASE_MNEMONIC, ''),
        0,
      );
      expect(keyring.publicKeyOf(0)).toBe(expected);
      expect(keyring.publicKeyOf(0)).not.toBe(PASSPHRASE_ACCOUNT_0);
    });
  });
});
