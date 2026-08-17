/**
 * Send flow: form -> plain-language confirmation (§5) -> submit.
 *
 * The popup never signs. It asks the background to build, describe, sign and
 * submit; each step is a separate typed RPC call.
 *
 * Redesign v1.1 (P1, docs/ui-redesign-konzept.md): the amount is the hero of
 * the form (Phantom-style big centred input), the recipient gets a live
 * validity check, memo/fee live behind a disclosure (open by default in
 * developer mode so nothing is hidden there), and success shows a drawn
 * check. Data flow, RPC calls and the TxConfirm screen are unchanged.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { formatAmount, useT } from '../../i18n';
import { api, formatRpcError, isRpcTimeout } from '../../messaging/client';
import { isValidMemoText, memoTextByteLength } from '../../core/stellar/memo';
import { StrKey } from '@stellar/stellar-sdk';
import type { Settings } from '../../core/settings';
import type { RpcResult } from '../../messaging/protocol';
import {
  useBalances,
  useDescribeTx,
  useInvalidateAccountData,
  useInvalidatePendingSubmission,
  usePendingSubmission,
  useTxStatus,
} from '../../state/queries';
import { useMarkUiProgress } from '../../state/ui-progress';
import {
  AnimatedCheck,
  Button,
  Card,
  Disclosure,
  Field,
  Notice,
  ScreenHeader,
  Spinner,
  TextInput,
} from '../components/primitives';
import { CheckIcon, SlidersIcon } from '../components/icons';
import { TxConfirm } from '../components/TxConfirm';
import { SubmitUnknown, resolutionOf } from '../components/SubmitUnknown';
import { FEE_RESERVE_XLM } from '../../core/stellar/horizon';

type Accounts = RpcResult<'account.list'>;
/**
 * `unknown` is not a variant of `done`: it is the state in which the wallet
 * has no idea whether the money moved, and the only one in which the screen
 * refuses to go back to the form (see `SubmitUnknown`).
 */
type Stage = 'form' | 'confirm' | 'done' | 'unknown';

export function Send({
  accounts,
  settings,
  onExit,
}: {
  accounts: Accounts;
  settings: Settings;
  onExit: () => void;
}): ReactNode {
  const { t, locale } = useT();
  const index = accounts.selectedIndex;
  const balances = useBalances(index, true);
  const invalidate = useInvalidateAccountData();
  const forgetPending = useInvalidatePendingSubmission();
  const markProgress = useMarkUiProgress();

  const [stage, setStage] = useState<Stage>('form');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [assetId, setAssetId] = useState('native');
  const [memo, setMemo] = useState('');
  const [feeStroops, setFeeStroops] = useState('');
  const [xdr, setXdr] = useState<string | null>(null);
  const [hash, setHash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when *this* submission came back without an outcome. */
  /** Hash only: the timebound lives in the background's record, nowhere else. */
  const [open, setOpen] = useState<{ hash: string } | null>(null);

  const description = useDescribeTx(stage === 'confirm' ? xdr : null);

  /**
   * A submission from an earlier popup session whose outcome is still open.
   * The background wrote the record before the envelope left, so this survives
   * a closed popup and a service worker the browser tore down mid-request,
   * and it is why re-entering this screen cannot start a second payment.
   */
  const carriedAny = usePendingSubmission(stage !== 'done').data?.pending ?? null;
  // Only this account's record locks this screen, the collision is two
  // envelopes from the *same* source account, nothing else.
  const carried = carriedAny !== null && carriedAny.accountIndex === index ? carriedAny : null;
  const openSubmission =
    open ?? (carried === null ? null : { hash: carried.hash });
  const outcomeOpen = stage !== 'done' && openSubmission !== null;
  const status = useTxStatus(openSubmission?.hash ?? null, outcomeOpen);
  const resolution = resolutionOf(status.data);

  // The network answered after all, and in our favour: leave the open state
  // and show the ordinary receipt, with the hash it was submitted under.
  useEffect(() => {
    if (!outcomeOpen || resolution !== 'included-success' || openSubmission === null) return;
    setHash(openSubmission.hash);
    setOpen(null);
    setStage('done');
    void markProgress({ firstTxDone: true });
    void invalidate();
  }, [outcomeOpen, resolution, openSubmission, markProgress, invalidate]);
  const isDeveloper = settings.mode === 'developer';

  const addressValid = destination.length === 0 || StrKey.isValidEd25519PublicKey(destination);
  const amountValid = amount.length === 0 || /^\d+(\.\d{1,7})?$/u.test(amount);
  const selected = balances.data?.balances.find((b) => b.id === assetId);
  const spendable =
    assetId === 'native' ? balances.data?.reserves.spendableXlm : selected?.balance;
  /**
   * What "Max" may actually put in the field. For XLM that is the available
   * balance *minus a fee reserve*; the fee comes out of the same balance, so
   * sending exactly the available amount failed with `op_underfunded` every
   * single time. For any other asset the two are the same number.
   */
  const maxSendable =
    assetId === 'native' ? balances.data?.reserves.maxSendableXlm : selected?.balance;
  const enough =
    amount.length === 0 || maxSendable === undefined || Number(amount) <= Number(maxSendable);
  // MEMO_TEXT is a 28-*byte* XDR field; characters can be multi-byte (P2 fix).
  const memoBytes = memoTextByteLength(memo);
  const memoValid = isValidMemoText(memo);

  const canSubmit =
    destination.length > 0 &&
    amount.length > 0 &&
    addressValid &&
    amountValid &&
    enough &&
    memoValid &&
    Number(amount) > 0;

  async function build(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const built = await api.buildTx({
        kind: 'payment',
        destination,
        assetId,
        amount,
        ...(memo ? { memo } : {}),
        ...(isDeveloper && feeStroops ? { feeStroops } : {}),
      });
      setXdr(built.xdr);
      setStage('confirm');
    } catch (err) {
      setError(formatRpcError(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndSubmit(): Promise<void> {
    if (!xdr) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await api.signTx(xdr);
      const result = await api.submitTx(signed.signedXdr);
      if (result.outcome === 'unknown') {
        // Not an error and not a success: the envelope is out there and only
        // the network can say what became of it.
        setOpen({ hash: result.hash });
        setStage('unknown');
        return;
      }
      setHash(result.hash);
      // Checklist "first transaction", recorded on real success only.
      await markProgress({ firstTxDone: true });
      await invalidate();
      setStage('done');
    } catch (err) {
      /**
       * A failed *call* is not a failed transaction. The service worker can be
       * torn down mid-submit and the client's own 75 s deadline can fire while
       * Horizon still holds the request, in both cases the envelope may well
       * be on its way. The background writes its record before sending, so it
       * is the authority on whether anything is still open.
       */
      try {
        const still = await api.pendingSubmission();
        if (still.pending !== null) {
          setOpen({ hash: still.pending.hash });
          setStage('unknown');
          return;
        }
      } catch {
        /* the background is unreachable; fall through below */
      }
      /**
       * Last resort. We cannot even ask whether something is open, so the one
       * thing we must not print is "took too long, please try again", the
       * envelope was signed and handed over. `tx.build` still refuses a second
       * one as long as the background's record exists.
       */
      setError(isRpcTimeout(err) ? t('error.SUBMIT_OUTCOME_UNKNOWN') : formatRpcError(t, err));
    } finally {
      setBusy(false);
    }
  }

  /** Only reachable once the network proved that nothing was applied. */
  function retryAfterResolution(): void {
    // The background dropped its record when the poll resolved; the popup's
    // cached copy of that answer has to go with it, or the screen locks itself
    // again on the next render.
    void forgetPending();
    setOpen(null);
    setXdr(null);
    setError(null);
    setStage('form');
  }

  if (outcomeOpen && openSubmission !== null) {
    return (
      <SubmitUnknown
        hash={openSubmission.hash}
        resolution={resolution}
        onClose={onExit}
        onRetry={retryAfterResolution}
      />
    );
  }

  if (stage === 'done') {
    const sentCode = assetId === 'native' ? 'XLM' : (selected?.code ?? '');
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        <div className="flex flex-col items-center gap-3 pt-6 text-center">
          <AnimatedCheck />
          <h1 className="text-xl font-bold text-text">{t('send.success')}</h1>
          <p className="text-sm text-muted">
            <span className="font-semibold text-text">
              {formatAmount(locale, amount)} {sentCode}
            </span>{' '}
            {t('send.sentTo', {
              // Same reasoning as `shortAddress` in tx-describe: a 4+4 preview
              // is cheap to collide with a vanity key, and this line is what
              // the user checks the recipient against.
              recipient: `${destination.slice(0, 12)}…${destination.slice(-12)}`,
            })}
          </p>
          <p className="px-4 text-xs leading-relaxed text-muted">{t('send.successBody')}</p>
        </div>
        <div>
          <p className="pb-1 text-xs text-muted">{t('send.viewHash')}</p>
          <Card>
            <p className="break-all font-mono text-[10px] text-text">{hash}</p>
          </Card>
        </div>
        <div className="mt-auto flex gap-2">
          <Button
            tone="secondary"
            className="flex-1"
            onClick={() => {
              setStage('form');
              setDestination('');
              setAmount('');
              setMemo('');
              setXdr(null);
            }}
          >
            {t('send.again')}
          </Button>
          <Button className="flex-1" onClick={onExit}>
            {t('app.close')}
          </Button>
        </div>
      </div>
    );
  }

  if (stage === 'confirm') {
    /**
     * Finding 4: a slow or hung `tx.describe` used to render a bare spinner,
     * no header, no Back, no way out of the flow. Every confirm state carries
     * its header now.
     */
    if (description.isLoading) {
      return (
        <div className="flex h-full flex-col gap-3">
          <ScreenHeader title={t('confirm.title')} onBack={() => setStage('form')} />
          <Spinner />
        </div>
      );
    }
    if (description.isError || !description.data) {
      return (
        <div className="flex h-full flex-col gap-3">
          <ScreenHeader title={t('confirm.title')} onBack={() => setStage('form')} />
          <Notice tone="danger">{t('tx.warn.UNPARSEABLE_TRANSACTION')}</Notice>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader title={t('confirm.title')} onBack={() => setStage('form')} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <TxConfirm
          description={description.data}
          mode={settings.mode}
          snapshot={balances.data}
          busy={busy}
          onConfirm={() => void confirmAndSubmit()}
          onReject={() => setStage('form')}
          confirmLabel={busy ? t('send.sending') : t('confirm.submit')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <ScreenHeader title={t('send.title')} onBack={onExit} />

      {/* Recipient stays the FIRST textbox in the DOM (E2E contract). */}
      <Field
        label={t('send.recipient')}
        error={!addressValid ? t('send.invalidAddress') : undefined}
      >
        <div className="relative">
          <TextInput
            className="pr-10"
            value={destination}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('send.recipientPlaceholder')}
            onChange={(e) => setDestination(e.target.value.trim())}
          />
          {/* Live validity check: pops in as soon as the address parses. */}
          <span
            aria-hidden
            className={`absolute right-3 top-1/2 -translate-y-1/2 text-success-fg transition-transform duration-[var(--sw-motion-base)] ${
              destination.length > 0 && addressValid ? 'scale-100' : 'scale-0'
            }`}
          >
            <CheckIcon size={16} strokeWidth={3} />
          </span>
        </div>
      </Field>

      {/* Hero: the amount (§3 "Ein Hero pro Screen"). One decimal input only. */}
      <div className="pb-1 pt-3 text-center">
        <input
          aria-label={t('send.amount')}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(',', '.').trim())}
          className="w-full border-none bg-transparent text-center text-[42px] font-bold tracking-tight text-text outline-none tabular-nums placeholder:text-border"
        />
        <div className="flex items-center justify-center gap-2.5 pt-1.5">
          {balances.data && balances.data.balances.length > 1 ? (
            <select
              aria-label={t('send.asset')}
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-text focus:border-accent focus:outline-none"
            >
              {balances.data.balances.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs font-semibold text-muted">{selected?.code ?? 'XLM'}</span>
          )}
          {spendable !== undefined ? (
            <span className="text-xs text-muted">
              {t('home.spendable')}: {formatAmount(locale, spendable)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setAmount(maxSendable ?? '')}
            disabled={maxSendable === undefined}
            className="rounded-full px-3 py-1 text-[11.5px] font-semibold text-accent-fg transition-colors duration-[var(--sw-motion-fast)] hover:bg-accent/20 disabled:opacity-40"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--sw-accent) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--sw-accent) 35%, transparent)',
            }}
          >
            {t('send.max')}
          </button>
        </div>
        {/*
         * The reserve grew from 0.0001 to 0.01 XLM when the fee strategy
         * landed (`FEE_RESERVE_XLM`), and an unexplained gap between the
         * available balance and what "Max" fills in reads as a bug. Say the
         * number instead of hiding it.
         */}
        {assetId === 'native' ? (
          <p className="pt-1 text-[11px] text-muted">
            {t('send.maxHint', { amount: FEE_RESERVE_XLM.toFixed(4) })}
          </p>
        ) : null}
        {!amountValid ? (
          <p role="alert" className="pt-2 text-xs text-danger-fg">
            {t('send.invalidAmount')}
          </p>
        ) : !enough ? (
          <p role="alert" className="pt-2 text-xs text-danger-fg">
            {t('send.insufficient')}
          </p>
        ) : null}
      </div>

      {/*
       * Memo & manual fee behind a disclosure. Developer mode opens it by
       * default: §4 row 7 promises the fee field is *visible* there, and the
       * E2E suite checks exactly that.
       */}
      <Disclosure
        label={t('send.moreOptions')}
        icon={<SlidersIcon size={15} />}
        defaultOpen={isDeveloper}
      >
        <Field label={`${t('send.memo')} (${t('app.optional')})`}>
          {/* maxLength stays as a soft cap on characters; the hard limit is
              28 UTF-8 bytes, checked below (multi-byte characters). */}
          <TextInput maxLength={28} value={memo} onChange={(e) => setMemo(e.target.value)} />
          {!memoValid ? (
            <p role="alert" className="pt-2 text-xs text-danger-fg">
              {t('send.memoTooLong', { bytes: memoBytes })}
            </p>
          ) : null}
        </Field>
        {/* §4: manual fee is a developer-mode surface. */}
        {isDeveloper ? (
          <Field label={t('send.feeManual')}>
            <TextInput
              inputMode="numeric"
              placeholder="100"
              value={feeStroops}
              maxLength={7}
              onChange={(e) => setFeeStroops(e.target.value.replace(/\D/gu, '').slice(0, 7))}
            />
          </Field>
        ) : null}
      </Disclosure>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {/* Busy label like TxConfirm: `tx.build` is a round trip, and a button
          that only greys out reads as broken. */}
      <Button className="mt-auto" disabled={!canSubmit || busy} onClick={() => void build()}>
        {busy ? t('send.reviewing') : t('send.review')}
      </Button>
    </div>
  );
}
