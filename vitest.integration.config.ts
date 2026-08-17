import { defineConfig } from 'vitest/config';

/**
 * Config für den ECHTEN Testnet-Integrationslauf (integration/).
 *
 * Bewusst getrennt von vitest.config.ts: diese Tests brauchen Internetzugang
 * (Horizon-Testnet, Soroban-RPC, Friendbot) und laufen deshalb nie in der
 * normalen Unit-Suite oder in Umgebungen ohne Netz. Start:
 *
 *     npm run test:testnet
 *
 * Ergebnis-Dokumentation: TESTNET-RESULTS.md / .json im Repo-Root.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Ausdrücklich nur die Testnet-Suiten: integration/mainnet.test.ts hat
    // eine eigene Config (npm run test:mainnet) und darf hier nie mitlaufen.
    include: ['integration/testnet.test.ts', 'integration/soroswap.test.ts'],
    // Ein einziger sequenzieller Lauf: Sequenznummern und Friendbot-Funding
    // vertragen keine Parallelität.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Netzwerk-Flakes nicht wegwiederholen: ein FAIL soll sichtbar bleiben.
    retry: 0,
  },
});
