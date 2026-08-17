/**
 * 1: Bootstrap: does the MV3 service worker start, does the popup open, and is
 * the whole run free of console errors and unhandled rejections?
 *
 * Also proves the premise the other specs rest on: `context.route` really does
 * intercept requests made by the service worker. If it did not, every "the
 * wallet talked to Horizon" assertion elsewhere would be vacuous.
 */
import {
  chromeLogErrors,
  expect,
  rpc,
  screenshot,
  test,
  waitForServiceWorker,
} from '../support/extension';

test('service worker boots and exposes the background script', async ({ context }) => {
  const worker = await waitForServiceWorker(context);
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/u);
});

test('context.route intercepts service-worker requests', async ({
  context,
  horizon,
  popup,
}) => {
  const worker = await waitForServiceWorker(context);
  const probe = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
  horizon.fund(probe, { xlm: '42.0000000' });

  const body = await worker.evaluate(async (accountId) => {
    const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${accountId}`);
    return { status: response.status, text: await response.text() };
  }, probe);

  expect(body.status).toBe(200);
  expect(body.text).toContain('42.0000000');
  expect(horizon.requestsMatching('/accounts/')).not.toHaveLength(0);
  // The popup fixture is requested so the worker stays alive for the assertion.
  expect(popup.url()).toContain('popup.html');
});

test('popup renders the welcome screen with no console errors', async ({ popup, errors }) => {
  await expect(popup.getByRole('heading', { name: 'Willkommen' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Neue Wallet erstellen' })).toBeVisible();
  await expect(popup.getByText('Testnetzwerk (kein echtes Geld)')).toBeVisible();
  // Invariant 3 / §1: the popup is 360x600.
  const frame = popup.locator('div.w-\\[360px\\]').first();
  await expect(frame).toBeVisible();
  await screenshot(popup, '01-onboarding-welcome');
  expect(errors.problems, errors.format()).toHaveLength(0);
});

test('the error collector really catches worker and popup failures', async ({
  context,
  popup,
  errors,
  userDataDir,
}) => {
  // A test suite whose error detection is broken is worse than none, so prove
  // the detector fires before trusting the other specs' clean bills of health.
  const worker = await waitForServiceWorker(context);
  await worker.evaluate(() => {
    console.error('E2E-SELFTEST worker console error');
    void Promise.reject(new Error('E2E-SELFTEST worker rejection'));
  });
  await popup.evaluate(() => {
    console.error('E2E-SELFTEST popup console error');
  });

  await expect
    .poll(() => errors.entries.filter((e) => e.text.includes('E2E-SELFTEST')).length, {
      timeout: 10_000,
    })
    .toBe(3);
  const sources = new Set(
    errors.entries.filter((e) => e.text.includes('E2E-SELFTEST')).map((e) => e.source),
  );
  expect([...sources].sort()).toEqual(['popup', 'service-worker']);

  // Informational: what chromium itself logged, the backstop for anything that
  // fails before the worker hook is installed.
  const logged = chromeLogErrors(userDataDir).filter((line) => line.includes('E2E-SELFTEST'));
  test.info().annotations.push({
    type: 'chrome-log',
    description: `${logged.length} matching lines in chrome_debug.log`,
  });

  // These were deliberate; do not fail the run on them.
  errors.ignore.push(/E2E-SELFTEST/u);
});

test('a fresh install reports itself as uninitialised and locked', async ({ popup }) => {
  const status = await rpc(popup, 'wallet.status', {});
  expect(status.ok).toBe(true);
  expect(status.result).toMatchObject({ initialized: false, unlocked: false, autoLockAt: null });
});
