/**
 * Origin approval and dApp signing prompt (§4 / invariant 5, 7).
 *
 * Only reachable in developer mode, because the content script that produces
 * these requests is not registered otherwise.
 */
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { api } from '../../messaging/client';
import type { RpcResult } from '../../messaging/protocol';
import type { Settings } from '../../core/settings';
import { useDescribeTx } from '../../state/queries';
import { Button, Card, Notice, ScreenHeader, Spinner } from '../components/primitives';
import { TxConfirm } from '../components/TxConfirm';

type Prompt = NonNullable<RpcResult<'dapp.pendingPrompt'>>;

/** G-address in the compact 6…6 form also used by TxConfirm. */
function shortKey(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

export function DappPrompt({
  prompt,
  settings,
  onResolved,
}: {
  prompt: Prompt;
  settings: Settings;
  onResolved: () => void;
}): ReactNode {
  const { t } = useT();
  /**
   * Finding 5: hand the network the page declared to the describer, so a
   * mismatch with the wallet's network surfaces as a danger warning.
   *
   * And describe the envelope in the *signing* account's context. The page
   * picks the signer via `accountToSign`; describing against the selected
   * account instead let it choose which account's trustlines the warnings were
   * computed from, enough to suppress the UNKNOWN_ISSUER scam-asset warning
   * on demand and to show a bogus FOREIGN_SOURCE_ACCOUNT for a transaction
   * whose source *is* the signer.
   */
  const description = useDescribeTx(
    prompt.kind === 'sign' ? prompt.xdr : null,
    prompt.declaredNetworkPassphrase,
    prompt.signerAccountIndex,
  );

  function resolve(approved: boolean): void {
    void api.resolvePrompt(prompt.requestId, approved).finally(onResolved);
  }

  if (prompt.kind === 'connect') {
    return (
      <div className="flex h-full flex-col gap-3">
        <ScreenHeader title={t('dapp.title')} />
        <Card>
          <p className="break-all text-sm text-text">
            {t('dapp.connectBody', { origin: prompt.origin })}
          </p>
        </Card>
        {!settings.allowedOrigins.includes(prompt.origin) ? (
          <Notice tone="warn">{t('dapp.unknownOrigin')}</Notice>
        ) : null}
        <div className="mt-auto flex gap-2">
          <Button tone="secondary" className="flex-1" onClick={() => resolve(false)}>
            {t('dapp.reject')}
          </Button>
          <Button className="flex-1" onClick={() => resolve(true)}>
            {t('dapp.approve')}
          </Button>
        </div>
      </div>
    );
  }

  if (description.isLoading) return <Spinner />;

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={t('dapp.title')} />
      <Card className="mb-3">
        <p className="break-all text-xs text-muted">
          {t('dapp.signBody', { origin: prompt.origin })}
        </p>
        {/* P2: show exactly which account the page's `accountToSign` selects,
            so "approve" never signs with an account the user did not see. */}
        {prompt.signerPublicKey ? (
          <p className="pt-1.5 text-xs font-semibold text-text" title={prompt.signerPublicKey}>
            {t('dapp.signingAs', { account: shortKey(prompt.signerPublicKey) })}
          </p>
        ) : null}
      </Card>
      {prompt.signerIsSelected === false ? (
        <div className="mb-3">
          <Notice tone="warn">{t('dapp.signingAsOther')}</Notice>
        </div>
      ) : null}
      {description.data ? (
        <TxConfirm
          description={description.data}
          mode={settings.mode}
          busy={false}
          onConfirm={() => resolve(true)}
          onReject={() => resolve(false)}
        />
      ) : (
        <>
          <Notice tone="danger">{t('tx.warn.UNPARSEABLE_TRANSACTION')}</Notice>
          <Button tone="secondary" className="mt-auto" onClick={() => resolve(false)}>
            {t('dapp.reject')}
          </Button>
        </>
      )}
    </div>
  );
}
