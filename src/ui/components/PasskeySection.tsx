/**
 * Enrol or remove a passkey, in Settings.
 *
 * The whole flow in one place because it is one decision the user makes twice
 * (on, off) and because every step of it needs the same user gesture chain:
 * the host permission for the RP ID, the WebAuthn ceremony, and the password
 * that proves the person switching this on already holds a key to the wallet.
 * See `src/core/crypto/passkey.ts` for what the ceremony's output is used for.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { api, rpcErrorI18nKey } from '../../messaging/client';
import {
  PasskeyError,
  createPasskey,
  openInTab,
  passkeyNeedsTab,
  passkeySupported,
} from '../passkey';
import { Button, Card, Field, Notice, TextInput } from './primitives';

type Phase = 'loading' | 'unsupported' | 'off' | 'enrolling' | 'on';

export function PasskeySection(): ReactNode {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('loading');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [supported, status] = await Promise.all([passkeySupported(), api.passkeyStatus()]);
    if (status.enrolled) {
      // An enrolled passkey stays visible even where the API has since gone
      // away, otherwise the only control that can remove it disappears too.
      setPhase('on');
      return;
    }
    setPhase(supported ? 'off' : 'unsupported');
  }, []);

  useEffect(() => {
    void refresh().catch(() => setPhase('unsupported'));
  }, [refresh]);

  async function enable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // The salt is reserved by the background and only becomes real if the
      // whole flow succeeds; an abandoned ceremony leaves nothing stored.
      const { prfSalt } = await api.passkeyPrepare();
      const { credentialId, prfOutput } = await createPasskey(prfSalt);
      await api.passkeyEnable({ password, credentialId, prfSalt, prfOutput });
      setPassword('');
      setPhase('on');
    } catch (err) {
      setError(
        err instanceof PasskeyError ? t(`passkey.error.${err.failure}`) : t(rpcErrorI18nKey(err)),
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.passkeyDisable();
      setPhase('off');
    } catch (err) {
      setError(t(rpcErrorI18nKey(err)));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading') return null;

  return (
    <Card className="flex flex-col gap-2">
      <div>
        <h3 className="text-sm font-semibold text-text">{t('passkey.title')}</h3>
        <p className="pt-1 text-xs leading-relaxed text-muted">{t('passkey.body')}</p>
      </div>

      {phase === 'unsupported' ? (
        <Notice tone="info">{t('passkey.unsupported')}</Notice>
      ) : null}

      {phase === 'on' ? (
        <>
          <Notice tone="info">{t('passkey.enabled')}</Notice>
          <Button tone="secondary" disabled={busy} onClick={() => void disable()}>
            {t('passkey.disable')}
          </Button>
        </>
      ) : null}

      {phase === 'off' ? (
        <Button
          tone="secondary"
          disabled={busy}
          onClick={() => {
            if (passkeyNeedsTab()) {
              void openInTab();
              return;
            }
            setPhase('enrolling');
          }}
        >
          {t('passkey.enable')}
        </Button>
      ) : null}

      {phase === 'enrolling' ? (
        <>
          {/*
            The password is asked for here and verified in the background, not
            because the ceremony needs it, but because adding a second key to a
            wallet is something only the holder of the first one may do.
          */}
          <Notice tone="warn">{t('passkey.enableWarn')}</Notice>
          <Field label={t('passkey.passwordLabel')}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              tone="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => {
                setPhase('off');
                setPassword('');
                setError(null);
              }}
            >
              {t('app.cancel')}
            </Button>
            <Button
              className="flex-1"
              disabled={busy || password.length === 0}
              onClick={() => void enable()}
            >
              {t('passkey.enableConfirm')}
            </Button>
          </div>
        </>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Card>
  );
}
