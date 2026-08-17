/**
 * i18n (ARCHITECTURE.md §8).
 *
 * DE and EN catalogues are typed against each other: a key that exists in one
 * and not the other is a compile error, which is the cheapest possible guard
 * against half-translated releases. No user-visible string is ever hardcoded in
 * a component.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import de from './de.json';
import en from './en.json';
import type { Locale } from '../core/settings';

export type TranslationKey = keyof typeof en;

/** Structural check: DE must cover exactly the EN key set, and vice versa. */
const deCatalog: Record<TranslationKey, string> = de;
const enCatalog: Record<TranslationKey, string> = en;

const CATALOGS: Record<Locale, Record<TranslationKey, string>> = {
  de: deCatalog,
  en: enCatalog,
};

export type TParams = Readonly<Record<string, string | number>>;

/** `{placeholder}` interpolation. Unknown placeholders are left untouched. */
export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Prefixes that mark a *parameter value* as an i18n key rather than as data.
 *
 * `core/` must not contain user-visible prose (§8), but some operation lines
 * legitimately need a technical distinction in the middle of a sentence,
 * "set" vs. "delete" a data field, which account settings a SET_OPTIONS
 * touches, which network a mismatch refers to. Before this existed, those
 * values were interpolated raw and a beginner read "Datenfeld config set" or
 * "…als dem eingestellten (testnet)". The describer now emits keys and the
 * renderer resolves them here, so the whole sentence is translated.
 */
const TRANSLATABLE_PARAM_PREFIXES = ['tx.term.', 'settings.network.'] as const;

/** Separator for a parameter that carries a *list* of term keys. */
export const TERM_LIST_SEPARATOR = '\u001f';

function isTermKey(value: string): boolean {
  return TRANSLATABLE_PARAM_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function resolveTermParams(locale: Locale, params?: TParams): TParams | undefined {
  if (!params) return params;
  let resolved: Record<string, string | number> | null = null;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    const parts = value.split(TERM_LIST_SEPARATOR);
    if (!parts.every(isTermKey)) continue;
    resolved ??= { ...params };
    resolved[name] = parts.map((part) => translate(locale, part)).join(', ');
  }
  return resolved ?? params;
}

export function translate(locale: Locale, key: string, params?: TParams): string {
  const resolvedParams = resolveTermParams(locale, params);
  const catalog = CATALOGS[locale];
  const template = (catalog as Record<string, string | undefined>)[key];
  if (template === undefined) {
    // Fall back to English, then to the key itself, so a missing string is
    // visible in development but never crashes the popup.
    const fallback = (CATALOGS.en as Record<string, string | undefined>)[key];
    return fallback === undefined ? key : interpolate(fallback, resolvedParams);
  }
  return interpolate(template, resolvedParams);
}

export interface I18n {
  readonly locale: Locale;
  readonly t: (key: string, params?: TParams) => string;
}

const I18nContext = createContext<I18n>({
  locale: 'de',
  t: (key, params) => translate('de', key, params),
});

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}): ReactNode {
  const t = useCallback(
    (key: string, params?: TParams) => translate(locale, key, params),
    [locale],
  );
  const value = useMemo<I18n>(() => ({ locale, t }), [locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The hook every component uses. */
export function useT(): I18n {
  return useContext(I18nContext);
}

/** Locale-aware amount formatting (thousands separator, up to 7 decimals). */
export function formatAmount(locale: Locale, amount: string | number, maxDecimals = 7): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  }).format(n);
}

export function formatDateTime(locale: Locale, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
