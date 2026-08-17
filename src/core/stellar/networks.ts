/**
 * Network catalogue.
 *
 * ARCHITECTURE.md §4 (v1.2): the picker is available in both modes. Beginners
 * see Testnet and Mainnet, developers additionally Futurenet; Mainnet requires
 * the typed gate in either mode (`mainnetAcknowledged`, see core/settings.ts).
 */
import { AppError } from '../errors';
import { Networks } from '@stellar/stellar-sdk';

export const NETWORK_IDS = ['testnet', 'futurenet', 'mainnet', 'custom'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

/**
 * An ordered, non-empty Soroban RPC fallback chain. The tuple type is not
 * decoration: `noUncheckedIndexedAccess` would otherwise make `chain[0]`
 * `string | undefined`, and "the wallet has no RPC endpoint at all" must not
 * be a state the type system considers possible.
 */
export type SorobanRpcChain = readonly [string, ...string[]];

export interface NetworkConfig {
  readonly id: NetworkId;
  readonly passphrase: string;
  readonly horizonUrl: string;
  /**
   * Soroban RPC endpoints in the order they are tried (`src/core/stellar/soroban.ts`).
   * There is deliberately more than one for the public networks: the endpoint
   * sits on the mandatory path of every aggregator swap and every unprepared
   * dApp Soroban transaction, and until v1.3 it was a single third-party host
   * with no fallback at all.
   */
  readonly sorobanRpcUrls: SorobanRpcChain;
  /**
   * The primary endpoint, i.e. `sorobanRpcUrls[0]`.
   *
   * Kept as a scalar because it is what `originsForNetwork` (and therefore
   * `INSTALL_TIME_ORIGINS`) must stay pinned to; the *minimum* host access a
   * network needs in order to work at all. Everything further down the chain
   * is opt-in host access, see `allOriginsForNetwork`.
   *
   * New code that actually talks to the network must use `sorobanRpcUrls` and
   * go through `soroban.ts`; reaching for this field means silently giving up
   * the fallback.
   */
  readonly sorobanRpcUrl: string;
  readonly friendbotUrl: string | null;
  /** Real funds at stake; the UI must say so. */
  readonly isMainnet: boolean;
}

/** Fill in the derived `sorobanRpcUrl` so the two can never drift apart. */
function withPrimaryRpc(
  config: Omit<NetworkConfig, 'sorobanRpcUrl'> & Partial<Pick<NetworkConfig, 'sorobanRpcUrl'>>,
): NetworkConfig {
  return { ...config, sorobanRpcUrl: config.sorobanRpcUrls[0] };
}

/**
 * Soroban RPC endpoint chains.
 *
 * Sources, all checked on 2026-08-17:
 *
 *  - The SDF does NOT run a public Mainnet RPC. `developers.stellar.org`
 *    only lists third-party providers for pubnet
 *    (https://developers.stellar.org/docs/data/apis/api-providers).
 *  - `https://rpc.lightsail.network` and `https://mainnet.sorobanrpc.com` are
 *    the same operator (Lightsail Network / "overcat"), a free service with no
 *    ToS and no SLA. sorobanrpc.com's own homepage now advertises only
 *    `rpc.lightsail.network`, so that is the primary and the older hostname is
 *    kept one slot behind it rather than dropped.
 *  - Gateway (`*.stellar.gateway.fm`) and Nodies (`*.nodies.app`) are the two
 *    further entries the official provider list marks as publicly accessible
 *    without registration. They matter because the first two share an
 *    operator: without them the "chain" would fail as one unit.
 *  - Not taken: Liquify, whose documented public URL embeds a shared API key
 *    in the path (`.../api=<key>/mainnet`), baking a third party's rotatable
 *    credential into the bundle is exactly what this change avoids elsewhere.
 *    OnFinality's `https://stellar.api.onfinality.io/public` is listed without
 *    a stated protocol (Horizon vs RPC) and was left out rather than guessed.
 *
 * NONE of these were reachable from the build environment (egress policy), so
 * the ordering rests on documentation, not on a measured health check.
 */
export const TESTNET: NetworkConfig = withPrimaryRpc({
  id: 'testnet',
  passphrase: Networks.TESTNET,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrls: [
    // SDF's own Testnet RPC; the one endpoint in this file with an operator
    // that is accountable for the network itself.
    'https://soroban-testnet.stellar.org',
    'https://soroban-rpc.testnet.stellar.gateway.fm',
    'https://stellar-soroban-testnet-public.nodies.app',
  ],
  friendbotUrl: 'https://friendbot.stellar.org',
  isMainnet: false,
});

export const FUTURENET: NetworkConfig = withPrimaryRpc({
  id: 'futurenet',
  passphrase: Networks.FUTURENET,
  horizonUrl: 'https://horizon-futurenet.stellar.org',
  // No second documented Futurenet RPC exists; a debugging network gets no
  // invented fallback.
  sorobanRpcUrls: ['https://rpc-futurenet.stellar.org'],
  friendbotUrl: 'https://friendbot-futurenet.stellar.org',
  isMainnet: false,
});

export const MAINNET: NetworkConfig = withPrimaryRpc({
  id: 'mainnet',
  passphrase: Networks.PUBLIC,
  horizonUrl: 'https://horizon.stellar.org',
  sorobanRpcUrls: [
    'https://rpc.lightsail.network',
    'https://mainnet.sorobanrpc.com',
    'https://soroban-rpc.mainnet.stellar.gateway.fm',
    'https://stellar-soroban-public.nodies.app',
  ],
  friendbotUrl: null,
  isMainnet: true,
});

/**
 * Alchemy's Stellar RPC hosts. Only the hosts; the account key lives in the
 * URL path (`/v2/<key>`), is typed in by the user and stored locally
 * (`settings.sorobanRpcOverride`), and is never part of this bundle.
 *
 * They are named here for one reason: the MV3 `connect-src` is fixed at
 * package time, so a runtime endpoint can only be reached if its origin was
 * already listed in the manifest. See `wxt.config.ts`.
 */
export const ALCHEMY_SOROBAN_ORIGINS: readonly string[] = [
  'https://stellar-mainnet.g.alchemy.com',
  'https://stellar-testnet.g.alchemy.com',
];

export const BUILTIN_NETWORKS: Readonly<Record<Exclude<NetworkId, 'custom'>, NetworkConfig>> =
  {
    testnet: TESTNET,
    futurenet: FUTURENET,
    mainnet: MAINNET,
  };

/** Phase 1 default for every fresh install. */
export const DEFAULT_NETWORK_ID: NetworkId = 'testnet';

/**
 * True for the one passphrase that means real money.
 *
 * Exported because the Mainnet gate in `core/settings.ts` has to ask the same
 * question about a *custom* network: the network id is not what puts funds at
 * risk, the passphrase is.
 */
export function isMainnetPassphrase(passphrase: string): boolean {
  return passphrase === Networks.PUBLIC;
}

/**
 * Prepend the user's own endpoint, if there is one.
 *
 * Precedence is the point of the feature: an operator who configured their own
 * RPC wants it used, not used-if-the-free-ones-are-down. It stays part of the
 * chain rather than replacing it, so a typo or an expired key degrades to the
 * public endpoints instead of taking Soroban down entirely, and because the
 * endpoint is only tried, never trusted: a hostile RPC can make a simulation
 * fail, it cannot make the wallet sign anything (`tx.sign` still runs against
 * the envelope the user confirmed).
 */
function chainWithOverride(
  chain: SorobanRpcChain,
  override?: string | null,
): SorobanRpcChain {
  if (override === undefined || override === null || override.length === 0) return chain;
  if (chain.includes(override)) return chain;
  return [override, ...chain];
}

export interface CustomNetworkEndpoints {
  readonly passphrase: string;
  readonly horizonUrl: string;
  readonly sorobanRpcUrl: string;
}

export function resolveNetwork(
  id: NetworkId,
  custom?: CustomNetworkEndpoints,
  /** `settings.sorobanRpcOverride`; the user's own endpoint, https only. */
  sorobanRpcOverride?: string | null,
): NetworkConfig {
  if (id === 'custom') {
    // A typed error, so the popup can render it instead of "INTERNAL_ERROR".
    // (`effectiveNetworkId` already falls back for this case; this is the
    // second line of defence for a direct caller.)
    if (!custom) throw new AppError('BAD_REQUEST', 'custom network selected but not configured');
    return withPrimaryRpc({
      id: 'custom',
      passphrase: custom.passphrase,
      horizonUrl: custom.horizonUrl,
      sorobanRpcUrls: chainWithOverride([custom.sorobanRpcUrl], sorobanRpcOverride),
      friendbotUrl: null,
      /**
       * Derived, never assumed. This used to be a hardcoded `false`, which
       * meant a hand-edited or replicated `storage.sync` record carrying
       * `passphrase = Networks.PUBLIC` put the wallet on real funds with no
       * Mainnet gate, no warning banner and no header badge, the network id
       * said "custom", so every check that keyed off the id looked away.
       * The passphrase is what the signature commits to, so the passphrase is
       * what decides.
       */
      isMainnet: isMainnetPassphrase(custom.passphrase),
    });
  }
  const builtin = BUILTIN_NETWORKS[id];
  if (sorobanRpcOverride === undefined || sorobanRpcOverride === null) return builtin;
  return withPrimaryRpc({
    ...builtin,
    sorobanRpcUrls: chainWithOverride(builtin.sorobanRpcUrls, sorobanRpcOverride),
  });
}

export function hasFriendbot(id: NetworkId): boolean {
  return id !== 'custom' && BUILTIN_NETWORKS[id].friendbotUrl !== null;
}

/* ------------------------------------------------------- host permissions */

function toPatterns(urls: readonly (string | null)[]): string[] {
  const patterns = new Set<string>();
  for (const url of urls) {
    if (url === null || url.length === 0) continue;
    try {
      patterns.add(`${new URL(url).origin}/*`);
    } catch {
      /* an unparseable custom URL simply yields no pattern */
    }
  }
  return [...patterns];
}

/**
 * The origins a network needs in order to work *at all*: Horizon, the primary
 * Soroban RPC, and Friendbot where there is one.
 *
 * Only the Testnet triple is in `host_permissions` at install time; everything
 * else is in `optional_host_permissions` and requested with a user gesture when
 * the network is actually selected (see `wxt.config.ts`, finding B).
 *
 * Deliberately NOT the whole RPC fallback chain; the fallbacks are extra host
 * access we should not demand up front, and `INSTALL_TIME_ORIGINS` is derived
 * from this function. Use {@link allOriginsForNetwork} when asking the user
 * for permission, so the chain is actually usable once granted.
 */
export function originsForNetwork(
  id: NetworkId,
  custom?: { horizonUrl: string; sorobanRpcUrl: string },
): string[] {
  if (id === 'custom') {
    return custom ? toPatterns([custom.horizonUrl, custom.sorobanRpcUrl]) : [];
  }
  const net = BUILTIN_NETWORKS[id];
  return toPatterns([net.horizonUrl, net.sorobanRpcUrl, net.friendbotUrl]);
}

/**
 * Everything the network may end up talking to, fallback chain included.
 *
 * This is what the Settings screen requests. A fallback whose origin is not
 * granted is not a crash; the request simply fails and `soroban.ts` moves on
 * to the next entry, but then the chain is decoration, so the permission
 * prompt asks for the whole chain in one go.
 */
export function allOriginsForNetwork(
  id: NetworkId,
  custom?: CustomNetworkEndpoints,
  sorobanRpcOverride?: string | null,
): string[] {
  const net = resolveNetworkOrNull(id, custom, sorobanRpcOverride);
  if (net === null) return [];
  return toPatterns([net.horizonUrl, ...net.sorobanRpcUrls, net.friendbotUrl]);
}

function resolveNetworkOrNull(
  id: NetworkId,
  custom?: CustomNetworkEndpoints,
  sorobanRpcOverride?: string | null,
): NetworkConfig | null {
  try {
    return resolveNetwork(id, custom, sorobanRpcOverride);
  } catch {
    return null;
  }
}

/**
 * Origins the packaged `connect-src` covers for Soroban RPC traffic.
 *
 * MV3 fixes the extension CSP at package time; there is no runtime API that
 * adds a host to `connect-src`. A user-configured endpoint can therefore only
 * ever work if its origin is already in this list, which is why the Settings
 * screen refuses an override outside it instead of storing something that
 * would fail silently on the next swap. `wxt.config.ts` is kept in sync by
 * `tests/csp.test.ts`.
 */
export const CSP_SOROBAN_ORIGINS: readonly string[] = [
  ...new Set([
    ...Object.values(BUILTIN_NETWORKS).flatMap((net) =>
      net.sorobanRpcUrls.map((url) => new URL(url).origin),
    ),
    ...ALCHEMY_SOROBAN_ORIGINS,
  ]),
];

/**
 * Can a user-supplied endpoint actually be reached from an extension page?
 *
 * Two independent conditions, both hard requirements: https (the key sits in
 * the URL, and `http:` would also be blocked by `default-src 'self'` anyway)
 * and an origin the packaged CSP names.
 */
export type EndpointRejection = 'not-a-url' | 'not-https' | 'not-in-csp';

export function checkSorobanEndpoint(url: string): EndpointRejection | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not-a-url';
  }
  if (parsed.protocol !== 'https:') return 'not-https';
  if (!CSP_SOROBAN_ORIGINS.includes(parsed.origin)) return 'not-in-csp';
  return null;
}

/** Granted at install time; never has to be requested (§4: Testnet is the
 * default network on a fresh install, in both modes). */
export const INSTALL_TIME_ORIGINS: readonly string[] = originsForNetwork('testnet');

/** What the dApp connector's content script needs (developer mode only). */
export const DAPP_CONNECTOR_ORIGINS: readonly string[] = ['http://*/*', 'https://*/*'];

/* ----------------------------------------------------------- trustlines */

export interface CuratedAsset {
  readonly code: string;
  readonly issuer: string;
  readonly name: string;
}

/**
 * Curated Testnet assets offered to beginners in the "add asset" flow (§4).
 *
 * OPEN QUESTION; the curation criteria are not decided yet. These two are the
 * issuers the Stellar test ecosystem itself points at (Circle's Testnet USDC
 * and SDF's reference token); they are hardcoded on purpose so that no remote
 * list can ever influence what a beginner is offered (invariant 3). Before
 * Mainnet this needs a written policy: who gets listed, on what evidence, and
 * who reviews removals, and each issuer address has to be re-verified against
 * the live network at release time.
 */
export const CURATED_TESTNET_ASSETS: readonly CuratedAsset[] = [
  {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    name: 'Circle USD (Testnet)',
  },
  {
    code: 'SRT',
    issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B',
    name: 'Stellar Reference Token (Testnet)',
  },
];

/**
 * Curated Mainnet assets (v1.2).
 *
 * Curation policy, as far as it is decided: only issuers whose `home_domain`
 * resolves to the issuing company itself and whose SEP-1 TOML lists the asset.
 * Both entries below are Circle's own issuing accounts. They are hardcoded for
 * the same reason as the Testnet ones (invariant 3: no remote list decides what
 * a beginner is offered) and are re-verified against live Horizon by the
 * read-only Mainnet run (`npm run test:mainnet`, check `curated-issuers-live`),
 * which fails loudly if an address or home_domain ever stops matching.
 */
export const CURATED_MAINNET_ASSETS: readonly CuratedAsset[] = [
  {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    name: 'Circle USD',
  },
  {
    code: 'EURC',
    issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
    name: 'Circle Euro',
  },
];

/**
 * Accepted `home_domain` values per curated issuer, verified by the read-only
 * Mainnet run, which prints whatever the account actually declares. Circle has
 * used both domains historically, so both are accepted; anything else is a
 * FAIL, not a warning. Note there are *other* EURC issuers on Stellar (MYKOBO's
 * among them); the code alone never identifies an asset, only code+issuer does.
 */
export const CURATED_MAINNET_HOME_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN: ['centre.io', 'circle.com'],
  GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2: ['centre.io', 'circle.com'],
};

/**
 * The curated list for a given network, never network-agnostic.
 *
 * Before v1.2 the Testnet list was used everywhere, which meant a Mainnet user
 * was offered Testnet issuers in "add asset" and saw Testnet vetted names on
 * Mainnet balances. Futurenet and custom networks get nothing: there is no
 * list we could vouch for there.
 */
export function curatedAssetsFor(id: NetworkId): readonly CuratedAsset[] {
  if (id === 'testnet') return CURATED_TESTNET_ASSETS;
  if (id === 'mainnet') return CURATED_MAINNET_ASSETS;
  return [];
}
