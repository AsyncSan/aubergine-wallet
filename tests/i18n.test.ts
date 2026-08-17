/**
 * ARCHITECTURE.md §8: everything bilingual, no user-visible string hardcoded.
 * These tests are the guard rail against a half-translated release.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import de from '../src/i18n/de.json';
import en from '../src/i18n/en.json';
import { TERM_LIST_SEPARATOR, interpolate, translate } from '../src/i18n';
import { WARNING_CODES } from '../src/core/stellar/tx-describe';
import { ERROR_CODES, TX_RESULT_CODES, errorMessage } from '../src/core/errors';

const deKeys = Object.keys(de).sort();
const enKeys = Object.keys(en).sort();

describe('catalogue parity', () => {
  it('has identical key sets in DE and EN', () => {
    expect(deKeys).toEqual(enKeys);
  });

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries({ ...de, ...en })) {
      expect(value, key).not.toBe('');
    }
  });

  it('uses the same placeholders in both languages', () => {
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/gu)].map((m) => m[1] ?? '').sort();
    for (const key of enKeys) {
      const deValue = (de as Record<string, string>)[key] ?? '';
      const enValue = (en as Record<string, string>)[key] ?? '';
      expect(placeholders(deValue), `placeholders differ for ${key}`).toEqual(
        placeholders(enValue),
      );
    }
  });
});

describe('coverage of generated keys', () => {
  it('translates every warning code from tx-describe', () => {
    for (const code of WARNING_CODES) {
      expect(deKeys, `missing DE text for ${code}`).toContain(`tx.warn.${code}`);
      expect(enKeys, `missing EN text for ${code}`).toContain(`tx.warn.${code}`);
    }
  });

  it('translates every error code', () => {
    for (const code of ERROR_CODES) {
      expect(deKeys).toContain(`error.${code}`);
    }
    expect(deKeys).toContain('error.TX_FAILED');
  });

  /**
   * Guard for the whole point of `error.txcode.*`: the wallet knows a fixed
   * set of Horizon result codes, and every one of them must have a beginner
   * text in *both* catalogues. Without this the next code added to the list
   * silently renders the raw identifier again.
   */
  it('translates every transaction result code the wallet can produce', () => {
    for (const code of TX_RESULT_CODES) {
      expect(deKeys, `missing DE text for ${code}`).toContain(`error.txcode.${code}`);
      expect(enKeys, `missing EN text for ${code}`).toContain(`error.txcode.${code}`);
    }
  });

  it('has an operation line for each operation type the describer emits', () => {
    const opKeys = enKeys.filter((k) => k.startsWith('tx.op.'));
    // A representative selection; the describer's switch is exhaustive.
    for (const key of [
      'tx.op.payment',
      'tx.op.createAccount',
      'tx.op.accountMerge',
      'tx.op.changeTrust.add',
      'tx.op.changeTrust.remove',
      'tx.op.setOptions',
      'tx.op.invokeHostFunction',
      'tx.op.unknown',
    ]) {
      expect(opKeys).toContain(key);
    }
  });
});

describe('transaction result codes (§6)', () => {
  it('resolves a known code to its own key and needs no parameters', () => {
    expect(errorMessage('TX_FAILED:op_no_trust')).toEqual({
      key: 'error.txcode.op_no_trust',
    });
  });

  it('falls back to the collective key and hands the raw code over as a parameter', () => {
    expect(errorMessage('TX_FAILED:op_from_a_future_protocol')).toEqual({
      key: 'error.TX_FAILED',
      params: { code: 'op_from_a_future_protocol' },
    });
    for (const locale of ['de', 'en'] as const) {
      const rendered = translate(locale, 'error.TX_FAILED', {
        code: 'op_from_a_future_protocol',
      });
      expect(rendered).toContain('op_from_a_future_protocol');
      expect(rendered).not.toContain('{code}');
    }
  });

  it('leaves non-TX_FAILED codes exactly where they were', () => {
    expect(errorMessage('WALLET_LOCKED')).toEqual({ key: 'error.WALLET_LOCKED' });
  });

  it('keeps the protocol identifier out of the beginner text', () => {
    for (const code of TX_RESULT_CODES) {
      for (const locale of ['de', 'en'] as const) {
        const text = translate(locale, `error.txcode.${code}`);
        expect(text, `${locale}/${code}`).not.toBe(`error.txcode.${code}`);
        expect(text, `${locale}/${code}`).not.toContain(code);
        expect(text, `${locale}/${code}`).not.toMatch(/\b(?:op|tx)_[a-z_]+/u);
        expect(text, `${locale}/${code}`).not.toContain('{');
      }
    }
  });

  /**
   * The dangerous half of these messages is not the cause, it is whether the
   * user's money moved. Every rejection the network reports means no operation
   * was applied, so the text must say so, except for `tx_unsuccessful`, which
   * this wallet raises when an endpoint claims success and failure at once and
   * where we genuinely do not know.
   */
  it('says plainly that nothing moved, where a beginner would otherwise panic', () => {
    for (const code of ['tx_too_late', 'tx_bad_seq', 'op_no_trust', 'op_line_full']) {
      expect(translate('de', `error.txcode.${code}`).toLowerCase(), code).toContain(
        'nichts gesendet',
      );
      expect(translate('en', `error.txcode.${code}`).toLowerCase(), code).toContain(
        'nothing was sent',
      );
    }
    for (const code of ['op_under_dest_min', 'op_too_few_offers', 'function_trapped']) {
      expect(translate('de', `error.txcode.${code}`).toLowerCase(), code).toContain(
        'nichts getauscht',
      );
      expect(translate('en', `error.txcode.${code}`).toLowerCase(), code).toContain(
        'nothing was swapped',
      );
    }
  });

  /**
   * This used to test `error.txcode.tx_unsuccessful`, a text nothing could
   * produce any more: `200 {successful: false}` stopped raising a `TX_FAILED:*`
   * code when it was reclassified as an open outcome, so the assertion was
   * green and empty, `translate` fell back to the missing key and a key
   * contains neither "nichts gesendet" nor "nothing was sent". The code, the
   * text and this test's old body are gone; the assertion belongs on the screen
   * that *is* reachable in that situation.
   */
  it('does not claim an outcome it cannot know', () => {
    for (const key of ['submit.unknown.body', 'submit.unknown.checking']) {
      expect(translate('de', key).toLowerCase(), key).not.toContain('nichts gesendet');
      expect(translate('en', key).toLowerCase(), key).not.toContain('nothing was sent');
      // The key has to exist, otherwise this would pass on the fallback again.
      expect(translate('de', key), key).not.toBe(key);
      expect(translate('en', key), key).not.toBe(key);
    }
    // And no catalogue may carry a text for a code the wallet cannot raise.
    expect(TX_RESULT_CODES as readonly string[]).not.toContain('tx_unsuccessful');
    expect(translate('en', 'error.txcode.tx_unsuccessful')).toBe(
      'error.txcode.tx_unsuccessful',
    );
  });

  it('reads as its own language, not as a translation of the other', () => {
    for (const code of TX_RESULT_CODES) {
      const key = `error.txcode.${code}`;
      expect(translate('de', key), code).not.toBe(translate('en', key));
    }
  });
});

describe('glossary (§8)', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    // [key, DE beginner term, EN beginner term]
    ['onboarding.phrase.title', 'Wiederherstellungssatz', 'recovery phrase'],
    ['home.reserved', 'reservierter Kontobetrag', 'reserved account balance'],
    ['app.testnetBadge', 'Testnetzwerk (kein echtes Geld)', 'test network (no real money)'],
  ];

  for (const [key, deTerm, enTerm] of cases) {
    it(`uses the agreed wording for ${key}`, () => {
      expect((de as Record<string, string>)[key]).toContain(deTerm);
      expect((en as Record<string, string>)[key]).toContain(enTerm);
    });
  }

  it('avoids raw jargon in beginner-facing trustline wording', () => {
    expect((de as Record<string, string>)['tx.op.changeTrust.add']).toContain(
      'Asset-Freigabe',
    );
    expect((en as Record<string, string>)['tx.op.changeTrust.add']).toContain(
      'Approve the asset',
    );
  });
});

/**
 * Guard for the class of bug where a raw SDK identifier ends up in a sentence
 * ("Datenfeld config set", "…als dem eingestellten (testnet)"): the describer
 * emits `tx.term.*` keys, and a missing key would silently render as the key.
 */
describe('term keys emitted by the describer', () => {
  const source = readFileSync('src/core/stellar/tx-describe.ts', 'utf8');
  const used = [...source.matchAll(/'(tx\.term\.[\w.]+)'/gu)].map((m) => m[1] ?? '');

  it('emits at least one term key', () => {
    expect(used.length).toBeGreaterThan(10);
  });

  it('has a DE and an EN string for every term key it emits', () => {
    for (const key of new Set(used)) {
      expect(deKeys, `missing DE text for ${key}`).toContain(key);
      expect(enKeys, `missing EN text for ${key}`).toContain(key);
    }
  });

  it('emits no raw technical identifier where a term key is expected', () => {
    // The two places that legitimately show an untranslated value are the
    // fail-closed paths, where the operation type is all we know.
    expect(source).not.toContain("action: op.value === undefined");
    expect(source).not.toContain("authorize: String(");
    expect(source).not.toContain("changes.push('signer')");
    expect(source).not.toContain('expected: ctx.networkName ?? ctx.networkPassphrase');
  });
});

describe('translate()', () => {
  it('interpolates parameters', () => {
    expect(interpolate('{a} and {b}', { a: 1, b: 'two' })).toBe('1 and two');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });

  it('returns DE and EN variants of the same key', () => {
    const deText = translate('de', 'tx.op.payment', {
      amount: '5',
      asset: 'XLM',
      destination: 'GABC…',
    });
    const enText = translate('en', 'tx.op.payment', {
      amount: '5',
      asset: 'XLM',
      destination: 'GABC…',
    });
    expect(deText).toContain('senden');
    expect(enText).toContain('Send');
    expect(deText).not.toBe(enText);
  });

  it('translates a parameter that is itself a term key', () => {
    const message = translate('de', 'tx.op.manageData', {
      name: 'config',
      action: 'tx.term.manageData.delete',
    });
    expect(message).toBe('Datenfeld config löschen');
    expect(
      translate('en', 'tx.op.manageData', { name: 'config', action: 'tx.term.manageData.delete' }),
    ).toBe('Delete the data field config');
  });

  it('translates a list of term keys into a readable enumeration', () => {
    const fields = ['tx.term.setOptions.signer', 'tx.term.setOptions.homeDomain'].join(
      TERM_LIST_SEPARATOR,
    );
    expect(translate('de', 'tx.op.setOptions', { fields })).toBe(
      'Kontoeinstellungen ändern (Unterschriftsberechtigte, Webadresse des Kontos)',
    );
  });

  it('leaves an ordinary value alone even if it looks key-ish', () => {
    expect(translate('de', 'tx.op.bumpSequence', { bumpTo: 'some.other.value' })).toBe(
      'Sequenznummer auf some.other.value setzen',
    );
  });

  it('falls back to the key rather than crashing', () => {
    expect(translate('de', 'does.not.exist')).toBe('does.not.exist');
  });
});

/**
 * Cheap static check for hardcoded user-visible strings: JSX text nodes in the
 * UI layer must come from `t(...)`, not from a literal.
 */
describe('no hardcoded user-visible strings in the UI layer', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  /**
   * Asset tickers and network codes (XLM, USDC) are identifiers, not prose:
   * they read the same in every language and are exempt by design.
   */
  const TICKER = /^[A-Z0-9]{2,12}$/u;

  it('contains no literal JSX prose', () => {
    const offenders: string[] = [];
    for (const file of walk('src/ui')) {
      const source = readFileSync(file, 'utf8');
      // Matches >Some words< between JSX tags, ignoring expressions and entities.
      for (const match of source.matchAll(/>\s*([A-Za-zÄÖÜäöüß][^<>{}\n]{2,})\s*</gu)) {
        const text = (match[1] ?? '').trim();
        if (text.length > 2 && !TICKER.test(text)) offenders.push(`${file}: "${text}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
