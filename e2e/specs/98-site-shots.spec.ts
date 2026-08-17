/**
 * Product screenshots for the website.
 *
 * Not a behaviour test: it drives the real extension in real Chromium and
 * writes the images the marketing site shows, replacing the hand-drawn SVG
 * mockups it used to ship. Kept as a spec so it inherits the extension fixture
 * and the mocked Horizon rather than re-implementing either.
 *
 *   npx playwright test -c e2e/playwright.config.ts 98-site-shots
 *
 * The matrix is locale × theme, because the site is bilingual and has a
 * light/dark toggle: a German visitor in light mode must not be shown an
 * English popup on a dark background. Onboarding always runs in the shipped
 * default locale (German); the locale is switched afterwards through the
 * real settings store, exactly as the language selector does.
 *
 * Balances come from the Horizon mock and are therefore test-network numbers,
 * which is what the captions on the site say. Nothing here is retouched.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../support/extension';
import { createWallet, reloadPopup, writeSyncedSettings } from '../support/flows';
/**
 * The catalogues are read from disk rather than imported: this file runs through
 * Playwright's plain ESM loader, which requires an import attribute for JSON and
 * would otherwise fail before a single test is collected.
 */
const CATALOGS: Record<'de' | 'en', Record<string, string>> = {
  de: JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/i18n/de.json'),
      'utf8',
    ),
  ) as Record<string, string>,
  en: JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/i18n/en.json'),
      'utf8',
    ),
  ) as Record<string, string>,
};

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../e2e-shots/site');

/** Curated testnet issuer, so the token row shows a vetted name not a raw key. */
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

type Locale = 'de' | 'en';
type Theme = 'light' | 'dark';

const MATRIX: { locale: Locale; theme: Theme }[] = [
  { locale: 'de', theme: 'dark' },
  { locale: 'de', theme: 'light' },
  { locale: 'en', theme: 'dark' },
  { locale: 'en', theme: 'light' },
];

for (const { locale, theme } of MATRIX) {
  test(`site screenshots, ${locale}/${theme}`, async ({ popup, horizon }) => {
    const t = (key: string): string => {
      const value = CATALOGS[locale][key];
      if (!value) throw new Error(`missing i18n key ${key} for ${locale}`);
      return value;
    };
    const shot = async (name: string): Promise<void> => {
      // Let the theme transition settle so no capture lands mid-fade.
      await popup.waitForTimeout(250);
      /**
       * `animations: 'disabled'` fast-forwards every running CSS animation and
       * transition to its end state before the pixels are read. The 250 ms above
       * is not enough on its own and never was: the receive sheet fades in over
       * longer than that, and one capture in the last run (de/dark) came out
       * with a ghost QR code and grey text, which then shipped to the site as a
       * screenshot of a screen the product never shows. A wait long enough for
       * the slowest transition would only make the race rarer; this removes it.
       */
      await popup.screenshot({
        path: `${OUT}/${name}-${locale}-${theme}.png`,
        animations: 'disabled',
      });
    };

    await mkdir(OUT, { recursive: true });
    /**
     * The exact popup frame from brand/tokens.json. The fixture's default
     * viewport is larger, which left a band of empty page below the bottom nav
     * in every capture, real pixels, but not what the browser shows a user.
     */
    await popup.setViewportSize({ width: 360, height: 600 });

    /* ---------------------------------------------------- 1 · beginner home */
    const { address } = await createWallet(popup);
    horizon.fund(address, {
      xlm: '1234.5678901',
      assets: [
        { code: 'USDC', issuer: USDC_ISSUER, balance: '250.0000000' },
        { code: 'yXLM', issuer: Keypair.random().publicKey(), balance: '80.0000000' },
      ],
    });

    // Both the app's own theme setting and the OS preference, so the capture is
    // right whether a screen reads the setting or the media query.
    await writeSyncedSettings(popup, { locale, theme });
    await popup.emulateMedia({ colorScheme: theme });
    await reloadPopup(popup);

    await expect(popup.getByTestId('balance-hero')).toBeVisible();
    await expect(popup.getByTestId('token-native')).toBeVisible();
    await expect(popup.getByText('Circle USD (Testnet)')).toBeVisible();
    // The balance count-up is rAF-driven JavaScript (400 ms), which
    // animations:'disabled' cannot fast-forward, without this wait the hero
    // number ships mid-count (seen live as 1,179.38 of 1,232.56).
    await popup.waitForTimeout(500);
    await shot('home');

    /* ------------------------------- 2 · confirmation carrying a warning */
    // Paying an address that was never funded turns into "create account" and
    // raises the reserve warning; the beginner-facing case §5 cares about.
    const stranger = Keypair.random().publicKey();
    await popup.getByTestId('action-send').click();
    await expect(popup.getByRole('heading', { name: t('send.title') })).toBeVisible();
    await popup.getByRole('textbox').first().fill(stranger);
    await popup.locator('input[inputmode="decimal"]').fill('5');
    await popup.getByRole('button', { name: t('send.review') }).click();

    await expect(popup.getByText(t('confirm.warnings'))).toBeVisible();
    await expect(popup.getByRole('button', { name: t('confirm.submit') })).toBeEnabled();
    await shot('confirm-warning');

    /* ------------------------------------------- 3 · receive, QR on screen */
    // Reload rather than clicking Back: the confirmation step sits two screens
    // deep, and a reload lands on Home from wherever the flow happens to be.
    // The wallet stays unlocked; the session lives in the service worker.
    await reloadPopup(popup);
    await expect(popup.getByTestId('balance-hero')).toBeVisible();
    await popup.getByTestId('action-receive').click();
    await expect(popup.getByTestId('receive-qr')).toBeVisible();
    await shot('receive');

    /* ------------------------------------ 4 · developer mode, XDR expanded */
    // Straight through the settings store: the UI path needs an answer to
    // chrome.permissions.request(), which no automated browser can give.
    await writeSyncedSettings(popup, {
      mode: 'developer',
      developerModeAcknowledged: true,
    });
    await reloadPopup(popup);
    await expect(popup.getByTestId('balance-hero')).toBeVisible();

    await popup.getByTestId('action-send').click();
    await popup.getByRole('textbox').first().fill(Keypair.random().publicKey());
    await popup.locator('input[inputmode="decimal"]').fill('5');
    await popup.getByRole('button', { name: t('send.review') }).click();
    await popup.getByRole('button', { name: t('confirm.showXdr') }).click();

    const xdr = popup.locator('pre');
    await expect(xdr.first()).toBeVisible();
    expect((await xdr.first().innerText()).length).toBeGreaterThan(100);
    /**
     * Bring the envelope to the top of the scrolling region.
     *
     * The popup is a fixed 360x600 frame: a header, one scrollable middle and a
     * pinned action row. scrollIntoViewIfNeeded() considers the block "in view"
     * as soon as its first line is, which left the screenshot showing a box
     * clipped by the action row; it read as a rendering fault rather than as
     * the raw XDR the caption promises. So the scroll container is found by
     * walking up from the block and scrolled by the measured delta instead.
     */
    await popup.evaluate(() => {
      const pre = document.querySelector('pre');
      if (!pre) return;
      let box: HTMLElement | null = pre.parentElement;
      while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
      if (!box) return;
      const delta = pre.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop += delta - 8;
    });
    await shot('developer-xdr');
  });
}

/** Assert the whole matrix landed, so a partial run cannot ship silently. */
test('every site screenshot exists', async () => {
  const { access } = await import('node:fs/promises');
  const missing: string[] = [];
  for (const { locale, theme } of MATRIX) {
    for (const name of ['home', 'confirm-warning', 'receive', 'developer-xdr']) {
      const file = `${OUT}/${name}-${locale}-${theme}.png`;
      await access(file).catch(() => missing.push(file));
    }
  }
  expect(missing, `missing screenshots:\n${missing.join('\n')}`).toHaveLength(0);
});
