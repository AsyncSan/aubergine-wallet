/**
 * A Ledger that is not a Ledger.
 *
 * Test support, deliberately outside `src/` so it cannot end up in a shipped
 * bundle. It implements {@link LedgerDevice} with real ed25519 keys, so a test
 * that drives the enrolment and signing paths through it exercises the same
 * verification the real device's output has to pass — in particular
 * `Transaction.addSignature`, which only accepts a signature that actually
 * verifies under the enrolled public key.
 *
 * The keys come from the *same* SLIP-0010 derivation the wallet uses for seed
 * accounts, from a different mnemonic. That is on purpose: it makes the fake
 * device's ladder look exactly like a real one (distinct key per path, stable
 * across calls) while guaranteeing its keys are foreign to the wallet's seed.
 */
import { Keypair, hash } from '@stellar/stellar-sdk';
import { deriveStellarKeypair, mnemonicToSeed } from '../../src/core/crypto/mnemonic';
import type { LedgerAppConfiguration, LedgerDevice } from '../../src/core/ledger/device';

/** A phrase that is never the wallet's own in any test. */
export const FAKE_DEVICE_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

export interface FakeLedgerOptions {
  /** Refuse everything, the way pressing "reject" on the device does. */
  readonly refuse?: boolean;
  /** Report the device as unplugged. */
  readonly disconnected?: boolean;
  /**
   * Return a signature that is well-formed but wrong.
   *
   * The case that matters most: a device that answers, plausibly, for a key
   * the wallet did not enrol. Nothing about the *shape* of that answer is
   * detectable, so the only thing standing between it and a broken envelope is
   * the verification on attach.
   */
  readonly corruptSignature?: boolean;
  readonly appConfiguration?: Partial<LedgerAppConfiguration>;
}

export class FakeLedgerDevice implements LedgerDevice {
  #seed: Uint8Array | null = null;
  #closed = false;
  readonly #options: FakeLedgerOptions;
  readonly #mnemonic: string;

  /** Every call the test made, so a test can assert on the ceremony itself. */
  readonly calls: string[] = [];

  constructor(options: FakeLedgerOptions = {}, mnemonic = FAKE_DEVICE_MNEMONIC) {
    this.#options = options;
    this.#mnemonic = mnemonic;
  }

  async #keypair(derivationIndex: number): Promise<Keypair> {
    this.#seed ??= await mnemonicToSeed(this.#mnemonic);
    return deriveStellarKeypair(this.#seed, derivationIndex);
  }

  #guard(): void {
    if (this.#closed) throw new Error('NotFoundError: the device is closed');
    if (this.#options.disconnected) throw new Error('no device found');
  }

  async getAppConfiguration(): Promise<LedgerAppConfiguration> {
    this.calls.push('getAppConfiguration');
    this.#guard();
    return {
      version: '5.0.3',
      hashSigningEnabled: false,
      maxDataSize: 1540,
      ...this.#options.appConfiguration,
    };
  }

  async getPublicKey(derivationIndex: number, display = false): Promise<string> {
    this.calls.push(`getPublicKey(${derivationIndex},${String(display)})`);
    this.#guard();
    if (this.#options.refuse) {
      const err = new Error('user refused');
      err.name = 'StellarUserRefusedError';
      throw err;
    }
    return (await this.#keypair(derivationIndex)).publicKey();
  }

  async signTransaction(
    derivationIndex: number,
    signatureBase: Uint8Array,
  ): Promise<Uint8Array> {
    this.calls.push(`signTransaction(${derivationIndex},${String(signatureBase.length)})`);
    this.#guard();
    if (this.#options.refuse) {
      const err = new Error('user refused');
      err.name = 'StellarUserRefusedError';
      throw err;
    }
    /**
     * The device is handed the *signature base* so it can parse and display
     * the transaction, but what it signs is `sha256(signatureBase)` — which is
     * the transaction hash, and is what `Transaction.addSignature` verifies
     * against. Signing the base itself would produce a 64-byte value that
     * looks perfectly valid and verifies under nothing.
     */
    const message = hash(Buffer.from(signatureBase));
    if (this.#options.corruptSignature) {
      // A different key entirely: right length, verifies under nothing we know.
      return new Uint8Array(Keypair.random().sign(message));
    }
    const kp = await this.#keypair(derivationIndex);
    return new Uint8Array(kp.sign(message));
  }

  async close(): Promise<void> {
    this.calls.push('close');
    this.#closed = true;
  }
}
