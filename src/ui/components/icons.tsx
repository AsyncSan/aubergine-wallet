/**
 * Inline SVG icon set (UI redesign v1.1, docs/ui-redesign-konzept.md).
 *
 * All icons are inlined as React components on a 24px grid with
 * `stroke="currentColor"` so they inherit the text color of their parent.
 * No icon font, no CDN, no remote request of any kind (invariants 3 & 4,
 * AMO source review): this file is the complete icon inventory.
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...props }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

export function HomeIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="m3 10.5 9-7 9 7V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20Z" />
    </svg>
  );
}

export function HistoryIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.51 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.04A1.7 1.7 0 0 0 10.03 3.1V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.04c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51.97Z" />
    </svg>
  );
}

/** Receive: arrow down onto a baseline. */
export function ReceiveIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M12 4v13" />
      <path d="m6 11 6 6 6-6" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** Send: arrow up from a baseline. */
export function SendIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M12 20V7" />
      <path d="m6 13 6-6 6 6" />
      <path d="M5 3h14" />
    </svg>
  );
}

/** Buy: coin with a euro-ish stroke, deliberately currency-neutral. */
export function BuyIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 9.2A4.1 4.1 0 0 0 12.6 8C10.6 8 9 9.8 9 12s1.6 4 3.6 4c1.1 0 2.1-.5 2.9-1.2" />
      <path d="M7.5 10.8h4.4M7.5 13.2h4.4" />
    </svg>
  );
}

export function LockIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function CopyIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function CheckIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function PlusIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronLeftIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="m14 6-6 6 6 6" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="m6 10 6 6 6-6" />
    </svg>
  );
}

/**
 * XLM mark for the native-asset row: a stylised orbit slash, close enough to
 * evoke Stellar without reproducing the trademarked logo geometry.
 */
export function InfoIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function XIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  );
}

export function MoreIcon(props: IconProps): ReactNode {
  const { size = 20, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable={false}
      {...rest}
    >
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </svg>
  );
}

/** Swap: two opposing horizontal arrows. */
export function SwapIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M4 8h14" />
      <path d="m15 4.5 3.5 3.5-3.5 3.5" />
      <path d="M20 16H6" />
      <path d="m9 12.5-3.5 3.5L9 19.5" />
    </svg>
  );
}

export function ShareIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="m16 6-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}

export function StellarIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M21 5 3 12l18 7" />
      <path d="M3 12h18" opacity={0.45} />
    </svg>
  );
}

/** Sliders: the "Memo & options" disclosure on the send form. */
export function SlidersIcon(props: IconProps): ReactNode {
  return (
    <svg {...base(props)}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}
