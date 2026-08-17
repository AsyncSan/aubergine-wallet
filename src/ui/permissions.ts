/**
 * Runtime host-permission requests (finding B).
 *
 * Only the Testnet endpoints are granted at install time. Everything a
 * developer-mode user opts into, other networks, a custom endpoint, and the
 * broad web access the dApp connector needs, sits in
 * `optional_host_permissions` and is requested here, from a click handler in
 * the popup. `chrome.permissions.request()` requires that user gesture, so
 * these helpers must never be called from an effect or a timer.
 */
import { browser } from 'wxt/browser';

/** True when every pattern is already granted. */
export async function hasOrigins(origins: readonly string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  try {
    const permissions = browser.permissions;
    if (!permissions?.contains) return false;
    return await permissions.contains({ origins: [...origins] });
  } catch {
    return false;
  }
}

/**
 * Ensure the patterns are granted, asking the user if they are not.
 * Returns false when the user declines; the caller must then not proceed.
 */
export async function ensureOrigins(origins: readonly string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  if (await hasOrigins(origins)) return true;
  try {
    const permissions = browser.permissions;
    if (!permissions?.request) return false;
    return await permissions.request({ origins: [...origins] });
  } catch {
    return false;
  }
}

/** Give back what is no longer needed, e.g. when leaving developer mode. */
export async function dropOrigins(origins: readonly string[]): Promise<void> {
  try {
    await browser.permissions?.remove?.({ origins: [...origins] });
  } catch {
    /* revocation is best-effort; the user can always revoke in the browser UI */
  }
}
