/**
 * Swap: exchange one held asset for another via the Stellar DEX (v1.2).
 *
 * A swap is a strict-send path payment to yourself, so the whole existing
 * pipeline is reused unchanged: the background quotes (`swap.quote`), builds
 * (`tx.build` kind "swap"), describes (`tx.describe`, including the fresh
 * HIGH_SLIPPAGE check against the books), signs and submits. The popup never
 * talks to Horizon itself and never signs (§3).
 *
 * The "to" list is deliberately the assets the account already holds: a path
 * payment can only deliver into an existing trustline. Anything else first
 * goes through "Asset hinzufügen", which is exactly the explanation the
 * screen gives when there is nothing to swap into.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { formatAmount, useT } from '../../i18n';
import { api, formatRpcError, isRpcTimeout } from '../../messaging/client';
import type { Settings } from '../../core/settings';
import type { RpcResult } from '../../messaging/protocol';
import {
  useBalances,
  useDescribeTx,
  useInvalidateAccountData,
  useInvalidatePendingSubmission,
  usePendingSubmission,
  useSwapQuote,
  useTxStatus,
} from '../../state/queries';
import { useUiStore } from '../../state/store';
import { useDebouncedValue } from '../../state/use-debounced-value';
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
import { SlidersIcon, SwapIcon } from '../components/icons';
import { TxConfirm } from '../components/TxConfirm';
import { SubmitUnknown, resolutionOf } from '../components/SubmitUnknown';

type Accounts = RpcResult<'account.list'>;
/** `unknown`, submitted, outcome open. See `SubmitUnknown` and Send.tsx. */
type Stage = 'form' | 'confirm' | 'done' | 'unknown';

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/u;
const SLIPPAGE_OPTIONS = [0.001, 0.005, 0.01] as const;

/** Floor to 7 decimals: the guaranteed minimum must never round *up*. */
export function slippageFloor(destAmount: string, slippage: number): string {
  const value = Number(destAmount) * (1 - slippage);
  if (!Number.isFinite(value) || value <= 0) return '0';
  return (Math.floor(value * 10_000_000) / 10_000_000).toFixed(7);
}

export function Swap({
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
  const navigate = useUiStore((s) => s.navigate);
  const isDeveloper = settings.mode === 'developer';

  const [stage, setStage] = useState<Stage>('form');
  const [sendAssetId, setSendAssetId] = useState('native');
  const [destAssetId, setDestAssetId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState<number>(0.005);
  const [feeStroops, setFeeStroops] = useState('');
  const [xdr, setXdr] = useState<string | null>(null);
  /** The quote the user accepted at review time, shown on confirm & success. */
  const [accepted, setAccepted] = useState<{
    destMin: string;
    destAmount: string;
    slippage: number;
    feeXlm: string | null;
    source: 'dex' | 'soroswap';
  } | null>(null);
  const [hash, setHash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when *this* submission came back without an outcome. */
  /** Hash only: the timebound lives in the background's record, nowhere else. */
  const [open, setOpen] = useState<{ hash: string } | null>(null);

  /** A submission whose outcome is still open, see the same block in Send.tsx. */
  const carriedAny = usePendingSubmission(stage !== 'done').data?.pending ?? null;
  const carried = carriedAny !== null && carriedAny.accountIndex === index ? carriedAny : null;
  const openSubmission =
    open ?? (carried === null ? null : { hash: carried.hash });
  const outcomeOpen = stage !== 'done' && openSubmission !== null;
  const status = useTxStatus(openSubmission?.hash ?? null, outcomeOpen);
  const resolution = resolutionOf(status.data);

  useEffect(() => {
    if (!outcomeOpen || resolution !== 'included-success' || openSubmission === null) return;
    setHash(openSubmission.hash);
    setOpen(null);
    setStage('done');
    void markProgress({ firstTxDone: true });
    void invalidate();
  }, [outcomeOpen, resolution, openSubmission, markProgress, invalidate]);

  const held = balances.data?.balances ?? [];
  const codeOf = (id: string): string => held.find((b) => b.id === id)?.code ?? '';
  const destChoices = held.filter((b) => b.id !== sendAssetId);
  const effectiveDest =
    destAssetId !== null && destAssetId !== sendAssetId ? destAssetId : destChoices[0]?.id ?? null;

  const amountValid = amount.length === 0 || AMOUNT_RE.test(amount);
  const selected = held.find((b) => b.id === sendAssetId);
  const spendable =
    sendAssetId === 'native' ? balances.data?.reserves.spendableXlm : selected?.balance;
  /**
   * What "Max" may actually put in the field. For XLM that is the available
   * balance *minus a fee reserve*; the fee comes out of the same balance, so
   * sending exactly the available amount failed with `op_underfunded` every
   * single time. For any other asset the two are the same number.
   */
  const maxSendable =
    sendAssetId === 'native' ? balances.data?.reserves.maxSendableXlm : selected?.balance;
  const enough =
    amount.length === 0 || maxSendable === undefined || Number(amount) <= Number(maxSendable);
  /**
   * Finding 5: the amount is part of the `swap.quote` query key, so typing
   * "12.5" used to start four Horizon path searches *and* four Soroswap POSTs.
   * Only the debounced value reaches the key, and while the two differ the
   * screen treats the quote as pending, so a rate for the previous amount is
   * never shown as if it belonged to the current one.
   */
  const quotedAmount = useDebouncedValue(amount);
  const quotePending = quotedAmount !== amount;
  const quoteEnabled =
    stage === 'form' &&
    effectiveDest !== null &&
    quotedAmount.length > 0 &&
    AMOUNT_RE.test(quotedAmount) &&
    Number(quotedAmount) > 0;
  const slippageBps = Math.round(slippage * 10_000);
  const quote = useSwapQuote(
    sendAssetId,
    quotedAmount,
    effectiveDest ?? '',
    quoteEnabled,
    slippageBps,
  );
  /** True while a fresh quote is on its way, including the debounce window. */
  const quoteBusy = quotePending || quote.isLoading;
  /** A quote is only *shown* while it belongs to what the user currently typed. */
  const quoteShown = quoteEnabled && !quotePending && quote.data?.found === true;

  // Aggregator quotes carry their own slippage floor (applied server-side from
  // our slippageBps); DEX quotes get the same tolerance applied locally.
  const viaSoroswap = quote.data?.found === true && quote.data.source === 'soroswap';
  const destMin =
    quote.data?.found !== true
      ? null
      : viaSoroswap && quote.data.minReceived !== null
        ? quote.data.minReceived
        : slippageFloor(quote.data.destAmount, slippage);
  const canReview =
    quoteShown && enough && destMin !== null && Number(destMin) > 0;
  /**
   * Finding 10: below ~1e-7 the guaranteed minimum floors to zero, so Review
   * stays disabled while a perfectly valid quote is on screen. Say why instead
   * of letting the user poke a dead button.
   */
  const quoteBelowMinimum = quoteShown && destMin !== null && Number(destMin) <= 0;
  /** How much more the winning aggregator route yields vs. the DEX quote. */
  const dexAdvantage =
    viaSoroswap &&
    quote.data?.found === true &&
    quote.data.dexDestAmount !== null &&
    Number(quote.data.dexDestAmount) > 0 &&
    Number(quote.data.destAmount) > Number(quote.data.dexDestAmount)
      ? Number(quote.data.destAmount) - Number(quote.data.dexDestAmount)
      : null;

  const description = useDescribeTx(stage === 'confirm' ? xdr : null);

  async function build(): Promise<void> {
    if (!quote.data?.found || effectiveDest === null || destMin === null) return;
    setBusy(true);
    setError(null);
    try {
      const soroswapRoute = quote.data.source === 'soroswap' && quote.data.quoteId !== null;
      const built = await api.buildTx({
        kind: 'swap',
        sendAssetId,
        // The amount the quote was made for, identical to `amount` here,
        // because Review is only enabled once the debounce has caught up.
        sendAmount: quotedAmount,
        destAssetId: effectiveDest,
        destMin,
        path: [...quote.data.path],
        // The quoteId is an opaque handle; the background rebuilds from its
        // own cached quote, so nothing here can alter the accepted terms.
        ...(soroswapRoute ? { route: 'soroswap' as const, quoteId: quote.data.quoteId ?? '' } : {}),
        // A manual fee applies to the locally built path payment only.
        ...(!soroswapRoute && isDeveloper && feeStroops ? { feeStroops } : {}),
      });
      setXdr(built.xdr);
      setAccepted({
        destMin,
        destAmount: quote.data.destAmount,
        slippage,
        feeXlm: null,
        source: quote.data.source,
      });
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
      // Keep the network fee for the success receipt; the description query
      // is gone once the stage leaves 'confirm'.
      const feeXlm = description.data?.meta.feeXlm ?? null;
      setAccepted((prev) => (prev === null ? prev : { ...prev, feeXlm }));
      const signed = await api.signTx(xdr);
      const result = await api.submitTx(signed.signedXdr);
      if (result.outcome === 'unknown') {
        setOpen({ hash: result.hash });
        setStage('unknown');
        return;
      }
      setHash(result.hash);
      await markProgress({ firstTxDone: true });
      await invalidate();
      setStage('done');
    } catch (err) {
      // A failed call is not a failed swap; the background knows whether an
      // envelope is still out there. Same reasoning as in Send.tsx.
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
    void forgetPending();
    setOpen(null);
    setXdr(null);
    setAccepted(null);
    setError(null);
    setStage('form');
  }

  /**
   * The accepted swap as a scannable receipt: what goes out, the guaranteed
   * minimum that comes in (bold, stacked), then rate / slippage / network fee.
   * Shown above the plain-language confirmation and again on the success
   * screen; the §5 sentence in TxConfirm stays the security-relevant text.
   */
  function receipt(testId: string, feeXlm: string | null, explainFee = false): ReactNode {
    if (accepted === null || effectiveDest === null) return null;
    const destCode = codeOf(effectiveDest);
    return (
      <div
        data-testid={testId}
        className="flex shrink-0 flex-col gap-2 rounded-token-lg border border-border bg-surface p-3 text-left"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="shrink-0 text-[11.5px] text-muted">{t('swap.youSend')}</span>
          <span className="text-lg font-bold tabular-nums tracking-tight text-text">
            {formatAmount(locale, amount)} {codeOf(sendAssetId)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="shrink-0 text-[11.5px] text-muted">{t('swap.youReceiveMin')}</span>
          <span className="text-lg font-bold tabular-nums tracking-tight text-accent-fg">
            {formatAmount(locale, accepted.destMin)} {destCode}
          </span>
        </div>
        <div className="flex flex-col gap-1 border-t border-border pt-2 text-[11.5px] text-muted">
          <div className="flex justify-between gap-2">
            <span>{t('swap.route')}</span>
            <span>{accepted.source === 'soroswap' ? t('swap.viaSoroswap') : t('swap.viaDex')}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>{t('swap.rate')}</span>
            <span className="tabular-nums">
              1 {codeOf(sendAssetId)} ≈{' '}
              {formatAmount(locale, Number(accepted.destAmount) / Number(amount), 7)} {destCode}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>{t('swap.slippage')}</span>
            <span className="tabular-nums">
              {formatAmount(locale, accepted.slippage * 100)} %
            </span>
          </div>
          {feeXlm !== null ? (
            <>
              <div className="flex justify-between gap-2">
                {/* An upper bound, not a price, see `confirm.feeMaxHint`. */}
                <span>{t('confirm.feeMax')}</span>
                <span className="tabular-nums">{formatAmount(locale, feeXlm)} XLM</span>
              </div>
              {/* On the confirmation the same sentence already sits in the
                  details block below, say it once, where it is needed. */}
              {explainFee ? <p className="leading-relaxed">{t('confirm.feeMaxHint')}</p> : null}
            </>
          ) : null}
        </div>
      </div>
    );
  }

  // Submitted, outcome open: no back arrow, no second transaction. This has
  // to come before every other branch, including the "no assets" one, or a
  // reload could route around it.
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

  // Not enough assets to swap between: explain and point to "add asset".
  if (balances.data && destChoices.length === 0 && stage === 'form') {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        <ScreenHeader title={t('swap.title')} onBack={onExit} />
        <Notice tone="info">{t('swap.needTwoAssets')}</Notice>
        <Button onClick={() => navigate('addAsset')}>{t('asset.add')}</Button>
      </div>
    );
  }

  if (stage === 'done') {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        {/* Compact header row: check + title side by side, so the receipt,
            the hash and both buttons fit the 600 px popup without clipping. */}
        <div className="flex shrink-0 items-center justify-center gap-3 pt-2 text-center">
          <AnimatedCheck size={44} />
          <h1 className="text-xl font-bold text-text">{t('swap.success')}</h1>
        </div>
        {receipt('swap-receipt', accepted?.feeXlm ?? null, true)}
        <p className="px-4 text-center text-xs leading-relaxed text-muted">
          {t('swap.successBody')}
        </p>
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
              setAmount('');
              setXdr(null);
              setAccepted(null);
            }}
          >
            {t('swap.again')}
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
          confirmLabel={busy ? t('swap.sending') : t('confirm.submit')}
          hero={receipt('swap-summary', description.data.meta.feeXlm)}
          allowSoroban={accepted?.source === 'soroswap'}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <ScreenHeader title={t('swap.title')} onBack={onExit} />

      {/* You pay: amount hero plus the asset it comes out of. */}
      <div className="shrink-0 pb-1 pt-1 text-center">
        <p className="text-xs font-medium text-muted">{t('swap.youSend')}</p>
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
          <select
            aria-label={t('swap.youSend')}
            data-testid="swap-from"
            value={sendAssetId}
            onChange={(e) => setSendAssetId(e.target.value)}
            className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-text focus:border-accent focus:outline-none"
          >
            {held.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </select>
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

      <div aria-hidden className="flex justify-center text-muted">
        <SwapIcon size={18} />
      </div>

      {/* You receive: live quote against the current order books. */}
      <div
        data-testid="swap-quote"
        className="flex shrink-0 flex-col gap-2 rounded-token border border-border bg-surface p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{t('swap.youReceive')}</span>
          <select
            aria-label={t('swap.youReceive')}
            data-testid="swap-to"
            value={effectiveDest ?? ''}
            onChange={(e) => setDestAssetId(e.target.value)}
            className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-text focus:border-accent focus:outline-none"
          >
            {destChoices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </select>
        </div>
        <p className="text-2xl font-bold tabular-nums tracking-tight text-text">
          {quoteShown && quote.data?.found === true
            ? formatAmount(locale, quote.data.destAmount)
            : '—'}
        </p>
        {/* The debounce window counts as "fetching": an old rate must never
            sit there looking current while the user is still typing. */}
        {amount.length > 0 && amountValid && Number(amount) > 0 && quoteBusy ? (
          <p className="text-xs text-muted">{t('swap.quoteLoading')}</p>
        ) : null}
        {quoteEnabled && !quotePending && quote.data?.found === false ? (
          <Notice tone="warn">{t('swap.noPath')}</Notice>
        ) : null}
        {/* Same class of bug as the balance notice on Home: a quote can fail
            with a locked wallet, an expired quote or a timeout, and all of
            them used to read "network unreachable". Render the real cause. */}
        {quoteEnabled && !quotePending && quote.isError ? (
          <Notice tone="danger">{formatRpcError(t, quote.error)}</Notice>
        ) : null}
        {quoteBelowMinimum ? <Notice tone="warn">{t('swap.amountTooSmall')}</Notice> : null}
        {quoteShown && quote.data?.found === true && effectiveDest !== null ? (
          <div className="flex flex-col gap-1 text-[11.5px] text-muted">
            <div className="flex justify-between">
              <span>{t('swap.route')}</span>
              <span data-testid="swap-source">
                {viaSoroswap ? t('swap.viaSoroswap') : t('swap.viaDex')}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t('swap.rate')}</span>
              <span className="tabular-nums">
                1 {codeOf(sendAssetId)} ≈{' '}
                {formatAmount(locale, Number(quote.data.destAmount) / Number(quotedAmount), 7)}{' '}
                {codeOf(effectiveDest)}
              </span>
            </div>
            {destMin !== null ? (
              <div className="flex justify-between">
                <span>{t('swap.minReceived')}</span>
                <span className="tabular-nums" data-testid="swap-dest-min">
                  {formatAmount(locale, destMin)} {codeOf(effectiveDest)}
                </span>
              </div>
            ) : null}
            {dexAdvantage !== null ? (
              <div className="flex justify-between">
                <span>{t('swap.vsDex')}</span>
                <span className="tabular-nums text-accent-fg">
                  {`+${formatAmount(locale, dexAdvantage, 7)} ${codeOf(effectiveDest)}`}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* The active value lives in the header, so the closed disclosure is
          already informative and the open one has room to breathe. */}
      <Disclosure
        label={`${t('swap.slippage')} · ${formatAmount(locale, slippage * 100)} %`}
        icon={<SlidersIcon size={15} />}
        defaultOpen={isDeveloper}
      >
        <p className="text-xs leading-relaxed text-muted">{t('swap.slippageHint')}</p>
        <div className="flex gap-2 pb-1">
          {SLIPPAGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={slippage === option}
              onClick={() => setSlippage(option)}
              className={`sw-press flex-1 rounded-token border px-2 py-2.5 text-[13px] font-semibold tabular-nums transition-colors duration-[var(--sw-motion-fast)] focus-visible:outline-2 focus-visible:outline-accent ${
                slippage === option
                  ? 'border-accent bg-accent/10 text-accent-fg'
                  : 'border-border bg-surface text-muted hover:border-accent hover:text-text'
              }`}
            >
              {formatAmount(locale, option * 100)} %
            </button>
          ))}
        </div>
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
      <Button className="mt-auto" disabled={!canReview || busy} onClick={() => void build()}>
        {busy ? t('swap.reviewing') : t('swap.review')}
      </Button>
    </div>
  );
}
