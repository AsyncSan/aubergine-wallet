/**
 * `window.aubergine`; the page-world provider (ARCHITECTURE.md §6).
 *
 * Freighter-compatible signature on purpose: existing Stellar dApps work
 * unchanged. This is an interoperability decision, not a new standard.
 *
 * This script runs in the MAIN world and therefore has **no** extension
 * privileges. It only posts messages to the content script, which is itself
 * only present while developer mode is on (invariant 7).
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { PROVIDER_CHANNEL } from '../src/messaging/protocol';

type ProviderMethod = 'isConnected' | 'getPublicKey' | 'signTransaction' | 'getNetwork';

interface SignOptions {
  network?: string;
  networkPassphrase?: string;
  accountToSign?: string;
}

/**
 * Error shape the dApp sees (finding 6).
 *
 * `new Error(code)` left `error.code` undefined, so the documented
 * `catch (e) { e.code === 'USER_REJECTED' }` pattern could never work. The code
 * is the machine-readable contract; the message stays human-readable.
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  USER_REJECTED: 'The user rejected the request.',
  WALLET_LOCKED: 'The wallet is locked.',
  DEVELOPER_MODE_REQUIRED: 'The wallet is not in developer mode.',
  SOROBAN_SIMULATION_FAILED: 'Simulating the contract call failed.',
  BAD_REQUEST: 'The request was malformed.',
  NETWORK_ERROR: 'The wallet could not reach the network.',
  UNSUPPORTED_OPERATION: 'The wallet does not support this operation yet.',
  INTERNAL_ERROR: 'The wallet hit an unexpected error.',
  TIMEOUT: 'The wallet did not answer in time.',
};

class AubergineProviderError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? ERROR_MESSAGES[code] ?? code);
    this.name = 'AubergineProviderError';
    this.code = code;
  }
}

function providerError(code: string): AubergineProviderError {
  return new AubergineProviderError(code);
}

interface AubergineProvider {
  readonly isAubergine: true;
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  signTransaction(xdr: string, options?: SignOptions): Promise<string>;
}

export default defineUnlistedScript(() => {
  let counter = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: AubergineProviderError) => void;
    }
  >();

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const msg = data as Record<string, unknown>;
    if (msg['channel'] !== PROVIDER_CHANNEL || msg['direction'] !== 'to-page') return;
    const id = typeof msg['id'] === 'string' ? msg['id'] : '';
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (msg['ok'] === true) entry.resolve(msg['result']);
    else
      entry.reject(
        providerError(typeof msg['error'] === 'string' ? msg['error'] : 'INTERNAL_ERROR'),
      );
  });

  function call(method: ProviderMethod, payload?: Record<string, unknown>): Promise<unknown> {
    counter += 1;
    const id = `sw-${Date.now().toString(36)}-${counter}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage(
        {
          channel: PROVIDER_CHANNEL,
          direction: 'to-extension',
          id,
          method,
          ...(payload ? { payload } : {}),
        },
        window.location.origin,
      );
      // Never leave a dApp promise hanging forever.
      setTimeout(() => {
        if (pending.delete(id)) reject(providerError('TIMEOUT'));
      }, 130_000);
    });
  }

  const provider: AubergineProvider = {
    isAubergine: true,
    async isConnected() {
      return (await call('isConnected')) === true;
    },
    async getPublicKey() {
      return String(await call('getPublicKey'));
    },
    async getNetwork() {
      const result = (await call('getNetwork')) as {
        network: string;
        networkPassphrase: string;
      };
      return result;
    },
    async signTransaction(xdr: string, options?: SignOptions) {
      return String(
        await call('signTransaction', {
          xdr,
          ...(options?.networkPassphrase ? { networkPassphrase: options.networkPassphrase } : {}),
          ...(options?.accountToSign ? { accountToSign: options.accountToSign } : {}),
        }),
      );
    },
  };

  Object.defineProperty(window, 'aubergine', {
    value: Object.freeze(provider),
    writable: false,
    configurable: false,
  });
});
