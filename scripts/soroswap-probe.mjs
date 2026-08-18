#!/usr/bin/env node
/**
 * Aufklärung, kein Test: was bietet die Soroswap-API heute wirklich an?
 *
 * Hintergrund. Der Wächter (`verifySoroswapEnvelope`) hat bis heute nie einen
 * ECHTEN Aggregator-Envelope gesehen. Drei Anläufe, drei verschiedene Wände:
 *
 *   1. Testnet XLM->USDC: "No path found" (keine Liquidität).
 *   2. Mainnet mit Wegwerf-Konto: 400 "Account not found".
 *   3. Mainnet mit EURC-Issuer: 428 "Missing trustline ... for asset: USDC".
 *
 * Punkt 3 ist übrigens KEIN Produktfehler: der Swap-Bildschirm bietet als Ziel
 * nur Assets an, die das Konto bereits hält ("a path payment can only deliver
 * into an existing trustline"). Ein echter Nutzer läuft da nie hinein.
 *
 * Für den Test brauchen wir aber eine Kombination, die durchgeht. Statt weiter
 * zu raten fragt dieses Skript die API, was sie hat. Es schreibt nichts,
 * signiert nichts, sendet nichts — nur GET/POST auf Quote-Endpunkte.
 *
 * Aufruf (aus src/extension-v13):
 *   node scripts/soroswap-probe.mjs
 */
import { readFileSync } from 'node:fs';

const API = 'https://api.soroswap.finance';

function apiKey() {
  const fromEnv = process.env.WXT_SOROSWAP_API_KEY ?? process.env.SOROSWAP_API_KEY;
  if (fromEnv) return fromEnv;
  const file = readFileSync(new URL('../../../secrets.env', import.meta.url), 'utf8');
  const line = file.split('\n').find((l) => l.startsWith('SOROSWAP_API_KEY='));
  if (!line) throw new Error('SOROSWAP_API_KEY nicht in secrets.env gefunden');
  return line.slice('SOROSWAP_API_KEY='.length).trim();
}

const KEY = apiKey();
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

function short(value, max = 600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function get(path) {
  try {
    const res = await fetch(`${API}${path}`, { headers });
    const body = await res.text();
    console.log(`\nGET  ${path}\n  -> HTTP ${res.status}  ${short(body)}`);
    if (!res.ok) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  } catch (err) {
    console.log(`\nGET  ${path}\n  -> Netzfehler: ${err.message}`);
    return null;
  }
}

async function quote(network, assetIn, assetOut, amount, protocols) {
  const body = {
    assetIn,
    assetOut,
    amount,
    tradeType: 'EXACT_IN',
    protocols,
    slippageBps: 50,
  };
  const res = await fetch(`${API}/quote?network=${network}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(
    `\nPOST /quote?network=${network}  [${protocols.join(',')}]\n` +
      `  in  ${assetIn}\n  out ${assetOut}\n  -> HTTP ${res.status}  ${short(text, 400)}`,
  );
  return res.ok ? JSON.parse(text) : null;
}

console.log('=== 1. Welche Endpunkte gibt es überhaupt? ===');
const candidates = [
  '/tokens?network=testnet',
  '/tokens/testnet',
  '/pools?network=testnet',
  '/pools/testnet',
  '/protocols?network=testnet',
  '/liquidity/pools?network=testnet',
];
const found = {};
for (const path of candidates) found[path] = await get(path);

console.log('\n\n=== 2. Testnet-Token, die die API kennt ===');
const tokenList =
  found['/tokens?network=testnet'] ?? found['/tokens/testnet'] ?? null;
const tokens = Array.isArray(tokenList)
  ? tokenList
  : Array.isArray(tokenList?.assets)
    ? tokenList.assets
    : Array.isArray(tokenList?.tokens)
      ? tokenList.tokens
      : [];
if (tokens.length === 0) {
  console.log('  Keine Tokenliste bekommen — siehe die Statuscodes oben.');
} else {
  for (const t of tokens.slice(0, 25)) {
    console.log(`  ${t.code ?? t.symbol ?? '?'}  ${t.contract ?? t.contractId ?? t.address ?? '?'}`);
  }
  console.log(`  (${tokens.length} insgesamt)`);
}

console.log('\n\n=== 3. Welche Testnet-Paare haben wirklich eine Route? ===');
const ids = tokens
  .map((t) => t.contract ?? t.contractId ?? t.address)
  .filter((id) => typeof id === 'string' && id.startsWith('C'));
const probeIds = ids.slice(0, 6);
let hit = null;
for (const a of probeIds) {
  for (const b of probeIds) {
    if (a === b || hit) continue;
    const q = await quote('testnet', a, b, '10000000', ['soroswap']);
    if (q && BigInt(q.amountOut ?? '0') > 0n) {
      hit = { a, b, q };
      console.log(`  ✓ ROUTE GEFUNDEN: ${a} -> ${b}`);
    }
  }
}
if (!hit) console.log('  Kein Paar mit Route unter den geprüften Token.');

console.log('\n\n=== 4. Ergebnis ===');
if (hit) {
  console.log('  Testnet hat eine soroswap-only Route. Damit lässt sich der');
  console.log('  Wächter-Test vollständig auf Testnet fahren, ohne Mainnet-Konto:');
  console.log(`    assetIn : ${hit.a}`);
  console.log(`    assetOut: ${hit.b}`);
  console.log(`    quote   : ${short(hit.q, 300)}`);
} else {
  console.log('  Testnet gibt nichts her. Dann braucht der Wächter-Test ein');
  console.log('  MAINNET-Konto mit USDC-Trustline (read-only, es wird nur');
  console.log('  gebaut und lokal geprüft, nie signiert und nie gesendet):');
  console.log('    export SOROSWAP_BUILD_ACCOUNT=G…');
}
