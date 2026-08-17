/**
 * TanStack Query hooks. Everything network-derived goes through here so
 * caching, retries and invalidation live in one place (ARCHITECTURE.md §1).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api, rpc } from '../messaging/client';
import type { RpcResult } from '../messaging/protocol';
import { effectiveNetworkId, type SettingsPatch } from '../core/settings';
import type { NetworkId } from '../core/stellar/networks';

/**
 * Network a cached entry belongs to. `'unknown'` only occurs while the
 * settings query is still in flight; the affected queries stay disabled until
 * then, so nothing is ever fetched under that scope.
 */
export type NetworkScope = NetworkId | 'unknown';

export const queryKeys = {
  status: ['wallet', 'status'] as const,
  settings: ['settings'] as const,
  accounts: ['accounts'] as const,
  /**
   * Balances and history are network-*scoped* data: the same account index
   * means entirely different balances and operations on Testnet and Mainnet.
   * Without the network in the key, switching networks re-used the previous
   * network's cache entry and showed its rows as if they were current, with no
   * loading state in between (finding 6).
   */
  balances: (index: number | undefined, network: NetworkScope) =>
    ['balances', network, index ?? 'selected'] as const,
  history: (index: number | undefined, network: NetworkScope) =>
    ['history', network, index ?? 'selected'] as const,
  prompt: ['dapp', 'prompt'] as const,
};

/**
 * Key prefixes that go stale the moment settings change. `['balances']` and
 * `['history']` are prefixes on purpose: they match every network/account
 * variant of the key at once.
 */
export const SETTINGS_INVALIDATED_KEYS: ReadonlyArray<readonly unknown[]> = [
  queryKeys.accounts,
  ['balances'],
  ['history'],
];

/**
 * Poll interval for the account list, as a function of its own state.
 *
 * Finding 1: a single failed `account.list` used to wedge the popup on the
 * spinner forever, because nothing ever refetched it. An errored query polls
 * until it recovers; a healthy one does not poll at all; the list only changes
 * when the popup itself changes it.
 */
export const ACCOUNTS_ERROR_RETRY_MS = 5_000;

export function accountsRefetchInterval(status: 'error' | 'pending' | 'success'): number | false {
  return status === 'error' ? ACCOUNTS_ERROR_RETRY_MS : false;
}

export function useStatus(): UseQueryResult<RpcResult<'wallet.status'>> {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api.status(),
    refetchInterval: 20_000,
  });
}

export function useSettings(): UseQueryResult<RpcResult<'settings.get'>> {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => api.getSettings() });
}

/** The network the wallet actually talks to, or `null` while settings load. */
function useNetworkScope(): NetworkId | null {
  const settings = useSettings();
  return settings.data ? effectiveNetworkId(settings.data) : null;
}

export function useAccounts(
  enabled: boolean,
): UseQueryResult<RpcResult<'account.list'>> {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => api.accounts(),
    enabled,
    refetchInterval: (query) => accountsRefetchInterval(query.state.status),
  });
}

export function useBalances(
  index: number | undefined,
  enabled: boolean,
): UseQueryResult<RpcResult<'account.balances'>> {
  const network = useNetworkScope();
  return useQuery({
    queryKey: queryKeys.balances(index, network ?? 'unknown'),
    queryFn: () => api.balances(index),
    enabled: enabled && network !== null,
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useHistory(
  index: number | undefined,
  enabled: boolean,
): UseQueryResult<RpcResult<'account.history'>> {
  const network = useNetworkScope();
  return useQuery({
    queryKey: queryKeys.history(index, network ?? 'unknown'),
    queryFn: () => api.history(index),
    enabled: enabled && network !== null,
    retry: 1,
  });
}

export function usePendingPrompt(
  enabled: boolean,
): UseQueryResult<RpcResult<'dapp.pendingPrompt'>> {
  return useQuery({
    queryKey: queryKeys.prompt,
    queryFn: () => api.pendingPrompt(),
    enabled,
    refetchInterval: 1_500,
  });
}

/**
 * How often a submission with an unknown outcome is re-checked.
 *
 * One `GET /transactions/{hash}` per interval, through the same token bucket
 * as everything else (`core/net/limiter.ts`). Stellar closes a ledger about
 * every 5 s, so anything faster only spends quota to learn the same thing
 * twice; the whole window is bounded by the envelope's 180 s timebound, i.e.
 * some 30 lookups in the worst case.
 */
export const TX_STATUS_POLL_MS = 6_000;

/**
 * The submission whose outcome is still open, if any.
 *
 * Queried when a send-like screen mounts: the record lives in the background's
 * session storage, so it outlives both a closed popup and a service worker the
 * browser tore down mid-request. Without this the warning would be lost exactly
 * in the cases it matters most.
 */
export function usePendingSubmission(
  enabled: boolean,
): UseQueryResult<RpcResult<'tx.pendingSubmission'>> {
  return useQuery({
    queryKey: ['tx', 'pendingSubmission'],
    queryFn: () => rpc('tx.pendingSubmission', {}),
    enabled,
    retry: false,
    staleTime: 0,
  });
}

/** Drops the cached "is something still open?" answer after a resolution. */
export function useInvalidatePendingSubmission(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: ['tx'] });
  };
}

/**
 * Resolve a submitted hash against Horizon until the answer is final.
 *
 * Polling stops on `included` and on `expired`; the two states that *are* an
 * answer. `pending` and `unknown` keep going, because the transaction can
 * still land right up to its timebound.
 */
export function useTxStatus(
  hash: string | null,
  enabled: boolean,
): UseQueryResult<RpcResult<'tx.status'>> {
  return useQuery({
    queryKey: ['tx', 'status', hash],
    // No timebound travels with the request: the background reads it off the
    // record it wrote when the envelope left, and that is the only copy any
    // caller could honestly supply anyway.
    queryFn: () => rpc('tx.status', { hash: hash ?? '' }),
    enabled: enabled && hash !== null && hash.length > 0,
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'included' || state === 'expired' ? false : TX_STATUS_POLL_MS;
    },
  });
}

export function useUpdateSettings(): UseMutationResult<
  RpcResult<'settings.set'>,
  Error,
  SettingsPatch
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.setSettings(patch),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings, settings);
      // A settings change can move the wallet to another network, which
      // invalidates *everything* network-derived, history included (finding 6).
      for (const key of SETTINGS_INVALIDATED_KEYS) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * The mainnet gate. Separate from `useUpdateSettings` because the capability
 * lives behind its own RPC, see `settings.acknowledgeMainnet`.
 */
export function useAcknowledgeMainnet(): UseMutationResult<
  RpcResult<'settings.acknowledgeMainnet'>,
  Error,
  void
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.acknowledgeMainnet(),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings, settings);
      for (const key of SETTINGS_INVALIDATED_KEYS) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useFundAccount(
  index: number | undefined,
): UseMutationResult<RpcResult<'account.fund'>, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.fund(index),
    onSuccess: async () => {
      // Friendbot needs a ledger to close before the balance shows up.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await client.invalidateQueries({ queryKey: ['balances'] });
      await client.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/**
 * Plain-language description of an envelope (§5).
 *
 * `declaredNetworkPassphrase` is the network the *calling dApp* claims the
 * transaction is for. Passing it through is what makes the NETWORK_MISMATCH
 * warning reachable at all (finding 5); the popup itself never declares one,
 * because there the wallet's network is the only truth.
 */
export function useDescribeTx(
  xdr: string | null,
  declaredNetworkPassphrase?: string | null,
  accountIndex?: number | null,
): UseQueryResult<RpcResult<'tx.describe'>> {
  return useQuery({
    queryKey: ['describe', xdr, declaredNetworkPassphrase ?? null, accountIndex ?? null],
    queryFn: () =>
      rpc('tx.describe', {
        xdr: xdr ?? '',
        ...(declaredNetworkPassphrase ? { declaredNetworkPassphrase } : {}),
        ...(accountIndex === undefined || accountIndex === null ? {} : { accountIndex }),
      }),
    enabled: xdr !== null && xdr.length > 0,
    retry: false,
    staleTime: Infinity,
  });
}

/**
 * Live DEX quote for the swap screen. Refetched every 15 s while the screen is
 * open so the shown rate does not silently go stale; `retry: false` because a
 * failed quote should say so immediately, not after three hidden attempts.
 *
 * `sendAmount` must be the *debounced* amount (finding 5): the raw input string
 * is part of the key, so every keystroke would otherwise start a Horizon path
 * search plus a Soroswap POST. The screen debounces before the value gets here.
 */
export function useSwapQuote(
  sendAssetId: string,
  sendAmount: string,
  destAssetId: string,
  enabled: boolean,
  slippageBps?: number,
): UseQueryResult<RpcResult<'swap.quote'>> {
  return useQuery({
    queryKey: ['swapQuote', sendAssetId, sendAmount, destAssetId, slippageBps ?? 50],
    queryFn: () => api.swapQuote(sendAssetId, sendAmount, destAssetId, slippageBps),
    enabled,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useAddAccount(): UseMutationResult<
  RpcResult<'account.add'>,
  Error,
  { label: string; password: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ label, password }) => api.addAccount(label, password),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.accounts });
    },
  });
}

export function useInvalidateAccountData(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: ['balances'] });
    await client.invalidateQueries({ queryKey: ['history'] });
    await client.invalidateQueries({ queryKey: queryKeys.accounts });
  };
}
