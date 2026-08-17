/**
 * Popup stability guard rails.
 *
 * Everything here is about the popup surviving a bad day: an RPC that never
 * comes back, a query that failed once, a network switch, a clipboard the
 * browser refuses. The rendering itself is covered by the E2E suite, these
 * tests pin the logic and the structural promises the screens make, so a
 * regression is caught in 30 ms instead of 10 minutes.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import de from '../src/i18n/de.json';
import en from '../src/i18n/en.json';

/** Swapped per test; the client only ever sees this one function. */
let sendMessage: (request: unknown) => Promise<unknown> = async () => ({});

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: (request: unknown) => sendMessage(request),
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
    },
  },
}));

const {
  DEFAULT_RPC_TIMEOUT_MS,
  RPC_TIMEOUT_OVERRIDES_MS,
  RpcTimeoutError,
  isRpcTimeout,
  rpc,
  rpcErrorI18nKey,
  rpcTimeoutMs,
} = await import('../src/messaging/client');
const { AppError } = await import('../src/core/errors');
const {
  ACCOUNTS_ERROR_RETRY_MS,
  SETTINGS_INVALIDATED_KEYS,
  accountsRefetchInterval,
  queryKeys,
} = await import('../src/state/queries');
const { networkPickerOptions, networkPickerValue } = await import('../src/ui/screens/Settings');
const { copyToClipboard } = await import('../src/ui/components/primitives');
const { DEFAULT_DEBOUNCE_MS } = await import('../src/state/use-debounced-value');
const { DEFAULT_SETTINGS } = await import('../src/core/settings');

const read = (path: string): string => readFileSync(path, 'utf8');

/* ------------------------------------------------------------------ */
/* 3; the RPC client can no longer hang forever                       */
/* ------------------------------------------------------------------ */

describe('rpc timeout (finding 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a typed timeout when the background never answers', async () => {
    sendMessage = () => new Promise<unknown>(() => undefined);
    const pending = rpc('wallet.status', {});
    const assertion = expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS + 1);
    await assertion;
  });

  it('carries a translatable code and the method that hung', async () => {
    sendMessage = () => new Promise<unknown>(() => undefined);
    const pending = rpc('account.list', {}).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS + 1);
    const err = await pending;
    expect(isRpcTimeout(err)).toBe(true);
    expect(err).toBeInstanceOf(AppError);
    expect((err as InstanceType<typeof RpcTimeoutError>).code).toBe('NETWORK_ERROR');
    expect((err as InstanceType<typeof RpcTimeoutError>).method).toBe('account.list');
  });

  it('leaves a normal answer completely untouched', async () => {
    sendMessage = async (request) => ({
      id: (request as { id: string }).id,
      ok: true,
      result: { initialized: true, unlocked: false, autoLockAt: null },
    });
    const pending = rpc('wallet.status', {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({
      initialized: true,
      unlocked: false,
      autoLockAt: null,
    });
  });

  it('still surfaces a typed error from the background rather than a timeout', async () => {
    sendMessage = async (request) => ({
      id: (request as { id: string }).id,
      ok: false,
      error: { code: 'WALLET_LOCKED' },
    });
    const pending = rpc('account.list', {}).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);
    const err = await pending;
    expect(isRpcTimeout(err)).toBe(false);
    expect((err as InstanceType<typeof AppError>).code).toBe('WALLET_LOCKED');
  });

  it('exempts the calls that legitimately take longer, and only those', () => {
    expect(rpcTimeoutMs('wallet.status')).toBe(DEFAULT_RPC_TIMEOUT_MS);
    expect(rpcTimeoutMs('tx.describe')).toBe(DEFAULT_RPC_TIMEOUT_MS);
    expect(Object.keys(RPC_TIMEOUT_OVERRIDES_MS).sort()).toEqual([
      'dapp.requestConnect',
      'dapp.signXdr',
      'tx.submit',
    ]);
  });

  it('outlives the background prompt timeout for the dApp calls', () => {
    // The exemption is only correct as long as it exceeds the queue's own
    // deadline, if that constant moves, this test moves with it.
    const source = read('src/background/dapp.ts');
    const promptTimeout = Number(
      /PROMPT_TIMEOUT_MS\s*=\s*([\d_]+)/u.exec(source)?.[1]?.replace(/_/gu, '') ?? '0',
    );
    expect(promptTimeout).toBeGreaterThan(0);
    expect(rpcTimeoutMs('dapp.signXdr')).toBeGreaterThan(promptTimeout);
    expect(rpcTimeoutMs('dapp.requestConnect')).toBeGreaterThan(promptTimeout);
  });

  it('outlives the Horizon submit deadline, so a pending payment is never mislabelled', () => {
    // stellar-sdk gives up on submitTransaction after 60 s.
    expect(rpcTimeoutMs('tx.submit')).toBeGreaterThan(60_000);
  });

  it('maps a timeout to its own text and keeps typed codes otherwise', () => {
    expect(rpcErrorI18nKey(new RpcTimeoutError('tx.build', 30_000))).toBe('error.TIMEOUT');
    expect(rpcErrorI18nKey(new AppError('WALLET_LOCKED'))).toBe('error.WALLET_LOCKED');
    // Adjusted: `tx_bad_seq` is one of the codes that now has its own text.
    // An unknown code still lands on the collective key.
    expect(rpcErrorI18nKey(new AppError('TX_FAILED:tx_bad_seq'))).toBe(
      'error.txcode.tx_bad_seq',
    );
    expect(rpcErrorI18nKey(new AppError('TX_FAILED:op_wat'))).toBe('error.TX_FAILED');
    expect(rpcErrorI18nKey(new Error('boom'))).toBe('error.INTERNAL_ERROR');
    expect(rpcErrorI18nKey('not even an error')).toBe('error.INTERNAL_ERROR');
  });

  it('has the timeout text in both catalogues', () => {
    expect((de as Record<string, string>)['error.TIMEOUT']).toBeTruthy();
    expect((en as Record<string, string>)['error.TIMEOUT']).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 1; a failed account list recovers instead of wedging the popup     */
/* ------------------------------------------------------------------ */

describe('account list recovery (finding 1)', () => {
  it('polls while the query is in the error state', () => {
    expect(accountsRefetchInterval('error')).toBe(ACCOUNTS_ERROR_RETRY_MS);
    expect(ACCOUNTS_ERROR_RETRY_MS).toBeGreaterThan(0);
  });

  it('does not poll a healthy account list', () => {
    expect(accountsRefetchInterval('success')).toBe(false);
    expect(accountsRefetchInterval('pending')).toBe(false);
  });

  it('renders an error state with a retry instead of an endless spinner', () => {
    const app = read('entrypoints/popup/App.tsx');
    expect(app).toMatch(/accountsQuery\.isError/u);
    expect(app).toMatch(/testId="accounts-error"/u);
    expect(app).toMatch(/onRetry=\{\(\) => void accountsQuery\.refetch\(\)\}/u);
    // The status poll is the heartbeat that heals it without a click.
    expect(app).toMatch(/status\.dataUpdatedAt/u);
  });
});

/* ------------------------------------------------------------------ */
/* 2; a failed status is not "no wallet"                              */
/* ------------------------------------------------------------------ */

describe('wallet status failure (finding 2)', () => {
  it('branches on the error before deciding that onboarding is due', () => {
    const app = read('entrypoints/popup/App.tsx');
    const errorBranch = app.indexOf('status.isError && status.data === undefined');
    const onboardingBranch = app.indexOf("status.data?.initialized !== true");
    expect(errorBranch).toBeGreaterThan(-1);
    expect(onboardingBranch).toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(onboardingBranch);
    expect(app).toMatch(/testId="status-error"/u);
  });

  it('has both halves of the explanation in both catalogues', () => {
    for (const key of ['app.statusFailed', 'app.statusFailedBody', 'app.loadFailed', 'app.loadFailedBody']) {
      expect((de as Record<string, string>)[key]).toBeTruthy();
      expect((en as Record<string, string>)[key]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4; the confirm stage always keeps its header and Back              */
/* ------------------------------------------------------------------ */

describe('confirm stage controls (finding 4)', () => {
  for (const file of ['src/ui/screens/Send.tsx', 'src/ui/screens/Swap.tsx']) {
    it(`never renders a bare spinner while describing in ${file}`, () => {
      const source = read(file);
      expect(source).not.toMatch(/description\.isLoading\)\s*return\s*<Spinner\s*\/>/u);
      const loading = source.indexOf('description.isLoading');
      expect(loading).toBeGreaterThan(-1);
      // The header (and with it Back) is rendered inside the loading branch.
      const branch = source.slice(loading, loading + 400);
      expect(branch).toContain('<ScreenHeader');
      expect(branch).toContain('onBack');
    });
  }
});

/* ------------------------------------------------------------------ */
/* 5 + 10, swap quote: debounced, and honest about being unusable     */
/* ------------------------------------------------------------------ */

describe('swap quote (findings 5 and 10)', () => {
  const swap = read('src/ui/screens/Swap.tsx');

  it('debounces before the amount enters the query key', () => {
    expect(swap).toContain('useDebouncedValue');
    expect(swap).toMatch(/const quotedAmount = useDebouncedValue\(amount\)/u);
    // The raw input must not reach the hook any more.
    expect(swap).toMatch(/useSwapQuote\(\s*sendAssetId,\s*quotedAmount,/u);
  });

  it('uses a debounce long enough to swallow typing', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
    expect(DEFAULT_DEBOUNCE_MS).toBeLessThanOrEqual(800);
  });

  it('never presents a quote for the previous amount as current', () => {
    expect(swap).toMatch(/const quotePending = quotedAmount !== amount/u);
    expect(swap).toMatch(/quoteShown = quoteEnabled && !quotePending/u);
    // The waiting state covers the debounce window, not just the request.
    expect(swap).toMatch(/quoteBusy = quotePending \|\| quote\.isLoading/u);
  });

  it('builds from the amount the quote was made for', () => {
    expect(swap).toMatch(/sendAmount: quotedAmount/u);
  });

  it('explains a quote whose guaranteed minimum floors to zero', () => {
    expect(swap).toMatch(/quoteBelowMinimum/u);
    expect(swap).toContain("t('swap.amountTooSmall')");
    expect((de as Record<string, string>)['swap.amountTooSmall']).toBeTruthy();
    expect((en as Record<string, string>)['swap.amountTooSmall']).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 6: network-scoped cache keys and invalidation                      */
/* ------------------------------------------------------------------ */

describe('network-scoped query keys (finding 6)', () => {
  it('puts the network into the balances and history keys', () => {
    expect(queryKeys.balances(0, 'testnet')).toEqual(['balances', 'testnet', 0]);
    expect(queryKeys.history(0, 'testnet')).toEqual(['history', 'testnet', 0]);
  });

  it('gives the same account a different key per network', () => {
    expect(queryKeys.history(1, 'mainnet')).not.toEqual(queryKeys.history(1, 'testnet'));
    expect(queryKeys.balances(1, 'mainnet')).not.toEqual(queryKeys.balances(1, 'testnet'));
  });

  it('keeps the prefix invalidation working', () => {
    expect(queryKeys.balances(undefined, 'testnet')[0]).toBe('balances');
    expect(queryKeys.history(undefined, 'testnet')[0]).toBe('history');
  });

  it('invalidates accounts, balances *and* history on a settings change', () => {
    const heads = SETTINGS_INVALIDATED_KEYS.map((key) => key[0]);
    expect(heads).toContain('accounts');
    expect(heads).toContain('balances');
    expect(heads).toContain('history');
  });

  it('wires that list into the settings mutation', () => {
    const source = read('src/state/queries.ts');
    expect(source).toMatch(/for \(const key of SETTINGS_INVALIDATED_KEYS\)/u);
  });
});

/* ------------------------------------------------------------------ */
/* 7 + 8, funding failure and busy feedback                           */
/* ------------------------------------------------------------------ */

describe('feedback on Home, Send and Swap (findings 7 and 8)', () => {
  it('renders a friendbot failure instead of silently flipping back', () => {
    const home = read('src/ui/screens/Home.tsx');
    expect(home).toMatch(/fund\.isError/u);
    expect(home).toContain("t('home.fundFailed')");
    // Adjusted: the four screens' identical error helpers were merged into
    // `formatRpcError`; the guarantee this test protects is unchanged.
    expect(home).toContain('formatRpcError(t, fund.error)');
    expect((de as Record<string, string>)['home.fundFailed']).toBeTruthy();
    expect((en as Record<string, string>)['home.fundFailed']).toBeTruthy();
  });

  /**
   * Send, Swap and AddAsset each carried a byte-identical `reportError` that
   * unpacked `TX_FAILED:*` by hand. One copy in `messaging/client.ts` now does
   * it, so a change to the mapping cannot reach two screens out of three.
   */
  it('has exactly one implementation of the error-to-text mapping', () => {
    // History joined the list when its hardcoded `t('error.NETWORK_ERROR')`
    // was replaced: a locked wallet or a timeout there used to be reported as
    // an unreachable network, which is a different problem with a different
    // remedy.
    for (const screen of ['Send', 'Swap', 'AddAsset', 'Home', 'History']) {
      const source = read(`src/ui/screens/${screen}.tsx`);
      expect(source, screen).toContain('formatRpcError(t,');
      expect(source, screen).not.toContain("startsWith('TX_FAILED:')");
      expect(source, screen).not.toContain("t('error.TX_FAILED'");
      expect(source, screen).not.toContain("t('error.NETWORK_ERROR')");
    }
  });

  it('swaps the Review label while the transaction is being built', () => {
    expect(read('src/ui/screens/Send.tsx')).toContain(
      "{busy ? t('send.reviewing') : t('send.review')}",
    );
    expect(read('src/ui/screens/Swap.tsx')).toContain(
      "{busy ? t('swap.reviewing') : t('swap.review')}",
    );
    for (const key of ['send.reviewing', 'swap.reviewing']) {
      expect((de as Record<string, string>)[key]).toBeTruthy();
      expect((en as Record<string, string>)[key]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 9: clipboard writes cannot raise unhandled rejections              */
/* ------------------------------------------------------------------ */

describe('clipboard (finding 9)', () => {
  const originalClipboard = globalThis.navigator?.clipboard;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: originalClipboard },
    });
  });

  function stubClipboard(writeText: (value: string) => Promise<void>): void {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });
  }

  it('reports success', async () => {
    const written: string[] = [];
    stubClipboard(async (value) => {
      written.push(value);
    });
    await expect(copyToClipboard('GABC')).resolves.toBe(true);
    expect(written).toEqual(['GABC']);
  });

  it('resolves false on a denied write instead of rejecting', async () => {
    stubClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(copyToClipboard('GABC')).resolves.toBe(false);
  });

  it('survives a browser with no clipboard at all', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await expect(copyToClipboard('GABC')).resolves.toBe(false);
  });

  it('leaves no raw writeText() call outside the one guarded helper', () => {
    // The helper itself is the single place that touches the API.
    const primitives = read('src/ui/components/primitives.tsx');
    expect([...primitives.matchAll(/clipboard\s*\.?\s*\n?\s*\.?writeText/gu)]).toHaveLength(1);
    expect(primitives).toMatch(/try \{\s*await navigator\.clipboard\.writeText/u);
    for (const file of ['src/ui/screens/Home.tsx', 'src/ui/screens/Receive.tsx']) {
      expect(read(file)).not.toMatch(/clipboard\s*\.?\s*\n?\s*\.?writeText/u);
      expect(read(file)).toContain('copyToClipboard');
    }
  });

  it('has the failure text in both catalogues', () => {
    expect((de as Record<string, string>)['app.copyFailed']).toBeTruthy();
    expect((en as Record<string, string>)['app.copyFailed']).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 11; an ErrorBoundary exists and is mounted                         */
/* ------------------------------------------------------------------ */

describe('error boundary (finding 11)', () => {
  it('wraps the app at the outermost level', () => {
    const main = read('entrypoints/popup/main.tsx');
    expect(main).toContain('<ErrorBoundary>');
    expect(main).toMatch(/<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/u);
  });

  it('wraps the screens again inside the i18n provider, so the message is translated', () => {
    expect(read('entrypoints/popup/App.tsx')).toContain('<ErrorBoundary locale={settings.locale}>');
  });

  it('offers a way out and reports nowhere (invariant 4)', () => {
    const boundary = read('src/ui/components/ErrorBoundary.tsx');
    expect(boundary).toContain('getDerivedStateFromError');
    expect(boundary).toContain('location.reload()');
    expect(boundary).not.toMatch(/fetch\(|sendMessage|XMLHttpRequest/u);
    for (const key of ['app.crashTitle', 'app.crashBody', 'app.reload']) {
      expect((de as Record<string, string>)[key]).toBeTruthy();
      expect((en as Record<string, string>)[key]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 13; the network picker never renders blank                         */
/* ------------------------------------------------------------------ */

describe('network picker (finding 13)', () => {
  const settingsWith = (patch: Partial<typeof DEFAULT_SETTINGS>): typeof DEFAULT_SETTINGS => ({
    ...DEFAULT_SETTINGS,
    ...patch,
  });

  it('shows the effective network, not the stored one', () => {
    const beginnerOnFuturenet = settingsWith({ mode: 'beginner', networkId: 'futurenet' });
    expect(networkPickerValue(beginnerOnFuturenet)).toBe('testnet');
    const unacknowledgedMainnet = settingsWith({
      networkId: 'mainnet',
      mainnetAcknowledged: false,
    });
    expect(networkPickerValue(unacknowledgedMainnet)).toBe('testnet');
  });

  it('always offers the value it renders, beginner mode', () => {
    for (const networkId of ['testnet', 'futurenet', 'mainnet', 'custom'] as const) {
      const settings = settingsWith({ mode: 'beginner', networkId, customNetwork: null });
      expect(networkPickerOptions(settings)).toContain(networkPickerValue(settings));
    }
  });

  it('always offers the value it renders, developer mode', () => {
    for (const networkId of ['testnet', 'futurenet', 'mainnet', 'custom'] as const) {
      const settings = settingsWith({
        mode: 'developer',
        networkId,
        mainnetAcknowledged: true,
        customNetwork: null,
      });
      expect(networkPickerOptions(settings)).toContain(networkPickerValue(settings));
    }
  });

  it('falls back to Testnet for a "custom" network that has no endpoint', () => {
    // `effectiveNetworkId` treats custom-without-endpoint as not-a-network, so
    // the picker shows the network actually in use rather than a dead entry.
    const settings = settingsWith({ mode: 'developer', networkId: 'custom', customNetwork: null });
    expect(networkPickerValue(settings)).toBe('testnet');
    expect(networkPickerOptions(settings)).toContain('testnet');
  });

  it('keeps a configured "custom" network visible in developer mode', () => {
    const settings = settingsWith({
      mode: 'developer',
      networkId: 'custom',
      customNetwork: {
        passphrase: 'Custom ; 2026',
        horizonUrl: 'https://horizon.example',
        sorobanRpcUrl: 'https://soroban.example',
      },
    });
    expect(networkPickerValue(settings)).toBe('custom');
    expect(networkPickerOptions(settings)).toContain('custom');
  });

  it('does not widen the beginner choice beyond Testnet and Mainnet', () => {
    const settings = settingsWith({ mode: 'beginner', networkId: 'testnet' });
    expect([...networkPickerOptions(settings)].sort()).toEqual(['mainnet', 'testnet']);
  });

  it('has a label for every option it can render', () => {
    for (const id of ['testnet', 'futurenet', 'mainnet', 'custom']) {
      expect((de as Record<string, string>)[`settings.network.${id}`]).toBeTruthy();
      expect((en as Record<string, string>)[`settings.network.${id}`]).toBeTruthy();
    }
  });

  it('binds the select to the effective value', () => {
    expect(read('src/ui/screens/Settings.tsx')).toContain(
      'value={networkPickerValue(settings)}',
    );
  });
});
