/**
 * Aufklärung, zweiter Durchgang: welche Kombination aus Konto und Paar bringt
 * die Soroswap-API dazu, auf Mainnet tatsächlich zu BAUEN — und was sagt der
 * Wächter dann zu den echten Bytes?
 *
 * Warum Mainnet. `GET /protocols?network=testnet` antwortet `200 []`: die API
 * führt auf Testnet KEIN einziges Protokoll. Der Aggregator ist dort nicht in
 * Betrieb, und die auf Testnet gepinnten Contract-IDs können prinzipiell nicht
 * gegen die Kette geprüft werden. Testnet ist als Prüfumgebung für diese Frage
 * damit erledigt, nicht "gerade leer".
 *
 * Warum eine Matrix. Drei Anläufe sind an drei verschiedenen Vorbedingungen
 * gescheitert: Konto existiert nicht (400), Konto hat keine Trustline für das
 * ZIEL-Asset (428). Daraus die Vermutung, die hier geprüft wird: prüft die API
 * nur die Zielseite, dann geht jedes Paar mit `assetOut = XLM` ohne jede
 * Trustline durch, und ein Issuer-Konto braucht für das eigene Asset ohnehin
 * keine.
 *
 * Read-only, ausnahmslos: es werden Quotes geholt, ein XDR gebaut und LOKAL
 * geprüft. Nichts wird signiert, nichts gesendet, kein Konto verändert.
 *
 * Aufruf (aus src/extension-v13):
 *   npx vite-node scripts/soroswap-probe2.ts
 */
import { readFileSync } from 'node:fs';
import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { MAINNET } from '../src/core/stellar/networks';
import {
  assetIdToContract,
  amountToStroops,
  stroopsToAmount,
  verifySoroswapEnvelope,
  SOROSWAP_API_URL,
} from '../src/core/stellar/soroswap';

const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const EURC = 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';

function apiKey(): string {
  const fromEnv = process.env['WXT_SOROSWAP_API_KEY'] ?? process.env['SOROSWAP_API_KEY'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const file = readFileSync(new URL('../../../secrets.env', import.meta.url), 'utf8');
  const line = file.split('\n').find((l) => l.startsWith('SOROSWAP_API_KEY='));
  if (line === undefined) throw new Error('SOROSWAP_API_KEY nicht in secrets.env gefunden');
  return line.slice('SOROSWAP_API_KEY='.length).trim();
}

const headers = {
  'Authorization': `Bearer ${apiKey()}`,
  'Content-Type': 'application/json',
};

interface Attempt {
  readonly label: string;
  readonly from: string;
  readonly assetIn: string;
  readonly assetOut: string;
}

const OWN = process.env['SOROSWAP_BUILD_ACCOUNT'];
const attempts: Attempt[] = [
  // Ziel ist XLM -> die Zielseite braucht garantiert keine Trustline.
  { label: 'USDC-Issuer verkauft USDC gegen XLM', from: USDC_ISSUER, assetIn: USDC, assetOut: 'native' },
  { label: 'EURC-Issuer verkauft EURC gegen XLM', from: EURC_ISSUER, assetIn: EURC, assetOut: 'native' },
  // Ziel ist das eigene Asset des Issuers -> Trustline für sich selbst entfällt.
  { label: 'USDC-Issuer kauft USDC mit XLM', from: USDC_ISSUER, assetIn: 'native', assetOut: USDC },
  { label: 'EURC-Issuer kauft EURC mit XLM', from: EURC_ISSUER, assetIn: 'native', assetOut: EURC },
  ...(OWN === undefined
    ? []
    : [
        { label: 'eigenes Konto kauft USDC mit XLM', from: OWN, assetIn: 'native', assetOut: USDC },
        { label: 'eigenes Konto verkauft USDC gegen XLM', from: OWN, assetIn: USDC, assetOut: 'native' },
      ]),
];

/** Was der Envelope oben drauf aufruft — unabhängig vom Wächter ausgelesen. */
function describeEntry(envelope: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(envelope, MAINNET.passphrase);
    if ('innerTransaction' in tx) return 'Fee-Bump-Envelope';
    const lines: string[] = [];
    for (const op of tx.operations) {
      if (op.type !== 'invokeHostFunction') {
        lines.push(`Operation ${op.type} (KEIN Soroban-Aufruf)`);
        continue;
      }
      const func = (op as { func: xdr.HostFunction }).func;
      if (func.switch().name !== 'hostFunctionTypeInvokeContract') {
        lines.push(`HostFunction ${func.switch().name}`);
        continue;
      }
      const call = func.invokeContract();
      const contract = call.contractAddress().contractId().toString('hex');
      lines.push(
        `invokeContract ${call.functionName().toString()}(${call.args().length} Argumente) ` +
          `auf 0x${contract.slice(0, 12)}…, ${(op as { auth?: unknown[] }).auth?.length ?? 0} Auth-Eintrag/Einträge`,
      );
    }
    return `${tx.operations.length} Operation(en): ${lines.join(' | ')}`;
  } catch (err) {
    return `nicht dekodierbar: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function run(attempt: Attempt, protocols: string[]): Promise<boolean> {
  const assetIn = assetIdToContract(attempt.assetIn, MAINNET.passphrase);
  const assetOut = assetIdToContract(attempt.assetOut, MAINNET.passphrase);
  const amount = amountToStroops(attempt.assetIn === 'native' ? '10' : '1');
  const tag = `${attempt.label} [${protocols.join(',')}]`;

  const quoteRes = await fetch(`${SOROSWAP_API_URL}/quote?network=mainnet`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      assetIn,
      assetOut,
      amount,
      tradeType: 'EXACT_IN',
      protocols,
      slippageBps: 50,
    }),
  });
  const quoteText = await quoteRes.text();
  if (!quoteRes.ok) {
    console.log(`  ✗ ${tag}\n      /quote  HTTP ${quoteRes.status}  ${quoteText.slice(0, 160)}`);
    return false;
  }
  const raw = JSON.parse(quoteText) as Record<string, unknown>;
  const amountOut = String(raw['amountOut'] ?? '0');
  const threshold = String(raw['otherAmountThreshold'] ?? '0');
  if (BigInt(amountOut) <= 0n) {
    console.log(`  ✗ ${tag}\n      /quote ok, aber keine Route`);
    return false;
  }

  const buildRes = await fetch(`${SOROSWAP_API_URL}/quote/build?network=mainnet`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ quote: raw, from: attempt.from, to: attempt.from }),
  });
  const buildText = await buildRes.text();
  if (!buildRes.ok) {
    console.log(`  ✗ ${tag}\n      /quote/build  HTTP ${buildRes.status}  ${buildText.slice(0, 200)}`);
    return false;
  }
  const envelope = String((JSON.parse(buildText) as Record<string, unknown>)['xdr'] ?? '');

  console.log(`\n  ✓ GEBAUT: ${tag}`);
  console.log(`      Route     ${String(raw['platform'] ?? '?')}, ${stroopsToAmount(amount)} -> ${stroopsToAmount(amountOut)}`);
  console.log(`      Envelope  ${describeEntry(envelope)}`);

  try {
    const tx = verifySoroswapEnvelope(envelope, MAINNET, attempt.from, {
      amountInStroops: amount,
      amountOutStroops: amountOut,
      minOutStroops: threshold,
      sendAssetContract: assetIn,
      destAssetContract: assetOut,
    });
    console.log(`      WÄCHTER   ANGENOMMEN (fee ${stroopsToAmount(tx.fee)} XLM)`);
  } catch (err) {
    console.log(`      WÄCHTER   ABGELEHNT: ${err instanceof Error ? err.message : String(err)}`);
    console.log('      ^^^ Das ist der Befund, auf den es ankommt: der Wächter lehnt einen ECHTEN');
    console.log('          Aggregator-Envelope ab. In dieser Form wäre die Swap-Funktion tot.');
  }
  return true;
}

console.log('=== Welche Protokolle führt die API? ===');
for (const network of ['mainnet', 'testnet']) {
  const res = await fetch(`${SOROSWAP_API_URL}/protocols?network=${network}`, { headers });
  console.log(`  ${network}: HTTP ${res.status}  ${(await res.text()).slice(0, 200)}`);
}

console.log('\n=== Matrix (Mainnet, read-only) ===');
let anyBuilt = false;
for (const protocols of [['soroswap'], ['soroswap', 'phoenix', 'aqua', 'sdex']]) {
  for (const attempt of attempts) {
    if (await run(attempt, protocols)) anyBuilt = true;
  }
}

console.log('\n=== Ergebnis ===');
if (!anyBuilt) {
  console.log('  Keine Kombination baut. Dann bleibt nur ein Mainnet-Konto mit');
  console.log('  USDC-Trustline: export SOROSWAP_BUILD_ACCOUNT=G… und nochmal.');
}
