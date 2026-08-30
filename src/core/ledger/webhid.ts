/**
 * The real device, over WebHID.
 *
 * **Window contexts only.** `navigator.hid` does not exist in an MV3 service
 * worker, which is the whole reason the Ledger flow needs a page of its own
 * (`entrypoints/ledger/`). Importing this module from the background would
 * pull the Ledger SDK into that bundle for no benefit and fail at the first
 * call, so nothing there imports it.
 *
 * Firefox has no WebHID at all and has declined to implement it, so
 * {@link isWebHidAvailable} is false there and the UI says so instead of
 * offering a button that cannot work.
 */
import { Buffer } from 'buffer';
import Str from '@ledgerhq/hw-app-str';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import { AppError } from '../errors';
import {
  ledgerAccountPath,
  rawPublicKeyToStrkey,
  toLedgerAppError,
  type LedgerAppConfiguration,
  type LedgerDevice,
} from './device';

/** Feature detection, not user-agent sniffing. */
export function isWebHidAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

class WebHidLedgerDevice implements LedgerDevice {
  readonly #transport: TransportWebHID;
  readonly #app: Str;

  constructor(transport: TransportWebHID) {
    this.#transport = transport;
    this.#app = new Str(transport);
  }

  async getAppConfiguration(): Promise<LedgerAppConfiguration> {
    try {
      const config = await this.#app.getAppConfiguration();
      return {
        version: config.version,
        hashSigningEnabled: config.hashSigningEnabled,
        maxDataSize: config.maxDataSize ?? null,
      };
    } catch (err) {
      throw toLedgerAppError(err);
    }
  }

  async getPublicKey(derivationIndex: number, display = false): Promise<string> {
    try {
      const { rawPublicKey } = await this.#app.getPublicKey(
        ledgerAccountPath(derivationIndex),
        display,
      );
      return rawPublicKeyToStrkey(new Uint8Array(rawPublicKey));
    } catch (err) {
      throw toLedgerAppError(err);
    }
  }

  async signTransaction(
    derivationIndex: number,
    signatureBase: Uint8Array,
  ): Promise<Uint8Array> {
    try {
      const { signature } = await this.#app.signTransaction(
        ledgerAccountPath(derivationIndex),
        Buffer.from(signatureBase),
      );
      return new Uint8Array(signature);
    } catch (err) {
      throw toLedgerAppError(err);
    }
  }

  async close(): Promise<void> {
    try {
      await this.#transport.close();
    } catch {
      /* closing a transport the browser already tore down is not an error */
    }
  }
}

/**
 * Open a device the user has already granted, without prompting.
 *
 * Returns `null` rather than throwing when there is nothing granted yet: "no
 * device is paired" is the normal first-run state, and the caller's answer to
 * it is to show a Connect button, not an error.
 */
export async function openGrantedLedger(): Promise<LedgerDevice | null> {
  if (!isWebHidAvailable()) return null;
  try {
    const devices = await TransportWebHID.list();
    if (devices.length === 0) return null;
    const first = devices[0];
    if (first === undefined) return null;
    return new WebHidLedgerDevice(await TransportWebHID.open(first));
  } catch {
    return null;
  }
}

/**
 * Show the browser's device chooser and open what the user picks.
 *
 * **Must be called from a user gesture.** WebHID requires transient
 * activation for the chooser, and the chooser takes focus — which is exactly
 * why this cannot run in the browser-action popup: that popup closes on focus
 * loss and would take the transport down with it mid-ceremony.
 */
export async function requestLedger(): Promise<LedgerDevice> {
  if (!isWebHidAvailable()) {
    throw new AppError('LEDGER_UNAVAILABLE', 'this browser has no WebHID');
  }
  try {
    return new WebHidLedgerDevice(await TransportWebHID.request());
  } catch (err) {
    throw toLedgerAppError(err);
  }
}
