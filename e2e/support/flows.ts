/**
 * Reusable user journeys. Deliberately driven through the real UI (clicks and
 * typing), not through RPC shortcuts; a helper that skips the UI would make
 * every test that depends on it prove less than it looks like it proves.
 *
 * The popup ships with German as the default locale, so the selectors below are
 * the German strings from `src/i18n/de.json`.
 */
import type { Page } from '@playwright/test';
import { expect, rpc } from './extension';

export const TEST_PASSWORD = 'correct-horse-battery-staple-9';

export interface OnboardResult {
  readonly words: string[];
  readonly address: string;
}

export const STELLAR_ADDRESS_RE = /G[A-Z2-7]{55}/u;

/** Create a wallet from the welcome screen through to the funded-or-not Home. */
export async function createWallet(
  page: Page,
  password: string = TEST_PASSWORD,
): Promise<OnboardResult> {
  await page.getByRole('button', { name: 'Neue Wallet erstellen' }).click();

  const inputs = page.locator('input[type="password"]');
  await inputs.nth(0).fill(password);
  await inputs.nth(1).fill(password);
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();

  // Recovery phrase screen; the words are hidden until the user asks for them.
  await expect(page.getByText('Dein Wiederherstellungssatz')).toBeVisible({ timeout: 30_000 });
  await page.getByText('Wörter anzeigen').click();
  const words = await readPhrase(page);

  await page.getByRole('button', { name: 'Ich habe die Wörter aufgeschrieben' }).click();

  // Word-chip quiz (redesign v1.1): "Tippe Wort A, Wort B und Wort C …".
  await expect(page.getByText('Kurz überprüfen')).toBeVisible();
  await answerVerifyQuiz(page, words);

  // Completion screen with the drawn check, continue to Home.
  await expect(page.getByText('Deine Wallet ist bereit')).toBeVisible();
  await page.getByRole('button', { name: 'Zur Übersicht', exact: true }).click();

  const address = await readHomeAddress(page);
  return { words, address };
}

/** Read the asked-for positions from the quiz prompt (1-based). */
export async function readQuizPositions(page: Page): Promise<number[]> {
  const prompt = (await page.getByText(/Tippe Wort/u).innerText()).trim();
  const positions = [...prompt.matchAll(/Wort (\d+)/gu)].map((m) => Number(m[1]));
  if (positions.length !== 3) {
    throw new Error(`could not read the verification challenge: "${prompt}"`);
  }
  return positions;
}

/**
 * Tap the correct chip for each asked-for position, in order. Chips are
 * matched by their word text; an already-used (disabled) chip is skipped so
 * duplicate words in a phrase cannot break the flow.
 */
export async function answerVerifyQuiz(page: Page, words: string[]): Promise<void> {
  const positions = await readQuizPositions(page);
  for (const position of positions) {
    const expected = words[position - 1];
    if (!expected) throw new Error(`phrase has no word at position ${position}`);
    await page
      .getByTestId('quiz-chips')
      .getByRole('button', { name: expected, exact: true, disabled: false })
      .first()
      .click();
  }
}

export async function readPhrase(page: Page): Promise<string[]> {
  const items = page.locator('ol li');
  await expect(items.first()).toBeVisible();
  // Each item renders "<position><word>" with no separating whitespace.
  const texts = await items.allInnerTexts();
  return texts.map((text) => text.trim().replace(/^\d+\s*/u, ''));
}

/**
 * The account's G… address as carried by the Home head pill.
 *
 * The pill shows only the shortened form; the full key travels in its
 * `data-address` attribute (the visible full-address block left Home in v1.2,
 * the pill click copies the full address to the clipboard).
 */
export async function readHomeAddress(page: Page, timeout = 30_000): Promise<string> {
  const pill = page.getByTestId('address-pill');
  await expect(pill).toBeVisible({ timeout });
  const address = await pill.getAttribute('data-address');
  if (!address || !STELLAR_ADDRESS_RE.test(address)) {
    throw new Error(`no Stellar address on the Home head pill: ${String(address)}`);
  }
  return address;
}

/** Wait until Home is rendered (balance hero present). */
export async function expectHome(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('balance-hero')).toBeVisible({ timeout });
}

/**
 * Reload the popup so its TanStack-Query cache starts empty.
 *
 * Needed whenever the mocked Horizon state changes *after* the popup has
 * already read a balance: the real cache holds a snapshot for 30 s, and waiting
 * that out in every test would hide slow paths behind a long timeout.
 */
export async function reloadPopup(page: Page): Promise<void> {
  await page.reload();
  await expectHome(page);
}

export async function unlock(page: Page, password: string): Promise<void> {
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: 'Entsperren' }).click();
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
}

/**
 * Turn developer mode on through the UI, including the warning step.
 *
 * `chrome.permissions.request()` fires from that click. In an automated browser
 * there is nobody to answer the native dialog, so the caller decides what the
 * answer should be via `stubPermissionRequest()`.
 */
export async function enableDeveloperMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Entwickler', exact: true }).click();
  await expect(page.getByText('Entwickler-Modus einschalten?')).toBeVisible();
  await page.getByRole('button', { name: 'Verstanden, einschalten' }).click();
  await expect(page.locator('header').getByText('Entwickler-Modus')).toBeVisible();
}

export async function disableDeveloperMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Einsteiger', exact: true }).click();
  await expect(page.locator('header').getByText('Entwickler-Modus')).toHaveCount(0);
}

/**
 * Replace `chrome.permissions.request` for this page.
 *
 * Must be installed with `page.addInitScript` *before* the popup loads. This
 * simulates the user's answer to the browser's own dialog, which cannot be
 * driven from Playwright; everything downstream of the answer is the real code.
 */
export async function stubPermissionRequest(page: Page, grant: boolean): Promise<void> {
  await page.addInitScript((granted) => {
    const wire = (): void => {
      const permissions = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.permissions;
      if (!permissions) return;
      (globalThis as unknown as Record<string, unknown>)['__e2ePermissionRequests'] = [];
      permissions.request = ((
        request: chrome.permissions.Permissions,
        callback?: (granted: boolean) => void,
      ) => {
        (
          (globalThis as unknown as Record<string, unknown>)[
            '__e2ePermissionRequests'
          ] as unknown[]
        ).push(request);
        if (callback) {
          callback(granted);
          return undefined;
        }
        return Promise.resolve(granted);
      }) as typeof permissions.request;
    };
    wire();
  }, grant);
}

/** What the (stubbed) permission API was asked for. */
export async function permissionRequests(page: Page): Promise<unknown[]> {
  return page.evaluate(
    () =>
      ((globalThis as unknown as Record<string, unknown>)['__e2ePermissionRequests'] as unknown[]) ??
      [],
  );
}

/** Ids of the content scripts the extension has registered at runtime (§7). */
export async function registeredScripts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return scripts.map((script) => script.id);
  });
}

/** Write settings straight into `chrome.storage.sync`, the way another profile would. */
export async function writeSyncedSettings(
  page: Page,
  patch: Record<string, unknown>,
): Promise<void> {
  // Both areas, like the real `writeSettings`: the security grants
  // (developerModeAcknowledged, allowedOrigins, mainnetAcknowledged) are
  // local-only by design and deliberately ignored when they arrive via sync.
  const stored = await page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get('settings.v1', (localItems) => {
          chrome.storage.sync.get('settings.v1', (syncItems) =>
            resolve({
              ...((localItems['settings.v1'] as Record<string, unknown>) ?? {}),
              ...((syncItems['settings.v1'] as Record<string, unknown>) ?? {}),
            }),
          );
        });
      }),
  );
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve) => {
        chrome.storage.local.set({ 'settings.v1': value }, () => {
          chrome.storage.sync.set({ 'settings.v1': value }, () => resolve());
        });
      }),
    { ...stored, ...patch },
  );
}

export async function walletStatus(page: Page): Promise<{
  initialized: boolean;
  unlocked: boolean;
  autoLockAt: number | null;
}> {
  const response = await rpc(page, 'wallet.status', {});
  if (!response.ok) throw new Error(`wallet.status failed: ${JSON.stringify(response.error)}`);
  return response.result as { initialized: boolean; unlocked: boolean; autoLockAt: number | null };
}
