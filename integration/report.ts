/**
 * Result collector for the real-Testnet integration run.
 *
 * Every check records PASS / FAIL / SKIP plus detail; at the end the run
 * writes TESTNET-RESULTS.md (human) and TESTNET-RESULTS.json (machine) to the
 * repository root, next to SECURITY-ANALYSE.md. The report is the *documented
 * evidence* of what has actually been exercised against the live network,
 * see TESTNET-INTEGRATION.md for the coverage matrix this feeds into.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly durationMs: number;
}

const STATUS_ICON: Record<CheckStatus, string> = {
  PASS: '✅',
  FAIL: '❌',
  SKIP: '⏭️',
};

/**
 * What distinguishes one run's report from another's. Defaults reproduce the
 * original Testnet report byte-for-byte, so adding the Mainnet run (v1.2) did
 * not change the existing output.
 */
export interface ReportProfile {
  /** File stem: `<basename>.md` / `.json`. */
  readonly basename: string;
  readonly heading: string;
  readonly command: string;
  readonly docs: string;
  /** Closing paragraph when everything passed. */
  readonly interpretationPass: string;
}

const TESTNET_PROFILE: ReportProfile = {
  basename: 'TESTNET-RESULTS',
  heading: 'Testnet-Integrationslauf, Ergebnisse',
  command: 'npm run test:testnet',
  docs: 'TESTNET-INTEGRATION.md',
  interpretationPass:
    'Alle gelaufenen Checks haben das erwartete Verhalten gegen das echte Testnetz gezeigt. Damit ist Mainnet-Blocker B (Sicherheitsanalyse) für die hier abgedeckten Pfade adressiert; die in TESTNET-INTEGRATION.md gelisteten Restpunkte (CORS im Browser, permissions.request, Firefox) bleiben offen.',
};

export class Reporter {
  readonly results: CheckResult[] = [];
  readonly startedAt = new Date();
  readonly profile: ReportProfile;

  constructor(profile: Partial<ReportProfile> = {}) {
    this.profile = { ...TESTNET_PROFILE, ...profile };
  }

  record(
    id: string,
    title: string,
    status: CheckStatus,
    detail: string,
    durationMs: number,
  ): void {
    this.results.push({ id, title, status, detail, durationMs });
    // Live progress on stdout so a watching user sees where the run is.
    console.log(`${STATUS_ICON[status]} [${status}] ${id}, ${detail || title}`);
  }

  count(status: CheckStatus): number {
    return this.results.filter((r) => r.status === status).length;
  }

  /** Repo root = two levels above integration/ (extension/integration/..). */
  static outputDir(): string {
    const repoRoot = path.resolve(__dirname, '..', '..');
    // Sanity check: only write there if it really looks like the repo root.
    if (fs.existsSync(path.join(repoRoot, 'extension'))) return repoRoot;
    return process.cwd();
  }

  write(): { mdPath: string; jsonPath: string } {
    const dir = Reporter.outputDir();
    const finishedAt = new Date();
    const pass = this.count('PASS');
    const fail = this.count('FAIL');
    const skip = this.count('SKIP');
    const verdict =
      fail > 0
        ? '❌ FEHLGESCHLAGEN, Details unten'
        : skip > 0 && pass === 0
          ? '⏭️ NICHT GELAUFEN, Netzwerk nicht erreichbar'
          : skip > 0
            ? '🟡 TEILWEISE, einige Checks übersprungen'
            : '✅ ALLE CHECKS BESTANDEN';

    const md = [
      `# ${this.profile.heading}`,
      '',
      `> Automatisch erzeugt von \`${this.profile.command}\` (extension/integration/).`,
      `> Was dieser Lauf abdeckt und was nicht: siehe ${this.profile.docs}.`,
      '',
      `- **Gestartet:** ${this.startedAt.toISOString()}`,
      `- **Beendet:** ${finishedAt.toISOString()}`,
      `- **Node:** ${process.version} · Plattform: ${process.platform}/${process.arch}`,
      `- **Ergebnis:** ${verdict} (${pass} PASS / ${fail} FAIL / ${skip} SKIP)`,
      '',
      '| Status | Check | Dauer | Details |',
      '|--------|-------|-------|---------|',
      ...this.results.map(
        (r) =>
          `| ${STATUS_ICON[r.status]} ${r.status} | \`${r.id}\`, ${r.title} | ${
            r.durationMs > 0 ? `${(r.durationMs / 1000).toFixed(1)} s` : '—'
          } | ${r.detail.replace(/\|/gu, '\\|').replace(/\n/gu, ' ')} |`,
      ),
      '',
      '## Interpretation',
      '',
      fail > 0
        ? 'Mindestens ein Check ist fehlgeschlagen; die Details-Spalte nennt den echten Horizon-/RPC-Befund. Fehlgeschlagene Checks bitte nicht wegdiskutieren: genau dafür ist der Lauf da.'
        : skip > 0 && pass === 0
          ? 'Kein Check ist gelaufen (Preflight fehlgeschlagen). Dieser Report dokumentiert damit ausdrücklich, dass das echte Netzwerkverhalten weiterhin UNGETESTET ist.'
          : this.profile.interpretationPass,
      '',
      `*Diese Datei nach dem Lauf zurück nach \`/Users/async/StellarWallet/\` legen, damit der Stand dokumentiert bleibt.*`,
      '',
    ].join('\n');

    const mdPath = path.join(dir, `${this.profile.basename}.md`);
    const jsonPath = path.join(dir, `${this.profile.basename}.json`);
    fs.writeFileSync(mdPath, md);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          startedAt: this.startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          node: process.version,
          summary: { pass, fail, skip },
          results: this.results,
        },
        null,
        2,
      ),
    );
    console.log(`\nReport geschrieben: ${mdPath}`);
    return { mdPath, jsonPath };
  }
}
