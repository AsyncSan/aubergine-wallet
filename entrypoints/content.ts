/**
 * Content script; the isolated-world relay between the page provider and the
 * background (ARCHITECTURE.md §3).
 *
 * Invariant 7: this file is **not** declared in the manifest. It is registered
 * at runtime by `syncContentScriptRegistration()` and only while developer mode
 * is active, so a beginner install exposes nothing to web pages.
 *
 * It performs no trust decisions of its own; it validates the message shape,
 * stamps the real origin (the page cannot forge it, the background reads it
 * from `sender`) and forwards.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { PROVIDER_CHANNEL, providerRequestSchema } from '../src/messaging/protocol';

export default defineContentScript({
  // No `matches` on purpose: WXT lifts them into `host_permissions`, and this
  // script must not widen the install-time permission surface (finding B).
  // The patterns live in `syncContentScriptRegistration()` alone and are
  // granted at runtime through `chrome.permissions.request()`.
  runAt: 'document_start',
  registration: 'runtime',
  async main() {
    // Inject the MAIN-world provider from a packaged file (invariant 3: no
    // remote code, no eval, no inline script string).
    try {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('/inject.js');
      script.type = 'module';
      script.addEventListener('load', () => script.remove());
      (document.head ?? document.documentElement).append(script);
    } catch {
      /* a CSP-hardened page may refuse the injection; the dApp then sees no provider */
    }

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      if ((data as Record<string, unknown>)['channel'] !== PROVIDER_CHANNEL) return;

      const parsed = providerRequestSchema.safeParse(data);
      if (!parsed.success) return;
      const request = parsed.data;

      void browser.runtime
        .sendMessage(request)
        .then((response: unknown) => {
          const res =
            typeof response === 'object' && response !== null
              ? (response as Record<string, unknown>)
              : { ok: false, error: 'INTERNAL_ERROR' };
          window.postMessage(
            {
              channel: PROVIDER_CHANNEL,
              direction: 'to-page',
              id: request.id,
              ok: res['ok'] === true,
              result: res['result'],
              error: typeof res['error'] === 'string' ? res['error'] : undefined,
            },
            window.location.origin,
          );
        })
        .catch(() => {
          window.postMessage(
            {
              channel: PROVIDER_CHANNEL,
              direction: 'to-page',
              id: request.id,
              ok: false,
              error: 'INTERNAL_ERROR',
            },
            window.location.origin,
          );
        });
    });
  },
});
