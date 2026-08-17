/**
 * Playwright fixtures for driving the built Chrome MV3 artefact.
 *
 * MV3 needs a persistent context with `--load-extension`; `serviceWorkers:
 * 'allow'` is what makes the background worker visible to the test *and* makes
 * its network requests routable.
 *
 * The chromium binary is pinned explicitly: the Playwright version in
 * `devDependencies` expects a newer build than the one preinstalled in this
 * image, and no browser download is possible here.
 */
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HorizonMock, LOG_SINK_URL } from '../fixtures/horizon-mock';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH =
  process.env['E2E_EXTENSION_PATH'] ?? path.resolve(here, '../../.output/chrome-mv3');
export const CHROMIUM_EXECUTABLE =
  process.env['E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const SCREENSHOT_DIR = path.resolve(here, '../screenshots');

export interface CollectedError {
  readonly source: string;
  readonly type: string;
  readonly text: string;
}

/**
 * Collects console errors and unhandled rejections from **every** popup page,
 * every web page and the service worker, for the whole test.
 *
 * Known limitation, stated rather than hidden: the service-worker hook can only
 * be installed once the worker exists, so an exception thrown in the very first
 * milliseconds of worker startup is not captured by the hook. The log-file scan
 * in `chromeLogErrors()` is the backstop for that.
 */
export class ErrorCollector {
  readonly entries: CollectedError[] = [];
  /** Patterns that are demonstrably not the extension's doing. */
  readonly ignore: RegExp[] = [];

  add(source: string, type: string, text: string): void {
    this.entries.push({ source, type, text });
  }

  get problems(): CollectedError[] {
    return this.entries.filter((e) => !this.ignore.some((re) => re.test(e.text)));
  }

  format(): string {
    return this.problems.map((e) => `  [${e.source}/${e.type}] ${e.text}`).join('\n');
  }
}

const SW_HOOK = (sink: string): boolean => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g['__e2eHookInstalled'] === true) return false;
  g['__e2eHookInstalled'] = true;
  const report = (type: string, text: string): void => {
    try {
      void fetch(
        `${sink}?type=${encodeURIComponent(type)}&text=${encodeURIComponent(String(text).slice(0, 1500))}`,
      );
    } catch {
      /* the sink is best effort */
    }
  };
  const original = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    const text = args
      .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a)))
      .join(' ');
    report('console.error', text);
    original(...args);
  };
  self.addEventListener('error', (event) => {
    report('error', `${event.message} @ ${event.filename}:${event.lineno}`);
  });
  self.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason as unknown;
    report(
      'unhandledrejection',
      reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason),
    );
  });
  return true;
};

/**
 * Copy the built artefact and move the two dApp-connector wildcards from
 * `optional_host_permissions` into `host_permissions`.
 *
 * Why this exists: `chrome.permissions.request()` opens a *native* browser
 * dialog. In headless automation nobody can answer it, and the call simply
 * never settles (verified; it hangs, it does not reject). Chrome treats
 * install-time host permissions exactly like optional ones the user has
 * granted, so this copy is the only way to exercise the granted branch.
 * Everything else in the artefact is byte-identical to the shipped build, and
 * every other spec runs against the shipped build unmodified.
 */
function makePreGrantedExtension(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aubergine-granted-'));
  fs.cpSync(EXTENSION_PATH, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    host_permissions: string[];
    optional_host_permissions: string[];
  };
  const wildcards = ['http://*/*', 'https://*/*'];
  manifest.host_permissions = [...manifest.host_permissions, ...wildcards];
  manifest.optional_host_permissions = manifest.optional_host_permissions.filter(
    (pattern) => !wildcards.includes(pattern),
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return dir;
}

export interface ExtensionOptions {
  /**
   * `default`; the shipped artefact, dApp web access not granted.
   * `pregranted`, same artefact with the connector's host access already
   * granted, standing in for a user who accepted the permission dialog.
   */
  hostAccess: 'default' | 'pregranted';
}

export interface ExtensionFixtures extends ExtensionOptions {
  extensionDir: string;
  context: BrowserContext;
  extensionId: string;
  horizon: HorizonMock;
  errors: ErrorCollector;
  userDataDir: string;
  /** An open popup page (`popup.html`), the way a user sees the extension. */
  popup: Page;
}

export const test = base.extend<ExtensionFixtures>({
  hostAccess: ['default', { option: true }],

  extensionDir: async ({ hostAccess }, use) => {
    if (hostAccess === 'default') {
      await use(EXTENSION_PATH);
      return;
    }
    const dir = makePreGrantedExtension();
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aubergine-e2e-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  },

  // eslint-disable-next-line no-empty-pattern
  errors: async ({}, use) => {
    const collector = new ErrorCollector();
    await use(collector);
    if (collector.problems.length > 0) {
      throw new Error(
        `console errors / unhandled rejections during the test:\n${collector.format()}`,
      );
    }
  },

  horizon: async ({}, use) => {
    await use(new HorizonMock());
  },

  context: async ({ userDataDir, extensionDir, horizon, errors }, use) => {
    if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
      throw new Error(
        `built extension not found at ${extensionDir}, run \`npm run build:chrome\` first`,
      );
    }
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: CHROMIUM_EXECUTABLE,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-sandbox',
        '--enable-logging',
        `--log-file=${path.join(userDataDir, 'chrome_debug.log')}`,
      ],
      serviceWorkers: 'allow',
      viewport: { width: 400, height: 700 },
      /**
       * 1 for every behaviour test; that is what the assertions were written
       * against. `98-site-shots` raises it so the marketing captures are sharp
       * on a HiDPI display; nothing else reads this.
       */
      deviceScaleFactor: Number(process.env['E2E_DEVICE_SCALE_FACTOR'] ?? 1),
    });

    await horizon.install(context);

    // The error sink the service-worker hook posts to. Registered AFTER the
    // Horizon mock: the sink lives under the Horizon origin (see LOG_SINK_URL)
    // and Playwright gives the last-registered route precedence, so sink
    // requests never reach the Horizon handler.
    await context.route(`${LOG_SINK_URL}*`, async (route) => {
      const url = new URL(route.request().url());
      errors.add(
        'service-worker',
        url.searchParams.get('type') ?? 'unknown',
        url.searchParams.get('text') ?? '',
      );
      await route.fulfill({
        status: 204,
        body: '',
        headers: { 'access-control-allow-origin': '*' },
      });
    });

    const attachPage = (page: Page): void => {
      // The label is resolved per event: a page starts life on about:blank.
      const label = (): string =>
        page.url().startsWith('chrome-extension://') ? 'popup' : 'page';
      page.on('console', (message) => {
        if (message.type() === 'error') errors.add(label(), 'console.error', message.text());
      });
      page.on('pageerror', (error) => {
        errors.add(label(), 'pageerror', `${error.message}\n${error.stack ?? ''}`);
      });
    };
    context.on('page', attachPage);
    for (const page of context.pages()) attachPage(page);

    const hookWorker = (worker: Worker): void => {
      void worker.evaluate(SW_HOOK, LOG_SINK_URL).catch(() => {
        /* the worker may have been torn down again already */
      });
    };
    context.on('serviceworker', hookWorker);
    for (const worker of context.serviceWorkers()) hookWorker(worker);

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const worker = await waitForServiceWorker(context);
    await use(new URL(worker.url()).host);
  },

  popup: async ({ context, extensionId }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(page);
  },
});

export const expect = test.expect;

/* --------------------------------------------------------------- helpers */

export async function waitForServiceWorker(
  context: BrowserContext,
  timeoutMs = 20_000,
): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: timeoutMs });
}

/**
 * MV3 workers are killed when idle. Any message from an extension page wakes
 * one, so the popup doubles as the wake-up call.
 */
export async function wakeServiceWorker(popup: Page): Promise<Worker> {
  const context = popup.context();
  if (context.serviceWorkers().length === 0) {
    await popup.evaluate(
      () =>
        new Promise<void>((resolve) => {
          chrome.runtime.sendMessage(
            { id: 'e2e-wake', method: 'wallet.status', params: {} },
            () => {
              void chrome.runtime.lastError;
              resolve();
            },
          );
        }),
    );
  }
  return waitForServiceWorker(context);
}

/**
 * Terminate the extension's service worker the way Chrome itself does.
 *
 * `chrome.runtime.reload()` was tried first and is unusable here: it takes the
 * unpacked extension offline for long enough that `chrome-extension://…` loads
 * come back as ERR_BLOCKED_BY_CLIENT. Closing the worker target through CDP is
 * the same event the wallet has to survive, worker gone, keyring gone.
 */
export async function killServiceWorker(context: BrowserContext): Promise<boolean> {
  const browser = context.browser();
  if (!browser) return false;
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  let killed = false;
  for (const target of targetInfos) {
    if (target.type !== 'service_worker') continue;
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    killed = true;
  }
  await cdp.detach().catch(() => undefined);
  return killed;
}

export interface RpcEnvelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; detail?: string };
}

/**
 * Call the §6 protocol straight from the popup context, bypassing the UI.
 * This is how the "can a beginner reach a developer-only method?" checks are
 * done; the UI hiding a button proves nothing.
 */
export async function rpc(
  page: Page,
  method: string,
  params: unknown = {},
): Promise<RpcEnvelope> {
  return page.evaluate(
    ({ method: m, params: p }) =>
      new Promise<RpcEnvelope>((resolve) => {
        chrome.runtime.sendMessage(
          { id: `e2e-${Math.random().toString(36).slice(2)}`, method: m, params: p },
          (response: unknown) => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({ id: 'e2e', ok: false, error: { code: 'PORT_ERROR', detail: err.message } });
              return;
            }
            resolve(response as RpcEnvelope);
          },
        );
      }),
    { method, params },
  );
}

export async function readStorage(
  page: Page,
  area: 'local' | 'sync',
): Promise<Record<string, unknown>> {
  return page.evaluate(
    (a) =>
      new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage[a as 'local' | 'sync'].get(null, (items) => resolve(items));
      }),
    area,
  );
}

export async function getAlarms(
  page: Page,
): Promise<Array<{ name: string; scheduledTime: number }>> {
  return page.evaluate(
    () =>
      new Promise<Array<{ name: string; scheduledTime: number }>>((resolve) => {
        chrome.alarms.getAll((alarms) =>
          resolve(alarms.map((a) => ({ name: a.name, scheduledTime: a.scheduledTime }))),
        );
      }),
  );
}

/** Errors chromium itself logged (backstop for pre-hook worker failures). */
export function chromeLogErrors(userDataDir: string): string[] {
  const file = path.join(userDataDir, 'chrome_debug.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /:ERROR:|Uncaught|Unchecked runtime\.lastError/u.test(line));
}

export async function screenshot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}
