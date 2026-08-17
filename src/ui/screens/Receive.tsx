/**
 * Receive (redesign v1.1, P2): the QR code is the hero of this screen.
 *
 * The QR is generated locally with `qrcode-generator` (pure JS, no network,
 * no canvas) and rendered as inline SVG, invariant 3 rules out any CDN.
 * Sharing prefers the native share sheet where the browser has one
 * (navigator.share) and falls back to copying the address, the fallback is
 * the common case on desktop Linux/Chromium, so it gets the same visible
 * "Kopiert" feedback as the copy pill.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { useT } from '../../i18n';
import type { RpcResult } from '../../messaging/protocol';
import { isMainnetActive, type Settings } from '../../core/settings';
import {
  Button,
  CopyableAddress,
  Notice,
  ScreenHeader,
  Spinner,
  copyToClipboard,
  type CopyState,
} from '../components/primitives';
import { ShareIcon } from '../components/icons';

type Accounts = RpcResult<'account.list'>;

function useQrPath(value: string): { path: string; size: number } | null {
  return useMemo(() => {
    if (!value) return null;
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { path: parts.join(''), size: count };
  }, [value]);
}

export function Receive({
  accounts,
  settings,
  onExit,
}: {
  accounts: Accounts;
  settings: Settings;
  onExit: () => void;
}): ReactNode {
  const { t } = useT();
  const account =
    accounts.accounts.find((a) => a.index === accounts.selectedIndex) ?? accounts.accounts[0];
  const qr = useQrPath(account?.publicKey ?? '');
  const [sharedFeedback, setSharedFeedback] = useState<CopyState>('idle');

  useEffect(() => {
    if (sharedFeedback === 'idle') return;
    const timer = setTimeout(() => setSharedFeedback('idle'), 1_800);
    return () => clearTimeout(timer);
  }, [sharedFeedback]);

  if (!account || !qr) return <Spinner />;

  async function share(): Promise<void> {
    if (!account) return;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: account.publicKey });
        return;
      } catch {
        // The user closed the share sheet; that is not an error.
        return;
      }
    }
    // A refused clipboard is reported, not swallowed into an unhandled
    // rejection (finding 9).
    setSharedFeedback((await copyToClipboard(account.publicKey)) ? 'copied' : 'failed');
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <ScreenHeader title={t('receive.title')} onBack={onExit} />
      <p className="text-center text-sm text-muted">{t('receive.body')}</p>

      {/* Hero: the QR code, on the same whisper of accent as the balance hero. */}
      <div
        className="flex justify-center rounded-token-lg py-3"
        style={{
          background:
            'radial-gradient(85% 85% at 50% 30%, color-mix(in srgb, var(--sw-accent) 12%, transparent), transparent 75%)',
        }}
      >
        <div className="sw-pop rounded-token-lg bg-white p-3.5 shadow-lg shadow-black/20">
          <svg
            role="img"
            data-testid="receive-qr"
            aria-label={t('receive.qrAlt')}
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            className="block h-48 w-48"
            shapeRendering="crispEdges"
          >
            {/* Plum near-black from the new palette; the QR stays on a white
                card in both themes, so contrast for scanners is unchanged. */}
            <path d={qr.path} fill="#12060F" />
          </svg>
        </div>
      </div>

      <CopyableAddress value={account.publicKey} />

      <Button tone="secondary" className="flex items-center justify-center gap-2" onClick={() => void share()}>
        <ShareIcon size={17} />
        {sharedFeedback === 'copied'
          ? t('app.copied')
          : sharedFeedback === 'failed'
            ? t('app.copyFailed')
            : t('receive.share')}
      </Button>

      <div className="mt-auto flex flex-col gap-2 pb-1">
        {/* Effective network, not the stored one: an unacknowledged
            `networkId: 'mainnet'` still means Testnet funds (§4 gate). */}
        {!isMainnetActive(settings) ? (
          <Notice tone="warn">{t('receive.warning')}</Notice>
        ) : (
          <Notice tone="info">{t('receive.onlyStellar')}</Notice>
        )}
      </div>
    </div>
  );
}
