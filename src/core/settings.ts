/**
 * Non-sensitive settings. Persisted in `chrome.storage.sync` (mode, locale) and
 * `chrome.storage.local` (everything else), invariant 2 allows this because
 * none of it is secret.
 */
import { z } from 'zod';
import {
  NETWORK_IDS,
  DEFAULT_NETWORK_ID,
  isMainnetPassphrase,
} from './stellar/networks';

export const MODES = ['beginner', 'developer'] as const;
export type Mode = (typeof MODES)[number];

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const THEMES = ['system', 'dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export const AUTO_LOCK_OPTIONS_MINUTES = [1, 5, 15, 30, 60] as const;
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

export const customNetworkSchema = z.object({
  passphrase: z.string().min(1),
  horizonUrl: z.string().url(),
  sorobanRpcUrl: z.string().url(),
});

export type CustomNetwork = z.infer<typeof customNetworkSchema>;

/**
 * An endpoint the user may type in. https only; no exceptions, no "localhost
 * is fine" carve-out:
 *
 *  - the value may carry a credential in its path (the Alchemy case,
 *    `https://stellar-mainnet.g.alchemy.com/v2/<key>`), and `http:` would put
 *    that key on the wire in clear text,
 *  - `default-src 'self'` plus the pinned `connect-src` would block an
 *    `http:` request anyway, so accepting one only produces a silent failure
 *    later instead of a clear refusal now.
 *
 * The refusal message deliberately does not echo the input, a rejected value
 * is still a value with a key in it, and error strings travel to the popup.
 */
export const httpsEndpointSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'endpoint must use https:');

export const settingsSchema = z.object({
  /** ARCHITECTURE.md §4: one switch, never flipped automatically. */
  mode: z.enum(MODES),
  locale: z.enum(LOCALES),
  theme: z.enum(THEMES),
  autoLockMinutes: z.number().int().min(1).max(240),
  networkId: z.enum(NETWORK_IDS),
  customNetwork: customNetworkSchema.nullable(),
  /**
   * The user's own Soroban RPC endpoint, taking precedence over the built-in
   * chain (developer mode only, `src/ui/screens/Settings.tsx`).
   *
   * SECRET. The whole reason this exists is an endpoint whose API key sits in
   * the URL path, so it is listed in `LOCAL_ONLY_SETTINGS_KEYS`
   * (`src/background/storage.ts`) and never written to `chrome.storage.sync`:
   * syncing it would replicate a paid credential to every profile the user is
   * signed into, over a channel neither we nor they control.
   */
  sorobanRpcOverride: httpsEndpointSchema.nullable(),
  selectedAccountIndex: z.number().int().min(0),
  /** Origins the user approved for the dApp connector (developer mode only). */
  allowedOrigins: z.array(z.string()),
  /** Whether the developer-mode warning has been acknowledged. */
  developerModeAcknowledged: z.boolean(),
  /**
   * Mainnet gate (v1.2, §4). Real funds are only ever reachable after the user
   * has typed the confirmation once. Fail-closed by design: without this flag
   * the *effective* network falls back to Testnet no matter what `networkId`
   * says; a settings write alone can never move anyone onto Mainnet.
   */
  mainnetAcknowledged: z.boolean(),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  mode: 'beginner',
  locale: 'de',
  theme: 'system',
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  networkId: DEFAULT_NETWORK_ID,
  customNetwork: null,
  sorobanRpcOverride: null,
  selectedAccountIndex: 0,
  allowedOrigins: [],
  developerModeAcknowledged: false,
  mainnetAcknowledged: false,
};

export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Merge a patch onto stored settings, dropping anything that fails validation. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return settingsSchema.parse({ ...current, ...patch });
}

/**
 * Networks a beginner may pick (§4, v1.2). Futurenet and custom endpoints stay
 * developer-only; they are debugging surfaces, not places to keep money.
 */
export const BEGINNER_NETWORK_IDS = ['testnet', 'mainnet'] as const;

/**
 * The network the wallet actually talks to.
 *
 * Two independent gates, both fail-closed:
 * 1. Mainnet requires `mainnetAcknowledged`; the typed confirmation in
 *    Settings. This holds in *both* modes, so a stray `settings.set` from
 *    anywhere (dApp path, restored backup, future migration) can never put a
 *    user on real funds without them having said so on this installation.
 * 2. Beginner mode is limited to `BEGINNER_NETWORK_IDS`; anything else falls
 *    back to Testnet instead of erroring, so a mode switch can never leave the
 *    wallet pointing at an endpoint the current mode is not allowed to use.
 */
export function effectiveNetworkId(settings: Settings): Settings['networkId'] {
  if (settings.networkId === 'mainnet') {
    return settings.mainnetAcknowledged ? 'mainnet' : DEFAULT_NETWORK_ID;
  }
  if (settings.networkId === 'custom') {
    // A stored `custom` without an endpoint is not a network. Both values pass
    // the schema, so the combination is reachable from a hand-edited store or a
    // `storage.sync` replication, and it used to make every network operation
    // throw an untyped INTERNAL_ERROR while the settings picker rendered blank.
    const custom = settings.customNetwork ?? null;
    if (custom === null) return DEFAULT_NETWORK_ID;
    /**
     * The same gate, reached by the other door.
     *
     * `customNetwork` travels in `storage.sync` (it is not a grant, so it is
     * not stripped) and its `passphrase` is a free-form string. A record with
     * `passphrase = Networks.PUBLIC` is therefore a Mainnet configuration that
     * calls itself `custom`, and every check that keyed off the *id* let it
     * through: no typed confirmation, no warning banner, no header badge, real
     * signatures on the public network. What decides is the passphrase, since
     * that is what the signature commits to.
     */
    if (isMainnetPassphrase(custom.passphrase) && !settings.mainnetAcknowledged) {
      return DEFAULT_NETWORK_ID;
    }
  }
  if (settings.mode === 'developer') return settings.networkId;
  return (BEGINNER_NETWORK_IDS as readonly string[]).includes(settings.networkId)
    ? settings.networkId
    : DEFAULT_NETWORK_ID;
}

/**
 * Real funds at stake right now, drives the header badge and the warnings.
 *
 * Not `=== 'mainnet'`: a `custom` network carrying the public passphrase is
 * Mainnet in every way that matters to the user's balance, and it is exactly
 * the configuration that used to get neither badge nor warning.
 */
export function isMainnetActive(settings: Settings): boolean {
  const id = effectiveNetworkId(settings);
  if (id === 'mainnet') return true;
  if (id === 'custom') {
    return isMainnetPassphrase(settings.customNetwork?.passphrase ?? '');
  }
  return false;
}
