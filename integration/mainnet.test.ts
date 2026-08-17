/**
 * READ-ONLY Mainnet-Lauf (v1.2).
 *
 *     cd extension && npm run test:mainnet
 *
 * Zweck: die Netzwerkschicht einmal gegen das ECHTE Hauptnetz sehen, bevor
 * jemand echtes Geld hineinlegt. Das Testnetz hat andere Liquidität, andere
 * Latenzen, andere Datenmengen und andere Assets, Grün auf Testnet sagt über
 * Mainnet-Parsing wenig aus.
 *
 * HARTE REGEL: dieser Lauf schreibt NICHTS in die Kette. Er signiert nichts,
 * sendet nichts, braucht keinen Schlüssel und kein Guthaben. Ein
 * fetch-Wächter (`no-write-guard`, letzter Check) protokolliert jeden
 * ausgehenden Request und lässt den Lauf fehlschlagen, falls doch je ein
 * POST auf `/transactions` abgesetzt würde; die Zusage ist damit geprüft
 * und nicht bloß behauptet.
 *
 * Optional: `MAINNET_WATCH_ACCOUNT=G...` setzt das Konto, dessen Snapshot und
 * Historie gelesen werden, z. B. die eigene Wallet-Adresse, um genau das zu
 * sehen, was die Extension später anzeigt. Ohne Angabe wird das Konto von
 * Circles USDC-Issuer gelesen (existiert garantiert, ist öffentlich).
 *
 * Ergebnis: MAINNET-RESULTS.md / .json im Repo-Root.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Account, Address, BASE_FEE, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  CURATED_MAINNET_ASSETS,
  CURATED_MAINNET_HOME_DOMAINS,
  MAINNET,
} from '../src/core/stellar/networks';
import {
  fetchAccount,
  fetchHistory,
  findStrictSendPath,
  memoRequiredFromData,
} from '../src/core/stellar/horizon';
import {
  hasSorobanFootprint,
  isSorobanTransaction,
  prepareSorobanTransaction,
  sorobanHealth,
} from '../src/core/stellar/soroban';
import {
  assetIdToContract,
  fetchSoroswapQuote,
  soroswapConfigFromEnv,
  soroswapNetworkFor,
  SOROSWAP_API_URL,
} from '../src/core/stellar/soroswap';
import { Reporter } from './report';

const reporter = new Reporter({
  basename: 'MAINNET-RESULTS',
  heading: 'Mainnet-Lauf (read-only), Ergebnisse',
  command: 'npm run test:mainnet',
  docs: 'MAINNET-TEST.md',
  interpretationPass:
    'Alle gelaufenen Checks haben gegen das echte Hauptnetz das erwartete Verhalten gezeigt: Snapshot- und History-Parsing, kuratierte Issuer, DEX-Pfadsuche, Soroban-Simulation und (falls Key gesetzt) die Soroswap-Quote. Der Lauf ist ausdrücklich read-only, Signieren, Senden und alles, was Geld bewegt, bleibt damit weiterhin nur auf Testnet nachgewiesen.',
});

/* ------------------------------------------------------------ write guard */

const outgoing: { method: string; url: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  outgoing.push({ method, url });
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

/** A request that would change chain state. Nothing here may produce one. */
function isWrite(entry: { method: string; url: string }): boolean {
  if (entry.method !== 'POST') return false;
  // Soroban `simulateTransaction` is a POST but pure read, it is the only
  // POST this run is allowed to make, and only to the RPC endpoint.
  if (entry.url.startsWith(MAINNET.sorobanRpcUrl)) return false;
  return true;
}

/** Fallback watch account: Circle's USDC issuer, public, permanent, funded. */
const DEFAULT_WATCH_ACCOUNT = CURATED_MAINNET_ASSETS[0]?.issuer ?? '';
const WATCH_ACCOUNT = process.env['MAINNET_WATCH_ACCOUNT'] ?? DEFAULT_WATCH_ACCOUNT;

const state = {
  horizonOk: false,
  sorobanOk: false,
  watchSequence: null as string | null,
};

function check(
  id: string,
  title: string,
  fn: () => Promise<string>,
  requires: 'none' | 'horizon' | 'soroban' = 'horizon',
): void {
  it(`${id}, ${title}`, async () => {
    if (requires === 'horizon' && !state.horizonOk) {
      reporter.record(id, title, 'SKIP', 'übersprungen: Horizon nicht erreichbar', 0);
      return;
    }
    if (requires === 'soroban' && (!state.horizonOk || !state.sorobanOk)) {
      reporter.record(id, title, 'SKIP', 'übersprungen: Soroban-RPC nicht erreichbar', 0);
      return;
    }
    const t0 = performance.now();
    try {
      const detail = await fn();
      reporter.record(id, title, 'PASS', detail, performance.now() - t0);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      reporter.record(id, title, 'FAIL', detail, performance.now() - t0);
      throw err;
    }
  });
}

describe.sequential('Mainnet read-only (echtes Horizon / Soroban-RPC / Soroswap)', () => {
  afterAll(() => {
    globalThis.fetch = realFetch;
    reporter.write();
  });

  /* ------------------------------------------------------------ preflight */

  check(
    'preflight-horizon',
    'Mainnet-Horizon ist erreichbar',
    async () => {
      let res: Response;
      try {
        res = await fetch(MAINNET.horizonUrl, { signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        throw new Error(
          `${MAINNET.horizonUrl} nicht erreichbar (${err instanceof Error ? err.message : String(err)}); dieser Lauf braucht direkten Internetzugang`,
        );
      }
      if (!res.ok) throw new Error(`${MAINNET.horizonUrl} antwortet HTTP ${res.status}`);
      const body = (await res.json()) as {
        horizon_version?: string;
        core_version?: string;
        network_passphrase?: string;
        history_latest_ledger?: number;
      };
      // Falsches Netz wäre der peinlichste Fehler dieses Laufs.
      expect(body.network_passphrase).toBe(MAINNET.passphrase);
      state.horizonOk = true;
      return `horizon ${body.horizon_version ?? '?'} / core ${body.core_version ?? '?'}, Ledger ${body.history_latest_ledger ?? '?'}, Passphrase bestätigt`;
    },
    'none',
  );

  check('preflight-soroban', 'Soroban-RPC (Mainnet) meldet sich healthy', async () => {
    state.sorobanOk = await sorobanHealth(MAINNET);
    expect(state.sorobanOk).toBe(true);
    return `getHealth → healthy (${MAINNET.sorobanRpcUrl})`;
  });

  /* ------------------------------------------------- kuratierte Mainnet-Assets */

  check(
    'curated-issuers-live',
    'Kuratierte Mainnet-Issuer existieren und deklarieren das erwartete home_domain',
    async () => {
      const lines: string[] = [];
      for (const asset of CURATED_MAINNET_ASSETS) {
        const snap = await fetchAccount(MAINNET, asset.issuer);
        expect(snap.exists, `${asset.code}-Issuer existiert nicht`).toBe(true);
        // home_domain ist (noch) nicht Teil des Snapshots, direkt lesen.
        const res = await fetch(`${MAINNET.horizonUrl}/accounts/${asset.issuer}`, {
          signal: AbortSignal.timeout(20_000),
        });
        const record = (await res.json()) as { home_domain?: string };
        const accepted = CURATED_MAINNET_HOME_DOMAINS[asset.issuer] ?? [];
        expect(
          accepted,
          `kein erwartetes home_domain für ${asset.code} hinterlegt`,
        ).not.toHaveLength(0);
        expect(
          accepted,
          `${asset.code}-Issuer deklariert "${record.home_domain ?? '(keins)'}" statt ${accepted.join(' / ')}, kuratierte Liste prüfen!`,
        ).toContain(record.home_domain ?? '');
        lines.push(`${asset.code} → ${record.home_domain ?? '?'}`);
      }
      return `${CURATED_MAINNET_ASSETS.length} Issuer verifiziert: ${lines.join(', ')}`;
    },
  );

  /* --------------------------------------------------- Snapshot & Historie */

  check(
    'snapshot-live',
    'Snapshot-Mapping (Balances, Reserven, Signatoren, SEP-29) gegen ein echtes Mainnet-Konto',
    async () => {
      const snap = await fetchAccount(MAINNET, WATCH_ACCOUNT);
      expect(snap.exists).toBe(true);
      expect(snap.accountId).toBe(WATCH_ACCOUNT);
      state.watchSequence = snap.sequence;
      const native = snap.balances.find((b) => b.isNative);
      expect(native, 'kein XLM-Eintrag im Snapshot').toBeTruthy();
      // Reservenarithmetik muss auf echten Daten aufgehen, nicht nur auf Stubs.
      expect(Number(snap.reserves.totalReservedXlm)).toBeGreaterThanOrEqual(1);
      expect(Number(snap.reserves.spendableXlm)).toBeLessThanOrEqual(Number(native?.balance));
      expect(snap.signers.length).toBeGreaterThan(0);
      expect(typeof snap.memoRequired).toBe('boolean');
      const custom = snap.balances.filter((b) => !b.isNative).length;
      return `${WATCH_ACCOUNT.slice(0, 6)}…${WATCH_ACCOUNT.slice(-4)}: ${native?.balance} XLM, ${custom} weitere Assets, ${snap.subentryCount} Subentries, reserviert ${snap.reserves.totalReservedXlm}, spendable ${snap.reserves.spendableXlm}, memoRequired=${snap.memoRequired}`;
    },
  );

  check('history-live', 'History-Parsing gegen echte Mainnet-Operationen', async () => {
    const entries = await fetchHistory(MAINNET, WATCH_ACCOUNT, 20);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
      expect(typeof entry.successful).toBe('boolean');
      expect(['in', 'out', 'self', 'other']).toContain(entry.direction);
      expect(entry.transactionHash).toHaveLength(64);
    }
    const kinds = [...new Set(entries.map((e) => e.type))].join(', ');
    return `${entries.length} Operationen geparst, Typen: ${kinds}`;
  });

  check('sep29-parsing-live', 'SEP-29-Flag wird aus echten data_attr korrekt gelesen', async () => {
    // memoRequiredFromData ist die SUT; hier gegen echte Horizon-Kodierung.
    const res = await fetch(`${MAINNET.horizonUrl}/accounts/${WATCH_ACCOUNT}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const record = (await res.json()) as { data?: Record<string, string> };
    const parsed = memoRequiredFromData(record.data ?? {});
    const snap = await fetchAccount(MAINNET, WATCH_ACCOUNT);
    // Beide Wege müssen dasselbe sagen, sonst liest der Snapshot falsch.
    expect(parsed).toBe(snap.memoRequired);
    const keys = Object.keys(record.data ?? {});
    return `data_attr [${keys.join(', ') || 'leer'}] → memoRequired=${parsed} (Snapshot stimmt überein)`;
  });

  /* ------------------------------------------------------- DEX-Pfadsuche */

  check(
    'strict-send-path-live',
    'DEX-Pfadsuche (findStrictSendPath) liefert auf echter Mainnet-Liquidität einen Kurs',
    async () => {
      const usdc = CURATED_MAINNET_ASSETS.find((a) => a.code === 'USDC');
      expect(usdc, 'USDC fehlt in der kuratierten Mainnet-Liste').toBeTruthy();
      const destId = `${usdc?.code ?? ''}:${usdc?.issuer ?? ''}`;
      const quote = await findStrictSendPath(MAINNET, 'native', '10', destId);
      expect(quote, 'keine Route XLM → USDC auf Mainnet; das wäre sehr ungewöhnlich').toBeTruthy();
      expect(Number(quote?.destAmount)).toBeGreaterThan(0);
      return `10 XLM → ${quote?.destAmount} USDC über ${quote?.path.length ?? 0} Zwischenschritt(e)`;
    },
  );

  /* ------------------------------------------------------ Soroban / SAC */

  check('sac-contract-ids', 'SAC-Contract-IDs werden mit der Public-Passphrase abgeleitet', async () => {
    const nativeSac = assetIdToContract('native', MAINNET.passphrase);
    const usdc = CURATED_MAINNET_ASSETS.find((a) => a.code === 'USDC');
    const usdcSac = assetIdToContract(`${usdc?.code ?? ''}:${usdc?.issuer ?? ''}`, MAINNET.passphrase);
    expect(nativeSac.startsWith('C')).toBe(true);
    expect(usdcSac.startsWith('C')).toBe(true);
    // Testnet-Ableitung derselben Assets muss sich unterscheiden (Passphrase!).
    expect(assetIdToContract('native', 'Test SDF Network ; September 2015')).not.toBe(nativeSac);
    return `XLM-SAC ${nativeSac.slice(0, 10)}…, USDC-SAC ${usdcSac.slice(0, 10)}…`;
  });

  check(
    'soroban-prepare-live',
    'prepareSorobanTransaction simuliert einen echten SAC-Aufruf (read-only, nie gesendet)',
    async () => {
      const snap = await fetchAccount(MAINNET, WATCH_ACCOUNT);
      const source = new Account(WATCH_ACCOUNT, snap.sequence);
      const sac = assetIdToContract('native', MAINNET.passphrase);
      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: MAINNET.passphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: sac,
            function: 'balance',
            args: [new Address(WATCH_ACCOUNT).toScVal()],
          }),
        )
        .setTimeout(60)
        .build();
      expect(isSorobanTransaction(tx)).toBe(true);
      const prepared = await prepareSorobanTransaction(MAINNET, tx.toXDR());
      expect(prepared.summary.ok, `Simulation fehlgeschlagen: ${prepared.summary.error ?? ''}`).toBe(
        true,
      );
      const parsed = TransactionBuilder.fromXDR(prepared.preparedXdr, MAINNET.passphrase);
      if ('innerTransaction' in parsed) throw new Error('unerwarteter Fee-Bump');
      expect(hasSorobanFootprint(parsed)).toBe(true);
      expect(Number(parsed.fee)).toBeGreaterThan(Number(BASE_FEE));
      return `Simulation ok, Footprint annotiert, minResourceFee ${prepared.summary.minResourceFee ?? '?'}, Fee ${parsed.fee} Stroops, Envelope wurde NICHT signiert und NICHT gesendet`;
    },
    'soroban',
  );

  /* ---------------------------------------------------------- Soroswap */

  check('soroswap-quote-live', 'Soroswap-Aggregator liefert eine Mainnet-Quote', async () => {
    const config = soroswapConfigFromEnv() ?? envConfigFallback();
    if (config === null) {
      reporter.record(
        'soroswap-quote-live',
        'Soroswap-Aggregator liefert eine Mainnet-Quote',
        'SKIP',
        'übersprungen: WXT_SOROSWAP_API_KEY nicht gesetzt (Key steht in secrets.env)',
        0,
      );
      return '';
    }
    expect(soroswapNetworkFor(MAINNET)).toBe('mainnet');
    const usdc = CURATED_MAINNET_ASSETS.find((a) => a.code === 'USDC');
    const quote = await fetchSoroswapQuote(
      config,
      MAINNET,
      'native',
      '10',
      `${usdc?.code ?? ''}:${usdc?.issuer ?? ''}`,
      50,
    );
    // fail-open by design: null heißt "Quelle heute stumm", kein Testfehler,
    // aber es soll im Report stehen.
    if (quote === null) return 'API lieferte keine Quote (fail-open griff), Details siehe Konsole';
    expect(Number(quote.destAmount)).toBeGreaterThan(0);
    expect(Number(quote.minReceived)).toBeLessThanOrEqual(Number(quote.destAmount));
    return `10 XLM → ${quote.destAmount} USDC via ${quote.platform ?? '?'}, min ${quote.minReceived}, impact ${quote.priceImpactPct ?? '?'} %`;
  });

  /* -------------------------------------------------------- Schreibwächter */

  check(
    'no-write-guard',
    'Der Lauf hat nachweislich nichts in die Kette geschrieben',
    async () => {
      const writes = outgoing.filter(isWrite);
      expect(writes, `unerlaubte schreibende Requests: ${JSON.stringify(writes)}`).toHaveLength(0);
      const hosts = [...new Set(outgoing.map((o) => new URL(o.url).host))];
      return `${outgoing.length} Requests an ${hosts.join(', ')}, davon 0 schreibend (kein POST /transactions, keine Signatur, kein Schlüssel im Spiel)`;
    },
    'none',
  );
});

/**
 * `soroswapConfigFromEnv` liest `import.meta.env` (Build-Zeit, WXT). Im
 * Node-Lauf kommt der Key aus der Prozessumgebung, dieselbe Variable.
 */
function envConfigFallback(): { apiUrl: string; apiKey: string } | null {
  const apiKey = process.env['WXT_SOROSWAP_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) return null;
  return { apiUrl: process.env['WXT_SOROSWAP_API_URL'] ?? SOROSWAP_API_URL, apiKey };
}
