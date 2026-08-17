/**
 * Persistence layer.
 *
 * Invariant 2: `storage.local` holds the ciphertext blob and nothing else that
 * is sensitive. Settings live in `storage.sync` so the mode switch follows the
 * user across profiles (§4), with a local fallback for browsers where sync is
 * unavailable.
 */
import { browser } from 'wxt/browser';
import { keystoreSchema, type Keystore } from '../core/crypto/keystore';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../core/settings';

const KEYSTORE_KEY = 'keystore.v1';
/** Exported so the worker can tell a settings change apart from any other. */
export const SETTINGS_KEY = 'settings.v1';

/**
 * A stored blob we cannot parse. Deliberately NOT `null`: "there is no wallet"
 * and "there is a wallet I cannot read" must never collapse into one answer.
 * They used to, and the consequence was the worst bug this codebase can have,
 * a keystore written by a newer build (or half-written, or hand-edited) made
 * `wallet.status` report `initialized: false`, the popup offered onboarding,
 * and the first button on that screen overwrote the only copy of the user's
 * recovery phrase.
 */
export const KEYSTORE_UNREADABLE = 'unreadable';
export type KeystoreRead = Keystore | null | typeof KEYSTORE_UNREADABLE;

export async function readKeystore(): Promise<KeystoreRead> {
  const stored = await browser.storage.local.get(KEYSTORE_KEY);
  const raw = stored[KEYSTORE_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = keystoreSchema.safeParse(raw);
  return parsed.success ? parsed.data : KEYSTORE_UNREADABLE;
}

export async function writeKeystore(keystore: Keystore): Promise<void> {
  await browser.storage.local.set({ [KEYSTORE_KEY]: keystore });
}

export async function clearKeystore(): Promise<void> {
  await browser.storage.local.remove(KEYSTORE_KEY);
}

/** True for "something is stored here", readable or not; the overwrite guard. */
export async function hasKeystore(): Promise<boolean> {
  return (await readKeystore()) !== null;
}

/** True only for a blob that is present and cannot be parsed. */
export async function keystoreIsUnreadable(): Promise<boolean> {
  return (await readKeystore()) === KEYSTORE_UNREADABLE;
}

const settingsKeySchemas = settingsSchema.partial().shape;

/**
 * Settings that never travel over `chrome.storage.sync`.
 *
 * The first three are security grants, not preferences. Syncing them meant a
 * capability earned on one profile silently applied on every other: the typed
 * MAINNET confirmation from machine A put machine B on real funds without the
 * gate, an origin approved once was trusted everywhere, and the developer-mode
 * warning was only ever acknowledged on a single machine. §4 footnote 2
 * promises "on this installation", so they are stripped from every sync
 * write *and* ignored on every sync read (an old record, another build, or a
 * hand-edited sync store must not be able to smuggle them back in).
 *
 * `sorobanRpcOverride` is here for a different reason: it is a *secret*, not a
 * grant. The endpoint format that motivated the feature carries the API key in
 * the URL path (`https://stellar-mainnet.g.alchemy.com/v2/<key>`), so syncing
 * it would copy a paid credential into every profile the user is signed into.
 * Invariant 2 keeps secrets out of `storage.sync`; a key in a URL is still a
 * key. Stripping it on read matters too: without that, a foreign sync record
 * could point this wallet's Soroban traffic at an endpoint of the attacker's
 * choosing.
 */
const LOCAL_ONLY_SETTINGS_KEYS = [
  'mainnetAcknowledged',
  'allowedOrigins',
  'developerModeAcknowledged',
  'sorobanRpcOverride',
] as const satisfies readonly (keyof Settings)[];

function stripLocalOnly<T extends Partial<Settings>>(record: T): Partial<Settings> {
  const out: Record<string, unknown> = { ...record };
  for (const key of LOCAL_ONLY_SETTINGS_KEYS) delete out[key];
  return out as Partial<Settings>;
}

/**
 * Parse the stored settings key by key. A single bad field used to discard the
 * whole record; one unknown `theme` or an out-of-range `autoLockMinutes` from
 * a newer build silently reset mode, locale, selected account *and* the list of
 * connected origins. Now only the offending key falls back to its default.
 */
function parseSettingsRecord(raw: unknown): Partial<Settings> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(settingsKeySchemas)) {
    if (!(key in source)) continue;
    const parsed = schema.safeParse(source[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as Partial<Settings>;
}

async function readSettingsFrom(
  area: 'sync' | 'local',
): Promise<Partial<Settings> | null> {
  try {
    const stored = await browser.storage[area].get(SETTINGS_KEY);
    const raw = stored[SETTINGS_KEY];
    if (raw === undefined || raw === null) return null;
    return parseSettingsRecord(raw);
  } catch {
    return null;
  }
}

export async function readSettings(): Promise<Settings> {
  const fromSync = await readSettingsFrom('sync');
  const fromLocal = await readSettingsFrom('local');
  // Preferences from sync win; the security grants come from local alone.
  return settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...fromLocal,
    ...(fromSync === null ? {} : stripLocalOnly(fromSync)),
  });
}

export async function writeSettings(settings: Settings): Promise<void> {
  const value = settingsSchema.parse(settings);
  try {
    await browser.storage.sync.set({ [SETTINGS_KEY]: stripLocalOnly(value) });
  } catch {
    /* sync unavailable (e.g. Firefox without an account), local is enough */
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: value });
}
