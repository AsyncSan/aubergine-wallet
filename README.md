# Aubergine

A self-custody browser wallet for the Stellar network, for Chrome and Firefox.
Beginner-friendly by default, with developer features behind one deliberate
switch.

**Status: not audited, not published in any browser store.** The wallet starts
on the Stellar test network. The main network is reachable behind a typed
confirmation, and we do not recommend it yet. See [What is not
done](#what-is-not-done) for the honest list.

Full feature documentation: <https://aubergine.tech/en/docs/>

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Build and run](#build-and-run)
- [Quality gates](#quality-gates)
- [Security model](#security-model)
- [Permissions](#permissions)
- [Architecture](#architecture)
- [What is not done](#what-is-not-done)
- [Licence](#licence)

---

## What it does

**Beginner mode**, which is the shipping default:

- Balance with the spendable amount separated from the reserve the network
  holds back
- Send, with every transaction described in plain language before signing, and
  a warning where one is due (a payment that creates an account, a payment that
  would go below the reserve, a transaction for a different network)
- Receive, as a QR code and as text
- Swap, over the Stellar DEX and the Soroswap aggregator at once, taking the
  better of the two quotes
- Asset approvals from a short curated list
- Test balance from friendbot while on the test network

**Developer mode**, one switch in settings behind a warning:

- The raw XDR envelope, the sequence number, the authorised signers and the
  account thresholds
- Network selection extended by futurenet, plus your own Soroban RPC endpoint
- Manual fee override, and the numeric reserve breakdown
- Asset approvals for any issuer with your own limit
- Signing Soroban contract calls
- The dApp connector at `window.aubergine`, following the established
  Freighter-shaped interface so existing Stellar applications work unchanged

In beginner mode no content script is registered in any web page. The wallet
does not exist as far as web pages are concerned, which is the absence of code
rather than a setting that can be overlooked.

### The swap envelope check

A swap through the aggregator is a smart contract call, and a smart contract
call is not readable by a human. The wallet therefore does not sign it on
request. It checks the prepared envelope against the quote first: the contract
must be one of the pinned Soroswap contracts, the function and its argument
count must match the known signature, the recipient argument must be the
user's own account, both token arguments must match assets derived locally
from the quote, the input amount must match and the minimum output must be at
least the user's minimum. On the two token contracts involved, only `transfer`
is permitted with the user's address.

If any of that does not match, nothing is signed. That also holds if Soroswap
changes its contracts: the aggregator route then fails until a new release
ships, and the DEX route keeps working. A visible outage is better than a
signature on something we no longer understand.

### The unknown-outcome case

Between "accepted" and "rejected" there is a third case: submitted, no answer.
The wallet records the hash and the timebound before submitting, and refuses to
build, sign or submit a second transaction for that account until the outcome
resolves, including for a signature request from a web page. Submitting the
*same* transaction again is allowed, because after a timeout that is the right
move and the network deduplicates it.

---

## Requirements

- Node.js 22 or newer
- npm 10 or newer (this project uses npm and `package-lock.json`, not pnpm)
- Chrome or Chromium 110+ (`minimum_chrome_version` in the manifest), or
  Firefox 142+ (`strict_min_version`; see the note under "Load it in Firefox")

---

## Build and run

```bash
npm install          # runs `wxt prepare` afterwards and generates .wxt/
npm run dev          # Chrome with hot reload
npm run dev:firefox  # Firefox with hot reload

npm run build          # both artifacts
npm run build:chrome   # only .output/chrome-mv3/
npm run build:firefox  # only .output/firefox-mv3/
npm run zip            # store-ready ZIP files
```

### Load it in Chrome

1. `npm run build:chrome`
2. Open `chrome://extensions`
3. Enable developer mode, top right
4. Click **Load unpacked** and select `.output/chrome-mv3`
5. Pin the wallet icon and click it

### Load it in Firefox

1. `npm run build:firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** and select
   `.output/firefox-mv3/manifest.json`

Temporary add-ons are removed when Firefox closes. A permanent install needs a
signed build.

The Firefox manifest already carries the data collection declaration AMO has
required for new submissions since 3 November 2025:
`browser_specific_settings.gecko.data_collection_permissions.required =
["none"]`, which needs Firefox Desktop 140+ or Android 142+. `strict_min_version`
is therefore 142, the higher of the two. The wallet collects nothing at all,
which is invariant 4 below.

### Notes for add-on reviewers

The published package is bundled by Vite, so this repository is submitted as
the source archive alongside it. Everything below is meant to reproduce the
uploaded artifact in the default AMO review environment (Ubuntu 24.04 LTS,
ARM64, Node 22 LTS, npm 10). No other operating system, tool or account is
needed, and no step reaches the network except `npm ci`.

```bash
npm ci                                  # installs from package-lock.json
printf 'WXT_SOROSWAP_API_KEY=%s\n' "<key from the listing notes>" > .env.local
npm run build:firefox                   # -> .output/firefox-mv3/
npm run zip                             # -> .output/aubergine-extension-<version>-firefox.zip
```

Two things worth knowing while comparing the build to the upload:

1. **`.env.local` is required to get an identical build.** `WXT_SOROSWAP_API_KEY`
   is inlined at build time, so a build without it differs from the uploaded
   package in exactly that one string. It is supplied in the reviewer notes of
   the submission.

   To be precise about what that key is, because "not a secret" would be too
   glib: it is a **shared service credential, deliberately shipped and
   extractable**, identical in every install. It authenticates this extension
   against the Soroswap quote API, carries no user data, and is rotatable by
   us at any time. It is not a capability over anyone's funds. Whoever holds
   it can spend our quota with the aggregator and nothing else — in
   particular, an attacker who holds the key (or who *is* the aggregator)
   still cannot cause a signature: every envelope the aggregator returns is
   checked against the quote the user was shown before it can be signed
   (`verifySoroswapEnvelope` in `src/core/stellar/soroswap.ts`, once on
   receipt and again after RPC preparation, because preparation rewrites the
   fee and copies the server's own `auth` entries into the operation).
2. **`npm test` runs the full suite** (794 unit tests, no network) if you want
   to see the behaviour the code claims. `npx addons-linter <zip>` reports 0
   errors and 2 warnings. Both warnings are `UNSAFE_VAR_ASSIGNMENT` on
   `innerHTML` inside the bundled React DOM runtime, in its
   `dangerouslySetInnerHTML` branch. Neither `innerHTML` nor
   `dangerouslySetInnerHTML` appears anywhere in `src/` or `entrypoints/`;
   `grep -rn "innerHTML" src entrypoints` returns nothing.

### First steps on the test network

1. Open the popup, choose **Create a new wallet**, set a password
2. Write the recovery phrase down and answer the verification question. If you
   would rather have a file than a piece of paper, the phrase screen will save
   one for you — see the note on it under *Security model*
3. On the overview, click **Get test balance** (friendbot)
4. The balance arrives after a few seconds and **Send** works from then on

The default network is `https://horizon-testnet.stellar.org`. No real money is
involved there.

### Optional build-time configuration

`WXT_SOROSWAP_API_KEY` enables the Soroswap aggregator as a second quote
source. Without it there is no error: the wallet falls back to the DEX route
alone. Copy `.env.example` to `.env.local`, which is gitignored and never part
of a source archive.

---

## Quality gates

```bash
npx tsc --noEmit    # TypeScript 5 strict
npm test            # Vitest, 794 unit tests across 43 files
npm run test:e2e    # Playwright against the built Chrome artifact
npm run test:testnet # integration run against the real test network
npm run test:mainnet # read-only integration run against the main network
```

`npm run test:e2e` needs a build first (`npm run build:chrome`) and starts
Chromium with `--load-extension`. Horizon, friendbot and Soroban are mocked
with `context.route`, so no traffic leaves the machine. The 20 behaviour specs
cover bootstrap, Argon2id under the MV3 CSP, onboarding, lock and unlock, auto
lock, payment, the required warnings, every row of the mode table, declined
optional permissions, content script registration, the dApp flow, the unlock
throttle, both swap routes, the main-network gate and the no-key-leak
invariant.

Two caveats worth knowing:

- The native `chrome.permissions.request()` dialog cannot be answered by an
  automated browser, so the user's answer is stubbed at exactly that boundary.
  The dApp specs additionally run against a copy of the artifact whose two
  wildcard patterns are install-time permissions, standing in for a user who
  accepted. Everything behind that is unmodified production code.
- Playwright needs `executablePath` here because the preinstalled Chromium is
  older than the build matching the Playwright version. Set `E2E_CHROMIUM` to
  point at another binary.

**No unit or E2E test runs against a real network.** Every response comes from
a fixture. `test:testnet` and `test:mainnet` are the only runs that talk to a
chain, and they need to be started deliberately.

---

## Security model

The seven invariants from `ARCHITECTURE.md` §3 are binding:

1. A decrypted seed or secret key never leaves the background context. There
   are two deliberate exceptions, `wallet.revealRecoveryPhrase` and
   `wallet.revealSecretKey`; both are user initiated, require the password
   again, and decrypt the vault freshly rather than reading the live keyring,
   so an unlocked popup left on a desk still gives nothing away. See *Getting
   your keys out* below.
2. `chrome.storage.local` holds only the ciphertext blob `{v,kdf,params,salt,iv,ct}`
   plus non-sensitive settings. In keystore v2 the KDF header is bound into the
   ciphertext as AES-GCM `additionalData`, so a downgraded cost parameter fails
   decryption instead of quietly taking effect.
3. No remote code, no CDN, no `eval`, no dynamic `import()` from external URLs.
4. No telemetry, no analytics, no crash reporting.
5. Every signing action requires an explicit confirmation.
6. Key material lives in `Uint8Array` and is overwritten with `.fill(0)`, as
   far as JavaScript allows. The remaining exceptions are named below.
7. The content script is registered dynamically, in developer mode only.

Key derivation is Argon2id at 64 MiB over 3 passes, with PBKDF2-SHA-512 at
600,000 iterations as the fallback where WebAssembly is blocked. Encryption is
AES-256-GCM. Unlocking is throttled after four failed attempts, growing
exponentially to a 30 minute ceiling, and the counter survives a browser
restart.

### Getting your keys out

Self-custody that only works inside one extension is not self-custody, so both
exports exist and neither is hidden. They are not the same thing, and the
difference is the point: the recovery phrase is the whole wallet, forever,
including every account added later, while `wallet.revealSecretKey` hands over
one account's SEP-0005 key in strkey form (`S…`) and nothing else. Anyone moving
a single account into another Stellar tool should use the narrow one — a wallet
that refuses to offer it does not stop the user, it only makes the phrase the
thing they paste into a stranger's website.

Both are gated the same way: the password every single time, even while the
wallet is unlocked, the vault decrypted from scratch rather than read out of the
running keyring, and a 60 second auto-hide, because a key on a screen is a key
anyone walking past can photograph. A hardware account is refused rather than
answered (`NO_SECRET_KEY`): the seed would happily derive a key for the same
path, and it would be a different key than the one on the device, so answering
would mean telling the user "this is your account's key" about an account they
do not control.

The optional `.txt` backup on the phrase screen is the one place the wallet
helps you put a plaintext recovery phrase on a disk, and it is offered with open
eyes: in practice the alternative to a file is rarely paper, it is a screenshot
in a photo library that syncs. What the wallet controls, it does. Writing the
file takes two separate clicks, the first of which only opens the warning. The
name is sixteen random consonants and digits with no prefix, date or counter,
because a name is metadata that travels everywhere the file goes and
`recovery-phrase.txt` in a downloads folder on a shared screen is a signpost to
the money; the screen names the file before and after saving, since a name that
gives nothing away also gives you nothing to search for. The file itself does
say what it is, on purpose — twelve BIP-39 words are recognisable to anyone who
would exploit them, so the label only costs the honest finder — and it carries
its own warnings. No `downloads` permission is involved: it is a blob URL and an
`<a download>`, so nothing about this feature appears in the install prompt.

The password that protects the vault is gated on strength, not only on length.
An 8-character floor alone does not survive an offline grind of a stolen
keystore blob: Argon2id at these parameters buys roughly 15-20 bits, and the
password has to carry the rest. The create and import flows therefore require a
minimum score from the entropy estimator in `core/password-strength.ts` (no
zxcvbn, so no 400 kB of dictionaries in a wallet bundle). The rule is enforced
in the background's request schema, not only by the disabled Continue button,
because a rule that lives in a `disabled` attribute is a suggestion. Verifying
an *existing* password is deliberately exempt, so nobody whose password predates
the floor is locked out of their own wallet.

The lockout deadline is a wall-clock instant, and the system clock belongs to
whoever is at the machine, so the throttle does not simply believe it. Winding
the clock backwards is detected and costs the full delay again from the new
reading. Winding it forwards is overridden by a `performance.now()` anchor for
as long as the service worker lives. What remains open, and cannot be closed by
an extension: a forward jump *combined with* a worker restart, because MV3
discards the anchor and nothing readable from an extension is both monotonic
and durable across that. An attacker who manages it is back to one guess per
Argon2id derivation with the failure counter still climbing, which is the floor
this throttle ever promised.

### Zeroization: what actually holds

Invariant 6 is a goal, not a guarantee. Actually zeroized: the BIP-39 seed, all
SLIP-0010 intermediate nodes, the derived AES key and the decrypted plaintext
buffer, all held as `Uint8Array` and overwritten in `finally` blocks.

Not fully erasable, because JavaScript does not allow it:

- **The recovery phrase is a string.** It comes out of `JSON.parse` on the
  decrypted vault and goes into `mnemonicToSeed`. Strings are immutable, and
  `x = ''` only drops the reference. What we did instead is shorten its
  lifetime as far as possible: the keyring no longer retains the phrase at all,
  only the seed, and the reveal screen decrypts the vault again rather than
  keeping it around.
- **The password is a string.** It comes from a DOM input, is copied into the
  service worker heap by structured clone, and only becomes bytes in
  `deriveKey`. Neither copy is overwritable. The UI resets its React state
  after use, which shortens the lifetime without erasing the bytes.
- **The SDK keeps its own copy.** `Keypair.fromRawEd25519Seed` copies the
  private key into a `Buffer` the SDK owns. We drop the reference after
  signing but do not overwrite those bytes.

The consequence for the threat model: encryption protects against theft of
storage while the wallet is locked. Nothing in JavaScript fully protects
against an attacker who can take a memory dump of the running process. That is
already listed as out of scope in §3, alongside a compromised operating system
and debugger access.

---

## Permissions

At install time the extension asks only for what beginner mode needs:

```
permissions:      storage, alarms, scripting
host_permissions: https://horizon-testnet.stellar.org/*
                  https://soroban-testnet.stellar.org/*
                  https://friendbot.stellar.org/*
                  https://api.soroswap.finance/*
```

Everything else sits in `optional_host_permissions` and is requested at
runtime, always out of a click:

| When | What |
|---|---|
| Turning on developer mode | `http://*/*`, `https://*/*`, which only the dApp connector needs |
| Switching to the main network or futurenet | that network's Horizon, Soroban and friendbot endpoints |
| Entering your own RPC endpoint | that origin, covered by the two wildcard patterns |

Declining changes nothing silently: the network is not switched, or the
connector stays off, and the wallet says so. Switching back to beginner mode
hands the extra permissions back. `clipboardWrite` is deliberately absent,
because `navigator.clipboard.writeText` does not need it from a focused popup.

---

## Architecture

```
extension-v13/
├── wxt.config.ts             Chrome MV3 and Firefox MV3 targets, Tailwind v4, Node polyfills
├── entrypoints/
│   ├── background.ts         Service worker: keyring, signing, RPC broker, auto lock
│   ├── content.ts            Relay, registered at RUNTIME only in developer mode
│   ├── inject.ts             window.aubergine (MAIN world, Freighter-shaped)
│   └── popup/                React 19 app, 360x600
├── src/
│   ├── core/                 chain- and UI-free domain logic, no `any`
│   │   ├── crypto/           kdf.ts (Argon2id, PBKDF2 fallback), keystore.ts
│   │   │                     (AES-256-GCM), mnemonic.ts (BIP-39, SEP-0005), zeroize.ts
│   │   ├── stellar/          horizon.ts, soroban.ts, soroswap.ts, tx-builder.ts,
│   │   │                     tx-describe.ts, networks.ts
│   │   ├── net/              limiter.ts (one token bucket for every path), sdk-cancel.ts
│   │   ├── keyring/          keyring.ts (RAM only), account.ts
│   │   ├── errors.ts         typed error codes, 39 translated Stellar result codes
│   │   └── settings.ts
│   ├── messaging/            protocol.ts (Zod-validated RPC union), client.ts
│   ├── background/           handlers.ts, autolock.ts, storage.ts, dapp.ts,
│   │                         pending-submission.ts, unlock-guard.ts
│   ├── state/                Zustand store and TanStack Query hooks
│   ├── ui/                   components/, screens/
│   └── i18n/                 de.json, en.json, useT()
├── tests/                    Vitest, 36 files
├── e2e/                      Playwright against the built Chrome MV3 artifact
└── integration/              runs against real testnet and mainnet, started deliberately
```

The source refers to `ARCHITECTURE.md` §3 to §8 in a great many places. That
document is in this repository so the invariants can actually be looked up.

---

## What is not done

Not included at all:

- No fiat on-ramp. The Buy button exists, the route through regulated anchor
  partners does not.
- No WalletConnect.
- No multisig execution. Signers are displayed, co-signing is not possible.
- No mobile app

Present but unfinished:

- Hardware wallet support is Ledger only, Chrome only, and classic operations
  only. Firefox has no WebHID and has declined to implement it, so the button
  is not offered there. Contract calls are refused rather than signed blind:
  the Stellar app cannot render an invocation, and signing one would mean
  confirming a bare hash on the device. **Not yet tested against physical
  hardware** — the flow is covered by unit tests through a fake device that
  produces real ed25519 signatures, which verifies every step except the
  device itself.
- A Ledger account cannot answer a signature request from a web page. The
  connector returns `LEDGER_REQUIRED` instead of opening a second window on a
  page's request.
- The curated asset list is a placeholder. The criteria for what belongs on it,
  and who decides, are open, and the issuer addresses have not been checked
  against the live network.
- A fully custom network cannot be selected, only a custom Soroban RPC
  endpoint.
- The dApp connector is a working skeleton: no approval window of its own, no
  expiry on approvals, no origin-to-account scoping.
- Tracking a payment with an unknown outcome only runs while the popup is open.
  A background loop would have to survive service worker death, which only
  `chrome.alarms` can do, and its minute granularity is coarser than the 180
  second window it would need to cover.
- The unknown-outcome block is one slot for the whole wallet rather than one
  per network and account, so an open submission on the test network
  temporarily blocks one on the main network.
- The fee is not recalculated between building and submitting, and fee-bump
  transactions are described but never signed.
- Slippage is only checked when a quote exists or the assets are identical.
  Otherwise the UI says it cannot be checked.
- One residual gap in the swap check is documented as a test rather than
  hidden: a correctly sized `transfer` to a foreign contract, underneath a
  genuine aggregator call, still passes. The on-chain mitigation is that the
  aggregator measures the balance difference and reverts below
  `amount_out_min`.

Not verified:

- No external security audit exists.
- The pinned Soroswap contract ids and signatures are verified against the
  `main` branch of both upstream repositories, not against the running chain.
- There is no CI.

---

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

No investment advice, no promised returns, no security guarantee. This
software is not audited.
