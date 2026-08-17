/**
 * Unlock (redesign v1.1, P2 "Unlock-Politur").
 *
 * Big friendly identity mark, password, one big button. The H1 brute-force
 * throttle (src/background/unlock-guard.ts) surfaces as a countdown ring
 * instead of a raw error string: while the lockout runs, the input is
 * disabled and the ring drains second by second. The countdown is purely
 * cosmetic; the background guard re-checks every attempt, so a manipulated
 * popup gains nothing (uiProgress rule: UI never gates security, and
 * security never trusts UI).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { api, rpcErrorI18nKey } from '../../messaging/client';
import { AppError, errorI18nKey } from '../../core/errors';
import { clearUiProgress } from '../../state/ui-progress';
import { Button, CountdownRing, Field, Notice, TextInput } from '../components/primitives';
import { Prop3d } from '../components/props3d';

export function Unlock(): ReactNode {
  const { t } = useT();
  const client = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetText, setResetText] = useState('');
  /**
   * Active lockout, driven by UNLOCK_THROTTLED (detail = seconds remaining).
   * `until` is an absolute timestamp so the countdown cannot drift when the
   * popup tab is throttled; `total` fixes the ring's 100% mark.
   */
  const [throttle, setThrottle] = useState<{ until: number; total: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!throttle) return;
    const update = (): void => {
      const secondsLeft = Math.ceil((throttle.until - Date.now()) / 1000);
      if (secondsLeft <= 0) {
        setThrottle(null);
        setError(null);
        // Give focus back the moment typing is useful again.
        setTimeout(() => passwordRef.current?.focus(), 0);
        return;
      }
      setRemaining(secondsLeft);
    };
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [throttle]);

  // The destructive path: only armed when the user has typed the keyword.
  // A native confirm() is one reflexive click; typing the word is a decision.
  const resetKeyword = t('unlock.resetKeyword');
  const resetArmed = resetText.trim().toUpperCase() === resetKeyword.toUpperCase();

  const throttled = throttle !== null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.unlock(password);
      setPassword('');
      await client.invalidateQueries();
    } catch (err) {
      if (err instanceof AppError && err.code === 'UNLOCK_THROTTLED') {
        const seconds = Number(err.detail);
        if (Number.isFinite(seconds) && seconds > 0) {
          setPassword('');
          setThrottle({ until: Date.now() + seconds * 1000, total: seconds });
          setRemaining(seconds);
        } else {
          setError(t(errorI18nKey(err.code), { seconds: err.detail ?? '?' }));
        }
      } else {
        // A call that never came back gets its own text (finding 3).
        setError(t(rpcErrorI18nKey(err)));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex h-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* Identity moment: the brand motif as its 3D render, floating over an
          aubergine glow; the same object as the toolbar icon, one size up. */}
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <Prop3d name="walletHero" size={116} />
        <div>
          <h1 className="sw-gradient-text text-xl font-semibold">{t('unlock.title')}</h1>
          <p className="pt-1 text-sm text-muted">{t('app.tagline')}</p>
        </div>
      </div>

      {throttled ? (
        <div
          data-testid="unlock-throttle"
          className="flex flex-col items-center gap-3 rounded-token-lg border border-warn/40 bg-warn/5 px-4 py-5 text-center"
        >
          <CountdownRing remaining={remaining} total={throttle?.total ?? 1} />
          <div>
            <p className="text-sm font-semibold text-text">{t('unlock.throttled')}</p>
            <p className="pt-1 text-xs leading-relaxed text-muted">{t('unlock.throttledBody')}</p>
          </div>
        </div>
      ) : null}

      <Field label={t('unlock.password')}>
        <TextInput
          ref={passwordRef}
          type="password"
          autoComplete="current-password"
          autoFocus
          disabled={throttled}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Button type="submit" disabled={busy || throttled || password.length === 0}>
        {t('unlock.submit')}
      </Button>

      <div className="mt-auto flex flex-col gap-2 pb-2">
        <button
          type="button"
          className="text-left text-xs text-muted underline"
          onClick={() => {
            setShowReset((v) => !v);
            setResetText('');
          }}
        >
          {t('unlock.forgot')}
        </button>
        {showReset ? (
          <>
            <Notice tone="warn">{t('unlock.forgotBody')}</Notice>
            <Field label={t('unlock.resetTypeLabel', { keyword: resetKeyword })}>
              <TextInput
                value={resetText}
                autoComplete="off"
                onChange={(e) => setResetText(e.target.value)}
              />
            </Field>
            <Button
              tone="danger"
              disabled={!resetArmed}
              onClick={() => {
                if (!resetArmed) return;
                void api
                  .reset()
                  .then(() => clearUiProgress())
                  .then(() => client.invalidateQueries());
              }}
            >
              {t('unlock.reset')}
            </Button>
          </>
        ) : null}
      </div>
    </form>
  );
}
