/**
 * The third outcome, on screen: "we do not know".
 *
 * Shared by Send, Swap and AddAsset because all three had the same hole, a
 * submission that timed out or hit a 5xx landed in the ordinary error branch,
 * the user read "the network cannot be reached right now", pressed Back and
 * sent again. `tx.build` then fetched a *fresh* sequence number, and if the
 * first transaction did make it into a ledger, both payments went through.
 *
 * Two rules this component exists to enforce:
 *
 * 1. **No route to a second transaction while the outcome is open.** There is
 *    no back arrow, no "send another", no reject button, only "close". The
 *    retry button appears exclusively once the network has answered in a way
 *    that proves nothing was applied (`expired`, or included-and-failed).
 * 2. **The hash is on screen.** It is the only handle the user has on a
 *    payment nobody can confirm yet, and it is what a support request or a
 *    block explorer needs. Same presentation as the success screen.
 */
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import type { RpcResult } from '../../messaging/protocol';
import { Button, Card, Notice, ScreenHeader } from './primitives';

type Status = RpcResult<'tx.status'>;

/**
 * What the screen shows, derived from the resolution poll.
 *
 * `checking` and `open` differ only in wording: `checking` means the lookup
 * itself has not answered yet, `open` means it answered "not in a ledger, and
 * it still can be". Neither offers a retry.
 */
export type SubmitResolution =
  | 'checking'
  | 'open'
  | 'expired'
  | 'included-success'
  | 'included-failed';

/** Map one `tx.status` answer to what the user is told. Pure, so it is testable. */
export function resolutionOf(status: Status | undefined): SubmitResolution {
  if (status === undefined) return 'checking';
  switch (status.state) {
    case 'included':
      // `successful === null` cannot happen for an included transaction, but a
      // missing flag must not be read as "it worked".
      return status.successful === true ? 'included-success' : 'included-failed';
    case 'expired':
      return 'expired';
    case 'pending':
      return 'open';
    default:
      // The lookup failed. Still no answer, never a licence to retry.
      return 'checking';
  }
}

/** True exactly when the network has proven that nothing was applied. */
export function mayRetry(resolution: SubmitResolution): boolean {
  return resolution === 'expired' || resolution === 'included-failed';
}

export function SubmitUnknown({
  hash,
  resolution,
  onClose,
  onRetry,
}: {
  hash: string;
  resolution: SubmitResolution;
  onClose: () => void;
  /**
   * Rebuilds a fresh transaction. Rendered *only* when {@link mayRetry} holds,
   * this is the one place the double-payment guard lives in the UI.
   */
  onRetry?: () => void;
}): ReactNode {
  const { t } = useT();
  const retryAllowed = mayRetry(resolution) && onRetry !== undefined;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      {/* No `onBack`: the way back into the form is exactly what must not exist. */}
      <ScreenHeader title={t('submit.unknown.title')} />

      <Notice tone="warn">
        <strong className="block pb-1">{t('submit.unknown.headline')}</strong>
        {t('submit.unknown.body')}
      </Notice>

      <div>
        <p className="pb-1 text-xs text-muted">{t('send.viewHash')}</p>
        <Card>
          <p className="break-all font-mono text-[10px] text-text" data-testid="pending-hash">
            {hash}
          </p>
        </Card>
      </div>

      {resolution === 'checking' || resolution === 'open' ? (
        <p className="text-xs leading-relaxed text-muted">{t('submit.unknown.checking')}</p>
      ) : null}
      {resolution === 'expired' ? (
        <Notice tone="info">{t('submit.unknown.expired')}</Notice>
      ) : null}
      {resolution === 'included-failed' ? (
        <Notice tone="danger">{t('submit.unknown.rejected')}</Notice>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">{t('submit.unknown.ifYouClose')}</p>

      <div className="mt-auto flex gap-2 pt-3">
        {retryAllowed ? (
          <Button tone="secondary" className="flex-1" onClick={onRetry}>
            {t('submit.unknown.retry')}
          </Button>
        ) : null}
        <Button className="flex-1" onClick={onClose}>
          {t('app.close')}
        </Button>
      </div>
    </div>
  );
}
