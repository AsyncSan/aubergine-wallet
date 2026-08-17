/**
 * 15: Unlock polish (redesign v1.1, P2) meets the H1 brute-force throttle.
 *
 * What is being proven, in the real popup against the real background guard:
 * the first four wrong passwords surface as a translated error, the fifth,
 * the one that trips the lockout, immediately shows the countdown ring
 * (UNLOCK_THROTTLED on the tripping attempt, no extra futile try needed),
 * the countdown actually ticks, and the form refuses input while locked.
 * Nobody waits out the 30 s here: expiry is unit-tested in
 * tests/hardening.test.ts against a seeded clock.
 */
import { expect, screenshot, test } from '../support/extension';
import { createWallet, unlock } from '../support/flows';

test('five wrong passwords: countdown ring, ticking seconds, disabled form', async ({
  popup,
  errors,
}) => {
  await createWallet(popup);

  await popup.getByRole('button', { name: 'Sperren' }).click();
  await expect(popup.getByRole('heading', { name: 'Wallet entsperren' })).toBeVisible();

  // Four free failures (typos happen): translated error, no ring yet.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await unlock(popup, `definitely-wrong-${attempt}`);
    await expect(popup.getByText('Das Passwort ist falsch.')).toBeVisible();
    await expect(popup.getByTestId('unlock-throttle')).toHaveCount(0);
  }

  // The fifth failure trips the lockout and reports it at once.
  await unlock(popup, 'definitely-wrong-5');
  await expect(popup.getByTestId('unlock-throttle')).toBeVisible();
  await expect(popup.getByText('Zu viele Fehlversuche')).toBeVisible();

  // The ring shows a plausible countdown (first lockout step is 30 s).
  const readSeconds = async (): Promise<number> => {
    const text = await popup.getByTestId('unlock-throttle-seconds').innerText();
    const match = /\d+/u.exec(text);
    if (!match) throw new Error(`no number in the countdown ring: "${text}"`);
    return Number(match[0]);
  };
  const first = await readSeconds();
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(30);

  // The form is out of service while the lockout runs.
  await expect(popup.locator('input[type="password"]')).toBeDisabled();
  await expect(popup.getByRole('button', { name: 'Entsperren' })).toBeDisabled();

  await screenshot(popup, '15-unlock-throttle');

  // The countdown is real: it goes down, not just rendered once.
  await expect
    .poll(readSeconds, { timeout: 5_000 })
    .toBeLessThan(first);

  expect(errors.problems, errors.format()).toHaveLength(0);
});
