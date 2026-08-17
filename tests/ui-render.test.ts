// @vitest-environment jsdom
/**
 * The two pieces of finding 5 and 11 that are only meaningful when actually
 * rendered: the debounce really has to swallow intermediate keystrokes, and
 * the boundary really has to catch a throw instead of blanking the popup.
 *
 * Deliberately tiny: React is mounted directly (no test-library dependency)
 * and only these two units are exercised. Full-screen behaviour stays with the
 * Playwright suite.
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from '../src/state/use-debounced-value';
import { ErrorBoundary } from '../src/ui/components/ErrorBoundary';
import de from '../src/i18n/de.json';
import en from '../src/i18n/en.json';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

describe('useDebouncedValue (finding 5)', () => {
  /** Every value the hook has ever returned, in order. */
  const seen: string[] = [];

  function Probe({ value }: { value: string }): ReactNode {
    seen.push(useDebouncedValue(value, 400));
    return null;
  }

  const last = (): string | undefined => seen[seen.length - 1];
  const render = (value: string): void => {
    act(() => root.render(createElement(Probe, { value })));
  };

  beforeEach(() => {
    seen.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the first value straight through', () => {
    render('1');
    expect(last()).toBe('1');
  });

  it('holds the previous value while the user is still typing', () => {
    render('1');
    render('12');
    expect(last()).toBe('1');
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(last()).toBe('1');
  });

  it('settles on the final value once typing stops', () => {
    render('1');
    render('12');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(last()).toBe('12');
  });

  it('emits one value for a burst of keystrokes, not one per key', () => {
    render('1');
    seen.length = 0;
    for (const value of ['12', '12.', '12.5', '12.55']) {
      render(value);
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // "1" while typing, then exactly one settled value, the intermediate
    // amounts never reach the query key, so they never hit the network.
    expect(new Set(seen)).toEqual(new Set(['1', '12.55']));
    expect(last()).toBe('12.55');
  });
});

describe('ErrorBoundary (finding 11)', () => {
  function Boom(): ReactNode {
    throw new Error('render exploded');
  }

  function Fine(): ReactNode {
    return createElement('p', null, 'ok');
  }

  it('renders its children untouched while nothing throws', () => {
    act(() => root.render(createElement(ErrorBoundary, { locale: 'de', children: createElement(Fine) })));
    expect(container.textContent).toBe('ok');
  });

  it('catches a render throw and shows a readable message plus a way out', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => root.render(createElement(ErrorBoundary, { locale: 'de', children: createElement(Boom) })));
    logged.mockRestore();

    const text = container.textContent ?? '';
    expect(text).toContain((de as Record<string, string>)['app.crashTitle']);
    expect(text).toContain((de as Record<string, string>)['app.crashBody']);
    const button = container.querySelector('button');
    expect(button?.textContent).toBe((de as Record<string, string>)['app.reload']);
    // Not a blank popup; that was the whole bug.
    expect(text.length).toBeGreaterThan(0);
  });

  it('speaks the locale it was given', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => root.render(createElement(ErrorBoundary, { locale: 'en', children: createElement(Boom) })));
    logged.mockRestore();
    expect(container.textContent).toContain((en as Record<string, string>)['app.crashTitle']);
  });
});
