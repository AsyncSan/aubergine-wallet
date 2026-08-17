/**
 * Home (redesign v1.1, docs/ui-redesign-konzept.md).
 *
 * One hero per screen: the spendable balance (clicking it toggles undercover
 * mode; every amount masks as bullets). Below it the Phantom-style action row
 * (Receive / Send / Buy / Swap). The full address lives in the head pill only;
 * "add asset" sits at the bottom of the asset list and in Settings.
 *
 * P3 (Bottom-Sheets): the permanent reserve explainer under the hero became a
 * compact line with an ⓘ that opens a sheet; asset rows open a details sheet.
 * §4 row 8 keeps holding: beginners get the explanation (plus the one total
 * they already see on the line), the itemised breakdown stays developer-only,
 * and because `Sheet` unmounts closed content, developer-only rows are not in
 * the beginner DOM at all.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { formatAmount, useT } from '../../i18n';
import { useBalances, useFundAccount } from '../../state/queries';
import type { RpcResult } from '../../messaging/protocol';
import { effectiveNetworkId, type Settings } from '../../core/settings';
import { hasFriendbot } from '../../core/stellar/networks';
import { useUiStore } from '../../state/store';
import { curatedAssetsFor } from '../../core/stellar/networks';
import {
  ActionButton,
  AssetIcon,
  Button,
  Card,
  CopyableAddress,
  CountUpAmount,
  Identicon,
  Notice,
  Sheet,
  Spinner,
  TokenRow,
  copyToClipboard,
  type CopyState,
} from '../components/primitives';
import { formatRpcError } from '../../messaging/client';
import {
  BuyIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
  ReceiveIcon,
  SendIcon,
  SwapIcon,
} from '../components/icons';
import { Prop3d } from '../components/props3d';
import { SecurityChecklist } from '../components/SecurityChecklist';
import { MASKED_AMOUNT, useSetUiPrefs, useUiPrefs } from '../../state/ui-prefs';

type Accounts = RpcResult<'account.list'>;
type Snapshot = RpcResult<'account.balances'>;
type BalanceEntry = Snapshot['balances'][number];

export function Home({
  accounts,
  settings,
  onLock,
}: {
  accounts: Accounts;
  settings: Settings;
  onLock: () => void;
}): ReactNode {
  const { t, locale } = useT();
  const index = accounts.selectedIndex;
  const account = accounts.accounts.find((a) => a.index === index) ?? accounts.accounts[0];
  const balancesQuery = useBalances(index, true);
  const fund = useFundAccount(index);
  const navigate = useUiStore((s) => s.navigate);
  const [buyNotice, setBuyNotice] = useState(false);
  const [addressCopied, setAddressCopied] = useState<CopyState>('idle');
  const [reserveOpen, setReserveOpen] = useState(false);
  const [assetSheet, setAssetSheet] = useState<BalanceEntry | null>(null);
  const isDeveloper = settings.mode === 'developer';
  /**
   * Undercover mode: clicking the balance masks every amount on this screen
   * (hero, reserve line, asset rows, asset sheet) as bullets. Persisted so a
   * hidden balance stays hidden when the popup reopens; purely cosmetic,
   * nothing fetched, built or signed changes.
   */
  const prefs = useUiPrefs();
  const setPrefs = useSetUiPrefs();
  const hidden = prefs.data?.hideBalances === true;
  const masked = (amount: string): string => (hidden ? MASKED_AMOUNT : amount);
  /**
   * Finding 13: this has to key off the *effective* network, not the stored
   * one. A beginner who once tried developer mode with Mainnet still has
   * `networkId: 'mainnet'` in settings while actually being on Testnet, the
   * old check hid the funding button and dead-ended onboarding.
   */
  const canFund = hasFriendbot(effectiveNetworkId(settings));

  useEffect(() => {
    if (addressCopied === 'idle') return;
    const timer = setTimeout(() => setAddressCopied('idle'), 1_800);
    return () => clearTimeout(timer);
  }, [addressCopied]);

  if (!account) return <Spinner />;

  const snapshot = balancesQuery.data;
  const shortAddress = `${account.publicKey.slice(0, 4)}…${account.publicKey.slice(-4)}`;

  /**
   * Readable second line (P0 "Token-Zeilen"): native gets its proper name,
   * curated assets their vetted name; unknown assets show the shortened
   * issuer so lookalike codes stay distinguishable.
   */
  const assetName = (balance: BalanceEntry): string | undefined => {
    if (balance.isNative) return t('asset.nativeName');
    const curated = curatedAssetsFor(effectiveNetworkId(settings)).find(
      (a) => a.code === balance.code && a.issuer === balance.issuer,
    );
    return (
      curated?.name ??
      (balance.issuer ? `${balance.issuer.slice(0, 4)}…${balance.issuer.slice(-4)}` : undefined)
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      {/* The wallet card (v1.2): account, balance and reserve on ONE object,
          the popup's version of the 3D renders' leather wallet, stitching and
          all (style.css .sw-wallet-card). */}
      <div
        data-testid="balance-hero"
        className="sw-wallet-card sw-edge-light shrink-0 rounded-token-lg px-3 pb-4 pt-2.5"
      >
        {/* Card head: identicon + short-address pill, lock right. */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            data-testid="address-pill"
            data-address={account.publicKey}
            title={account.label || t('home.accountLabel', { index: account.index + 1 })}
            onClick={() => {
              // A denied clipboard is a state, not an unhandled rejection
              // (finding 9); the pill says so instead of silently doing nothing.
              void copyToClipboard(account.publicKey).then((ok) =>
                setAddressCopied(ok ? 'copied' : 'failed'),
              );
            }}
            className="sw-press flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 transition-colors duration-[var(--sw-motion-fast)] hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Identicon value={account.publicKey} />
            {addressCopied === 'copied' ? (
              <span className="text-xs font-medium text-accent-fg">{t('app.copied')}</span>
            ) : addressCopied === 'failed' ? (
              <span className="text-xs font-medium text-danger-fg">{t('app.copyFailed')}</span>
            ) : (
              <span className="font-mono text-[11.5px] text-text">{shortAddress}</span>
            )}
          </button>
          <button
            type="button"
            onClick={onLock}
            aria-label={t('home.lock')}
            title={t('home.lock')}
            className="flex h-9 w-9 items-center justify-center rounded-token text-muted transition-colors duration-[var(--sw-motion-fast)] hover:bg-surface/70 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <LockIcon size={18} />
          </button>
        </div>

        <p className="pt-2 text-center text-xs font-medium text-muted">{t('home.spendable')}</p>
        {balancesQuery.isLoading ? (
          <Spinner />
        ) : (
          /* Undercover mode: the number itself is the toggle. */
          <button
            type="button"
            data-testid="balance-amount"
            aria-pressed={hidden}
            aria-label={t(hidden ? 'home.showBalances' : 'home.hideBalances')}
            title={t(hidden ? 'home.showBalances' : 'home.hideBalances')}
            onClick={() => void setPrefs({ hideBalances: !hidden })}
            className="sw-press mx-auto block rounded-token pt-0.5 text-4xl font-bold tabular-nums tracking-tight text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            {hidden ? (
              MASKED_AMOUNT
            ) : (
              <CountUpAmount value={snapshot?.reserves.spendableXlm ?? '0'} />
            )}{' '}
            <span className="text-base font-medium text-muted">XLM</span>
          </button>
        )}
        {snapshot?.exists ? (
          <button
            type="button"
            data-testid="reserve-info"
            onClick={() => setReserveOpen(true)}
            className="mx-auto mt-1 flex items-center gap-1 rounded-token px-2 py-0.5 text-[11px] text-muted transition-colors duration-[var(--sw-motion-fast)] hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            {t('home.reservedShort', {
              amount: masked(formatAmount(locale, snapshot.reserves.totalReservedXlm)),
            })}
            <InfoIcon size={12.5} />
          </button>
        ) : null}
      </div>

      <div className="flex items-start justify-center gap-4 py-1">
        <ActionButton
          testId="action-receive"
          icon={<ReceiveIcon size={22} />}
          label={t('nav.receive')}
          onClick={() => navigate('receive')}
        />
        <ActionButton
          testId="action-send"
          primary
          icon={<SendIcon size={22} />}
          label={t('nav.send')}
          onClick={() => navigate('send')}
        />
        <ActionButton
          testId="action-buy"
          icon={<BuyIcon size={22} />}
          label={t('home.buy')}
          onClick={() => setBuyNotice((v) => !v)}
        />
        <ActionButton
          testId="action-swap"
          icon={<SwapIcon size={22} />}
          label={t('home.swap')}
          onClick={() => navigate('swap')}
        />
      </div>

      {buyNotice ? <Notice tone="info">{t('home.buySoon')}</Notice> : null}

      <SecurityChecklist />

      {snapshot && !snapshot.exists ? (
        <div className="flex flex-col gap-2">
          <Notice tone="warn">{t('home.notFunded')}</Notice>
          {canFund ? (
            <Button onClick={() => fund.mutate()} disabled={fund.isPending}>
              {fund.isPending ? t('home.funding') : t('home.fund')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {snapshot?.exists && canFund ? (
        <Button
          tone="secondary"
          onClick={() => fund.mutate()}
          disabled={fund.isPending}
        >
          {fund.isPending ? t('home.funding') : t('home.fund')}
        </Button>
      ) : null}

      {/* Finding 7: friendbot can refuse (rate limit, already funded, network
          down). The button used to just flip back, which looks broken, say
          what happened, right where the button is. */}
      {fund.isError ? (
        <Notice tone="danger">
          {`${t('home.fundFailed')} ${formatRpcError(t, fund.error)}`}
        </Notice>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('home.assets')}
        </h2>
        {!snapshot || snapshot.balances.length === 0 ? (
          <Card className="flex flex-col items-center gap-1.5 py-5 text-center">
            <Prop3d name="iceCoin" size={84} />
            <p className="text-xs text-muted">{t('home.noAssets')}</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Presentational only: XLM first, Horizon's order otherwise. */}
            {[...snapshot.balances]
              .sort((a, b) => Number(b.isNative) - Number(a.isNative))
              .map((balance) => (
                <TokenRow
                  key={balance.id}
                  testId={`token-${balance.id}`}
                  onClick={() => setAssetSheet(balance)}
                  icon={
                    <AssetIcon
                      code={balance.code}
                      issuer={balance.issuer}
                      isNative={balance.isNative}
                    />
                  }
                  code={balance.code}
                  name={
                    isDeveloper && balance.issuer ? (
                      <span className="font-mono text-[10px]" title={balance.issuer}>
                        {balance.issuer}
                      </span>
                    ) : (
                      assetName(balance)
                    )
                  }
                  amount={masked(formatAmount(locale, balance.balance))}
                />
              ))}
          </div>
        )}
        {/* §4 row 5: asset approval, curated for beginners, free for developers.
            Lives at the very bottom of Home (and in Settings) since the "Mehr"
            sheet made way for Swap. */}
        <button
          type="button"
          data-testid="home-add-asset"
          onClick={() => navigate('addAsset')}
          className="sw-press mt-1 flex w-full items-center justify-center gap-2 rounded-token-lg border border-dashed border-border px-3 py-2.5 text-sm font-medium text-accent-fg transition-colors duration-[var(--sw-motion-fast)] hover:border-accent hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <PlusIcon size={16} />
          {t('asset.add')}
        </button>
      </section>

      {/* The balance query can fail with more than one code (locked wallet,
          RPC timeout, a broken endpoint). It used to render the hardcoded
          "network unreachable" text for every one of them; now it says what
          actually went wrong. */}
      {balancesQuery.isError ? (
        <Notice tone="danger">{formatRpcError(t, balancesQuery.error)}</Notice>
      ) : null}

      {/* P3: reserve explainer sheet. Beginners get the explanation; the
          itemised breakdown is developer-only and unmounted otherwise. */}
      <Sheet
        open={reserveOpen}
        onClose={() => setReserveOpen(false)}
        title={t('reserve.sheetTitle')}
        testId="reserve-sheet"
      >
        <p className="text-sm leading-relaxed text-muted">{t('home.reservedExplain')}</p>
        {isDeveloper && snapshot?.exists ? (
          <Card className="flex flex-col gap-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted">{t('confirm.reserveTotal')}</span>
              <span className="tabular-nums text-text">
                {snapshot.reserves.totalReservedXlm} XLM
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t('confirm.reserveBase')}</span>
              <span className="tabular-nums text-text">{snapshot.reserves.baseReserveXlm} XLM</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t('confirm.reserveEntries')}</span>
              <span className="tabular-nums text-text">{snapshot.reserves.subentryCount}</span>
            </div>
          </Card>
        ) : null}
      </Sheet>

      {/* P3: asset details sheet, opened from any token row. */}
      <Sheet
        open={assetSheet !== null}
        onClose={() => setAssetSheet(null)}
        title={assetSheet?.code ?? ''}
        testId="asset-sheet"
      >
        {assetSheet ? (
          <>
            <div className="flex items-center gap-3">
              <AssetIcon
                code={assetSheet.code}
                issuer={assetSheet.issuer}
                isNative={assetSheet.isNative}
                size={44}
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text">{assetSheet.code}</p>
                {assetName(assetSheet) ? (
                  <p className="truncate text-xs text-muted">{assetName(assetSheet)}</p>
                ) : null}
              </div>
            </div>
            <Card className="flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted">{t('asset.balanceLabel')}</span>
                <span className="tabular-nums text-text">
                  {masked(formatAmount(locale, assetSheet.balance))} {assetSheet.code}
                </span>
              </div>
              {isDeveloper && !assetSheet.isNative ? (
                <div className="flex justify-between">
                  <span className="text-muted">{t('asset.limit')}</span>
                  <span className="tabular-nums text-text">
                    {assetSheet.limit ? formatAmount(locale, assetSheet.limit) : t('asset.limitPlaceholder')}
                  </span>
                </div>
              ) : null}
            </Card>
            {assetSheet.issuer ? (
              <div>
                <p className="pb-1 text-xs text-muted">{t('asset.issuer')}</p>
                <CopyableAddress value={assetSheet.issuer} />
              </div>
            ) : null}
          </>
        ) : null}
      </Sheet>

    </div>
  );
}
