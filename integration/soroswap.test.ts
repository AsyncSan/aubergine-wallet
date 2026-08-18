/**
 * Echter Soroswap-Integrationslauf, Teil von `npm run test:testnet`.
 *
 * Prüft gegen die LIVE-API genau das, was die Unit-Suite nur gegen Stubs
 * testen kann: Request-Format, Response-Parsing, Stroop-Konvertierung und —
 * der eigentliche Zweck — ob `verifySoroswapEnvelope` das annimmt, was der
 * Aggregator HEUTE WIRKLICH zurückgibt.
 *
 * WARUM DIE PRÜFUNG AUF MAINNET LÄUFT, obwohl die Datei im Testnet-Lauf
 * steckt. `GET /protocols?network=testnet` antwortet `200 []`: die API führt
 * auf Testnet kein einziges Protokoll, der Aggregator ist dort nicht in
 * Betrieb. Die auf Testnet gepinnten Contract-IDs können deshalb prinzipiell
 * nicht gegen die Kette geprüft werden — für den Testnet-Pfad ist der e2e-Mock
 * die einzige Deckung, die es je geben wird. Der Zugriff auf Mainnet ist
 * ausnahmslos LESEND: es wird eine Quote geholt, ein XDR gebaut und lokal
 * geprüft. Nichts wird signiert, nichts gesendet, kein Konto verändert.
 *
 * WARUM DAS QUELLKONTO EIN ISSUER IST. `/quote/build` hat drei
 * Vorbedingungen, alle am 18.08.2026 erlaufen: das Konto muss existieren
 * (sonst `400 Account not found`), und es muss das ZIEL-Asset halten können
 * (sonst `428 Missing trustline`). Ein Issuer, der sein eigenes Asset gegen
 * XLM verkauft, erfüllt beides ohne Trustline und ohne dass irgendjemand ein
 * Konto anlegen oder Geld hinterlegen müsste. `SOROSWAP_BUILD_ACCOUNT=G…`
 * setzt bei Bedarf ein eigenes Konto.
 *
 * Der API-Key kommt aus `WXT_SOROSWAP_API_KEY` (Umgebung oder ../.env.local).
 * Ohne Key wird die Datei übersprungen; der Lauf bleibt dann DEX-only, exakt
 * wie das Produkt selbst.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAINNET, TESTNET } from '../src/core/stellar/networks';
import {
  fetchSoroswapQuote,
  verifySoroswapEnvelope,
  assetIdToContract,
  amountToStroops,
  slippageFloor,
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
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const BUILD_ACCOUNT = process.env['SOROSWAP_BUILD_ACCOUNT'] ?? MAINNET_USDC_ISSUER;
const SLIPPAGE_BPS = 50;

/**
 * Die API drosselt hart: `429 Rate limit exceeded, retryAfter: 1` nach wenigen
 * Aufrufen in Folge. Ohne Pause fällt die Hälfte der Datei aus einem Grund
 * durch, der mit dem Prüfgegenstand nichts zu tun hat.
 */
async function pace(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function api(path: string, body?: unknown): Promise<Response> {
  await pace();
  const headers = {
    'Authorization': `Bearer ${config?.apiKey ?? ''}`,
    'Content-Type': 'application/json',
  };
  return body === undefined
    ? fetch(`${SOROSWAP_API_URL}${path}`, { headers })
    : fetch(`${SOROSWAP_API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe.skipIf(config === null)('Soroswap API (live)', () => {
  it('authenticates: /quote answers with a real HTTP status, not a rejection', async () => {
    if (config === null) return;
    // Der Produkt-Client ist bewusst fail-open (jeder Fehler -> null). Dieser
    // Check unterscheidet deshalb explizit: 401/403 = Key-Problem (Failure),
    // alles andere = API akzeptiert Request und Key.
    const res = await api('/quote?network=mainnet', {
      assetIn: assetIdToContract('native', MAINNET.passphrase),
      assetOut: assetIdToContract(MAINNET_USDC, MAINNET.passphrase),
      amount: amountToStroops('10'),
      tradeType: 'EXACT_IN',
      protocols: ['soroswap', 'phoenix', 'aqua', 'sdex'],
      slippageBps: SLIPPAGE_BPS,
    });
    const bodyText = await res.text();
    console.info(`[soroswap] /quote mainnet HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    // Beobachtet: 201 Created. Festgehalten, damit ein künftiger Wechsel auf
    // einen Fehlercode auffällt, ohne den genauen Erfolgscode festzunageln.
    expect(res.ok, `unerwarteter Status ${res.status}`).toBe(true);
  }, 60_000);

  /**
   * Kein Test der API, sondern ein Wächter über unsere eigene Annahme: solange
   * hier `[]` steht, ist die Testnet-Aggregator-Route nicht prüfbar und die auf
   * Testnet gepinnten IDs bleiben unbelegt. Kommt hier eines Tages etwas
   * zurück, wird dieser Test rot — und das ist die Aufforderung, den
   * Wächter-Check unten zusätzlich auf Testnet zu fahren.
   */
  it('dokumentiert, dass Soroswap auf Testnet kein Protokoll führt', async () => {
    if (config === null) return;
    const res = await api('/protocols?network=testnet');
    expect(res.ok, `/protocols antwortet ${res.status}`).toBe(true);
    const protocols = (await res.json()) as unknown[];
    console.info(`[soroswap] testnet protocols: ${JSON.stringify(protocols)}`);
    expect(
      protocols,
      'Soroswap ist auf Testnet aufgetaucht — den Wächter-Check jetzt AUCH dort fahren',
    ).toEqual([]);
  }, 60_000);

  it('parses a REAL quote on mainnet (read-only, nothing is built or signed)', async () => {
    if (config === null) return;
    await pace();
    const quote = await fetchSoroswapQuote(
      config,
      MAINNET,
      'native',
      '10',
      MAINNET_USDC,
      SLIPPAGE_BPS,
    );
    // XLM/USDC ist das liquideste Stellar-Paar, hier MUSS eine Route kommen,
    // sonst passt unser Parser nicht auf die echten Response-Felder.
    expect(quote).not.toBeNull();
    if (quote === null) return;
    expect(Number(quote.destAmount)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeLessThanOrEqual(Number(quote.destAmount));
    // Der versprochene Boden ist der aus der Slippage, nicht der Wert, den die
    // API in `otherAmountThreshold` schreibt — siehe tests/soroswap-quote-floor.
    expect(quote.minOutStroops).toBe(slippageFloor(quote.amountOutStroops, SLIPPAGE_BPS));
    console.info(
      `[soroswap] MAINNET 10 XLM -> ${quote.destAmount} USDC (min ${quote.minReceived}, via ${quote.platform ?? '?'}, impact ${quote.priceImpactPct ?? '?'} %)`,
    );
  }, 60_000);

  /**
   * DER KANARIENVOGEL. Die einzige Prüfung, die kein Mock ersetzen kann:
   * stimmen die gepinnten IDs, die gepinnten Signaturen und der Maßstab für
   * `amount_out_min` mit dem überein, was der Aggregator heute zurückgibt?
   *
   * Am 18.08.2026 lautete die Antwort NEIN — der Wächter lehnte jeden echten
   * Envelope ab, weil er `otherAmountThreshold` als garantierten Boden nahm.
   * Die Aggregator-Route war auf Mainnet vollständig tot. Dieser Test ist die
   * Wache, die das ein zweites Mal sofort meldet.
   *
   * Scheitert er, ist das KEIN Testproblem: dann kann das Wallet einen echten
   * Swap nicht mehr ausführen.
   */
  it('verifies a REAL aggregator envelope end to end (mainnet, read-only)', async () => {
    if (config === null) return;
    const assetIn = assetIdToContract(MAINNET_USDC, MAINNET.passphrase);
    const assetOut = assetIdToContract('native', MAINNET.passphrase);
    const amount = amountToStroops('1');

    const quoteRes = await api('/quote?network=mainnet', {
      assetIn,
      assetOut,
      amount,
      tradeType: 'EXACT_IN',
      protocols: ['soroswap'],
      slippageBps: SLIPPAGE_BPS,
    });
    const quoteText = await quoteRes.text();
    // `ok`, nicht `=== 200`: die API antwortet auf /quote mit **201 Created**.
    // Der Produkt-Client prüft `res.ok`, ein strengerer Test wäre strenger als
    // das, was er absichert — und würde aus einem sachfremden Grund rot.
    expect(quoteRes.ok, `HTTP ${quoteRes.status}: ${quoteText.slice(0, 200)}`).toBe(true);
    const raw = JSON.parse(quoteText) as Record<string, unknown>;
    const amountOut = String(raw['amountOut'] ?? '0');
    expect(BigInt(amountOut) > 0n, `keine Route: ${quoteText.slice(0, 200)}`).toBe(true);

    const buildRes = await api('/quote/build?network=mainnet', {
      quote: raw,
      from: BUILD_ACCOUNT,
      to: BUILD_ACCOUNT,
    });
    const buildText = await buildRes.text();
    expect(
      buildRes.ok,
      `/quote/build für ${BUILD_ACCOUNT} antwortet ${buildRes.status}: ${buildText.slice(0, 300)} — ` +
        'bei "Account not found" oder "Missing trustline" ein passendes Mainnet-Konto setzen: ' +
        'SOROSWAP_BUILD_ACCOUNT=G…',
    ).toBe(true);
    const envelope = String((JSON.parse(buildText) as Record<string, unknown>)['xdr'] ?? '');
    expect(envelope.length).toBeGreaterThan(0);

    // Und jetzt der Punkt der ganzen Übung: die Produktionsfunktion,
    // unverändert, gegen echte Bytes.
    const tx = verifySoroswapEnvelope(envelope, MAINNET, BUILD_ACCOUNT, {
      amountInStroops: amount,
      amountOutStroops: amountOut,
      minOutStroops: slippageFloor(amountOut, SLIPPAGE_BPS),
      sendAssetContract: assetIn,
      destAssetContract: assetOut,
    });
    expect(tx.source).toBe(BUILD_ACCOUNT);
    console.info(
      `[soroswap] WÄCHTER HAT EINEN ECHTEN ENVELOPE ANGENOMMEN: via ${String(raw['platform'] ?? '?')}, ` +
        `${tx.operations.length} op(s), fee ${stroopsToAmount(tx.fee)} XLM, ` +
        `1 USDC -> ${stroopsToAmount(amountOut)} XLM`,
    );
  }, 90_000);

  /** Testnet bleibt beobachtet: taucht dort je Liquidität auf, sagt es das. */
  it('reports testnet liquidity honestly (no route expected today)', async () => {
    if (config === null) return;
    await pace();
    const quote = await fetchSoroswapQuote(
      config,
      TESTNET,
      'native',
      '10',
      TESTNET_USDC,
      SLIPPAGE_BPS,
    );
    if (quote === null) {
      console.info('[soroswap] no testnet route for XLM->USDC (erwartet, siehe /protocols)');
      return;
    }
    expect(Number(quote.destAmount)).toBeGreaterThan(0);
    expect(quote.minOutStroops).toBe(slippageFloor(quote.amountOutStroops, SLIPPAGE_BPS));
    console.info(`[soroswap] TESTNET hat plötzlich eine Route: ${quote.destAmount} USDC`);
  }, 60_000);
});
