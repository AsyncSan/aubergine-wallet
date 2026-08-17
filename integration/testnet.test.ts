/**
 * Echter Testnet-Integrationslauf (Mainnet-Blocker B der Sicherheitsanalyse).
 *
 * Läuft NICHT in der normalen Unit-Suite (eigene Config, braucht Internet):
 *
 *     cd extension && npm ci && npm run test:testnet
 *
 * System under test sind die ECHTEN Core-Module der Extension
 * (`src/core/stellar/*`), nicht eine Parallel-Implementierung. Der Lauf
 * erzeugt Wegwerf-Schlüsselpaare, lässt sie vom Friendbot finanzieren und
 * prüft gegen das live Stellar-Testnetz genau die Pfade, die bisher nur
 * gegen gemocktes Horizon getestet waren: Snapshot-Mapping, Sequenznummern,
 * echte Fehlercodes (tx_bad_seq, op_underfunded), SEP-29 memo_required
 * gegen echte data_attr-Kodierung, Trustlines, kuratierte Issuer live,
 * Soroban-Simulation (prepareSorobanTransaction).
 *
 * Nur SDK-Setup (Signieren der Wegwerf-Keys, manageData für SEP-29, der
 * Soroban-Test-Envelope) benutzt @stellar/stellar-sdk direkt, Signieren im
 * Produkt macht der Keyring, der ist unit-getestet und hier nicht das Thema.
 *
 * Jeder Check landet im Reporter; am Ende entstehen TESTNET-RESULTS.md und
 * TESTNET-RESULTS.json im Repo-Root (Doku: TESTNET-INTEGRATION.md).
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { AppError } from '../src/core/errors';
import { CURATED_TESTNET_ASSETS, TESTNET } from '../src/core/stellar/networks';
import {
  fetchAccount,
  fetchHistory,
  fundWithFriendbot,
  memoRequiredFromData,
  submitTransactionXdr,
} from '../src/core/stellar/horizon';
import {
  buildChangeTrustTransaction,
  buildPaymentTransaction,
} from '../src/core/stellar/tx-builder';
import { describeTransaction } from '../src/core/stellar/tx-describe';
import {
  hasSorobanFootprint,
  isSorobanTransaction,
  prepareSorobanTransaction,
  sorobanHealth,
} from '../src/core/stellar/soroban';
import { Reporter } from './report';

const reporter = new Reporter();

/** Shared state across the sequential checks. */
const state = {
  horizonOk: false,
  sorobanOk: false,
  alice: Keypair.random(),
  bob: Keypair.random(),
  /** Sequence of alice BEFORE the first payment, reused for tx_bad_seq. */
  staleSequence: null as string | null,
  submitLatenciesMs: [] as number[],
};

/** Sign a builder-produced XDR with a throwaway key (setup, not SUT). */
function sign(xdr: string, key: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, TESTNET.passphrase);
  if ('innerTransaction' in tx) throw new Error('unexpected fee-bump envelope');
  tx.sign(key);
  return tx.toXDR();
}

async function timedSubmit(signedXdr: string): Promise<Awaited<ReturnType<typeof submitTransactionXdr>>> {
  const t0 = performance.now();
  const res = await submitTransactionXdr(TESTNET, signedXdr);
  state.submitLatenciesMs.push(performance.now() - t0);
  return res;
}

/**
 * Registers a vitest test that reports into the Reporter.
 *
 * - Preflight-Checks setzen state.horizonOk / state.sorobanOk.
 * - Alle anderen Checks werden übersprungen (SKIP), wenn ihre Voraussetzung
 *   fehlt; der Report dokumentiert dann explizit, dass sie NICHT gelaufen
 *   sind, statt still zu fehlen.
 */
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

describe.sequential('Testnet-Integration (echtes Horizon / Soroban-RPC / Friendbot)', () => {
  afterAll(() => {
    reporter.write();
  });

  /* ------------------------------------------------------------ preflight */

  check(
    'preflight-horizon',
    'Testnet-Horizon ist erreichbar',
    async () => {
      let res: Response;
      try {
        res = await fetch(TESTNET.horizonUrl, { signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        throw new Error(
          `${TESTNET.horizonUrl} nicht erreichbar (${err instanceof Error ? err.message : String(err)}), Internetzugang nötig; dieser Lauf muss auf einem Rechner MIT Netz laufen`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `${TESTNET.horizonUrl} antwortet HTTP ${res.status}, Proxy/Firewall? Dieser Lauf braucht direkten Internetzugang`,
        );
      }
      const body = (await res.json()) as { horizon_version?: string; core_version?: string };
      state.horizonOk = true;
      return `horizon ${body.horizon_version ?? '?'} / core ${body.core_version ?? '?'}`;
    },
    'none',
  );

  check(
    'preflight-soroban',
    'Soroban-RPC meldet sich healthy (extension: sorobanHealth)',
    async () => {
      state.sorobanOk = await sorobanHealth(TESTNET);
      expect(state.sorobanOk).toBe(true);
      return `getHealth → healthy (${TESTNET.sorobanRpcUrl})`;
    },
    'horizon',
  );

  /* -------------------------------------------------- funding & snapshots */

  check('friendbot-funding', 'Friendbot finanziert frisches Konto; Snapshot-Mapping stimmt', async () => {
    await fundWithFriendbot(TESTNET, state.alice.publicKey());
    const snap = await fetchAccount(TESTNET, state.alice.publicKey());
    expect(snap.exists).toBe(true);
    const native = snap.balances.find((b) => b.isNative);
    expect(Number(native?.balance)).toBeGreaterThan(9000);
    // Reserven-Arithmetik gegen echte Horizon-Felder (2 Basiseinträge).
    expect(snap.reserves.totalReservedXlm).toBe('1.0000000');
    expect(Number(snap.reserves.spendableXlm)).toBeGreaterThan(9000);
    expect(snap.memoRequired).toBe(false);
    return `alice ${state.alice.publicKey().slice(0, 6)}… mit ${native?.balance} XLM, spendable ${snap.reserves.spendableXlm}`;
  });

  check('unfunded-account-404', 'Unbekanntes Konto → sauberer exists:false-Snapshot (echter 404-Pfad)', async () => {
    const ghost = Keypair.random().publicKey();
    const snap = await fetchAccount(TESTNET, ghost);
    expect(snap.exists).toBe(false);
    expect(snap.sequence).toBe('0');
    return 'Horizon-404 wird als leerer Snapshot gemappt, kein Throw';
  });

  /* --------------------------------------------------------- payment flow */

  check('payment-roundtrip', 'Zahlung mit echter Sequenznummer: build → sign → submit → History', async () => {
    await fundWithFriendbot(TESTNET, state.bob.publicKey());
    const before = await fetchAccount(TESTNET, state.alice.publicKey());
    state.staleSequence = before.sequence;
    const xdr = buildPaymentTransaction(TESTNET, state.alice.publicKey(), before.sequence, {
      destination: state.bob.publicKey(),
      assetId: 'native',
      amount: '100',
      destinationExists: true,
    });
    const res = await timedSubmit(sign(xdr, state.alice));
    expect(res.successful).toBe(true);
    expect(res.ledger).not.toBeNull();
    const bobAfter = await fetchAccount(TESTNET, state.bob.publicKey());
    const bobNative = Number(bobAfter.balances.find((b) => b.isNative)?.balance ?? '0');
    expect(bobNative).toBeGreaterThanOrEqual(10_100 - 1);
    const history = await fetchHistory(TESTNET, state.alice.publicKey(), 10);
    expect(history.length).toBeGreaterThan(0);
    return `tx ${res.hash.slice(0, 8)}… in Ledger ${res.ledger}; echte History geparst (${history.length} Einträge)`;
  });

  check('memo-28-bytes-live', 'Zahlung mit exakt 28-Byte-Multibyte-Memo (P2-Fix) geht durch', async () => {
    const snap = await fetchAccount(TESTNET, state.alice.publicKey());
    const memo = 'ä'.repeat(14); // 14 Zeichen, exakt 28 UTF-8-Bytes
    const xdr = buildPaymentTransaction(TESTNET, state.alice.publicKey(), snap.sequence, {
      destination: state.bob.publicKey(),
      assetId: 'native',
      amount: '1',
      memo,
      destinationExists: true,
    });
    const res = await timedSubmit(sign(xdr, state.alice));
    expect(res.successful).toBe(true);
    return `28-Byte-Memo („ä“×14) vom echten Netz akzeptiert, tx ${res.hash.slice(0, 8)}…`;
  });

  /* ------------------------------------------------- echte Fehlercodes */

  check('tx-bad-seq', 'Verbrauchte Sequenznummer → TX_FAILED:tx_bad_seq (echtes Error-Mapping)', async () => {
    expect(state.staleSequence).not.toBeNull();
    const xdr = buildPaymentTransaction(
      TESTNET,
      state.alice.publicKey(),
      state.staleSequence ?? '0',
      { destination: state.bob.publicKey(), assetId: 'native', amount: '1', destinationExists: true },
    );
    try {
      await submitTransactionXdr(TESTNET, sign(xdr, state.alice));
      expect.unreachable('stale sequence must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('TX_FAILED:tx_bad_seq');
    }
    return 'Horizon 400 → extras.result_codes.transaction korrekt zu TX_FAILED:tx_bad_seq gemappt';
  });

  check('op-underfunded', 'Zahlung über Kontostand → TX_FAILED:op_underfunded', async () => {
    const snap = await fetchAccount(TESTNET, state.alice.publicKey());
    const xdr = buildPaymentTransaction(TESTNET, state.alice.publicKey(), snap.sequence, {
      destination: state.bob.publicKey(),
      assetId: 'native',
      amount: '1000000',
      destinationExists: true,
    });
    try {
      await submitTransactionXdr(TESTNET, sign(xdr, state.alice));
      expect.unreachable('overspend must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('TX_FAILED:op_underfunded');
    }
    return 'Operations-Result-Code hat Vorrang vor Transaction-Code (op_underfunded)';
  });

  /* ------------------------------------------------------- SEP-29 (H2) */

  check('sep29-flag-roundtrip', 'config.memo_required setzen → Snapshot.memoRequired true (echte data_attr-Kodierung)', async () => {
    // Setup mit dem SDK: manageData ist bewusst kein Wallet-Feature.
    const bobSnap = await fetchAccount(TESTNET, state.bob.publicKey());
    const tx = new TransactionBuilder(new Account(state.bob.publicKey(), bobSnap.sequence), {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.manageData({ name: 'config.memo_required', value: '1' }))
      .setTimeout(180)
      .build();
    tx.sign(state.bob);
    const res = await timedSubmit(tx.toXDR());
    expect(res.successful).toBe(true);
    // System under test: liest die Extension das echte Horizon-Encoding (base64 "MQ==")?
    const flagged = await fetchAccount(TESTNET, state.bob.publicKey());
    expect(flagged.memoRequired).toBe(true);
    // Direkter Blick auf das Roh-Encoding, damit der Report es festhält:
    const raw = await fetch(
      `${TESTNET.horizonUrl}/accounts/${state.bob.publicKey()}`,
    ).then((r) => r.json() as Promise<{ data: Record<string, string> }>);
    expect(memoRequiredFromData(raw.data)).toBe(true);
    return `Horizon liefert data["config.memo_required"]="${raw.data['config.memo_required']}" → memoRequired=true (H2 real verifiziert)`;
  });

  check('sep29-describe-warning', 'tx.describe warnt (danger) bei memolosem Payment an memo_required-Konto', async () => {
    const snap = await fetchAccount(TESTNET, state.alice.publicKey());
    const memoless = buildPaymentTransaction(TESTNET, state.alice.publicKey(), snap.sequence, {
      destination: state.bob.publicKey(),
      assetId: 'native',
      amount: '1',
      destinationExists: true,
    });
    const description = describeTransaction(memoless, {
      networkPassphrase: TESTNET.passphrase,
      memoRequiredAccounts: [state.bob.publicKey()],
    });
    const warning = description.warnings.find((w) => w.code === 'MEMO_REQUIRED');
    expect(warning?.severity).toBe('danger');
    return 'MEMO_REQUIRED-Warnung (severity danger) mit echtem Flag-Konto erzeugt';
  });

  check('sep29-payment-with-memo', 'Zahlung MIT Memo an memo_required-Konto geht durch', async () => {
    const snap = await fetchAccount(TESTNET, state.alice.publicKey());
    const xdr = buildPaymentTransaction(TESTNET, state.alice.publicKey(), snap.sequence, {
      destination: state.bob.publicKey(),
      assetId: 'native',
      amount: '1',
      memo: 'deposit-42',
      destinationExists: true,
    });
    const res = await timedSubmit(sign(xdr, state.alice));
    expect(res.successful).toBe(true);
    return `Memo-Zahlung akzeptiert, tx ${res.hash.slice(0, 8)}…`;
  });

  /* -------------------------------------------- Assets & Trustlines */

  check('curated-issuers-live', 'Kuratierte Testnet-Issuer existieren live (P0-C, Testnet-Teil)', async () => {
    const findings: string[] = [];
    for (const asset of CURATED_TESTNET_ASSETS) {
      const snap = await fetchAccount(TESTNET, asset.issuer);
      if (!snap.exists) findings.push(`${asset.code}: Issuer ${asset.issuer.slice(0, 6)}… existiert NICHT`);
    }
    expect(findings, findings.join('; ')).toHaveLength(0);
    return CURATED_TESTNET_ASSETS.map((a) => `${a.code} ✓`).join(', ');
  });

  check('trustline-roundtrip', 'ChangeTrust gegen echten Issuer: build → submit → Balance sichtbar', async () => {
    const usdc = CURATED_TESTNET_ASSETS[0];
    expect(usdc).toBeDefined();
    if (!usdc) return 'unreachable';
    const snap = await fetchAccount(TESTNET, state.alice.publicKey());
    const xdr = buildChangeTrustTransaction(TESTNET, state.alice.publicKey(), snap.sequence, {
      assetCode: usdc.code,
      issuer: usdc.issuer,
    });
    const res = await timedSubmit(sign(xdr, state.alice));
    expect(res.successful).toBe(true);
    const after = await fetchAccount(TESTNET, state.alice.publicKey());
    const entry = after.balances.find((b) => b.id === `${usdc.code}:${usdc.issuer}`);
    expect(entry).toBeDefined();
    return `Trustline ${usdc.code} etabliert, Balance-Zeile im Snapshot (limit ${entry?.limit ?? '?'})`;
  });

  /* ------------------------------------------------------------- Soroban */

  check(
    'soroban-prepare',
    'prepareSorobanTransaction simuliert echten SAC-Call und annotiert Footprint',
    async () => {
      // Der native Stellar Asset Contract existiert auf jedem Netz, kein
      // eigenes Deployment nötig. balance(alice) ist ein reiner Read-Call.
      const sacId = Asset.native().contractId(TESTNET.passphrase);
      const snap = await fetchAccount(TESTNET, state.alice.publicKey());
      const tx = new TransactionBuilder(new Account(state.alice.publicKey(), snap.sequence), {
        fee: BASE_FEE,
        networkPassphrase: TESTNET.passphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: sacId,
            function: 'balance',
            args: [new Address(state.alice.publicKey()).toScVal()],
          }),
        )
        .setTimeout(180)
        .build();
      expect(isSorobanTransaction(tx)).toBe(true);
      expect(hasSorobanFootprint(tx)).toBe(false);
      // System under test: der echte Simulationspfad der Extension.
      const { preparedXdr, summary } = await prepareSorobanTransaction(TESTNET, tx.toXDR());
      expect(summary.ok).toBe(true);
      expect(summary.minResourceFee).not.toBeNull();
      const prepared = TransactionBuilder.fromXDR(preparedXdr, TESTNET.passphrase);
      expect(hasSorobanFootprint(prepared as Parameters<typeof hasSorobanFootprint>[0])).toBe(true);
      return `SAC ${sacId.slice(0, 8)}… balance() simuliert, minResourceFee=${summary.minResourceFee} stroops, Footprint annotiert`;
    },
    'soroban',
  );

  check(
    'soroban-simulation-error',
    'Fehlgeschlagene Simulation wird gemeldet, nie verschluckt (fail-closed)',
    async () => {
      const sacId = Asset.native().contractId(TESTNET.passphrase);
      const snap = await fetchAccount(TESTNET, state.alice.publicKey());
      const tx = new TransactionBuilder(new Account(state.alice.publicKey(), snap.sequence), {
        fee: BASE_FEE,
        networkPassphrase: TESTNET.passphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: sacId,
            function: 'no_such_function',
            args: [],
          }),
        )
        .setTimeout(180)
        .build();
      const { summary } = await prepareSorobanTransaction(TESTNET, tx.toXDR());
      expect(summary.ok).toBe(false);
      expect(summary.error).toBeTruthy();
      return `Simulationsfehler sauber gemeldet: ${(summary.error ?? '').slice(0, 80)}…`;
    },
    'soroban',
  );

  /* --------------------------------------------------------------- Timing */

  check('ledger-timing', 'Submit-Latenzen dokumentieren (informativ)', async () => {
    expect(state.submitLatenciesMs.length).toBeGreaterThan(0);
    const sorted = [...state.submitLatenciesMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    return `${sorted.length} Submits, Median ${(median / 1000).toFixed(1)} s, Max ${(max / 1000).toFixed(1)} s (Testnet-Ledger ~5–6 s)`;
  });
});
