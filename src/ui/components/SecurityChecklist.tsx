/**
 * Security checklist on Home (redesign v1.1, P1, konzept §3 "Subtile
 * Gamification"). Three steps: wallet created (always true once Home renders),
 * recovery phrase confirmed, first transaction. Progress lives in
 * `uiProgress.v1` (cosmetic only, never gates anything).
 *
 * Visibility: collapsed card while incomplete; once complete it shows the full
 * ring one last time with a dismiss button, then never again.
 */
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { useMarkUiProgress, useUiProgress } from '../../state/ui-progress';
import { useUiStore } from '../../state/store';
import { CheckIcon, ChevronDownIcon } from './icons';
import { ProgressRing } from './primitives';

const TOTAL = 3;

function Item({
  label,
  done,
  actionLabel,
  onAction,
  testId,
}: {
  label: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
  testId: string;
}): ReactNode {
  return (
    <li data-testid={testId} className="flex items-center gap-2.5 py-1.5 text-[13px]">
      <span
        aria-hidden
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
          done ? 'border-success bg-success text-[#052b1f]' : 'border-border'
        }`}
      >
        {done ? <CheckIcon size={11} strokeWidth={3.5} /> : null}
      </span>
      <span className={done ? 'text-text' : 'text-muted'}>{label}</span>
      {!done && actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="ml-auto rounded-token px-1.5 py-0.5 text-xs font-semibold text-accent-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          {actionLabel}
        </button>
      ) : null}
    </li>
  );
}

export function SecurityChecklist(): ReactNode {
  const { t } = useT();
  const progress = useUiProgress();
  const mark = useMarkUiProgress();
  const navigate = useUiStore((s) => s.navigate);
  const [open, setOpen] = useState(false);

  const data = progress.data;
  if (!data) return null;

  const done = 1 + (data.backupConfirmed ? 1 : 0) + (data.firstTxDone ? 1 : 0);
  const complete = done >= TOTAL;
  if (complete && data.checklistDismissed) return null;

  const remaining = TOTAL - done;

  return (
    <section
      data-testid="security-checklist"
      className="rounded-token-lg border border-border bg-surface p-3"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <ProgressRing done={done} total={TOTAL} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-text">
            {t('checklist.title')}
          </span>
          <span className="block pt-0.5 text-[11.5px] text-muted">
            {complete
              ? t('checklist.done')
              : remaining === 1
                ? t('checklist.remainingOne')
                : t('checklist.remainingMany', { count: remaining })}
          </span>
        </span>
        <span
          aria-hidden
          className={`text-muted transition-transform duration-[var(--sw-motion-base)] ${open ? 'rotate-180' : ''}`}
        >
          <ChevronDownIcon size={17} />
        </span>
      </button>

      {open ? (
        <ul className="flex flex-col pt-2.5">
          <Item testId="checklist-created" label={t('checklist.itemCreated')} done />
          <Item
            testId="checklist-backup"
            label={t('checklist.itemBackup')}
            done={data.backupConfirmed}
            actionLabel={t('checklist.go')}
            onAction={() => navigate('settings')}
          />
          <Item
            testId="checklist-firsttx"
            label={t('checklist.itemFirstTx')}
            done={data.firstTxDone}
            actionLabel={t('checklist.go')}
            onAction={() => navigate('send')}
          />
        </ul>
      ) : null}

      {complete ? (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => void mark({ checklistDismissed: true })}
            className="rounded-token px-2 py-1 text-xs font-medium text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            {t('checklist.dismiss')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
