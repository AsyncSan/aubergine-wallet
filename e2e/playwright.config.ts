import { defineConfig } from '@playwright/test';

/**
 * E2E configuration for the built Chrome MV3 artefact.
 *
 * - Workers = 1: every test launches its own Chromium with a persistent profile
 *   and its own extension instance; running them in parallel makes the
 *   service-worker lifecycle (and the auto-lock timing tests) unreliable.
 * - No `webServer`: the dApp tests spin up their own loopback server, and there
 *   is no outbound network in this environment at all.
 */
export default defineConfig({
  testDir: './specs',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
