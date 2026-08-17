import { defineConfig } from 'vitest/config';

/**
 * Config für den READ-ONLY Mainnet-Lauf (integration/mainnet.test.ts).
 *
 * Getrennt von vitest.integration.config.ts, damit "einmal gegen Mainnet
 * schauen" nie versehentlich den Testnet-Lauf mitstartet (der finanziert
 * Konten und sendet Transaktionen) und umgekehrt. Start:
 *
 *     npm run test:mainnet
 *
 * Der Lauf schreibt nichts in die Kette, siehe Kopfkommentar der Suite und
 * den Check `no-write-guard`. Ergebnis: MAINNET-RESULTS.md / .json im Repo-Root.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/mainnet.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Netz-Flakes sollen sichtbar bleiben, nicht weggeglättet werden.
    retry: 0,
  },
});
