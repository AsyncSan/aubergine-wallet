/**
 * Service worker; the only context that ever holds key material
 * (ARCHITECTURE.md §3).
 *
 * Responsibilities:
 *  - own the in-memory keyring and the auto-lock timer,
 *  - sign transactions (and never hand out a secret key),
 *  - broker every Horizon / Soroban RPC call,
 *  - dispatch the typed protocol from §6.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { toWireError } from '../src/core/errors';
import { parseRequest, type RpcMethod, type RpcResponse } from '../src/messaging/protocol';
import { BackgroundContext, handlers } from '../src/background/handlers';
import { AutoLock } from '../src/background/autolock';
import {
  PROVIDER_CHANNEL,
  providerRequestSchema,
  type ProviderRequest,
} from '../src/messaging/protocol';
import { normalizeOrigin, syncContentScriptRegistration } from '../src/background/dapp';
import { classifySender } from '../src/background/sender';
import { SETTINGS_KEY } from '../src/background/storage';

export default defineBackground(() => {
  const ctx = new BackgroundContext();

  // Restore mode-dependent state as soon as the worker boots.
  void (async () => {
    const settings = await ctx.settings();
    await syncContentScriptRegistration(settings.mode === 'developer');
  })();

  browser.alarms?.onAlarm.addListener((alarm) => {
    ctx.autoLock.handleAlarm(alarm.name);
  });

  /**
   * Settings are cached for the worker's lifetime, so a change that did not go
   * through `settings.set`, `chrome.storage.sync` replicating another profile,
   * or a second extension page, would otherwise never be noticed. Re-reading
   * cannot grant anything: `syncContentScriptRegistration` still checks the
   * optional host permission and fails closed (invariant 7).
   */
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (!Object.prototype.hasOwnProperty.call(changes, SETTINGS_KEY)) return;
    void ctx.reloadSettings();
  });

  async function dispatch(raw: unknown): Promise<RpcResponse> {
    let id = 'unknown';
    try {
      const request = parseRequest(raw);
      id = request.id;
      // The map is exhaustive over RpcMethod; the cast only re-links the
      // params/result pair that the union widened apart.
      const handler = handlers[request.method] as (
        c: BackgroundContext,
        p: unknown,
      ) => Promise<unknown>;
      const result = await handler(ctx, request.params);
      return { id, ok: true, result } as RpcResponse<RpcMethod>;
    } catch (err) {
      return { id, ok: false, error: toWireError(err) };
    }
  }

  /**
   * Translate a page-level provider call (relayed by the content script) into
   * the internal protocol. Kept separate so web content can never reach an
   * arbitrary RPC method.
   */
  async function dispatchProvider(
    request: ProviderRequest,
    origin: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    try {
      switch (request.method) {
        case 'isConnected': {
          /**
           * Deliberately does NOT report the lock state any more. It used to,
           * which handed every page in the browser a free "is this wallet
           * unlocked right now?" oracle; a targeting signal for phishing, and
           * one the page has no legitimate use for. What a dApp actually needs
           * to know is whether the connector is available at all.
           */
          const settings = await ctx.settings();
          return { ok: true, result: settings.mode === 'developer' };
        }
        case 'getNetwork': {
          /**
           * Which network the wallet is on (and, on mainnet, that there is
           * money in play) is only a connected site's business. An unconnected
           * page asking gets the same answer as one the user rejected.
           */
          const settings = await ctx.settings();
          if (settings.mode !== 'developer') return { ok: false, error: 'DEVELOPER_MODE_REQUIRED' };
          if (!settings.allowedOrigins.includes(normalizeOrigin(origin))) {
            return { ok: false, error: 'USER_REJECTED' };
          }
          const network = await ctx.network();
          return {
            ok: true,
            result: { network: network.id, networkPassphrase: network.passphrase },
          };
        }
        case 'getPublicKey': {
          const res = await handlers['dapp.requestConnect'](ctx, { origin });
          if (!res.approved || res.publicKey === null) return { ok: false, error: 'USER_REJECTED' };
          return { ok: true, result: res.publicKey };
        }
        case 'signTransaction': {
          const payload = request.payload ?? {};
          const xdr = typeof payload['xdr'] === 'string' ? payload['xdr'] : '';
          if (!xdr) return { ok: false, error: 'BAD_REQUEST' };
          const networkPassphrase =
            typeof payload['networkPassphrase'] === 'string'
              ? payload['networkPassphrase']
              : undefined;
          const accountToSign =
            typeof payload['accountToSign'] === 'string'
              ? payload['accountToSign']
              : undefined;
          const res = await handlers['dapp.signXdr'](ctx, {
            origin,
            xdr,
            ...(networkPassphrase === undefined ? {} : { networkPassphrase }),
            ...(accountToSign === undefined ? {} : { accountToSign }),
          });
          return { ok: true, result: res.signedXdr };
        }
        default:
          return { ok: false, error: 'BAD_REQUEST' };
      }
    } catch (err) {
      return { ok: false, error: toWireError(err).code };
    }
  }

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (response: unknown) => void) => {
      const asRecord =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>)
          : {};

      /**
       * Finding 8: `sender.id === runtime.id` does not tell a popup apart from
       * a content script; both carry our id. The context decides what is
       * reachable: a script in a page gets the four page-provider methods and
       * nothing else, the full RPC surface (including `tx.sign`) is reserved
       * for extension pages.
       */
      const context = classifySender(
        sender,
        browser.runtime.id,
        browser.runtime.getURL('/'),
      );

      // Relayed page provider call.
      if (asRecord['channel'] === PROVIDER_CHANNEL) {
        if (context !== 'content-script') {
          sendResponse({ ok: false, error: 'BAD_REQUEST' });
          return true;
        }
        const parsed = providerRequestSchema.safeParse(message);
        if (!parsed.success) {
          sendResponse({ ok: false, error: 'BAD_REQUEST' });
          return true;
        }
        const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');
        void dispatchProvider(parsed.data, origin).then(sendResponse);
        return true;
      }

      // Internal RPC. Extension pages only; a content script is refused here
      // even though it carries the extension's id.
      if (context !== 'extension-page') {
        sendResponse({ id: 'unknown', ok: false, error: { code: 'BAD_REQUEST' } });
        return true;
      }
      void dispatch(message).then(sendResponse);
      return true;
    },
  );

  // Locking on browser shutdown is implicit (RAM only), but be explicit anyway.
  browser.runtime.onSuspend?.addListener(() => {
    ctx.keyring.lock();
  });

  // Expose the alarm name for debugging in the service-worker console.
  Object.defineProperty(globalThis, '__aubergineAlarm', {
    value: AutoLock.alarmName,
    configurable: true,
  });
});
