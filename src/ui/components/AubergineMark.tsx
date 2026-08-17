/**
 * The brand mark: an aubergine standing in a wallet.
 *
 * Direct port of the website's AubergineMark.astro, which itself carries the
 * micro geometry of brand/logo-explore/01-slot.svg at every size. One geometry
 * for all sizes is deliberate; the header mark, the Unlock mark and the
 * toolbar icon must be the same shape, not three cousins.
 *
 * Colours are literal, not theme tokens: the mark has to hold on both brand
 * grounds without a light/dark variant (checked in brand/logo-explore/preview/),
 * and wiring it to --sw-* would break it the moment the palette moved. The
 * royal blue wallet is part of the mark itself, mirroring the 3D renders'
 * blue leather wallet; it is not a leftover of the old blue UI accent.
 *
 * No gradients on purpose: at 22 px a gradient is invisible, and every
 * gradient needs an id, which collides as soon as the mark appears twice.
 */
import type { ReactNode } from 'react';

export function AubergineMark({
  size = 24,
  className = '',
}: {
  size?: number;
  className?: string;
}): ReactNode {
  /** Stitching and clasp are noise below this (see the 16 px pixel proof). */
  const detailed = size >= 32;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden
      focusable={false}
      className={`shrink-0 ${className}`}
    >
      <rect x="6" y="35" width="52" height="22" rx="6" fill="#2B62C4" />
      <path
        d="M27.5 11c-2.2 4.6-2.4 7.9-3.7 11.2-1.7 4.1-2.9 7.6-2.6 11.8.4 7.5 5.5 12.6 10.8 12.6s10.4-5.1 10.8-12.6c.2-4.2-1-7.7-2.6-11.8-1.3-3.3-1.5-6.6-3.7-11.2-1.8-1.5-7.2-1.5-9 0z"
        fill="#7B34A8"
      />
      <g fill="#2ED3A0">
        <ellipse cx="32" cy="13" rx="5.6" ry="3.6" />
        <path d="M31 10.5c-6 1-10.4 4.6-11.7 10.2 4.7-1.3 9-4.2 12-8z" />
        <path d="M31.5 12c-4.3 2.3-7.2 6.5-7.7 12.4 3.5-2.3 6.2-5.8 7.9-9.6z" />
        <path d="M33 10.5c6 1 10.4 4.6 11.7 10.2-4.7-1.3-9-4.2-12-8z" />
        <path d="M32.5 12c4.3 2.3 7.2 6.5 7.7 12.4-3.5-2.3-6.2-5.8-7.9-9.6z" />
      </g>
      <path d="M32 12L33.2 5" stroke="#2ED3A0" strokeWidth="3.4" strokeLinecap="round" />
      <path
        d="M6 39c8.5 0 12.5 4 26 4s17.5-4 26-4v12a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6z"
        fill="#4C8DFF"
      />
      {detailed ? (
        <>
          <path
            d="M13 51.5h29"
            stroke="#CFE0FF"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="2.4 3"
            opacity="0.45"
          />
          <path d="M47 44h9a3.5 3.5 0 0 1 0 7h-9z" fill="#2B62C4" />
          <circle cx="51.5" cy="47.5" r="2" fill="#CFE0FF" />
        </>
      ) : null}
    </svg>
  );
}
