/**
 * Onboarding: create or restore a wallet.
 *
 * The "fear moments" (backup, verification) are designed first, per the product
 * one-pager. The recovery phrase is fetched from the background exactly once,
 * password-gated, and is never written to storage by the popup.
 *
 * Redesign v1.1 (P1 "Onboarding-Reise", docs/ui-redesign-konzept.md): the
 * create path is a visible 3-step journey (password → phrase → verify) with a
 * progress bar, the verification is a tap-the-word-chips quiz over three
 * positions instead of a single multiple choice, and completion gets a drawn
 * check plus a one-time confetti burst (the only confetti in the product,
 * konzept §7). Crypto flow and RPC calls are unchanged from v1.0.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { api, rpcErrorI18nKey } from '../../messaging/client';
import {
  mnemonicWordCountValid,
  normalizeMnemonic,
  validateMnemonic,
} from '../../core/crypto/mnemonic';
import {
  MIN_PASSWORD_SCORE,
  estimatePasswordStrength,
} from '../../core/password-strength';
import { useMarkUiProgress } from '../../state/ui-progress';
import {
  AnimatedCheck,
  Button,
  ConfettiBurst,
  Field,
  Notice,
  ScreenHeader,
  StepProgress,
  TextArea,
  TextInput,
} from '../components/primitives';
import { Prop3d } from '../components/props3d';

type Step = 'welcome' | 'password' | 'phrase' | 'verify' | 'done' | 'import';

export type OnboardingTarget = 'home' | 'receive';

/** How many phrase positions the quiz asks for (mockup: three word chips). */
const QUIZ_COUNT = 3;

/**
 * Meter + label under the password field. The estimate comes from
 * `core/password-strength` (the same module that gates the Continue button),
 * so what the meter shows and what the gate enforces can never disagree.
 */
function StrengthMeter({ password }: { password: string }): ReactNode {
  const { t } = useT();
  const { score } = estimatePasswordStrength(password);
  const fill =
    score <= 1 ? 'bg-danger' : score < MIN_PASSWORD_SCORE + 1 ? 'bg-warn' : 'bg-success';
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="flex flex-1 gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <div
            key={segment}
            className={`h-1 flex-1 rounded-full ${segment <= score ? fill : 'bg-border'}`}
          />
        ))}
      </div>
      <span className="text-xs text-muted">{t(`onboarding.password.strength${score}`)}</span>
    </div>
  );
}

/** Three distinct positions (0-based), ascending, out of a 12-word phrase. */
function pickQuizPositions(): number[] {
  const pool = Array.from({ length: 12 }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = pool[i] as number;
    pool[i] = pool[j] as number;
    pool[j] = a;
  }
  return pool.slice(0, QUIZ_COUNT).sort((x, y) => x - y);
}

export function Onboarding({
  onDone,
}: {
  onDone: (target: OnboardingTarget) => void;
}): ReactNode {
  const { t } = useT();
  const client = useQueryClient();
  const markProgress = useMarkUiProgress();
  const [step, setStep] = useState<Step>('welcome');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [importInput, setImportInput] = useState('');
  /** BIP-39 passphrase ("25th word"). Part of the derivation, so it is stored
   * with the phrase and shown again under Settings (finding 7). */
  const [bip39Passphrase, setBip39Passphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const words = useMemo(() => (mnemonic ? mnemonic.split(' ') : []), [mnemonic]);

  // ----- word-chip quiz state (verify step) ------------------------------
  const [quizPositions] = useState(pickQuizPositions);
  /** Index into quizPositions: which slot is being asked for right now. */
  const [quizPos, setQuizPos] = useState(0);
  /** Chip indices (into the shuffled chip list) already used successfully. */
  const [usedChips, setUsedChips] = useState<ReadonlySet<number>>(new Set());
  /** Chip index currently shaking after a wrong tap, if any. */
  const [wrongChip, setWrongChip] = useState<number | null>(null);
  const [verifyError, setVerifyError] = useState(false);

  /** All 12 words, shuffled once; the tappable chips. */
  const chips = useMemo(() => {
    const shuffled = words.map((word, index) => ({ word, index }));
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = shuffled[i] as { word: string; index: number };
      shuffled[i] = shuffled[j] as { word: string; index: number };
      shuffled[j] = a;
    }
    return shuffled;
  }, [words]);

  function handleError(err: unknown): void {
    // Includes the typed timeout, so a wedged background says "took too long"
    // rather than nothing at all (finding 3).
    setError(t(rpcErrorI18nKey(err)));
  }

  async function createWallet(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.create(password, 128);
      const { mnemonic: phrase } = await api.revealRecoveryPhrase(password);
      setMnemonic(phrase);
      setPassword('');
      setStep('phrase');
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function importWallet(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.importMnemonic(
        password,
        normalizeMnemonic(importInput),
        bip39Passphrase.length > 0 ? bip39Passphrase : undefined,
      );
      setBip39Passphrase('');
      setPassword('');
      // Whoever restores from a phrase demonstrably possesses that phrase.
      await markProgress({ backupConfirmed: true });
      await client.invalidateQueries();
      onDone('home');
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  /** A chip was tapped on the verify step. Duplicates count by word, not index. */
  function pickChip(chipIndex: number, word: string): void {
    const needed = words[quizPositions[quizPos] ?? -1];
    if (word === needed) {
      setUsedChips((prev) => new Set(prev).add(chipIndex));
      setVerifyError(false);
      const next = quizPos + 1;
      setQuizPos(next);
      if (next >= QUIZ_COUNT) {
        // Phrase confirmed for real, record it, then celebrate.
        void markProgress({ backupConfirmed: true });
        setMnemonic('');
        setStep('done');
      }
    } else {
      setVerifyError(true);
      setWrongChip(chipIndex);
      setTimeout(() => setWrongChip(null), 420);
    }
  }

  if (step === 'welcome') {
    return (
      <div className="flex h-full flex-col gap-4">
        {/* First thing a new user ever sees: the brand motif as its 3D render,
            then the promise. Same object as the toolbar icon and Unlock. */}
        <div className="flex flex-col items-center pt-1 text-center">
          <Prop3d name="walletHero" size={140} />
          <h1 className="sw-gradient-text pt-1 text-xl font-semibold">
            {t('onboarding.welcome.title')}
          </h1>
          <p className="pt-1 text-sm text-muted">{t('app.tagline')}</p>
        </div>
        <p className="text-sm leading-relaxed text-muted">{t('onboarding.welcome.body')}</p>
        <Notice tone="warn">{t('onboarding.welcome.notAudited')}</Notice>
        <div className="mt-auto flex flex-col gap-2 pb-2">
          <Button onClick={() => setStep('password')}>
            {t('onboarding.welcome.create')}
          </Button>
          <Button
            tone="secondary"
            onClick={() => {
              setStep('import');
            }}
          >
            {t('onboarding.welcome.import')}
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'password' || step === 'import') {
    const isImport = step === 'import';
    const trimmed = normalizeMnemonic(importInput);
    const phraseOk = trimmed.length > 0 && validateMnemonic(trimmed);
    const countOk = trimmed.length === 0 || mnemonicWordCountValid(trimmed);
    // The password is what stands between a stolen `storage.local` blob and
    // the recovery phrase, so 8 characters alone is not enough, the strength
    // gate applies to create and import alike (both protect the same secret).
    const strongEnough =
      estimatePasswordStrength(password).score >= MIN_PASSWORD_SCORE;
    const passwordOk = password.length >= 8 && strongEnough && password === repeat;
    const canSubmit = passwordOk && (!isImport || phraseOk);

    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        {isImport ? null : <StepProgress step={1} total={3} />}
        <ScreenHeader
          title={t(isImport ? 'onboarding.import.title' : 'onboarding.password.title')}
          onBack={() => {
            setStep('welcome');
            setError(null);
          }}
        />
        {isImport ? (
          <>
            <p className="text-sm text-muted">{t('onboarding.import.body')}</p>
            <Field
              label={t('onboarding.phrase.title')}
              error={
                trimmed.length > 0 && !countOk
                  ? t('onboarding.import.wordCount')
                  : trimmed.length > 0 && countOk && !phraseOk
                    ? t('onboarding.import.invalid')
                    : undefined
              }
            >
              <TextArea
                rows={4}
                autoComplete="off"
                spellCheck={false}
                value={importInput}
                placeholder={t('onboarding.import.placeholder')}
                onChange={(e) => setImportInput(e.target.value)}
              />
            </Field>
            {showPassphrase ? (
              <Field
                label={`${t('onboarding.import.passphrase')} (${t('app.optional')})`}
                hint={t('onboarding.import.passphraseHint')}
              >
                <TextInput
                  type="password"
                  autoComplete="off"
                  value={bip39Passphrase}
                  onChange={(e) => setBip39Passphrase(e.target.value)}
                />
              </Field>
            ) : (
              <button
                type="button"
                className="self-start text-xs font-medium text-accent-fg"
                onClick={() => setShowPassphrase(true)}
              >
                {t('onboarding.import.passphraseToggle')}
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">{t('onboarding.password.body')}</p>
        )}

        <Field
          label={t('onboarding.password.label')}
          error={
            password.length > 0 && password.length < 8
              ? t('onboarding.password.tooShort')
              : password.length >= 8 && !strongEnough
                ? t('onboarding.password.tooWeak')
                : undefined
          }
        >
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {password.length > 0 ? <StrengthMeter password={password} /> : null}
        </Field>
        <Field
          label={t('onboarding.password.repeat')}
          error={
            repeat.length > 0 && repeat !== password
              ? t('onboarding.password.mismatch')
              : undefined
          }
        >
          <TextInput
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Button
          className="mt-auto"
          disabled={!canSubmit || busy}
          onClick={() => {
            void (isImport ? importWallet() : createWallet()).finally(() => {
              // Invariant 6, best effort: drop the repeated password as soon as
              // it has served its purpose (see README, "Zeroization").
              setRepeat('');
            });
          }}
        >
          {t('app.continue')}
        </Button>
      </div>
    );
  }

  if (step === 'phrase') {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        <StepProgress step={2} total={3} />
        <ScreenHeader title={t('onboarding.phrase.title')} />
        <p className="text-sm leading-relaxed text-muted">{t('onboarding.phrase.body')}</p>
        <Notice tone="warn">{t('onboarding.phrase.neverShare')}</Notice>

        {revealed ? (
          <ol className="grid grid-cols-3 gap-1.5">
            {words.map((word, i) => (
              <li
                key={`${word}-${i}`}
                className="rounded-token border border-border bg-surface px-2 py-1.5 text-xs"
              >
                <span className="mr-1 text-muted">{i + 1}</span>
                <span className="font-medium text-text">{word}</span>
              </li>
            ))}
          </ol>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="rounded-token border border-dashed border-border bg-surface px-3 py-8 text-xs text-muted"
          >
            {t('onboarding.phrase.hidden')}
            <span className="mt-2 block font-medium text-accent-fg">
              {t('onboarding.phrase.reveal')}
            </span>
          </button>
        )}

        <Button
          className="mt-auto"
          disabled={!revealed}
          onClick={() => {
            setStep('verify');
          }}
        >
          {t('onboarding.phrase.written')}
        </Button>
      </div>
    );
  }

  if (step === 'verify') {
    const positionsHuman = quizPositions.map((p) => p + 1);
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        <StepProgress step={3} total={3} />
        <ScreenHeader title={t('onboarding.verify.title')} onBack={() => setStep('phrase')} />
        <p className="text-sm text-muted">
          {t('onboarding.verify.body', {
            p1: positionsHuman[0] ?? 0,
            p2: positionsHuman[1] ?? 0,
            p3: positionsHuman[2] ?? 0,
          })}
        </p>

        {/* Slots: which positions are asked for, filled as chips are tapped. */}
        <div data-testid="quiz-slots" className="flex justify-center gap-2">
          {quizPositions.map((position, slotIndex) => {
            const filled = slotIndex < quizPos;
            return (
              <span
                key={position}
                className={`min-w-[86px] rounded-[10px] border px-2.5 py-2 text-center text-xs ${
                  filled
                    ? 'border-accent bg-surface font-medium text-text'
                    : 'border-dashed border-border text-muted'
                }`}
              >
                {filled
                  ? (words[position] ?? '')
                  : t('onboarding.verify.slot', { position: position + 1 })}
              </span>
            );
          })}
        </div>

        {/* All 12 words as tappable chips, shuffled once. */}
        <div data-testid="quiz-chips" className="grid grid-cols-3 gap-2 pt-1">
          {chips.map((chip, chipIndex) => {
            const used = usedChips.has(chipIndex);
            return (
              <button
                key={`${chip.word}-${chip.index}`}
                type="button"
                data-testid="quiz-chip"
                disabled={used}
                onClick={() => pickChip(chipIndex, chip.word)}
                className={`rounded-[10px] border px-2 py-2 text-xs font-medium transition-colors duration-[var(--sw-motion-fast)] focus-visible:outline-2 focus-visible:outline-accent ${
                  used
                    ? 'border-success bg-success/10 text-success-fg'
                    : wrongChip === chipIndex
                      ? 'sw-shake border-danger bg-danger/10 text-danger-fg'
                      : 'border-border bg-surface text-text hover:border-accent'
                }`}
              >
                {chip.word}
              </button>
            );
          })}
        </div>

        {verifyError ? <Notice tone="danger">{t('onboarding.verify.wrong')}</Notice> : null}
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="flex h-full flex-col gap-3">
        <ConfettiBurst />
        <div className="flex flex-col items-center gap-3 pt-10 text-center">
          <AnimatedCheck />
          <h1 className="text-xl font-bold text-text">{t('onboarding.done.title')}</h1>
          <p className="max-w-[250px] text-sm leading-relaxed text-muted">
            {t('onboarding.done.body')}
          </p>
        </div>
        <div className="mt-auto flex flex-col gap-2 pb-2">
          <Button onClick={() => onDone('receive')}>{t('onboarding.done.ctaReceive')}</Button>
          <Button tone="secondary" onClick={() => onDone('home')}>
            {t('onboarding.done.ctaHome')}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
