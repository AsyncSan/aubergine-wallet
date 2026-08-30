/**
 * The Ledger window (ARCHITECTURE.md §3).
 *
 * ## Why this is a window and not a screen in the popup
 *
 * `navigator.hid` exists only in a window context, so the bytes have to pass
 * through a page to reach the device. It cannot be the browser-action popup:
 * that popup closes the moment focus moves — and the WebHID device chooser
 * takes focus, as does the user turning to the physical device for the thirty
 * seconds it takes to read an operation on a five-line screen. A popup that
 * closes takes its HID transport with it, mid-ceremony.
 *
 * ## What this page is allowed to do
 *
 * Carry bytes. That is the whole remit. It never decides whether a signature
 * may happen (`ledger.beginSign` ran every guard in the background before this
 * page saw a request id) and it cannot forge one (`ledger.completeSign`
 * verifies against the key recorded at enrolment). Even the envelope is
 * fetched over RPC rather than taken from the URL, so it does not end up in
 * browser history or the window title.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, useT } from '../../src/i18n';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { ErrorBoundary } from '../../src/ui/components/ErrorBoundary';
import { api, formatRpcError } from '../../src/messaging/client';
import { useSettings } from '../../src/state/queries';
import {
  Button,
  Card,
  Field,
  Notice,
  ScreenHeader,
  Spinner,
  TextInput,
} from '../../src/ui/components/primitives';
import { MAX_LEDGER_DERIVATION_INDEX } from '../../src/messaging/protocol';
import { isWebHidAvailable, openGrantedLedger, requestLedger } from '../../src/core/ledger/webhid';
import { toLedgerAppError, type LedgerDevice } from '../../src/core/ledger/device';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function LedgerApp(): ReactNode {
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
      <ErrorBoundary locale={settings.locale}>
        <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 p-5">
          <Screen />
        </main>
      </ErrorBoundary>
    </I18nProvider>
  );
}

/** `?request=<id>` means "sign this"; without it the page manages accounts. */
function useRequestId(): string | null {
  const [id] = useState(() => new URLSearchParams(window.location.search).get('request'));
  return id;
}

function Screen(): ReactNode {
  const requestId = useRequestId();
  const { t } = useT();

  if (!isWebHidAvailable()) {
    return (
      <>
        <ScreenHeader title={t('ledger.title')} />
        <Notice tone="warn">{t('ledger.unsupportedBrowser')}</Notice>
      </>
    );
  }
  return requestId === null ? <AddAccount /> : <SignRequest requestId={requestId} />;
}

/* ------------------------------------------------------------ the device */

/**
 * Hold one open transport for the page.
 *
 * `connect` must be called from a click: WebHID needs transient activation for
 * the chooser. A device the user already granted is reopened silently on
 * mount, so the common case (second visit) has no button to press.
 */
function useDevice(): {
  device: LedgerDevice | null;
  version: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<LedgerDevice | null>;
} {
  const { t } = useT();
  const [device, setDevice] = useState<LedgerDevice | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback(async (next: LedgerDevice): Promise<LedgerDevice> => {
    const config = await next.getAppConfiguration();
    setVersion(config.version);
    setDevice(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const granted = await openGrantedLedger();
      if (granted === null) return;
      // Under StrictMode this effect runs twice, so the transport opened by
      // the run that lost the race has to be closed rather than left dangling
      // on a device that only allows one open handle.
      if (cancelled) {
        await granted.close();
        return;
      }
      try {
        // `getAppConfiguration` is also the liveness check: a granted device
        // with the Stellar app closed answers nothing useful, and finding that
        // out now is better than at the confirmation step.
        await adopt(granted);
      } catch {
        await granted.close();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const connect = useCallback(async (): Promise<LedgerDevice | null> => {
    setConnecting(true);
    setError(null);
    try {
      return await adopt(await requestLedger());
    } catch (err) {
      setError(formatRpcError(t, toLedgerAppError(err)));
      return null;
    } finally {
      setConnecting(false);
    }
  }, [adopt, t]);

  return { device, version, connecting, error, connect };
}

function ConnectCard({
  connecting,
  onConnect,
}: {
  connecting: boolean;
  onConnect: () => void;
}): ReactNode {
  const { t } = useT();
  return (
    <Card>
      <p className="text-sm text-muted">{t('ledger.prepare')}</p>
      <Button onClick={onConnect} disabled={connecting}>
        {connecting ? t('ledger.connecting') : t('ledger.connect')}
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------ enrolment */

function AddAccount(): ReactNode {
  const { t } = useT();
  const { device, version, connecting, error, connect } = useDevice();
  const [derivationIndex, setDerivationIndex] = useState(0);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function reveal(): Promise<void> {
    const active = device ?? (await connect());
    if (!active) return;
    setBusy(true);
    setFailure(null);
    setPublicKey(null);
    try {
      // `display: true`: the user has to compare the address on the device's
      // own screen. An address this page prints on its own proves nothing —
      // the whole point of the hardware is that its screen is the trusted one.
      setPublicKey(await active.getPublicKey(derivationIndex, true));
    } catch (err) {
      setFailure(formatRpcError(t, toLedgerAppError(err)));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (publicKey === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.ledgerAddAccount({ password, derivationIndex, publicKey, label });
      setSaved(true);
      setPassword('');
    } catch (err) {
      setFailure(formatRpcError(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ScreenHeader title={t('ledger.add.title')} />
      <p className="text-sm text-muted">{t('ledger.add.body')}</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {device === null ? (
        <ConnectCard connecting={connecting} onConnect={() => void connect()} />
      ) : (
        <Card>
          {version ? (
            <p className="text-xs text-muted">{t('ledger.appVersion', { version })}</p>
          ) : null}
          <Field label={t('ledger.add.pathLabel')}>
            <TextInput
              type="number"
              min={0}
              max={MAX_LEDGER_DERIVATION_INDEX}
              value={String(derivationIndex)}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                setDerivationIndex(Number.isFinite(next) && next >= 0 ? next : 0);
                setPublicKey(null);
                setSaved(false);
              }}
            />
          </Field>
          <p className="text-xs text-muted">{`m/44'/148'/${derivationIndex}'`}</p>
          <Button tone="secondary" onClick={() => void reveal()} disabled={busy}>
            {t('ledger.add.show')}
          </Button>
          {busy && publicKey === null ? (
            <p className="text-sm text-muted">{t('ledger.add.confirmOnDevice')}</p>
          ) : null}
        </Card>
      )}

      {publicKey !== null ? (
        <Card>
          <p className="break-all font-mono text-xs">{publicKey}</p>
          <Field label={t('ledger.add.labelField')}>
            <TextInput
              value={label}
              maxLength={64}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field label={t('ledger.add.passwordField')} hint={t('ledger.add.passwordHint')}>
            <TextInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button onClick={() => void save()} disabled={busy || password.length === 0}>
            {t('ledger.add.save')}
          </Button>
        </Card>
      ) : null}

      {saved ? <Notice tone="success">{t('ledger.add.saved')}</Notice> : null}
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
    </>
  );
}

/* ------------------------------------------------------------ signing */

type SignPhase = 'loading' | 'ready' | 'onDevice' | 'submitting' | 'done' | 'failed';

function SignRequest({ requestId }: { requestId: string }): ReactNode {
  const { t } = useT();
  const { device, connecting, error, connect } = useDevice();
  const [phase, setPhase] = useState<SignPhase>('loading');
  const [request, setRequest] = useState<Awaited<
    ReturnType<typeof api.ledgerSignRequest>
  > | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRequest(await api.ledgerSignRequest(requestId));
        setPhase('ready');
      } catch (err) {
        setFailure(formatRpcError(t, err));
        setPhase('failed');
      }
    })();
  }, [requestId, t]);

  async function run(): Promise<void> {
    if (!request) return;
    const active = device ?? (await connect());
    if (!active) return;
    setFailure(null);
    setPhase('onDevice');
    try {
      const signature = await active.signTransaction(
        request.derivationIndex,
        Uint8Array.from(atob(request.signatureBase), (c) => c.charCodeAt(0)),
      );
      let binary = '';
      for (const byte of signature) binary += String.fromCharCode(byte);
      const { signedXdr } = await api.ledgerCompleteSign(requestId, btoa(binary));
      setPhase('submitting');
      /**
       * Submitting from *here*, not from the popup that started this. The
       * popup may well be gone — it closed the moment this window took focus —
       * and the background writes its pending-submission record before the
       * envelope leaves either way, so the outcome bookkeeping is unaffected
       * by which page made the call.
       */
      await api.submitTx(signedXdr);
      setPhase('done');
    } catch (err) {
      setFailure(formatRpcError(t, toLedgerAppError(err)));
      setPhase('failed');
    }
  }

  async function cancel(): Promise<void> {
    try {
      await api.ledgerCancelSign(requestId);
    } finally {
      window.close();
    }
  }

  if (phase === 'loading') return <Spinner />;

  return (
    <>
      <ScreenHeader title={t('ledger.sign.title')} />
      {request ? (
        <Card>
          <p className="text-xs text-muted">{t('ledger.sign.account')}</p>
          <p className="break-all font-mono text-xs">{request.publicKey}</p>
        </Card>
      ) : (
        <Notice tone="warn">{t('ledger.sign.noRequest')}</Notice>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {phase === 'ready' && request ? (
        device === null ? (
          <ConnectCard connecting={connecting} onConnect={() => void connect()} />
        ) : (
          <Button onClick={() => void run()}>{t('ledger.send.route')}</Button>
        )
      ) : null}

      {phase === 'onDevice' ? <Notice tone="info">{t('ledger.sign.waiting')}</Notice> : null}
      {phase === 'submitting' ? <Notice tone="info">{t('ledger.sign.submitting')}</Notice> : null}
      {phase === 'done' ? <Notice tone="success">{t('ledger.sign.done')}</Notice> : null}
      {failure ? <Notice tone="danger">{failure}</Notice> : null}

      {phase === 'failed' && request ? (
        <Button tone="secondary" onClick={() => void run()}>
          {t('ledger.sign.retry')}
        </Button>
      ) : null}

      {phase === 'done' ? (
        <Button onClick={() => window.close()}>{t('app.close')}</Button>
      ) : (
        <Button tone="ghost" onClick={() => void cancel()}>
          {t('app.cancel')}
        </Button>
      )}
    </>
  );
}
