import type { ReactNode } from 'react';
import { formatAmount, formatDateTime, useT } from '../../i18n';
import { formatRpcError } from '../../messaging/client';
import { useHistory } from '../../state/queries';
import type { RpcResult } from '../../messaging/protocol';
import { Card, Notice, ScreenHeader, Spinner } from '../components/primitives';
import { Prop3d } from '../components/props3d';

type Accounts = RpcResult<'account.list'>;

const DIRECTION_KEY: Record<'in' | 'out' | 'self' | 'other', string> = {
  in: 'history.in',
  out: 'history.out',
  self: 'history.self',
  other: 'history.other',
};

export function History({
  accounts,
  onExit,
}: {
  accounts: Accounts;
  onExit: () => void;
}): ReactNode {
  const { t, locale } = useT();
  const query = useHistory(accounts.selectedIndex, true);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <ScreenHeader title={t('history.title')} onBack={onExit} />

      {query.isLoading ? <Spinner /> : null}
      {/*
        * The real cause, not a guess: a locked wallet, a timeout or a rejected
        * request all used to render "the network cannot be reached right now".
        * Same fix as on Home and in Swap; one shared formatter.
        */}
      {query.isError ? (
        <Notice tone="danger">{formatRpcError(t, query.error)}</Notice>
      ) : null}

      {query.data && query.data.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 pt-8 text-center">
          <Prop3d name="historyHourglass" size={116} />
          <p className="pt-1 text-sm font-semibold text-text">{t('history.empty')}</p>
          <p className="text-xs leading-relaxed text-muted">{t('history.emptyBody')}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {query.data?.entries.map((entry) => (
          <Card key={entry.id} className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">
                {t(DIRECTION_KEY[entry.direction])}
                {!entry.successful ? (
                  <span className="ml-2 text-xs text-danger-fg">{t('history.failed')}</span>
                ) : null}
              </p>
              <p className="text-[11px] text-muted">{formatDateTime(locale, entry.createdAt)}</p>
              {entry.counterparty ? (
                <p className="truncate font-mono text-[10px] text-muted">
                  {entry.counterparty}
                </p>
              ) : null}
            </div>
            {entry.amount ? (
              <p
                className={`shrink-0 text-sm ${
                  entry.direction === 'in' ? 'text-success-fg' : 'text-text'
                }`}
              >
                {entry.direction === 'out' ? '−' : entry.direction === 'in' ? '+' : ''}
                {formatAmount(locale, entry.amount)} {entry.assetCode ?? ''}
              </p>
            ) : (
              <p className="shrink-0 text-[11px] text-muted">{entry.type}</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
