/**
 * Asset approval / trustline flow; §4 row 5.
 *
 * Beginner mode: pick from a small curated list, one tap, no jargon (the
 * glossary in §8 calls a trustline an "Asset-Freigabe" / "asset approval").
 * Developer mode: any issuer, editable limit, including `0` to remove a
 * trustline, which `tx-describe` flags as a danger.
 *
 * Both paths go through the very same build → describe → confirm → submit
 * chain as a payment, so invariant 5 holds without a second code path.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { useT } from '../../i18n';
import { api, formatRpcError, isRpcTimeout } from '../../messaging/client';
import { effectiveNetworkId, type Settings } from '../../core/settings';
import type { RpcResult } from '../../messaging/protocol';
import { curatedAssetsFor } from '../../core/stellar/networks';
import {
  useBalances,
  useDescribeTx,
  useInvalidateAccountData,
  useInvalidatePendingSubmission,
  usePendingSubmission,
  useTxStatus,
} from '../../state/queries';
import { useMarkUiProgress } from '../../state/ui-progress';
import { Button, Card, Field, Notice, ScreenHeader, Spinner, TextInput } from '../components/primitives';
import { TxConfirm } from '../components/TxConfirm';
import { SubmitUnknown, resolutionOf } from '../components/SubmitUnknown';

type Accounts = RpcResult<'account.list'>;
/** `unknown`, submitted, outcome open. See `SubmitUnknown` and Send.tsx. */
type Stage = 'form' | 'confirm' | 'done' | 'unknown';

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/u;

export function AddAsset({
  accounts,
  settings,
  onExit,
}: {
  accounts: Accounts;
  settings: Settings;
  onExit: () => void;
}): ReactNode {
  const { t } = useT();
  const index = accounts.selectedIndex;
  const balances = useBalances(index, true);
  const invalidate = useInvalidateAccountData();
  const forgetPending = useInvalidatePendingSubmission();
  const markProgress = useMarkUiProgress();
  const isDeveloper = settings.mode === 'developer';
  /** The curated list belongs to the *effective* network, never to the stored
   * one, same reasoning as the funding button on Home (finding 13). */
  const curatedAssets = curatedAssetsFor(effectiveNetworkId(settings));

  const [stage, setStage] = useState<Stage>('form');
  const [assetCode, setAssetCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [limit, setLimit] = useState('');
  const [xdr, setXdr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when *this* submission came back without an outcome. */
  /** Hash only: the timebound lives in the background's record, nowhere else. */
  const [open, setOpen] = useState<{ hash: string } | null>(null);

  const description = useDescribeTx(stage === 'confirm' ? xdr : null);

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
    setOpen(null);
    setStage('done');
    void markProgress({ firstTxDone: true });
    void invalidate();
  }, [outcomeOpen, resolution, openSubmission, markProgress, invalidate]);

  const held = new Set(
    (balances.data?.balances ?? [])
      .filter((b) => !b.isNative && b.issuer !== null)
      .map((b) => `${b.code}:${b.issuer ?? ''}`),
  );

  const codeValid = /^[A-Za-z0-9]{1,12}$/u.test(assetCode);
  const issuerValid = StrKey.isValidEd25519PublicKey(issuer);
  const limitValid = limit.length === 0 || AMOUNT_RE.test(limit);
  const canSubmit = codeValid && issuerValid && limitValid;

  async function build(code: string, assetIssuer: string, assetLimit: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const built = await api.buildTx({
        kind: 'changeTrust',
        assetCode: code,
        issuer: assetIssuer,
        ...(assetLimit ? { limit: assetLimit } : {}),
      });
      setAssetCode(code);
      setIssuer(assetIssuer);
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
        setOpen({ hash: result.hash });
        setStage('unknown');
        return;
      }
      // A trustline is a real transaction; it counts for the checklist too.
      await markProgress({ firstTxDone: true });
      await invalidate();
      setStage('done');
    } catch (err) {
      // A failed call is not a failed transaction, same reasoning as Send.tsx.
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
    setError(null);
    setStage('form');
  }

  // Submitted, outcome open: no way back into a form that would build a second
  // envelope. Comes before every other branch on purpose.
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
    return (
      <div className="flex h-full flex-col gap-3">
        <ScreenHeader title={t('asset.addTitle')} />
        <Notice tone="success">{t('asset.added', { code: assetCode })}</Notice>
        <Button className="mt-auto" onClick={onExit}>
          {t('app.close')}
        </Button>
      </div>
    );
  }

  if (stage === 'confirm') {
    if (description.isLoading) return <Spinner />;
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
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <ScreenHeader title={t('asset.addTitle')} onBack={onExit} />
      <p className="text-sm leading-relaxed text-muted">{t('asset.addBody')}</p>
      <Notice>{t('asset.reserveHint')}</Notice>

      {/* §4: beginners choose from the curated list, nothing else. */}
      <section className="flex flex-col gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('asset.curated')}
        </h2>
        {curatedAssets.map((asset) => {
          const alreadyHeld = held.has(`${asset.code}:${asset.issuer}`);
          return (
            <Card key={`${asset.code}:${asset.issuer}`} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{asset.code}</p>
                <p className="truncate text-[11px] text-muted">{asset.name}</p>
                {isDeveloper ? (
                  <p className="truncate font-mono text-[10px] text-muted">{asset.issuer}</p>
                ) : null}
              </div>
              <Button
                tone="secondary"
                disabled={busy || alreadyHeld}
                onClick={() => void build(asset.code, asset.issuer, '')}
              >
                {alreadyHeld ? t('asset.alreadyHeld') : t('asset.add')}
              </Button>
            </Card>
          );
        })}
        {curatedAssets.length === 0 ? (
          <Card>
            <p className="text-xs text-muted">{t('asset.curatedNone')}</p>
          </Card>
        ) : null}
        <p className="text-[11px] leading-relaxed text-muted">{t('asset.curatedNote')}</p>
      </section>

      {/* §4: any issuer and an editable limit are developer-mode surfaces. */}
      {isDeveloper ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('asset.custom')}
          </h2>
          <Field
            label={t('asset.code')}
            error={assetCode.length > 0 && !codeValid ? t('asset.codeInvalid') : undefined}
          >
            <TextInput
              value={assetCode}
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setAssetCode(e.target.value.trim())}
            />
          </Field>
          <Field
            label={t('asset.issuer')}
            error={issuer.length > 0 && !issuerValid ? t('send.invalidAddress') : undefined}
          >
            <TextInput
              value={issuer}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('send.recipientPlaceholder')}
              onChange={(e) => setIssuer(e.target.value.trim())}
            />
          </Field>
          <Field
            label={`${t('asset.limit')} (${t('app.optional')})`}
            hint={t('asset.limitHint')}
            error={!limitValid ? t('send.invalidAmount') : undefined}
          >
            <TextInput
              inputMode="decimal"
              value={limit}
              placeholder={t('asset.limitPlaceholder')}
              onChange={(e) => setLimit(e.target.value.replace(',', '.').trim())}
            />
          </Field>
          {limit === '0' ? <Notice tone="warn">{t('asset.limitZero')}</Notice> : null}
          <Button
            disabled={!canSubmit || busy}
            onClick={() => void build(assetCode, issuer, limit)}
          >
            {t('asset.review')}
          </Button>
        </section>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
