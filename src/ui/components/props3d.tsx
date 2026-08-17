/**
 * The website's rendered 3D props (website/src/assets/3d/, one shared style
 * contract in website/scripts/assetgen/gen.mjs) at popup scale. The webp files
 * are copied into src/assets/3d/ and bundled by Vite; nothing is fetched at
 * runtime (invariants 3 & 4).
 *
 * Kept in its own module so primitives.tsx stays importable from the node-env
 * unit tests without asset imports.
 *
 * Every prop is decorative: it repeats what the neighbouring heading already
 * says, so it is hidden from assistive technology.
 */
import type { ReactNode } from 'react';
import walletHeroUrl from '../../assets/3d/wallet-hero.webp';
import iceCoinUrl from '../../assets/3d/ice-coin.webp';
import historyHourglassUrl from '../../assets/3d/history-hourglass.webp';

export const PROPS_3D = {
  /** The brand motif itself: the aubergine standing in its blue leather wallet. */
  walletHero: walletHeroUrl,
  /** Frosted mint coin, money that is calm, not loud. Empty asset list. */
  iceCoin: iceCoinUrl,
  /** Hourglass; nothing has happened yet. Empty history. */
  historyHourglass: historyHourglassUrl,
} as const;

export function Prop3d({
  name,
  size = 120,
  float = true,
  glow = true,
  className = '',
}: {
  name: keyof typeof PROPS_3D;
  size?: number;
  /** Idle bob; pauses automatically under prefers-reduced-motion (style.css). */
  float?: boolean;
  /** Soft aubergine pool behind the prop, as on the website. */
  glow?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span
      aria-hidden
      className={`relative isolate inline-grid shrink-0 place-items-center ${className}`}
      style={{ width: size, height: size }}
    >
      {glow ? (
        <span
          className="pointer-events-none absolute inset-0 -z-10 rounded-full blur-2xl"
          style={{
            background:
              'radial-gradient(circle at 50% 55%, color-mix(in oklab, var(--sw-accent) 38%, transparent) 0%, transparent 62%)',
          }}
        />
      ) : null}
      <img
        src={PROPS_3D[name]}
        width={size}
        height={size}
        alt=""
        decoding="async"
        draggable={false}
        className={float ? 'sw-float h-auto w-full select-none' : 'h-auto w-full select-none'}
      />
    </span>
  );
}
