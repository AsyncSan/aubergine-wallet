// @vitest-environment jsdom
/**
 * The screen the user sees while nobody knows whether their money moved.
 *
 * Rendered for real (same minimal setup as `ui-render.test.ts`: React mounted
 * directly, no test-library dependency) because the property under test is a
 * property of the *rendered output*; that there is no control on it which
 * leads back to a form that would build a second transaction. A unit test of
 * the state machine would not have caught the original bug either: the state
 * machine was fine, the screen offered "Back" and "Send again".
 */
import { readFileSync } from 'node:fs';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SubmitUnknown,
  mayRetry,
  resolutionOf,
  type SubmitResolution,
} from '../src/ui/components/SubmitUnknown';
import de from '../src/i18n/de.json';
import en from '../src/i18n/en.json';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HASH = '9f2b7c1de4a05836bf1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(resolution: SubmitResolution, onRetry?: (() => void) | 'none'): void {
  const handler = onRetry === 'none' ? undefined : (onRetry ?? ((): void => {}));
  act(() =>
    root.render(
      createElement(SubmitUnknown, {
        hash: HASH,
        resolution,
        onClose: () => {},
        ...(handler === undefined ? {} : { onRetry: handler }),
      }),
    ),
  );
}

const buttonLabels = (): string[] =>
  [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

const text = (): string => container.textContent ?? '';

describe('resolutionOf', () => {
  it('reads "not in a ledger yet" as open, never as a licence to retry', () => {
    expect(resolutionOf({ state: 'pending', successful: null, ledger: null, resultCode: null })).toBe(
      'open',
    );
    expect(mayRetry('open')).toBe(false);
  });

  it('keeps a failed lookup open too; no answer is not an answer', () => {
    expect(resolutionOf({ state: 'unknown', successful: null, ledger: null, resultCode: null })).toBe(
      'checking',
    );
    expect(resolutionOf(undefined)).toBe('checking');
    expect(mayRetry('checking')).toBe(false);
  });

  it('only calls it settled when the network said so', () => {
    expect(
      resolutionOf({ state: 'included', successful: true, ledger: 7, resultCode: null }),
    ).toBe('included-success');
    expect(
      resolutionOf({ state: 'included', successful: false, ledger: 7, resultCode: 'tx_failed' }),
    ).toBe('included-failed');
    expect(resolutionOf({ state: 'expired', successful: null, ledger: null, resultCode: null })).toBe(
      'expired',
    );
    expect(mayRetry('expired')).toBe(true);
    expect(mayRetry('included-failed')).toBe(true);
  });

  it('does not read a missing success flag as success', () => {
    expect(
      resolutionOf({ state: 'included', successful: null, ledger: null, resultCode: null }),
    ).toBe('included-failed');
  });
});

describe('the open-outcome screen offers no second transaction', () => {
  for (const resolution of ['checking', 'open'] as const) {
    it(`has exactly one control, "close", while the outcome is ${resolution}`, () => {
      render(resolution);
      // No "try again", no "another payment", and above all no back arrow:
      // `ScreenHeader` only renders one when it is given an `onBack`.
      expect(buttonLabels()).toEqual([(de as Record<string, string>)['app.close']]);
      expect(text()).not.toContain((de as Record<string, string>)['submit.unknown.retry']);
      expect(text()).not.toContain((de as Record<string, string>)['send.again']);
    });
  }

  it('says in one sentence what happened and what not to do', () => {
    render('open');
    const body = (de as Record<string, string>)['submit.unknown.body'] ?? '';
    expect(text()).toContain(body);
    expect(body.toLowerCase()).toContain('unterwegs');
    // The instruction, not just the situation.
    expect(body.toLowerCase()).toContain('kein');
  });

  it('shows the hash, because it is the only handle on the payment', () => {
    render('open');
    expect(container.querySelector('[data-testid="pending-hash"]')?.textContent).toBe(HASH);
  });

  it('offers a retry only once the network proved that nothing was applied', () => {
    render('expired');
    expect(buttonLabels()).toContain((de as Record<string, string>)['submit.unknown.retry']);
    expect(text()).toContain((de as Record<string, string>)['submit.unknown.expired']);

    render('included-failed');
    expect(buttonLabels()).toContain((de as Record<string, string>)['submit.unknown.retry']);
  });

  it('keeps the screen locked when the caller supplies no retry handler at all', () => {
    render('expired', 'none');
    expect(buttonLabels()).toEqual([(de as Record<string, string>)['app.close']]);
  });
});

describe('the wording', () => {
  const keys = [
    'submit.unknown.title',
    'submit.unknown.headline',
    'submit.unknown.body',
    'submit.unknown.checking',
    'submit.unknown.ifYouClose',
    'submit.unknown.expired',
    'submit.unknown.rejected',
    'submit.unknown.retry',
    'error.SUBMIT_OUTCOME_UNKNOWN',
  ] as const;

  it('exists in both catalogues and reads as its own language', () => {
    for (const key of keys) {
      const deText = (de as Record<string, string>)[key] ?? '';
      const enText = (en as Record<string, string>)[key] ?? '';
      expect(deText, key).not.toBe('');
      expect(enText, key).not.toBe('');
      expect(deText, key).not.toBe(enText);
    }
  });

  /**
   * The one thing this text must never do: claim an outcome. Neither "sent"
   * nor "failed" is true here, and both would push the user towards exactly
   * the second payment this whole change exists to prevent.
   */
  it('never claims the transaction arrived or failed', () => {
    const deText = ((de as Record<string, string>)['submit.unknown.body'] ?? '').toLowerCase();
    const enText = ((en as Record<string, string>)['submit.unknown.body'] ?? '').toLowerCase();
    expect(deText).not.toContain('gesendet.');
    expect(deText).not.toContain('fehlgeschlagen');
    expect(enText).not.toContain('failed');
    expect(enText).not.toContain('was sent');
  });
});

/**
 * Structural guard, in the style of `ui-stability.test.ts`: the three screens
 * that submit must route an open outcome to `SubmitUnknown` *before* any other
 * branch, and must not hand `SubmitUnknown` a back handler. A future edit that
 * re-adds a way back into the form fails here in 30 ms instead of costing
 * somebody a second payment.
 */
describe('all three submitting screens route an open outcome the same way', () => {
  const read = (file: string): string => readFileSync(file, 'utf8');

  for (const screen of ['Send', 'Swap', 'AddAsset']) {
    const source = read(`src/ui/screens/${screen}.tsx`);

    it(`${screen} asks the background whether something is still open`, () => {
      expect(source).toContain('usePendingSubmission(');
      expect(source).toContain('useTxStatus(');
      // The record is account-scoped: another account's open submission must
      // not lock this screen, and this one's must.
      expect(source).toContain('accountIndex === index');
    });

    it(`${screen} renders the locked screen and nothing else while open`, () => {
      const at = source.indexOf('outcomeOpen && openSubmission !== null');
      expect(at, `${screen} has no open-outcome branch`).toBeGreaterThan(-1);
      const branch = source.slice(at, at + 400);
      expect(branch).toContain('<SubmitUnknown');
      // No route back into the form: `SubmitUnknown` renders its header
      // without one, and nothing here may pass one either.
      expect(branch).not.toContain('onBack');
      expect(branch).not.toContain("setStage('form')");
    });

    it(`${screen} treats a failed submit call as possibly-still-open`, () => {
      // The service worker can die mid-request and the client's own deadline
      // can fire first, in both cases the envelope may be on its way.
      expect(source).toContain('api.pendingSubmission()');
    });
  }
});
