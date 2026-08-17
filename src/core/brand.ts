/**
 * The product name, in one place.
 *
 * ARCHITECTURE.md §7 makes brand/tokens.json the single source of truth, but
 * that file sits outside the extension's Vite root and cannot be imported from
 * here without punching a hole in the dev server's filesystem allowlist. So it
 * is mirrored: this constant and `brand/tokens.json` must be changed together,
 * and the two other places the name is spelled out are
 *
 *   - wxt.config.ts        (manifest `name` and `action.default_title`)
 *   - entrypoints/popup/index.html  (<title>, before React mounts)
 *
 * Deliberately NOT covered by this constant: the page-world provider is exposed
 * as `window.aubergine` with an `isAubergine` marker (see
 * entrypoints/inject.ts). That is a published API surface, dApps feature-detect
 * on it, so renaming it is a breaking change, not a branding change.
 */
export const BRAND_NAME = 'Aubergine';
