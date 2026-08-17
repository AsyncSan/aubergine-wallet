/**
 * Echter Soroswap-API-Integrationslauf (Testnet), Teil von `npm run test:testnet`.
 *
 * Prüft gegen die LIVE Aggregator-API genau das, was die Unit-Suite nur gegen
 * Stubs testet: Request-Format, Response-Parsing, Stroop-Konvertierung und die
 * Envelope-Verifikation über einen echten `/quote/build`-Roundtrip.
 *
 * Der API-Key kommt aus `WXT_SOROSWAP_API_KEY` (Umgebung oder ../.env.local).
 * Ohne Key wird die Datei übersprungen; der Lauf bleibt dann DEX-only, exakt
 * wie das Produkt selbst.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { MAINNET, TESTNET } from '../src/core/stellar/networks';
import {
  fetchSoroswapQuote,
  buildSoroswapSwap,
  assetIdToContract,
  amountToStroops,
  stroopsToAmount,
  SOROSWAP_API_URL,
  type SoroswapConfig,
} from '../src/core/stellar/soroswap';

function loadApiKey(): string | null {
  const fromEnv = process.env['WXT_SOROSWAP_API_KEY'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const envFile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'),
      'utf8',
    );
    const line = envFile
      .split('\n')
      .find((l) => l.startsWith('WXT_SOROSWAP_API_KEY='));
    const value = line?.slice('WXT_SOROSWAP_API_KEY='.length).trim();
    return value !== undefined && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const API_KEY = loadApiKey();
const config: SoroswapConfig | null =
  API_KEY === null ? null : { apiUrl: SOROSWAP_API_URL, apiKey: API_KEY };

/** USDC des SDF-Testanchors auf Testnet (auch in der kuratierten Liste). */
const TESTNET_USDC = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
/** Circle-USDC auf Mainnet; das liquideste Paar, ideal als Parsing-Probe. */
const MAINNET_USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe.skipIf(config === null)('Soroswap API (live, testnet)', () => {
  it('authenticates: /quote answers with a real HTTP status, not a rejection', async () => {
    // Der Produkt-Client ist bewusst fail-open (jeder Fehler -> null). Dieser
    // Check unterscheidet deshalb explizit: 401/403 = Key-Problem (Failure),
    // 2xx/404 = API akzeptiert Request und Key.
    if (config === null) return;
    const res = await fetch(`${config.apiUrl}/quote?network=testnet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetIn: assetIdToContract('native', TESTNET.passphrase),
        assetOut: assetIdToContract(TESTNET_USDC, TESTNET.passphrase),
        amount: amountToStroops('10'),
        tradeType: 'EXACT_IN',
        protocols: ['soroswap', 'phoenix', 'aqua', 'sdex'],
        slippageBps: 50,
      }),
    });
    const bodyText = await res.text();
    console.info(`[soroswap] /quote testnet HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  }, 30_000);

  it('parses a REAL quote on mainnet (read-only, nothing is built or signed)', async () => {
    if (config === null) return;
    const quote = await fetchSoroswapQuote(config, MAINNET, 'native', '10', MAINNET_USDC, 50);
    // XLM/USDC ist das liquideste Stellar-Paar, hier MUSS eine Route kommen,
    // sonst passt unser Parser nicht auf die echten Response-Felder.
    expect(quote).not.toBeNull();
    if (quote === null) return;
    expect(Number(quote.destAmount)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeLessThanOrEqual(Number(quote.destAmount));
    console.info(
      `[soroswap] MAINNET 10 XLM -> ${quote.destAmount} USDC (min ${quote.minReceived}, via ${quote.platform ?? '?'}, impact ${quote.priceImpactPct ?? '?'} %)`,
    );
  }, 30_000);

  it('quotes XLM -> USDC or honestly reports no route', async () => {
    if (config === null) return;
    const quote = await fetchSoroswapQuote(config, TESTNET, 'native', '10', TESTNET_USDC, 50);
    // Kein Route-Zwang: Testnet-Liquidität kommt und geht. Aber wenn eine
    // Route existiert, müssen die Zahlen konsistent sein.
    if (quote === null) {
      console.info('[soroswap] no testnet route for XLM->USDC right now (ok)');
      return;
    }
    expect(Number(quote.destAmount)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeLessThanOrEqual(Number(quote.destAmount));
    console.info(
      `[soroswap] 10 XLM -> ${quote.destAmount} USDC (min ${quote.minReceived}, via ${quote.platform ?? '?'})`,
    );
  }, 30_000);

  it('builds a verifiable envelope from a live quote', async () => {
    if (config === null) return;
    const quote = await fetchSoroswapQuote(config, TESTNET, 'native', '10', TESTNET_USDC, 50);
    if (quote === null) {
      console.info('[soroswap] skipped build check, no route');
      return;
    }
    // Wegwerf-Keypair: gebaut wird für diese Adresse, signiert wird nie.
    const from = Keypair.random().publicKey();
    const { tx } = await buildSoroswapSwap(config, TESTNET, quote, from);
    expect(tx.source).toBe(from);
    expect(tx.operations.every((op) => op.type === 'invokeHostFunction')).toBe(true);
    console.info(`[soroswap] build ok: ${tx.operations.length} op(s), fee ${stroopsToAmount(tx.fee)} XLM`);
  }, 30_000);
});
