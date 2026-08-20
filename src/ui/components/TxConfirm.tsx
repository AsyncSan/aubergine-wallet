/**
 * The confirmation dialog, invariant 5 made visible.
 *
 * Beginner mode shows only the plain-language summary, the effects and the
 * warnings. Developer mode additionally discloses the raw XDR, the numeric
 * reserve breakdown and the signer overview (§4 table).
 */
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { Mode } from '../../core/settings';
import type { RpcResult } from '../../messaging/protocol';
import { Button, Card, Notice, type NoticeTone } from './primitives';

type Description = RpcResult<'tx.describe'>;
type Snapshot = RpcResult<'account.balances'>;

const SEVERITY_TONE: Record<'info' | 'warn' | 'danger', NoticeTone> = {
  info: 'info',
  warn: 'warn',
  danger: 'danger',
};

export function TxConfirm({
  description,
  mode,
  snapshot,
  busy,
  onConfirm,
  onReject,
  confirmLabel,
  hero,
  allowSoroban = false,
}: {
  description: Description;
  mode: Mode;
  snapshot?: Snapshot | undefined;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  confirmLabel?: string;
  /**
   * Optional flow-specific summary card rendered above the plain-language
   * description (e.g. the swap "you pay / you receive at least" card). Purely
   * additive: the translated §5 sentence below stays the security-relevant
   * text and is never replaced by this.
   */
  hero?: ReactNode;
  /**
   * §4 refinement: set only by the wallet's own swap flow for an envelope the
   * background built via the aggregator (its hash is allow-listed for exactly
   * one beginner-mode signature). The dApp prompt path never sets this, so
   * external contract calls remain blocked in beginner mode, here and in
   * `tx.sign`.
   */
  allowSoroban?: boolean;
}): ReactNode {
  const { t } = useT();
  const [showXdr, setShowXdr] = useState(false);
  const isDeveloper = mode === 'developer';

  /**
   * §4 row 3: a contract call is a developer-mode capability. In beginner mode
   * the dialog explains why it will not sign, instead of showing a summary the
   * describer cannot fully translate. The background refuses it as well.
   */
  const isSoroban = description.warnings.some((w) => w.code === 'SOROBAN_INVOCATION');
  const sorobanBlocked = isSoroban && !isDeveloper && !allowSoroban;

  // Fail-closed (§5): anything we could not translate cannot be confirmed.
  const blocked = !description.translatable || sorobanBlocked;

  // Finding 5: the user must always see which network they are signing against.
  const networkLabel = description.meta.networkName
    ? t(`settings.network.${description.meta.networkName}`)
    : description.meta.network;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      {hero ?? null}
      <section className="flex flex-col gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('confirm.summary')}
        </h2>
        <Card>
          <p className="text-sm leading-relaxed text-text">
            {t(description.summary.key, description.summary.params)}
          </p>
        </Card>
      </section>

      {description.effects.length > 1 ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('confirm.operations')}
          </h2>
          <Card>
            <ol className="flex list-decimal flex-col gap-1.5 pl-4">
              {description.effects.map((effect) => (
                <li key={effect.opIndex} className="text-sm leading-relaxed text-text">
                  {t(effect.message.key, effect.message.params)}
                </li>
              ))}
            </ol>
          </Card>
        </section>
      ) : null}

      {description.warnings.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('confirm.warnings')}
          </h2>
          {description.warnings.map((warning, i) => (
            <Notice key={`${warning.code}-${i}`} tone={SEVERITY_TONE[warning.severity]}>
              {t(warning.message.key, warning.message.params)}
            </Notice>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('confirm.details')}
        </h2>
        <Card className="flex flex-col gap-1 text-xs">
          <Row label={t('confirm.network')} value={networkLabel} />
          {/*
           * "Network fee" was a promise the number could not keep: during a
           * surge the wallet bids four times the observed clearing price, and
           * Stellar then charges every transaction in the ledger the *same*
           * market price, so what stood here as the fee was in truth a
           * ceiling, up to 4× above what the user actually pays. Labelled as
           * the limit it is, with one line saying why.
           */}
          <Row label={t('confirm.feeMax')} value={`${description.meta.feeXlm} XLM`} />
          {/*
           * With more than one operation the total says little on its own,
           * the per-operation figure is the one that can be compared to
           * `BASE_FEE` and to the wallet's own ceiling. Published by
           * `tx.describe` all along, shown nowhere until now.
           */}
          {description.meta.operationCount > 1 ? (
            <Row
              label={t('confirm.feePerOperation')}
              value={`${description.meta.feePerOperationStroops} Stroops`}
            />
          ) : null}
          <Row
            label={t('confirm.source')}
            value={shorten(description.meta.source)}
            mono
          />
          {description.meta.memo ? (
            <Row label={t('confirm.memo')} value={description.meta.memo.value} />
          ) : null}
          {isDeveloper ? (
            <Row label={t('confirm.sequence')} value={description.meta.sequence} mono />
          ) : null}
        </Card>
        <p className="text-[11px] leading-relaxed text-muted">{t('confirm.feeMaxHint')}</p>
      </section>

      {/*
        The decoded contract call. Shown in *both* modes, unlike the reserve
        breakdown and the XDR below: a beginner who reaches this screen at all
        (the wallet's own swap flow, or developer mode) is being asked to
        approve a contract call, and hiding what it calls would leave exactly
        the audience least able to reconstruct it with the least information.
      */}
      {description.invocations.map((invocation) => (
        <section key={invocation.opIndex} className="flex flex-col gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('confirm.contractCall')}
          </h2>
          <Card className="flex flex-col gap-1 text-xs">
            {/*
              Not run through `shorten()`. That helper cuts to 6+6 characters,
              which is fine for the sender row (the user already knows their own
              account) and wrong here: the contract id is the one value a user
              checks character by character against the address a dApp
              published, and 6+6 is inside reach of a vanity-key generator.
              Full value, wrapped.
            */}
            {invocation.call && invocation.call.contractId !== '' ? (
              <Row label={t('confirm.contract')} value={invocation.call.contractId} mono />
            ) : null}
            {invocation.call && invocation.call.functionName !== '' ? (
              <Row label={t('confirm.function')} value={invocation.call.functionName} mono />
            ) : null}
            {invocation.executableKey ? (
              <Row label={t('confirm.executable')} value={t(invocation.executableKey)} />
            ) : null}
            {invocation.wasmHash ? (
              <Row label={t('confirm.wasmHash')} value={invocation.wasmHash} mono />
            ) : null}
            {invocation.wasmByteLength !== null ? (
              <Row
                label={t('confirm.wasmSize')}
                value={`${invocation.wasmByteLength} B`}
              />
            ) : null}

            {invocation.call ? (
              <div className="flex flex-col gap-1 pt-1">
                <span className="text-muted">{t('confirm.arguments')}</span>
                {invocation.call.args.length === 0 ? (
                  <span className="text-text">{t('confirm.noArguments')}</span>
                ) : (
                  <ol className="flex list-decimal flex-col gap-0.5 pl-4">
                    {invocation.call.args.map((arg, i) => (
                      <li key={i} className="break-all text-text">
                        <span className="text-muted">{t(arg.typeKey)}: </span>
                        <span className="font-mono">{arg.value}</span>
                        {arg.truncated ? (
                          <span className="text-muted"> ({t('confirm.argTruncated')})</span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
                {invocation.call.argsOmitted > 0 ? (
                  <span className="text-muted">
                    {t('confirm.argsOmitted', { count: invocation.call.argsOmitted })}
                  </span>
                ) : null}
              </div>
            ) : null}

            {invocation.auth.length > 0 ? (
              <div className="flex flex-col gap-1 pt-2">
                <span className="text-muted">{t('confirm.authTitle')}</span>
                {invocation.auth.map((entry, i) => (
                  <div key={i} className="flex flex-col gap-0.5">
                    <span className="text-muted">
                      {entry.credential === 'address' && entry.address !== ''
                        ? t('confirm.authAddress', { address: entry.address })
                        : t('confirm.authSourceAccount')}
                    </span>
                    <ul className="flex flex-col gap-0.5">
                      {entry.invocations.map((node, j) => (
                        <li
                          key={j}
                          className="break-all font-mono text-text"
                          /* Indentation carries the tree depth; the list is
                             breadth-first, so a sibling never disappears
                             behind another branch's sub-tree. */
                          style={{ paddingLeft: `${node.depth * 10}px` }}
                        >
                          {node.contractId === '' ? '—' : node.contractId}
                          {node.functionName === '' ? '' : ` · ${node.functionName}`}
                        </li>
                      ))}
                    </ul>
                    {entry.nodesOmitted > 0 ? (
                      <span className="text-muted">
                        {t('confirm.authNodesOmitted', { count: entry.nodesOmitted })}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
          <p className="text-[11px] leading-relaxed text-muted">
            {t('confirm.contractCallHint')}
          </p>
        </section>
      ))}

      {/* §4: numeric reserve breakdown is a developer-mode surface. */}
      {isDeveloper && snapshot ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('confirm.reserveBreakdown')}
          </h2>
          <Card className="flex flex-col gap-1 text-xs">
            <Row
              label={t('confirm.reserveBase')}
              value={`${snapshot.reserves.baseReserveXlm} XLM`}
            />
            <Row
              label={t('confirm.reserveEntries')}
              value={String(snapshot.reserves.subentryCount)}
            />
            <Row
              label={t('confirm.reserveTotal')}
              value={`${snapshot.reserves.totalReservedXlm} XLM`}
            />
          </Card>
        </section>
      ) : null}

      {/* §4: signer overview, display only in phase 1. */}
      {isDeveloper && snapshot && snapshot.signers.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('confirm.signers')}
          </h2>
          <Card className="flex flex-col gap-1 text-xs">
            {snapshot.signers.map((signer) => (
              <Row
                key={signer.key}
                label={shorten(signer.key)}
                value={t('confirm.signerWeight', { weight: signer.weight })}
                mono
              />
            ))}
            <p className="pt-1 text-[11px] text-muted">
              {t('confirm.thresholds', {
                low: snapshot.thresholds.low,
                medium: snapshot.thresholds.medium,
                high: snapshot.thresholds.high,
              })}
            </p>
          </Card>
        </section>
      ) : null}

      {/* §4: raw XDR disclosure, developer mode only. */}
      {isDeveloper ? (
        <section className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowXdr((v) => !v)}
            className="self-start text-xs font-medium text-accent-fg"
          >
            {showXdr ? t('confirm.hideXdr') : t('confirm.showXdr')}
          </button>
          {showXdr ? (
            <Card>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-tight text-muted">
                {description.raw}
              </pre>
            </Card>
          ) : null}
        </section>
      ) : null}

      {sorobanBlocked ? (
        <Notice tone="warn">
          <strong className="block pb-1">{t('soroban.blocked.title')}</strong>
          {t('soroban.blocked.body')}
        </Notice>
      ) : null}

      {blocked && !sorobanBlocked ? (
        <Notice tone="danger">{t('confirm.blocked')}</Notice>
      ) : null}

      <div className="sticky bottom-0 mt-auto flex gap-2 bg-bg pt-3">
        <Button tone="secondary" className="flex-1" onClick={onReject} disabled={busy}>
          {t('confirm.reject')}
        </Button>
        <Button
          tone="primary"
          className="flex-1"
          onClick={onConfirm}
          disabled={busy || blocked}
        >
          {confirmLabel ?? t('confirm.submit')}
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted">{label}</span>
      <span className={`min-w-0 break-all text-right text-text ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function shorten(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}
