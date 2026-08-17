/**
 * Popup shell (360×600, §7).
 *
 * Routes between screens, owns the persistent header badges required by §4 and
 * holds no secret material of any kind (invariant 1).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { I18nProvider, useT } from '../../src/i18n';
import { api } from '../../src/messaging/client';
import { BRAND_NAME } from '../../src/core/brand';
import { DEFAULT_SETTINGS, effectiveNetworkId } from '../../src/core/settings';
import {
  useAccounts,
  usePendingPrompt,
  useSettings,
  useStatus,
} from '../../src/state/queries';
import { useUiStore, type Screen } from '../../src/state/store';
import { clearUiProgress } from '../../src/state/ui-progress';
import { clearUiPrefs } from '../../src/state/ui-prefs';
import { ErrorState, Spinner } from '../../src/ui/components/primitives';
import { AubergineMark } from '../../src/ui/components/AubergineMark';
import { ErrorBoundary } from '../../src/ui/components/ErrorBoundary';
import { HistoryIcon, HomeIcon, SettingsIcon } from '../../src/ui/components/icons';
import { AddAsset } from '../../src/ui/screens/AddAsset';
import { DappPrompt } from '../../src/ui/screens/DappPrompt';
import { History } from '../../src/ui/screens/History';
import { Home } from '../../src/ui/screens/Home';
import { Onboarding } from '../../src/ui/screens/Onboarding';
import { Receive } from '../../src/ui/screens/Receive';
import { Send } from '../../src/ui/screens/Send';
import { Settings } from '../../src/ui/screens/Settings';
import { Swap } from '../../src/ui/screens/Swap';
import { Unlock } from '../../src/ui/screens/Unlock';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 5_000, retry: 1 },
  },
});

export function App(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  );
}

function Root(): ReactNode {
  const settingsQuery = useSettings();
  const settings = settingsQuery.data ?? DEFAULT_SETTINGS;
  return (
    <I18nProvider locale={settings.locale}>
      {/* Inner boundary: still knows the user's language, so a render throw in
          any screen shows a translated message instead of a blank popup. */}
      <ErrorBoundary locale={settings.locale}>
        <Shell />
      </ErrorBoundary>
    </I18nProvider>
  );
}

/**
 * Redesign v1.1: Send/Receive are primary *actions* on Home (action row), not
 * destinations; the tab bar keeps the three places you can "be".
 */
const NAV: ReadonlyArray<{ screen: Screen; key: string; icon: typeof HomeIcon }> = [
  { screen: 'home', key: 'nav.home', icon: HomeIcon },
  { screen: 'history', key: 'nav.history', icon: HistoryIcon },
  { screen: 'settings', key: 'nav.settings', icon: SettingsIcon },
];

function Shell(): ReactNode {
  const { t } = useT();
  const client = useQueryClient();
  const status = useStatus();
  const settingsQuery = useSettings();
  const settings = settingsQuery.data ?? DEFAULT_SETTINGS;
  const unlocked = status.data?.unlocked === true;
  const accountsQuery = useAccounts(unlocked);
  const promptQuery = usePendingPrompt(unlocked && settings.mode === 'developer');
  const screen = useUiStore((s) => s.screen);
  const navigate = useUiStore((s) => s.navigate);

  /**
   * Finding 1: the 20 s status poll is the popup's heartbeat, it is also what
   * heals a failed `account.list`. Without this the popup sat on a spinner
   * forever after a single failed call, because nothing ever asked again.
   */
  useEffect(() => {
    if (accountsQuery.isError) void accountsQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.dataUpdatedAt]);

  // Land on Home the moment the wallet becomes usable.
  useEffect(() => {
    if (unlocked && (screen === 'loading' || screen === 'unlock' || screen === 'onboarding')) {
      navigate('home');
    }
    if (!unlocked && screen !== 'loading') {
      navigate('loading');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  if (status.isLoading || settingsQuery.isLoading) {
    return <Frame settings={settings}>{<Spinner />}</Frame>;
  }

  /**
   * Finding 2: a *failed* `wallet.status` is not the same as "no wallet".
   * Treating it as one walked an existing user through the whole onboarding
   * only to fail with WALLET_EXISTS at the end. Fail closed: say what happened
   * and offer another attempt (the 20 s poll also keeps trying).
   *
   * Only when there is no answer at all: a failed *refetch* on top of a known
   * status must not tear a working popup down; the last known state is still
   * the truth there.
   */
  if (status.isError && status.data === undefined) {
    return (
      <Frame settings={settings}>
        <ErrorState
          testId="status-error"
          message={t('app.statusFailed')}
          detail={t('app.statusFailedBody')}
          onRetry={() => void status.refetch()}
        />
      </Frame>
    );
  }

  if (status.data?.initialized !== true) {
    return (
      <Frame settings={settings}>
        <Onboarding
          onDone={(target) => {
            // Navigate first: the unlock effect above only redirects to Home
            // while the screen is still loading/unlock/onboarding, so setting
            // e.g. "receive" before the status refetch keeps the choice.
            navigate(target);
            void client.invalidateQueries();
          }}
        />
      </Frame>
    );
  }

  if (!unlocked) {
    return (
      <Frame settings={settings}>
        <Unlock />
      </Frame>
    );
  }

  const accounts = accountsQuery.data;
  if (!accounts) {
    // Finding 1: without this branch a single failed `account.list` left the
    // popup on <Spinner/> with nothing that could ever clear it.
    if (accountsQuery.isError) {
      return (
        <Frame settings={settings}>
          <ErrorState
            testId="accounts-error"
            message={t('app.loadFailed')}
            detail={t('app.loadFailedBody')}
            onRetry={() => void accountsQuery.refetch()}
          />
        </Frame>
      );
    }
    return <Frame settings={settings}>{<Spinner />}</Frame>;
  }

  const prompt = promptQuery.data;
  if (prompt) {
    return (
      <Frame settings={settings}>
        <DappPrompt
          prompt={prompt}
          settings={settings}
          onResolved={() => void promptQuery.refetch()}
        />
      </Frame>
    );
  }

  const body = (() => {
    switch (screen) {
      case 'send':
        return <Send accounts={accounts} settings={settings} onExit={() => navigate('home')} />;
      case 'swap':
        return <Swap accounts={accounts} settings={settings} onExit={() => navigate('home')} />;
      case 'addAsset':
        return (
          <AddAsset accounts={accounts} settings={settings} onExit={() => navigate('home')} />
        );
      case 'receive':
        return (
          <Receive accounts={accounts} settings={settings} onExit={() => navigate('home')} />
        );
      case 'history':
        return <History accounts={accounts} onExit={() => navigate('home')} />;
      case 'settings':
        return (
          <Settings
            settings={settings}
            onExit={() => navigate('home')}
            onReset={() => {
              if (globalThis.confirm(t('unlock.resetConfirm'))) {
                void api
                  .reset()
                  .then(() => clearUiProgress())
                  .then(() => clearUiPrefs())
                  .then(() => client.invalidateQueries());
              }
            }}
          />
        );
      default:
        return (
          <Home
            accounts={accounts}
            settings={settings}
            onLock={() => {
              void api.lock().then(() => client.invalidateQueries());
            }}
          />
        );
    }
  })();

  return (
    <Frame settings={settings} bareMain>
      {/* Keyed on the screen so the entrance animation plays once per
          navigation, never while the user works inside a screen. The wrapper
          spans the full popup height; sw-under-header / sw-above-nav push the
          screen's *content* clear of the two glass bars, so scrolled content
          slides under the frost instead of being clipped at its edge. */}
      <div key={screen} className="sw-screen-in sw-under-header sw-above-nav h-full min-h-0">
        {body}
      </div>
      {/* Floating tab dock: a frosted pill the content scrolls behind. */}
      <nav className="sw-dock absolute inset-x-3 bottom-2.5 z-10 flex gap-1 rounded-2xl border p-1.5">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active =
            screen === item.screen ||
            (item.screen === 'home' && (screen === 'addAsset' || screen === 'swap'));
          return (
            <button
              key={item.screen}
              type="button"
              data-testid={`tab-${item.screen}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(item.screen)}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1 text-[10.5px] font-medium transition-colors duration-[var(--sw-motion-fast)] ${
                active
                  ? 'bg-accent/12 text-accent-fg'
                  : 'text-muted hover:bg-surface/60 hover:text-text'
              }`}
            >
              <Icon size={21} strokeWidth={active ? 2.4 : 2} />
              {t(item.key)}
            </button>
          );
        })}
      </nav>
    </Frame>
  );
}

/**
 * Chrome around every screen: brand mark plus the persistent mode/network
 * badges from §4, as a frosted overlay bar the screens scroll under (v1.2).
 */
function Frame({
  settings,
  children,
  bareMain = false,
}: {
  settings: typeof DEFAULT_SETTINGS;
  children: ReactNode;
  /**
   * The tab layout brings its own under-header/above-dock wrappers, so only
   * direct screens (Unlock, Onboarding, prompts, error states) let the frame
   * pad the content clear of the header.
   */
  bareMain?: boolean;
}): ReactNode {
  const { t } = useT();
  const screen = useUiStore((s) => s.screen);
  const isDeveloper = settings.mode === 'developer';
  const network = effectiveNetworkId(settings);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  /**
   * The header overlays the content, so every screen needs to know how tall it
   * is, and the height is not a constant: the badges wrap to a second row in
   * developer mode. Measured once and on every resize into --sw-header-h,
   * which .sw-under-header turns into content padding.
   */
  useEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    if (!root || !header) return;
    const apply = (): void => {
      root.style.setProperty('--sw-header-h', `${header.offsetHeight}px`);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  /**
   * Scroll events do not bubble, so the frame listens in the capture phase:
   * whichever nested container scrolls, the header learns whether content is
   * currently sliding under it and grows its shadow. Reset per navigation,
   * a fresh screen starts at scrollTop 0 without firing a scroll event.
   */
  useEffect(() => setScrolled(false), [screen]);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof HTMLElement) setScrolled(target.scrollTop > 6);
    };
    main.addEventListener('scroll', onScroll, true);
    return () => main.removeEventListener('scroll', onScroll, true);
  }, []);

  /**
   * v1.2: Mainnet no longer means "no badge". Since beginners can reach it, the
   * riskier state is the one that must be labelled, permanently, in red.
   */
  const onMainnet = network === 'mainnet';
  const showNetworkBadge = !onMainnet;

  return (
    /* `relative isolate` gives the aurora its own stacking context: with
       z-index -1 the blobs paint above this div's background but below every
       in-flow child, so no screen content ever needs a z-index. */
    <div
      ref={rootRef}
      className="relative isolate flex h-[600px] w-[360px] flex-col overflow-hidden bg-bg px-3 pb-2 text-text"
    >
      {/* The website hero's atmosphere at popup scale (style.css .sw-aurora):
          one aubergine and one ice blob, drifting slowly. Purely decorative. */}
      <div aria-hidden className="sw-aurora" />
      {/* Mark + wordmark left, badges right; at 360 px the badges wrap to a
          second row when they must (developer mode), each pill unbroken, and
          the measured height keeps the content clear either way. */}
      <header
        ref={headerRef}
        data-scrolled={scrolled || undefined}
        className="sw-header absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
      >
        <span className="flex items-center gap-2">
          <AubergineMark size={22} />
          <span className="sw-gradient-text text-[13px] font-bold tracking-tight">
            {BRAND_NAME}
          </span>
        </span>
        {showNetworkBadge || onMainnet || isDeveloper ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {showNetworkBadge ? (
              <span className="whitespace-nowrap rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10px] text-warn-fg">
                {t('app.testnetBadge')}
              </span>
            ) : null}
            {onMainnet ? (
              <span className="whitespace-nowrap rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger-fg">
                {t('app.mainnetBadge')}
              </span>
            ) : null}
            {/* §4: once developer mode is on, it stays visible. */}
            {isDeveloper ? (
              <span className="whitespace-nowrap rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-fg">
                {t('app.devBadge')}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>
      <main
        ref={mainRef}
        className={`min-h-0 flex-1 ${bareMain ? '' : 'sw-under-header h-full'}`}
      >
        {children}
      </main>
    </div>
  );
}
