/**
 * Last line of defence for the popup.
 *
 * Without a boundary any render throw unmounts the whole tree and leaves a
 * blank 360×600 window with no way back; the user cannot even reach the lock
 * button. This renders a readable sentence plus a reload instead.
 *
 * It deliberately does not report anywhere (invariant 4: no telemetry, no crash
 * reporting). The details go to the local devtools console and nowhere else.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translate } from '../../i18n';
import { LOCALES, type Locale } from '../../core/settings';
import { Button } from './primitives';

/**
 * The boundary may sit *outside* the i18n provider (in `main.tsx` it wraps the
 * provider itself), so it cannot use `useT()`. Where the locale is known it is
 * passed in; otherwise the browser's language is the best available guess.
 */
function detectLocale(): Locale {
  const tag = globalThis.navigator?.language?.slice(0, 2).toLowerCase() ?? '';
  return (LOCALES as readonly string[]).includes(tag) ? (tag as Locale) : 'de';
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Known locale, when the boundary sits inside the settings-aware tree. */
  readonly locale?: Locale;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local console only, never a network call (invariant 4).
    console.error('[popup] render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const locale = this.props.locale ?? detectLocale();
    return (
      <div
        data-testid="error-boundary"
        className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <p className="text-sm font-semibold text-text">{translate(locale, 'app.crashTitle')}</p>
        <p className="text-xs leading-relaxed text-muted">{translate(locale, 'app.crashBody')}</p>
        <Button tone="secondary" onClick={() => globalThis.location.reload()}>
          {translate(locale, 'app.reload')}
        </Button>
      </div>
    );
  }
}
