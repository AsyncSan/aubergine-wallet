/**
 * Shared UI primitives. Tailwind v4 utility classes bound to the design tokens
 * from `brand/tokens.json` (ARCHITECTURE.md §7).
 */
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { formatAmount, useT } from '../../i18n';
import { ChevronDownIcon, StellarIcon, XIcon } from './icons';

type ButtonTone = 'primary' | 'secondary' | 'danger' | 'ghost';

const TONE_CLASSES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110 disabled:opacity-40',
  secondary: 'bg-surface border border-border text-text hover:border-accent disabled:opacity-40',
  danger: 'bg-danger text-[#1a0606] hover:brightness-110 disabled:opacity-40',
  ghost: 'text-muted hover:text-text',
};

export function Button({
  tone = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }): ReactNode {
  return (
    <button
      {...props}
      className={`sw-press rounded-token px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${TONE_CLASSES[tone]} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text">{label}</span>
      {children}
      {hint && !error ? <span className="text-xs text-muted">{hint}</span> : null}
      {error ? (
        <span className="text-xs text-danger-fg" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function TextInput({
  className = '',
  ...props
}: ComponentPropsWithRef<'input'>): ReactNode {
  return (
    <input
      {...props}
      className={`w-full rounded-token border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none ${className}`}
    />
  );
}

export function TextArea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return (
    <textarea
      {...props}
      className={`w-full rounded-token border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none ${className}`}
    />
  );
}

export function Select({
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      {...props}
      className={`w-full rounded-token border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none ${className}`}
    />
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={`rounded-token border border-border bg-surface p-3 ${className}`}>
      {children}
    </div>
  );
}

/**
 * Circular icon action (redesign v1.1): the Phantom-style action row on Home.
 * The visible label is part of the button, so the accessible name stays the
 * plain word ("Senden") that both users and the E2E suite rely on.
 */
export function ActionButton({
  icon,
  label,
  primary = false,
  onClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
  testId: string;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="group flex w-16 flex-col items-center gap-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-full border transition-all duration-[var(--sw-motion-fast)] group-hover:-translate-y-0.5 group-active:scale-95 ${
          primary
            ? 'border-accent bg-accent text-on-accent group-hover:brightness-110'
            : 'border-border bg-surface text-accent-fg group-hover:border-accent group-hover:bg-surface2'
        }`}
      >
        {icon}
      </span>
      <span className="text-[11.5px] font-medium text-muted transition-colors duration-[var(--sw-motion-fast)] group-hover:text-text">
        {label}
      </span>
    </button>
  );
}

/**
 * Deterministic token icon (redesign v1.1, P0 "Token-Zeilen").
 *
 * Native XLM gets the brand gradient with the Stellar glyph; every other
 * asset gets an initial on a solid colour picked deterministically from
 * `code:issuer`. All colours are dark enough for white text in both light
 * and dark mode, and the icon is decorative; the asset code is always
 * rendered as real text right next to it. No remote favicon/logo service
 * (invariants 3 & 4): everything is generated locally.
 */
const ASSET_ICON_COLORS = [
  '#2775ca', // USDC-ish blue
  '#7b2fb8', // brand aubergine (deep, white text stays AA)
  '#0e8a6d', // teal
  '#b7791f', // amber
  '#c0392b', // red
  '#b23a78', // magenta
  '#54678f', // slate
  '#3f7d33', // green
] as const;

function assetIconColor(code: string, issuer: string | null): string {
  const key = `${code}:${issuer ?? ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return ASSET_ICON_COLORS[hash % ASSET_ICON_COLORS.length] ?? ASSET_ICON_COLORS[0];
}

export function AssetIcon({
  code,
  issuer,
  isNative,
  size = 38,
}: {
  code: string;
  issuer: string | null;
  isNative: boolean;
  size?: number;
}): ReactNode {
  const style = { width: size, height: size };
  if (isNative) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-full text-white"
        style={{
          ...style,
          /* Aubergine leaning toward ice at the end; the brand gradient. */
          background:
            'linear-gradient(135deg, var(--sw-accent), color-mix(in srgb, var(--sw-accent) 40%, var(--sw-ice)))',
        }}
      >
        <StellarIcon size={Math.round(size * 0.52)} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
      style={{ ...style, backgroundColor: assetIconColor(code, issuer) }}
    >
      {code.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * Asset row (redesign v1.1): round icon, code + readable name, balance right.
 * Deliberately no fiat value yet; that needs a price source and a privacy
 * review first (v1.2), and a fake placeholder would fail the bank test.
 */
export function TokenRow({
  icon,
  code,
  name,
  amount,
  testId,
  onClick,
}: {
  icon: ReactNode;
  code: string;
  name?: ReactNode;
  amount: string;
  testId?: string;
  /** P3: with a handler the row becomes a real button opening asset details. */
  onClick?: () => void;
}): ReactNode {
  const className =
    'sw-lift flex w-full items-center gap-3 rounded-token-lg border border-border bg-surface px-3 py-2.5 text-left hover:bg-surface2';
  const content = (
    <>
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{code}</p>
        {name ? <p className="truncate text-[11.5px] text-muted">{name}</p> : null}
      </div>
      <p className="shrink-0 text-sm font-semibold tabular-nums text-text">{amount}</p>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className={`${className} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}
      >
        {content}
      </button>
    );
  }
  return (
    <div data-testid={testId} className={className}>
      {content}
    </div>
  );
}

/**
 * Progressive disclosure ("Memo & Optionen"): keeps secondary inputs out of
 * the way without removing them. Content is unmounted while closed, so the
 * E2E rule "developer-only fields are not in the beginner DOM" keeps holding.
 */
export function Disclosure({
  label,
  icon,
  defaultOpen = false,
  children,
}: {
  label: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    /**
     * `shrink-0` matters: inside a `flex-col` screen that scrolls, a flex
     * child may be compressed below its content height, and with
     * `overflow-hidden` that clipped the open disclosure instead of letting
     * the screen scroll (seen on the Swap form on a real device).
     */
    <div className="shrink-0 overflow-hidden rounded-token-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-[13px] font-semibold text-muted transition-colors duration-[var(--sw-motion-fast)] hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {icon}
        {label}
        <span
          className={`ml-auto transition-transform duration-[var(--sw-motion-fast)] ${open ? 'rotate-180' : ''}`}
        >
          <ChevronDownIcon size={15} />
        </span>
      </button>
      {open ? <div className="flex flex-col gap-2.5 px-3.5 pb-3.5">{children}</div> : null}
    </div>
  );
}

/**
 * Drawn success check (redesign v1.1): circle and check mark draw themselves
 * in via stroke-dashoffset keyframes (entrypoints/popup/style.css). With
 * prefers-reduced-motion the final frame is shown immediately.
 */
export function AnimatedCheck({ size }: { size?: number }): ReactNode {
  return (
    <svg
      className="sw-check"
      style={size === undefined ? undefined : { width: size, height: size }}
      viewBox="0 0 100 100"
      aria-hidden
      focusable={false}
    >
      <circle className="c" cx="50" cy="50" r="45" />
      <path className="m" d="M32 51 45 64 69 39" />
    </svg>
  );
}

/**
 * Circular progress (redesign v1.1, P1 "Sicherheits-Checkliste"). Decorative,
 * the fraction is always rendered as real text inside the ring, so screen
 * readers and the E2E suite read "2/3", never the stroke offset.
 */
export function ProgressRing({
  done,
  total,
  size = 40,
}: {
  done: number;
  total: number;
  size?: number;
}): ReactNode {
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <svg aria-hidden focusable={false} width={size} height={size} viewBox="0 0 40 40" className="-rotate-90">
        <circle cx="20" cy="20" r={radius} fill="none" stroke="var(--sw-surface2)" strokeWidth="4" />
        <circle
          cx="20"
          cy="20"
          r={radius}
          fill="none"
          stroke="var(--sw-success)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset var(--sw-motion-base) ease' }}
        />
      </svg>
      <span
        data-testid="progress-ring-count"
        className="absolute inset-0 flex items-center justify-center text-[10.5px] font-semibold text-success-fg"
      >
        {done}/{total}
      </span>
    </span>
  );
}

/**
 * Onboarding journey header (redesign v1.1, P1): "Schritt n von 3" above a
 * thin animated bar. The step label is the accessible progress signal; the
 * bar itself is decorative.
 */
export function StepProgress({ step, total }: { step: number; total: number }): ReactNode {
  const { t } = useT();
  const percent = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1.5 pb-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
        {t('onboarding.progress', { step, total })}
      </span>
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-surface2">
        <div
          className="h-full rounded-full"
          style={{
            width: `${percent}%`,
            background:
              'linear-gradient(90deg, var(--sw-accent), color-mix(in srgb, var(--sw-accent) 40%, var(--sw-ice)))',
            transition: 'width 450ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </div>
    </div>
  );
}

/**
 * One-shot confetti burst, onboarding completion ONLY (konzept §7: the
 * "bank test" allows this exactly once, never on transactions). Pure local
 * canvas, no library; skipped entirely under prefers-reduced-motion.
 */
export function ConfettiBurst(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const colors = ['#a855f7', '#9be7d2', '#c77dff', '#2ed3a0', '#ffb020'];
    const parts = Array.from({ length: 80 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 3 + Math.random() * 5.5;
      return {
        x: 180,
        y: 220,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - 3,
        gravity: 0.12 + Math.random() * 0.08,
        size: 3 + Math.random() * 4,
        color: colors[Math.floor(Math.random() * colors.length)] ?? '#a855f7',
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        life: 70 + Math.random() * 40,
      };
    });

    let frame = 0;
    let handle = 0;
    const tick = (): void => {
      ctx.clearRect(0, 0, 360, 600);
      frame += 1;
      let alive = false;
      for (const p of parts) {
        if (frame > p.life) continue;
        alive = true;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.985;
        p.rotation += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.globalAlpha = Math.max(0, 1 - frame / p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (alive) handle = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, 360, 600);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={360}
      height={600}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50"
    />
  );
}

/**
 * Decimal places the count-up animation should hold, derived from the target
 * value so an integer balance never flickers through fake cents. Exported for
 * unit tests.
 */
export function countUpDecimals(target: number): number {
  if (!Number.isFinite(target)) return 0;
  const text = String(target);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(7, text.length - dot - 1);
}

/**
 * Count-up number (redesign v1.1, P2 "Micro-Interactions"): the balance counts
 * from its previous value (0 on first load) to the new one in ≤400 ms. The
 * final frame is ALWAYS the exact `formatAmount` of the original string, the
 * animation only ever touches intermediate frames, so nothing the user keeps
 * seeing was produced by float math. No animation under prefers-reduced-motion,
 * and non-numeric input is rendered verbatim, exactly like `formatAmount`.
 */
export function CountUpAmount({ value }: { value: string }): ReactNode {
  const { locale } = useT();
  const [display, setDisplay] = useState(() => formatAmount(locale, 0));
  const fromRef = useRef(0);

  useEffect(() => {
    const target = Number(value);
    const finalText = formatAmount(locale, value);
    const reduceMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!Number.isFinite(target) || reduceMotion || fromRef.current === target) {
      fromRef.current = Number.isFinite(target) ? target : 0;
      setDisplay(finalText);
      return;
    }
    const from = fromRef.current;
    const decimals = countUpDecimals(target);
    const started = performance.now();
    const DURATION_MS = 400;
    let handle = 0;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - started) / DURATION_MS);
      if (progress >= 1) {
        fromRef.current = target;
        setDisplay(finalText);
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(formatAmount(locale, from + (target - from) * eased, decimals));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [value, locale]);

  return <>{display}</>;
}

/**
 * Countdown ring (redesign v1.1, P2 "Unlock-Politur"): the friendly face of
 * the H1 unlock throttle. The remaining seconds are real text (and the
 * accessible signal); the draining ring is decorative. Warn tone, not danger,
 * the wallet is protecting the user, not scolding them.
 */
export function CountdownRing({
  remaining,
  total,
  size = 96,
}: {
  remaining: number;
  total: number;
  size?: number;
}): ReactNode {
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        aria-hidden
        focusable={false}
        width={size}
        height={size}
        viewBox="0 0 40 40"
        className="-rotate-90"
      >
        <circle cx="20" cy="20" r={radius} fill="none" stroke="var(--sw-surface2)" strokeWidth="3" />
        <circle
          cx="20"
          cy="20"
          r={radius}
          fill="none"
          stroke="var(--sw-warn)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <span
        aria-live="polite"
        data-testid="unlock-throttle-seconds"
        className="absolute inset-0 flex flex-col items-center justify-center leading-none"
      >
        <span className="text-xl font-bold tabular-nums text-text">{remaining}</span>
        <span className="pt-0.5 text-[10px] font-medium text-muted">s</span>
      </span>
    </span>
  );
}

/**
 * Bottom sheet (redesign v1.1, P3 "Bottom-Sheets").
 *
 * Renders nothing while closed, content stays out of the DOM, so the E2E
 * rule "developer-only details are not in the beginner DOM" keeps holding for
 * everything a sheet carries. Backdrop click, the X button and Escape all
 * close it; the close button takes focus on open so keyboard users are inside
 * the dialog immediately. The popup is a fixed 360×600 surface, so a plain
 * `fixed inset-0` overlay covers exactly the whole UI.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  const { t } = useT();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" data-testid={testId}>
      <button
        type="button"
        aria-label={t('app.close')}
        tabIndex={-1}
        onClick={onClose}
        className="sw-sheet-backdrop absolute inset-0 h-full w-full cursor-default bg-black/55"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sw-sheet-panel sw-glass sw-edge-light absolute inset-x-0 bottom-0 flex max-h-[520px] flex-col rounded-t-[20px] border-t border-border"
      >
        <div aria-hidden className="flex justify-center pb-1 pt-2.5">
          <span className="h-1 w-9 rounded-full bg-surface2" />
        </div>
        <div className="flex items-center gap-2 px-4 pb-2">
          <h2 className="flex-1 text-base font-semibold text-text">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('app.close')}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors duration-[var(--sw-motion-fast)] hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <XIcon size={17} />
          </button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-5 pt-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * Deterministic identicon from the account's public key (redesign v1.1,
 * Mockup-Rest "Home-Kopf"): a 5×5 vertically mirrored pixel pattern, GitHub
 * style, generated locally as inline SVG; no canvas, no external service
 * (invariants 3 & 4). Decorative only: the address itself is always real
 * text right next to it.
 */
const IDENTICON_COLORS = [
  '#a855f7',
  '#7b2fb8',
  '#2ed3a0',
  '#b7791f',
  '#c0392b',
  '#b23a78',
  '#0e8a6d',
  '#54678f',
] as const;

export function Identicon({ value, size = 26 }: { value: string; size?: number }): ReactNode {
  // FNV-1a over the key: cheap, stable, and spread well enough for 25 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash ^ value.charCodeAt(i)) * 0x01000193) >>> 0;
  }
  const color = IDENTICON_COLORS[hash % IDENTICON_COLORS.length] ?? IDENTICON_COLORS[0];
  const cells: string[] = [];
  let bits = hash;
  for (let col = 0; col < 3; col += 1) {
    for (let row = 0; row < 5; row += 1) {
      // Re-mix per cell so the pattern is not just the same 32 bits repeated.
      bits = (bits * 1103515245 + 12345) >>> 0;
      if ((bits & 0x40000000) !== 0) {
        // Shift by +1: one blank cell of margin inside the 7×7 viewBox.
        cells.push(`M${col + 1} ${row + 1}h1v1h-1z`);
        if (col < 2) cells.push(`M${5 - col} ${row + 1}h1v1h-1z`);
      }
    }
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface2"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 7 7" shapeRendering="crispEdges">
        <path d={cells.join('')} fill={color} />
      </svg>
    </span>
  );
}

export type NoticeTone = 'info' | 'warn' | 'danger' | 'success';

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  info: 'border-border bg-surface text-muted',
  warn: 'border-warn/50 bg-warn/10 text-warn-fg',
  danger: 'border-danger/50 bg-danger/10 text-danger-fg',
  success: 'border-success/50 bg-success/10 text-success-fg',
};

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: NoticeTone;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      className={`rounded-token border px-3 py-2 text-xs leading-relaxed ${NOTICE_CLASSES[tone]}`}
    >
      {children}
    </div>
  );
}

export function Spinner(): ReactNode {
  const { t } = useT();
  return (
    <div className="flex items-center justify-center py-8 text-sm text-muted">
      {t('app.loading')}
    </div>
  );
}

/**
 * Terminal state for a screen that has no data to show at all: a readable
 * sentence and a way out. Rendered instead of an endless spinner whenever a
 * query the whole screen depends on failed (findings 1 and 2).
 */
export function ErrorState({
  message,
  detail,
  onRetry,
  testId,
}: {
  message: string;
  detail?: string;
  onRetry?: () => void;
  testId?: string;
}): ReactNode {
  const { t } = useT();
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <p className="text-sm font-medium text-text">{message}</p>
      {detail ? <p className="text-xs leading-relaxed text-muted">{detail}</p> : null}
      {onRetry ? (
        <Button tone="secondary" onClick={onRetry}>
          {t('app.retry')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Clipboard write that cannot explode. A denied or unavailable clipboard used
 * to reject an unhandled promise *and* silently swallow the "copied" feedback
 * (finding 9); callers now get a boolean and can say what happened.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** What a copy button is currently showing. */
export type CopyState = 'idle' | 'copied' | 'failed';

/** Address with copy-to-clipboard, used on Home and Receive. */
export function CopyableAddress({ value }: { value: string }): ReactNode {
  const { t } = useT();
  const [copied, setCopied] = useState<CopyState>('idle');

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 1_800);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void copyToClipboard(value).then((ok) => setCopied(ok ? 'copied' : 'failed'));
      }}
      className="group flex w-full items-center gap-2 rounded-token border border-border bg-surface px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-tight text-text">
        {value}
      </span>
      <span className={`shrink-0 text-xs ${copied === 'failed' ? 'text-danger-fg' : 'text-accent-fg'}`}>
        {copied === 'failed'
          ? t('app.copyFailed')
          : copied === 'copied'
            ? t('app.copied')
            : t('app.copy')}
      </span>
    </button>
  );
}

export function ScreenHeader({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack?: () => void;
  action?: ReactNode;
}): ReactNode {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2 pb-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-token px-2 py-1 text-sm text-muted hover:text-text"
          aria-label={t('app.back')}
        >
          ←
        </button>
      ) : null}
      <h1 className="flex-1 text-base font-semibold text-text">{title}</h1>
      {action}
    </div>
  );
}
