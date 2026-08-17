/**
 * In-memory keyring; the only place in the extension that ever holds an
 * unlocked seed (ARCHITECTURE.md §3).
 *
 * Rules enforced here:
 *  - nothing is persisted from this module; the caller owns storage,
 *  - no method returns a secret key or the seed,
 *  - `lock()` zeroizes every buffer it holds (invariant 6).
 */
import type { Keypair, Transaction } from '@stellar/stellar-sdk';
import { AppError } from '../errors';
import { deriveStellarKeypair, mnemonicToSeed, validateMnemonic } from '../crypto/mnemonic';
import { zeroize } from '../crypto/zeroize';
import { toPublicAccount, type AccountMeta, type PublicAccount, type Vault } from './account';

interface UnlockedState {
  seed: Uint8Array;
  /** Public keys by SEP-0005 index; derived once at unlock. */
  publicKeys: Map<number, string>;
  accounts: AccountMeta[];
}

export class Keyring {
  #state: UnlockedState | null = null;

  get isUnlocked(): boolean {
    return this.#state !== null;
  }

  /**
   * Load a decrypted vault into RAM and derive all public keys.
   *
   * The mnemonic and the optional BIP-39 passphrase are consumed here and
   * deliberately **not** retained: the seed is all the keyring needs, and a
   * string cannot be zeroized (see README, "Zeroization"). Anything that needs
   * the phrase again re-decrypts the vault with the password.
   */
  async unlock(vault: Vault): Promise<void> {
    if (!validateMnemonic(vault.mnemonic)) {
      throw new AppError('INVALID_MNEMONIC', 'vault contains an invalid recovery phrase');
    }
    const seed = await mnemonicToSeed(vault.mnemonic, vault.bip39Passphrase ?? '');
    const publicKeys = new Map<number, string>();
    try {
      for (const account of vault.accounts) {
        const kp = await deriveStellarKeypair(seed, account.index);
        publicKeys.set(account.index, kp.publicKey());
      }
    } catch (err) {
      // Invariant 6: a derivation that throws must not leave the freshly
      // derived seed lying in RAM for the garbage collector to maybe reuse.
      zeroize(seed);
      throw err;
    }
    this.lock();
    this.#state = {
      seed,
      publicKeys,
      accounts: [...vault.accounts],
    };
  }

  /** Wipe everything. Idempotent. */
  lock(): void {
    if (!this.#state) return;
    zeroize(this.#state.seed);
    this.#state.publicKeys.clear();
    this.#state.accounts = [];
    this.#state = null;
  }

  #require(): UnlockedState {
    if (!this.#state) throw new AppError('WALLET_LOCKED');
    return this.#state;
  }

  listAccounts(): PublicAccount[] {
    const state = this.#require();
    return state.accounts.map((meta) => {
      const publicKey = state.publicKeys.get(meta.index);
      if (!publicKey) throw new AppError('INTERNAL_ERROR', `no key for index ${meta.index}`);
      return toPublicAccount(meta, publicKey);
    });
  }

  publicKeyOf(index: number): string {
    const key = this.#require().publicKeys.get(index);
    if (!key) throw new AppError('BAD_REQUEST', `unknown account index ${index}`);
    return key;
  }

  indexOfPublicKey(publicKey: string): number {
    for (const [index, key] of this.#require().publicKeys) {
      if (key === publicKey) return index;
    }
    throw new AppError('BAD_REQUEST', 'unknown public key');
  }

  /** Derive and remember an additional account. Returns its public form. */
  async addAccount(label: string): Promise<PublicAccount> {
    const state = this.#require();
    const nextIndex = state.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1;
    const kp = await deriveStellarKeypair(state.seed, nextIndex);
    // Same window as in signTransaction: a lock during the derivation would
    // otherwise register an account derived from a zeroized seed.
    if (this.#state !== state) throw new AppError('WALLET_LOCKED');
    const meta: AccountMeta = { index: nextIndex, label };
    state.accounts.push(meta);
    state.publicKeys.set(nextIndex, kp.publicKey());
    return toPublicAccount(meta, kp.publicKey());
  }

  /**
   * Drop an account that was derived but could not be persisted, so RAM and
   * the encrypted vault never disagree. Index 0 always stays.
   */
  removeAccount(index: number): void {
    if (index === 0) return;
    const state = this.#require();
    state.accounts = state.accounts.filter((a) => a.index !== index);
    state.publicKeys.delete(index);
  }

  /**
   * Account metadata for re-encryption after a mutation.
   *
   * Note what this deliberately does *not* return: the recovery phrase. The
   * caller re-decrypts the vault with the user's password (`account.add` asks
   * for it) and merges these metas in, so the keyring never has to hold the
   * phrase as a long-lived JS string.
   */
  accountMetas(): AccountMeta[] {
    return [...this.#require().accounts];
  }

  /**
   * Sign in place and return the signed envelope.
   *
   * The keypair is created, used and dropped inside this method; no caller ever
   * receives it. This is the single choke point for invariant 1.
   */
  async signTransaction(tx: Transaction, accountIndex: number): Promise<string> {
    const state = this.#require();
    const expectedPublicKey = state.publicKeys.get(accountIndex);
    if (expectedPublicKey === undefined) {
      throw new AppError('BAD_REQUEST', `unknown account index ${accountIndex}`);
    }
    let kp: Keypair | null = null;
    try {
      kp = await deriveStellarKeypair(state.seed, accountIndex);
      /**
       * Derivation is four awaited HMAC round trips. `lock()` zeroizes the very
       * buffer we are deriving from, in place, so a lock landing inside that
       * window (auto-lock alarm, a second `wallet.unlock`, `wallet.lock` from
       * another extension page) used to produce a *valid-looking* signature
       * from the all-zero seed: the wrong key, reported as success, failing
       * on-chain with `tx_bad_auth` and no error anywhere in the wallet.
       *
       * Two cheap post-conditions close that window: the state object must
       * still be the one we started from, and the key we derived must be the
       * key we promised. Fail closed as WALLET_LOCKED either way.
       */
      if (this.#state !== state) throw new AppError('WALLET_LOCKED');
      if (kp.publicKey() !== expectedPublicKey) throw new AppError('WALLET_LOCKED');
      tx.sign(kp);
      return tx.toXDR();
    } finally {
      kp = null;
    }
  }
}
