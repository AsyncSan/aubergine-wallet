/**
 * Soroswap Aggregator API client (v1.1 swap upgrade).
 *
 * Second quote source next to the classic DEX path payment: the aggregator
 * routes across Soroswap AMM, Phoenix, Aqua and the SDEX and returns a
 * ready-to-sign XDR. Like Horizon, it is only ever called from the background
 * broker (§3); the popup never talks to the network.
 *
 * Security posture (§4 refinement, see ARCHITECTURE.md):
 * - The quote used for building is the one the *background* fetched and cached,
 *   keyed by an opaque `quoteId`. The popup can choose a quote, never alter it.
 * - The built envelope is parsed and checked here (source account, operation
 *   types, fee ceiling) before it is offered for signing.
 * - A missing API key disables the source gracefully; the DEX quote remains.
 */
import {
  Address,
  Asset,
  BASE_FEE,
  Networks,
  TransactionBuilder,
  scValToBigInt,
  xdr,
  type Operation,
  type Transaction,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { AppError } from '../errors';
import { assetFromId } from './horizon';
import type { NetworkConfig } from './networks';

export const SOROSWAP_API_URL = 'https://api.soroswap.finance';

/** Per-request ceiling for the aggregator API. */
export const SOROSWAP_TIMEOUT_MS = 15_000;

/** Aggregator protocols we ask the API to route across. */
const PROTOCOLS = ['soroswap', 'phoenix', 'aqua', 'sdex'] as const;

/**
 * Build-time configuration. WXT/Vite statically replaces `import.meta.env.*`;
 * an absent key yields `undefined` and the Soroswap source stays off.
 */
export interface SoroswapConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
}

export function soroswapConfigFromEnv(): SoroswapConfig | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const apiKey = env?.['WXT_SOROSWAP_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) return null;
  return { apiUrl: env?.['WXT_SOROSWAP_API_URL'] ?? SOROSWAP_API_URL, apiKey };
}

/** The API serves exactly the two public networks. Custom/futurenet: off. */
export function soroswapNetworkFor(network: NetworkConfig): 'mainnet' | 'testnet' | null {
  if (network.id === 'mainnet') return 'mainnet';
  if (network.id === 'testnet') return 'testnet';
  return null;
}

/* ------------------------------------------------------------ conversions */

const STROOPS_PER_UNIT = 10_000_000n;

/** `"12.3456789"` → `"123456789"` (stroops). Rejects >7 decimals, like the chain. */
export function amountToStroops(amount: string): string {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/u.exec(amount);
  if (!match) throw new AppError('INVALID_AMOUNT', amount);
  const whole = BigInt(match[1] ?? '0');
  const frac = BigInt((match[2] ?? '').padEnd(7, '0') || '0');
  return (whole * STROOPS_PER_UNIT + frac).toString();
}

/** `"123456789"` (stroops) → `"12.3456789"` decimal, trailing zeros trimmed. */
export function stroopsToAmount(stroops: string): string {
  if (!/^\d+$/u.test(stroops)) throw new AppError('INVALID_AMOUNT', stroops);
  const value = BigInt(stroops);
  const whole = value / STROOPS_PER_UNIT;
  const frac = (value % STROOPS_PER_UNIT).toString().padStart(7, '0').replace(/0+$/u, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

/**
 * The aggregator addresses tokens by their contract id. Classic assets map to
 * their Stellar Asset Contract (deterministic per network passphrase).
 */
export function assetIdToContract(assetId: string, networkPassphrase: string): string {
  const asset = assetId === 'native' ? Asset.native() : assetFromId(assetId);
  return asset.contractId(networkPassphrase);
}

/* ------------------------------------------------------------------ quote */

/**
 * Everything we rely on from a quote response. `passthrough()` keeps the full
 * payload intact, because `/quote/build` wants the object back verbatim.
 */
const quoteResponseSchema = z
  .object({
    amountIn: z.coerce.string(),
    amountOut: z.coerce.string(),
    otherAmountThreshold: z.coerce.string(),
    tradeType: z.string().optional(),
    platform: z.string().optional(),
    priceImpactPct: z.coerce.string().optional(),
  })
  .passthrough();

export interface SoroswapQuote {
  /** Best route output, decimal units. */
  readonly destAmount: string;
  /** Slippage floor already applied by the API (decimal units). */
  readonly minReceived: string;
  readonly priceImpactPct: string | null;
  readonly platform: string | null;
  /**
   * The three amounts in stroops, kept verbatim from the response. They are the
   * yardstick {@link verifySoroswapEnvelope} measures the built envelope
   * against, without them the wallet would be signing an opaque contract call.
   */
  readonly amountInStroops: string;
  readonly amountOutStroops: string;
  readonly minOutStroops: string;
  /**
   * The Stellar Asset Contract of the asset the user *sends*, derived locally
   * from the asset id and the network passphrase, never read back from the API
   * response. This is what makes the outflow check independent of the
   * aggregator: the SAC id of a classic asset is deterministic, so the wallet
   * can name the exact token contract that is allowed to debit the account.
   */
  readonly sendAssetContract: string;
  /** Same, for the asset the user receives. Kept for symmetry/diagnostics. */
  readonly destAssetContract: string;
  /** The verbatim API payload, required input for `/quote/build`. */
  readonly raw: Record<string, unknown>;
}

/**
 * Der Boden, den der Nutzer versprochen bekommt: `amountOut` abzüglich der
 * Slippage, die er selbst eingestellt hat, exakt in Stroops abgerundet.
 *
 * DIESE FUNKTION EXISTIERT WEGEN EINES LIVE-BEFUNDS (18.08.2026, Mainnet).
 * Vorher galt `otherAmountThreshold` aus der `/quote`-Antwort als der
 * garantierte Boden. Das ist es nicht: die API lieferte
 * `otherAmountThreshold === amountOut`, also gar keine Slippage, während
 * `/quote/build` in denselben Envelope
 * `amount_out_min = amountOut * (1 - slippage)` schrieb. Zwei unabhängige
 * Messungen am gepinnten Mainnet-Router:
 *
 *   amountOut 64909597 -> Envelope 64585050   (exakt 50,000 bps)
 *   amountOut 74456861 -> Envelope 74084577   (exakt 50,000 bps)
 *
 * Zwei Folgen, beide ernst:
 *
 * 1. `verifySoroswapEnvelope` verlangte `amount_out_min >= otherAmountThreshold`
 *    und lehnte damit JEDEN echten Envelope ab
 *    (`SWAP_ENVELOPE_MISMATCH: entry call guarantees … instead of the promised
 *    minimum …`). Die Aggregator-Route war auf Mainnet vollständig tot —
 *    fail-closed, aber tot.
 * 2. Schwerer noch: der Swap-Bildschirm zeigte `otherAmountThreshold` als
 *    „du bekommst mindestens X". Das war der ERWARTETE Betrag, nicht der
 *    garantierte. Die signierten Bytes trugen 0,5 % weniger. Ein Versprechen,
 *    das die Signatur nicht deckt, ist genau das, was der Wächter verhindern
 *    soll.
 *
 * Warum abrunden und nicht runden: die API rundet kaufmännisch (Fall 2 trifft
 * `round`, Fall 1 liegt eine Stroop darüber). Abrunden ist der kleinere Wert,
 * das Versprechen bleibt also in jedem Fall gedeckt.
 *
 * Warum nicht einfach `min(otherAmountThreshold, floor)`: {@link
 * thresholdIsConsistent} läuft vorher und verwirft jede Quote, deren
 * Schwellwert UNTER diesem Boden liegt. Der API-Wert kann hier also nie der
 * kleinere sein; ein `min` wäre toter Code, der Sicherheit vortäuscht.
 */
export function slippageFloor(amountOutStroops: string, slippageBps: number): string {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(slippageBps))));
  return ((BigInt(amountOutStroops) * (10_000n - bps)) / 10_000n).toString();
}

/**
 * Does the API's own `otherAmountThreshold` actually correspond to the slippage
 * we asked for? Exact BigInt stroop arithmetic, no float: the threshold must sit
 * between `amountOut * (1 - slippage)` and `amountOut` itself. A threshold above
 * the quoted output is nonsense too (the swap could never fill).
 */
export function thresholdIsConsistent(
  amountOutStroops: string,
  thresholdStroops: string,
  slippageBps: number,
): boolean {
  let out: bigint;
  let threshold: bigint;
  try {
    out = BigInt(amountOutStroops);
    threshold = BigInt(thresholdStroops);
  } catch {
    return false;
  }
  if (out <= 0n || threshold <= 0n || threshold > out) return false;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(slippageBps))));
  // Floor division rounds the bound down, so a threshold that is off by the
  // rounding remainder is still accepted; anything genuinely worse is not.
  const floor = (out * (10_000n - bps)) / 10_000n;
  return threshold >= floor;
}

async function post(
  config: SoroswapConfig,
  path: string,
  network: 'mainnet' | 'testnet',
  body: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}?network=${network}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // A hanging aggregator must not hang the swap screen: `fetch` has no
      // default timeout, and this request sits directly under a user click.
      signal: AbortSignal.timeout(SOROSWAP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError('NETWORK_ERROR', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    throw new AppError('NETWORK_ERROR', `soroswap ${path} responded ${res.status}`);
  }
  return res.json() as Promise<unknown>;
}

/**
 * Ask the aggregator for an EXACT_IN quote. `null` means "no route", the
 * normal empty-liquidity answer, mirroring `findStrictSendPath`. Transport
 * errors also resolve to `null` by design: the Soroswap source is an upgrade
 * on top of the DEX quote, and a flaky aggregator must never break the swap
 * screen (fail-open to fewer sources, never to a worse user position).
 */
export async function fetchSoroswapQuote(
  config: SoroswapConfig,
  network: NetworkConfig,
  sendAssetId: string,
  sendAmount: string,
  destAssetId: string,
  slippageBps: number,
): Promise<SoroswapQuote | null> {
  const apiNetwork = soroswapNetworkFor(network);
  if (apiNetwork === null) return null;
  try {
    const sendAssetContract = assetIdToContract(sendAssetId, network.passphrase);
    const destAssetContract = assetIdToContract(destAssetId, network.passphrase);
    const payload = await post(config, '/quote', apiNetwork, {
      assetIn: sendAssetContract,
      assetOut: destAssetContract,
      amount: amountToStroops(sendAmount),
      tradeType: 'EXACT_IN',
      protocols: [...PROTOCOLS],
      slippageBps,
    });
    const parsed = quoteResponseSchema.safeParse(payload);
    if (!parsed.success) return null;
    const amountIn = parsed.data.amountIn;
    const amountOut = parsed.data.amountOut;
    const threshold = parsed.data.otherAmountThreshold;
    if (BigInt(amountOut) <= 0n) return null;
    // The screen promises "you receive at least <threshold>". A quote whose own
    // threshold does not match its own slippage setting makes that promise
    // meaningless, `{amountOut: 25 USDC, otherAmountThreshold: 1 stroop}` parses
    // fine and would render "at least 0,0000001 USDC" with no warning anywhere.
    // Drop such a quote rather than display it (fail-closed to the DEX route).
    if (!thresholdIsConsistent(amountOut, threshold, slippageBps)) return null;
    const promisedFloor = slippageFloor(amountOut, slippageBps);
    return {
      destAmount: stroopsToAmount(amountOut),
      minReceived: stroopsToAmount(promisedFloor),
      priceImpactPct: parsed.data.priceImpactPct ?? null,
      platform: parsed.data.platform ?? null,
      amountInStroops: amountIn,
      amountOutStroops: amountOut,
      minOutStroops: promisedFloor,
      sendAssetContract,
      destAssetContract,
      raw: parsed.data as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ build */

const buildResponseSchema = z.object({ xdr: z.string().min(1) });

/**
 * Fee ceiling for an aggregator-built envelope: Soroban resource fees are
 * real, but a swap has no business costing more than 10 XLM. Anything above
 * is a malformed or hostile response and is refused before signing.
 */
export const MAX_SOROSWAP_FEE_STROOPS = 100_000_000n;

/**
 * Build the ready-to-sign envelope for a cached quote and verify it:
 * the source must be the swapping account, every operation must be a Soroban
 * invocation (that is what an aggregator swap is, anything else, e.g. a
 * sneaky `setOptions`, is rejected), and the fee must be sane. Returns the
 * parsed transaction so the caller can hash exactly what will be signed.
 */
export async function buildSoroswapSwap(
  config: SoroswapConfig,
  network: NetworkConfig,
  quote: SoroswapQuote,
  from: string,
): Promise<{ xdr: string; tx: Transaction }> {
  const apiNetwork = soroswapNetworkFor(network);
  if (apiNetwork === null) {
    throw new AppError('BAD_REQUEST', 'soroswap is unavailable on this network');
  }
  const payload = await post(config, '/quote/build', apiNetwork, {
    quote: quote.raw,
    from,
    to: from,
  });
  const parsed = buildResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError('NETWORK_ERROR', 'soroswap build returned no envelope');
  }
  return {
    xdr: parsed.data.xdr,
    tx: verifySoroswapEnvelope(parsed.data.xdr, network, from, expectationOf(quote)),
  };
}

/** The quote's own numbers, as the yardstick for the envelope it produced. */
export function expectationOf(quote: SoroswapQuote): SoroswapExpectation {
  return {
    amountInStroops: quote.amountInStroops,
    amountOutStroops: quote.amountOutStroops,
    minOutStroops: quote.minOutStroops,
    sendAssetContract: quote.sendAssetContract,
    destAssetContract: quote.destAssetContract,
  };
}

const ALLOWED_OPERATIONS: readonly string[] = ['invokeHostFunction'];

/**
 * What the wallet promised the user, in stroops. Passing this to
 * {@link verifySoroswapEnvelope} turns "some Soroban call" into a checked claim.
 */
export interface SoroswapExpectation {
  readonly amountInStroops: string;
  readonly amountOutStroops: string;
  readonly minOutStroops: string;
  /**
   * SAC of the asset the user sends, derived locally (see
   * {@link SoroswapQuote.sendAssetContract}). The authorised outflow must sit on
   * exactly this token contract.
   */
  readonly sendAssetContract: string;
  /**
   * SAC of the asset the user *receives*, derived locally the same way. This is
   * the proceeds side of the swap, and it is only checkable because the entry
   * contract is pinned: a pinned contract has a known signature, so the token
   * the proceeds are denominated in sits at a known argument position (see
   * {@link ENTRY_SIGNATURES}). Without it, "you receive at least X *of what*"
   * was never actually verified.
   */
  readonly destAssetContract: string;
}

/* ------------------------------------------------- pinned Soroswap entries */

/**
 * SECOND LAYER, not the primary one. The published top-level entry points of
 * the Soroswap deployment, keyed by network passphrase.
 *
 * Sources (fetched 2026-08-17, verbatim `ids` entries):
 * - Aggregator: github.com/soroswap/aggregator, `public/mainnet.contracts.json`
 *   (`aggregator`) and `public/testnet.contracts.json` (`aggregator`).
 * - AMM router: github.com/soroswap/core, `public/mainnet.contracts.json`
 *   (`router`) and `public/testnet.contracts.json` (`router`).
 *
 * WARNING, MAINTENANCE: this is a hard-coded allowlist of *deployed* contract
 * ids. Every Soroswap redeploy (aggregator upgrade, router v2, a new adapter
 * that the API routes through directly) invalidates it and takes the whole
 * aggregator route offline with `SWAP_ENVELOPE_MISMATCH` until this constant is
 * updated and the extension is shipped again. That is a deliberate fail-closed
 * trade-off, and it is exactly why the *primary* defence below
 * ({@link assertAuthorisedOutflow}) is address-free and derived from the quote:
 * an out-of-date list here must never be the only thing standing between the
 * user and a drain, and it must never be the only thing that has to be right.
 *
 * A network with no entry (custom, futurenet) has no published deployment, so
 * no envelope can be pinned there, `soroswapNetworkFor` already refuses those
 * networks, and the check below refuses them a second time.
 */
/**
 * Which of the two published contracts an entry id belongs to. The role is not
 * cosmetic: aggregator and AMM router expose the *same function name* with
 * *different* signatures, so "where does the recipient argument sit" can only be
 * answered per role. See {@link ENTRY_SIGNATURES}.
 */
export type SoroswapEntryRole = 'aggregator' | 'router';

export interface SoroswapEntry {
  readonly id: string;
  readonly role: SoroswapEntryRole;
}

export const SOROSWAP_ENTRIES: ReadonlyMap<string, readonly SoroswapEntry[]> = new Map<
  string,
  readonly SoroswapEntry[]
>([
  [
    Networks.PUBLIC,
    [
      // soroswap/aggregator public/mainnet.contracts.json → ids.aggregator
      { id: 'CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO', role: 'aggregator' },
      // soroswap/core public/mainnet.contracts.json → ids.router
      { id: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH', role: 'router' },
    ],
  ],
  [
    Networks.TESTNET,
    [
      // soroswap/aggregator public/testnet.contracts.json → ids.aggregator
      { id: 'CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA', role: 'aggregator' },
      // soroswap/core public/testnet.contracts.json → ids.router
      { id: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD', role: 'router' },
    ],
  ],
]);

/** The bare ids, derived so the two can never drift apart. */
export const SOROSWAP_ENTRY_CONTRACTS: ReadonlyMap<string, readonly string[]> = new Map(
  [...SOROSWAP_ENTRIES].map(([passphrase, entries]) => [passphrase, entries.map((e) => e.id)]),
);

/**
 * The signature of the entry call, per role; a POSITIVE list, and the reason
 * the proceeds side of the swap is checkable at all.
 *
 * Sources (fetched 2026-08-17, verbatim from the contract source):
 * - github.com/soroswap/aggregator, `contracts/aggregator/src/lib.rs`,
 *   `trait SoroswapAggregatorTrait`:
 *
 *     swap_exact_tokens_for_tokens(env, token_in, token_out, amount_in,
 *                                  amount_out_min, distribution, to, deadline)
 *
 *   `env` is not an ScVal argument, so the on-the-wire positions are
 *   token_in 0, token_out 1, amount_in 2, amount_out_min 3, distribution 4,
 *   to 5, deadline 6.
 * - github.com/soroswap/core, `contracts/router/src/lib.rs`,
 *   `trait SoroswapRouterTrait`:
 *
 *     swap_exact_tokens_for_tokens(e, amount_in, amount_out_min, path, to, deadline)
 *
 *   i.e. amount_in 0, amount_out_min 1, path 2, to 3, deadline 4.
 *
 * WHY A POSITIVE LIST OF ONE FUNCTION. `fetchSoroswapQuote` only ever asks for
 * `tradeType: 'EXACT_IN'`, so `swap_exact_tokens_for_tokens` is the only entry
 * call a quote of ours can legitimately produce. The sibling
 * `swap_tokens_for_exact_tokens` (same `to` position, amounts swapped in
 * meaning) is deliberately *not* listed: an EXACT_OUT envelope answering an
 * EXACT_IN quote is a mismatch in itself. Everything not on this list,
 * including admin functions such as `set_pause` or a future `swap_v2`, is
 * refused rather than waved through, because an unlisted function means we do
 * not know where the recipient sits, and "we do not know" must not read as "it
 * is fine".
 *
 * MAINTENANCE, honestly: Soroban contracts can be upgraded in place, keeping
 * their id. A signature change on the pinned ids therefore takes the aggregator
 * route offline with `SWAP_ENVELOPE_MISMATCH` until this table is updated and
 * the extension is shipped; the same fail-closed trade-off the pinned id list
 * already carries.
 */
interface EntrySignature {
  readonly fn: string;
  readonly arity: number;
  readonly to: number;
  readonly amountIn: number;
  readonly amountOutMin: number;
  /** Argument holding the sold token, when the signature names it directly. */
  readonly tokenIn: number | null;
  /** Argument holding the bought token, when the signature names it directly. */
  readonly tokenOut: number | null;
  /** `Vec<Address>` route whose first/last element are the two tokens. */
  readonly path: number | null;
}

const ENTRY_SIGNATURES: Readonly<Record<SoroswapEntryRole, EntrySignature>> = {
  aggregator: {
    fn: 'swap_exact_tokens_for_tokens',
    arity: 7,
    tokenIn: 0,
    tokenOut: 1,
    amountIn: 2,
    amountOutMin: 3,
    to: 5,
    path: null,
  },
  router: {
    fn: 'swap_exact_tokens_for_tokens',
    arity: 5,
    tokenIn: null,
    tokenOut: null,
    amountIn: 0,
    amountOutMin: 1,
    path: 2,
    to: 3,
  },
};

/**
 * SEP-41 (Stellar token interface) functions that move value *out of* the
 * holder named in one of their arguments. `from` is the debited holder, the
 * account whose authorization the call consumes, and `amount` the size of the
 * outflow. Indices are the SEP-41 signatures, `env` excluded:
 *
 *   transfer(from, to, amount)
 *   transfer_from(spender, from, to, amount)
 *   approve(from, spender, amount, live_until_ledger)
 *   burn(from, amount)
 *   burn_from(spender, from, amount)
 *
 * `approve` is in the list because an allowance is a deferred outflow: an
 * `approve(victim, attacker, i128::MAX)` drains just as thoroughly, only later.
 */
const OUTFLOW_FUNCTIONS: Readonly<Record<string, { readonly from: number; readonly amount: number }>> =
  {
    transfer: { from: 0, amount: 2 },
    transfer_from: { from: 1, amount: 3 },
    approve: { from: 0, amount: 2 },
    burn: { from: 0, amount: 1 },
    burn_from: { from: 1, amount: 2 },
  };

/**
 * One SEP-41 outflow the *user's* account authorises somewhere in the auth tree.
 * `contract` is the token contract that would be debited; `null` means the call
 * sits on something that is not a contract address at all, `amount === null`
 * that the argument in the amount position was not a 128-bit integer. Both are
 * kept rather than dropped so the check can reject them explicitly.
 */
export interface AuthorizedOutflow {
  readonly contract: string | null;
  readonly fn: string;
  readonly amount: bigint | null;
}

/** Every address and every 128-bit amount reachable from a contract call. */
interface ScanResult {
  readonly accountAddresses: string[];
  /**
   * Contract addresses (`C…`). NOT an allowlist and NOT a rejection criterion:
   * the intermediate hop tokens of a multi-hop route and the pools behind them
   * are route-dependent and only the (potentially hostile) aggregator knows
   * them, so refusing unknown `C…` here would break every legitimate multi-hop
   * swap. The recipient side is instead pinned *positionally*, see
   * {@link assertEntryCallShape}, which reads the `to` argument of the pinned
   * entry call. This list exists so error messages can name what the envelope
   * actually touches; it is read in {@link assertAuthorisedOutflow}.
   */
  readonly contractAddresses: string[];
  /**
   * Muxed accounts, claimable balances and liquidity-pool ids. None of these
   * belong in an aggregator swap, and a muxed `M…` in particular would hide a
   * foreign `G…` payout target from the account check. Collected to be refused.
   */
  readonly exoticAddresses: string[];
  readonly amounts: bigint[];
}

type ScanSink = {
  accountAddresses: string[];
  contractAddresses: string[];
  exoticAddresses: string[];
  amounts: bigint[];
};

function emptyScan(): ScanSink {
  return { accountAddresses: [], contractAddresses: [], exoticAddresses: [], amounts: [] };
}

/** Strkey for an ScAddress, or `null` when the SDK cannot render this variant. */
function scAddressToString(address: xdr.ScAddress): string | null {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return null;
  }
}

/** The `C…` id, but only when the address really is a contract address. */
function contractIdOf(address: xdr.ScAddress): string | null {
  if (address.switch().name !== 'scAddressTypeContract') return null;
  return scAddressToString(address);
}

function scanScVal(value: xdr.ScVal, out: ScanSink): void {
  switch (value.switch().name) {
    case 'scvAddress': {
      const address = value.address();
      const rendered = scAddressToString(address);
      switch (address.switch().name) {
        // An *account* address is the payout target; that one must be us.
        case 'scAddressTypeAccount':
          out.accountAddresses.push(rendered ?? '<unreadable account address>');
          return;
        // Contract addresses are the route itself (pools, tokens, adapters),
        // but also a perfectly good drain target, so they are kept, not dropped.
        case 'scAddressTypeContract':
          out.contractAddresses.push(rendered ?? '<unreadable contract address>');
          return;
        default:
          out.exoticAddresses.push(rendered ?? `<${address.switch().name}>`);
          return;
      }
    }
    case 'scvI128':
    case 'scvU128':
      out.amounts.push(scValToBigInt(value));
      return;
    case 'scvVec': {
      for (const entry of value.vec() ?? []) scanScVal(entry, out);
      return;
    }
    case 'scvMap': {
      for (const entry of value.map() ?? []) {
        scanScVal(entry.key(), out);
        scanScVal(entry.val(), out);
      }
      return;
    }
    default:
      return;
  }
}

/** The strkey at argument `index`, or `null` when it is not an address at all. */
function addressArg(args: readonly xdr.ScVal[], index: number): string | null {
  const arg = args[index];
  if (arg === undefined || arg.switch().name !== 'scvAddress') return null;
  return scAddressToString(arg.address());
}

/** The 128-bit integer at argument `index`, or `null` when it is not one. */
function intArg(args: readonly xdr.ScVal[], index: number): bigint | null {
  const arg = args[index];
  if (arg === undefined) return null;
  const name = arg.switch().name;
  if (name !== 'scvI128' && name !== 'scvU128') return null;
  return scValToBigInt(arg);
}

/** Does `address` occur anywhere in these arguments, however deeply nested? */
function argsMention(args: readonly xdr.ScVal[], address: string): boolean {
  const sink = emptyScan();
  for (const arg of args) scanScVal(arg, sink);
  return sink.accountAddresses.includes(address) || sink.contractAddresses.includes(address);
}

function scanAuthorizedInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
  out: ScanSink,
): void {
  const fn = invocation.function();
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    for (const arg of fn.contractFn().args()) scanScVal(arg, out);
  }
  for (const sub of invocation.subInvocations()) scanAuthorizedInvocation(sub, out);
}

/**
 * Collect everything an `invokeHostFunction` operation can move: the arguments
 * of the invoked function *and* the arguments of every sub-invocation the
 * attached authorization entries cover; the transaction signature authorises
 * those trees too, so checking only the top-level call would be a blind spot.
 */
export function scanInvokeOperation(op: Operation.InvokeHostFunction): ScanResult {
  const out = emptyScan();
  if (op.func.switch().name === 'hostFunctionTypeInvokeContract') {
    for (const arg of op.func.invokeContract().args()) scanScVal(arg, out);
  }
  for (const entry of op.auth ?? []) scanAuthorizedInvocation(entry.rootInvocation(), out);
  return out;
}

/**
 * Walk one authorization tree *structurally*, contract, function name and
 * argument positions, not a flat bag of values, and record every SEP-41 call
 * that debits `expectedSource`. Sub-invocations are included: variant B of the
 * reported attack hides the `transfer(victim, attacker, amountIn)` exactly
 * there, under a harmless-looking root call.
 */
function collectOutflows(
  invocation: xdr.SorobanAuthorizedInvocation,
  expectedSource: string,
  out: AuthorizedOutflow[],
): void {
  const fn = invocation.function();
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const call = fn.contractFn();
    const name = call.functionName().toString();
    const spec = OUTFLOW_FUNCTIONS[name];
    if (spec !== undefined) {
      const args = call.args();
      const fromArg = args[spec.from];
      const amountArg = args[spec.amount];
      const from =
        fromArg !== undefined && fromArg.switch().name === 'scvAddress'
          ? scAddressToString(fromArg.address())
          : null;
      if (from !== null && from === expectedSource) {
        const amountName = amountArg?.switch().name;
        out.push({
          contract: contractIdOf(call.contractAddress()),
          fn: name,
          amount:
            amountArg !== undefined && (amountName === 'scvI128' || amountName === 'scvU128')
              ? scValToBigInt(amountArg)
              : null,
        });
      }
    }
  }
  for (const sub of invocation.subInvocations()) collectOutflows(sub, expectedSource, out);
}

/** Every outflow of `expectedSource` authorised by this operation's auth tree. */
export function collectAuthorizedOutflows(
  op: Operation.InvokeHostFunction,
  expectedSource: string,
): AuthorizedOutflow[] {
  const out: AuthorizedOutflow[] = [];
  for (const entry of op.auth ?? []) collectOutflows(entry.rootInvocation(), expectedSource, out);
  return out;
}

/**
 * Does this envelope already carry a Soroban resource footprint? Deliberately
 * re-derived here instead of importing `hasSorobanFootprint` from `./soroban`,
 * which would drag the RPC client into this otherwise pure, offline-verifiable
 * module. `ext().switch() === 1` is the `sorobanData` arm of the v1 tx ext.
 */
function hasResourceFootprint(tx: Transaction): boolean {
  try {
    return tx.toEnvelope().v1().tx().ext().switch() === 1;
  } catch {
    return false;
  }
}

/**
 * The top-level contract of every `invokeHostFunction`, pinned against
 * {@link SOROSWAP_ENTRY_CONTRACTS}. Unknown entry point → refuse.
 */
function assertPinnedEntryContract(
  op: Operation.InvokeHostFunction,
  networkPassphrase: string,
): SoroswapEntryRole {
  const allowed = SOROSWAP_ENTRIES.get(networkPassphrase);
  if (allowed === undefined) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      'no published Soroswap deployment is pinned for this network',
    );
  }
  if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') {
    // Uploading or creating a contract is not a swap under any reading.
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `swap envelope invokes ${op.func.switch().name} instead of a contract`,
    );
  }
  const target = contractIdOf(op.func.invokeContract().contractAddress());
  const entry = target === null ? undefined : allowed.find((candidate) => candidate.id === target);
  if (entry === undefined) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `unknown swap entry contract ${target ?? '<not a contract address>'}`,
    );
  }
  return entry.role;
}

/**
 * The proceeds side, which used to be entirely unchecked.
 *
 * The reasoning, because the naive rule is wrong: "the recipient of the outflow
 * must be the user or a pinned contract" would break every real swap, the
 * debit goes to a pool or an adapter whose address is route-dependent and which
 * only the aggregator could name. But we do not have to know the route to know
 * where the *proceeds* land: {@link buildSoroswapSwap} sends `to: from` to the
 * API, the entry contract is pinned, and a pinned contract has a known
 * signature, so the recipient argument sits at a known position and must be
 * the signing account.
 *
 * That check is load-bearing rather than cosmetic, because the pinned contract
 * enforces the rest on-chain: the aggregator resolves each hop's adapter from
 * its own admin-registered table (`get_adapter(protocol_id)`, an enum, the
 * caller cannot inject an adapter address), measures `to`'s `token_out` balance
 * before and after the whole distribution, and reverts unless the delta is at
 * least `amount_out_min`. So pinning contract + function + `to` + `token_out` +
 * `amount_out_min` buys exactly the guarantee the swap screen promises: this
 * account receives at least this much of this asset.
 *
 * Checked here: function name (positive list), argument count, `to`, both token
 * arguments against the locally derived SACs, `amount_in` against the quote and
 * `amount_out_min` against the promised floor.
 */
function assertEntryCallShape(
  call: xdr.InvokeContractArgs,
  role: SoroswapEntryRole,
  expectedSource: string,
  expected: SoroswapExpectation,
): void {
  const spec = ENTRY_SIGNATURES[role];
  const name = call.functionName().toString();
  if (name !== spec.fn) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `pinned ${role} is called as ${name}, not as the quoted ${spec.fn}`,
    );
  }
  const args = call.args();
  if (args.length !== spec.arity) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `${spec.fn} on the pinned ${role} takes ${spec.arity} arguments, ` +
        `the envelope passes ${args.length}; this is not the signature we pinned`,
    );
  }
  const recipient = addressArg(args, spec.to);
  if (recipient === null || recipient !== expectedSource) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `swap proceeds are directed at ${recipient ?? '<not an address>'} ` +
        `instead of the signing account ${expectedSource}`,
    );
  }
  // Which two tokens: named outright by the aggregator, first/last hop of the
  // route for the AMM router. Intermediate hops stay unchecked on purpose.
  let tokenIn: string | null = null;
  let tokenOut: string | null = null;
  if (spec.tokenIn !== null && spec.tokenOut !== null) {
    tokenIn = addressArg(args, spec.tokenIn);
    tokenOut = addressArg(args, spec.tokenOut);
  } else if (spec.path !== null) {
    const route = args[spec.path];
    const hops = route !== undefined && route.switch().name === 'scvVec' ? (route.vec() ?? []) : [];
    if (hops.length < 2) {
      throw new AppError('SWAP_ENVELOPE_MISMATCH', 'swap route has fewer than two hops');
    }
    tokenIn = addressArg(hops, 0);
    tokenOut = addressArg(hops, hops.length - 1);
  }
  if (tokenIn !== expected.sendAssetContract) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `swap sells ${tokenIn ?? '<not an address>'} instead of the quoted ` +
        `${expected.sendAssetContract}`,
    );
  }
  if (tokenOut !== expected.destAssetContract) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `swap pays out ${tokenOut ?? '<not an address>'} instead of the quoted ` +
        `${expected.destAssetContract}`,
    );
  }
  const amountIn = intArg(args, spec.amountIn);
  if (amountIn === null || amountIn !== BigInt(expected.amountInStroops)) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `entry call spends ${amountIn?.toString() ?? '<unreadable amount>'} ` +
        `instead of the quoted ${expected.amountInStroops}`,
    );
  }
  const minOut = intArg(args, spec.amountOutMin);
  // `>=`, not `==`: a floor *above* what the user was promised is strictly
  // better for them, anything below silently downgrades the promise.
  if (minOut === null || minOut < BigInt(expected.minOutStroops)) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `entry call guarantees ${minOut?.toString() ?? '<unreadable amount>'} ` +
        `instead of the promised minimum ${expected.minOutStroops}`,
    );
  }
}

/**
 * Which functions may touch the SAC of an asset in this swap while the user's
 * own account is named in the arguments; a POSITIVE list, deliberately of one.
 *
 * WHY A POSITIVE LIST AND NOT A BLOCKLIST. The outflow model below understands
 * five SEP-41 functions. A SAC exposes more than SEP-41: `set_authorized`,
 * `clawback`, `set_admin`, `mint`. Those are administrative, they are not in
 * the outflow model, and "not in the model" used to mean "invisible", an
 * honest `transfer` plus a `clawback` passed, because the zero-outflow
 * rejection only fires when there is *no* recognised outflow at all. A blocklist
 * would have to enumerate every value-bearing function of every current and
 * future token implementation and would be wrong again the day one is added.
 * The positive list inverts the burden: a swap needs the account to hand over
 * tokens, and the one function that does that is `transfer`. Everything else is
 * refused by name, whether or not this wallet understands it.
 *
 * (`approve` is not here on purpose: an allowance moves nothing now and permits
 * a withdrawal later, so it can never be part of paying for a swap. See
 * {@link assertAuthorisedOutflow}.)
 *
 * Scope: only the two SACs the quote names, and only when the user's address
 * occurs in the arguments. Adapters legitimately `approve` a pool out of their
 * *own* balance mid-route; that never mentions the user and stays untouched.
 */
const SAC_FUNCTIONS_ALLOWED_WITH_USER: readonly string[] = ['transfer'];

/** A call on a known SAC that names the user and is not on the positive list. */
interface UnmodelledTokenCall {
  readonly contract: string;
  readonly fn: string;
}

function collectUnmodelledTokenCalls(
  invocation: xdr.SorobanAuthorizedInvocation,
  expectedSource: string,
  expected: SoroswapExpectation,
  out: UnmodelledTokenCall[],
): void {
  const fn = invocation.function();
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const call = fn.contractFn();
    const contract = contractIdOf(call.contractAddress());
    if (contract === expected.sendAssetContract || contract === expected.destAssetContract) {
      const name = call.functionName().toString();
      if (
        !SAC_FUNCTIONS_ALLOWED_WITH_USER.includes(name) &&
        argsMention(call.args(), expectedSource)
      ) {
        out.push({ contract: contract as string, fn: name });
      }
    }
  }
  for (const sub of invocation.subInvocations()) {
    collectUnmodelledTokenCalls(sub, expectedSource, expected, out);
  }
}

/** Every non-`transfer` call on a quoted SAC that names the signing account. */
export function collectUnmodelledTokenCallsOf(
  op: Operation.InvokeHostFunction,
  expectedSource: string,
  expected: SoroswapExpectation,
): UnmodelledTokenCall[] {
  const out: UnmodelledTokenCall[] = [];
  for (const entry of op.auth ?? []) {
    collectUnmodelledTokenCalls(entry.rootInvocation(), expectedSource, expected, out);
  }
  return out;
}

/**
 * Exported separately so the checks are unit-testable without any network.
 *
 * With an `expected` quote this is the wallet's only defence against a hostile
 * or compromised aggregator API: `/quote/build` returns a ready-made contract
 * call, and nothing about "invokeHostFunction" says whether it swaps or drains.
 * We therefore decode the arguments and hold the envelope to three claims that
 * a genuine swap always satisfies and a drain cannot:
 *
 *  1. every *account* address in the call (and in its authorised sub-calls) is
 *     the signing account; the proceeds cannot be routed to a stranger;
 *  2. no single amount exceeds what the quote itself moves, a `transfer(…,
 *     i128::MAX)` or a silently enlarged input is refused;
 *  3. the minimum the user was shown appears verbatim as an argument, the
 *     "you receive at least X" line is backed by the signed bytes, not by the
 *     API's good manners.
 *
 * Claims 1–3 are value-shaped and were blind to *contract* recipients, which is
 * how `swap(victim, attackerContract, …)` and a smuggled
 * `transfer(victim, attackerContract, amountIn)` both got through. Claim 4 is
 * therefore evaluated on the auth tree's structure rather than on a flat bag of
 * values:
 *
 *  4. the signing account authorises *exactly one* outflow in this envelope,
 *     that outflow sits on the SAC of the asset the quote says we are selling,
 *     it moves exactly `amountInStroops`; no more, no less, no second one,
 *     and it is a `transfer`, because an allowance or a burn never pays for a
 *     swap however well it fits the arithmetic.
 *
 * Claim 5 pins the top-level entry contract against the published Soroswap
 * deployment. Claims 4 and 5 together cover only the money *leaving*; the
 * proceeds were unchecked, which is what claims 6 and 7 close:
 *
 *  6. the pinned entry is called with the signature we pinned it for, its
 *     recipient argument is the signing account, its two token arguments are
 *     the SACs the quote names, and its `amount_in` / `amount_out_min` are the
 *     numbers the user was shown ({@link assertEntryCallShape}). Because the
 *     entry contract itself verifies the delivered amount against
 *     `amount_out_min` on `to`'s balance, this is what makes "you receive at
 *     least X" a property of the signed bytes rather than of API good manners.
 *  7. no function other than `transfer` may touch either quoted token contract
 *     while naming the signing account, so an administrative SAC call
 *     (`clawback`, `set_authorized`, …) can no longer ride along unseen next to
 *     an honest transfer.
 */
export function verifySoroswapEnvelope(
  xdrString: string,
  network: NetworkConfig,
  expectedSource: string,
  expected?: SoroswapExpectation,
): Transaction {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(xdrString, network.passphrase);
    if ('innerTransaction' in parsed) {
      throw new AppError('UNSUPPORTED_OPERATION', 'aggregator returned a fee-bump envelope');
    }
    tx = parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('NETWORK_ERROR', 'aggregator returned a malformed envelope');
  }
  if (tx.source !== expectedSource) {
    throw new AppError('BAD_REQUEST', 'aggregator envelope has a foreign source account');
  }
  const scan = emptyScan();
  const outflows: AuthorizedOutflow[] = [];
  const unmodelled: UnmodelledTokenCall[] = [];
  let authEntryCount = 0;
  for (const op of tx.operations) {
    if (!ALLOWED_OPERATIONS.includes(op.type)) {
      throw new AppError('BAD_REQUEST', `unexpected operation in swap envelope: ${op.type}`);
    }
    // Operation-level source hijacking is the same trick one level down.
    if (op.source !== undefined && op.source !== expectedSource) {
      throw new AppError('BAD_REQUEST', 'aggregator operation has a foreign source account');
    }
    const invoke = op as Operation.InvokeHostFunction;
    const role = assertPinnedEntryContract(invoke, network.passphrase);
    if (expected !== undefined) {
      assertEntryCallShape(invoke.func.invokeContract(), role, expectedSource, expected);
      unmodelled.push(...collectUnmodelledTokenCallsOf(invoke, expectedSource, expected));
    }
    const found = scanInvokeOperation(invoke);
    scan.accountAddresses.push(...found.accountAddresses);
    scan.contractAddresses.push(...found.contractAddresses);
    scan.exoticAddresses.push(...found.exoticAddresses);
    scan.amounts.push(...found.amounts);
    outflows.push(...collectAuthorizedOutflows(invoke, expectedSource));
    authEntryCount += (invoke.auth ?? []).length;
  }
  if (expected !== undefined) {
    assertEnvelopeMatchesQuote(scan, expectedSource, expected);
    assertAuthorisedOutflow(outflows, authEntryCount, hasResourceFootprint(tx), expected, scan);
    // Last, so the more specific diagnoses above win: an administrative or
    // simply unknown call on one of the quoted token contracts that names the
    // signing account. It is invisible to the outflow model, which is exactly
    // why it may not be tolerated next to an otherwise honest transfer.
    const stray = unmodelled[0];
    if (stray !== undefined) {
      throw new AppError(
        'SWAP_ENVELOPE_MISMATCH',
        `swap envelope authorises ${stray.fn} on the token contract ${stray.contract}; ` +
          'only transfer may touch a quoted token on behalf of the signing account',
      );
    }
  }
  if (BigInt(tx.fee) > MAX_SOROSWAP_FEE_STROOPS) {
    throw new AppError('BAD_REQUEST', `aggregator fee ${tx.fee} exceeds the ${MAX_SOROSWAP_FEE_STROOPS} stroop ceiling`);
  }
  if (BigInt(tx.fee) < BigInt(BASE_FEE)) {
    throw new AppError('BAD_REQUEST', 'aggregator fee below network minimum');
  }
  return tx;
}

function assertEnvelopeMatchesQuote(
  scan: ScanResult,
  expectedSource: string,
  expected: SoroswapExpectation,
): void {
  for (const account of scan.accountAddresses) {
    if (account !== expectedSource) {
      throw new AppError('SWAP_ENVELOPE_MISMATCH', `foreign recipient ${account}`);
    }
  }
  // A muxed `M…` renders as its own strkey, so it would sail past the loop
  // above while still naming a foreign underlying `G…`. Nothing in an
  // aggregator swap needs one, so any exotic address type is refused outright.
  const exotic = scan.exoticAddresses[0];
  if (exotic !== undefined) {
    throw new AppError('SWAP_ENVELOPE_MISMATCH', `unsupported address in swap call: ${exotic}`);
  }
  const amountIn = BigInt(expected.amountInStroops);
  const amountOut = BigInt(expected.amountOutStroops);
  // Both sides of the swap legitimately appear as arguments, and the output can
  // be numerically larger than the input (different decimals), so the ceiling is
  // the larger of the two. Anything above it is not part of this swap.
  const ceiling = amountIn > amountOut ? amountIn : amountOut;
  for (const amount of scan.amounts) {
    if (amount > ceiling) {
      throw new AppError('SWAP_ENVELOPE_MISMATCH', `amount ${amount.toString()} exceeds the quote`);
    }
  }
  // The promised minimum used to be checked by asking whether it occurred
  // *anywhere* among the decoded amounts; a claim a hostile envelope satisfies
  // by mentioning the number in any unrelated argument, and one that also
  // (wrongly) refused an envelope guaranteeing more than promised. It is now
  // checked where it actually binds: at `amount_out_min` of the pinned entry
  // call, see `assertEntryCallShape`, which runs before this function and is
  // strictly stronger, right contract, right function, right position, and
  // `>=` rather than "present somewhere".
}

/**
 * The primary, address-free invariant:
 *
 *   the signing account authorises EXACTLY ONE outflow in this envelope, and
 *   that outflow moves EXACTLY `amountInStroops` of the SAC of the asset the
 *   quote says is being sold.
 *
 * It needs no allowlist of counterparties: the SAC id of a classic asset is
 * derived locally from the asset and the network passphrase, and the amount
 * comes from the quote the user was shown. Whoever the funds go *to* is left
 * open on purpose, pools and adapters are route-dependent and unknowable, but
 * the size and the token of what leaves the account are nailed down, so an
 * extra hidden `transfer`, an inflated one, or one on a different token is out.
 *
 * ON AN EMPTY AUTH TREE. This function runs twice per swap: once on the raw
 * `/quote/build` response, which typically carries no auth entries at all, and
 * again on the envelope the Soroban RPC prepared, which does. "No auth entries"
 * therefore cannot simply mean "reject" without breaking the honest first pass.
 * The split:
 *
 * - auth entries present → the full invariant, no exceptions. Zero outflows
 *   among non-empty auth is itself a rejection: a swap that debits nobody is
 *   not the swap the user was shown, and it is the shape an attacker would pick
 *   to hide a drain behind a function name we do not model.
 * - no auth entries and no resource footprint → unprepared envelope. Accepted
 *   provisionally, and it is *not* silent: such an envelope cannot execute
 *   (submission fails without a footprint), it cannot debit the account either
 *   (`require_auth` has no entry to consume, not even for the source account),
 *   and the caller is required to re-verify the prepared bytes, which is the
 *   pass where auth entries exist and this invariant bites. The pinned entry
 *   contract and the value checks above still apply here.
 * - no auth entries but a resource footprint present → refused. That is a
 *   *prepared*, submittable envelope claiming it needs no authorization, which
 *   is either a nonsensical swap or an RPC trying to slip past this check.
 */
function assertAuthorisedOutflow(
  outflows: readonly AuthorizedOutflow[],
  authEntryCount: number,
  hasFootprint: boolean,
  expected: SoroswapExpectation,
  scan: ScanResult,
): void {
  if (authEntryCount === 0) {
    if (hasFootprint) {
      throw new AppError(
        'SWAP_ENVELOPE_MISMATCH',
        'prepared swap envelope authorises nothing; it cannot be the swap that was quoted',
      );
    }
    return;
  }
  if (outflows.length === 0) {
    const touched = [...new Set(scan.contractAddresses)].join(', ');
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      'swap envelope authorises no outflow from the signing account' +
        (touched.length > 0 ? `; it touches ${touched}` : ''),
    );
  }
  if (outflows.length > 1) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `swap envelope authorises ${outflows.length} outflows from the signing account, expected 1`,
    );
  }
  // outflows.length === 1, so the element exists; `at` keeps noUncheckedIndexedAccess happy.
  const only = outflows[0] as AuthorizedOutflow;
  if (only.contract === null || only.contract !== expected.sendAssetContract) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `authorised ${only.fn} debits ${only.contract ?? '<not a contract address>'}, ` +
        `not the expected token contract ${expected.sendAssetContract}`,
    );
  }
  const amountIn = BigInt(expected.amountInStroops);
  if (only.amount === null || only.amount !== amountIn) {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `authorised ${only.fn} moves ${only.amount?.toString() ?? '<unreadable amount>'} ` +
        `instead of the quoted ${expected.amountInStroops}`,
    );
  }
  // Right token, right size, and still not a swap payment unless it actually
  // settles. `approve(user, spender, amountIn)` satisfies every clause above
  // word for word while moving nothing: it hands a stranger the right to take
  // the tokens whenever they like, and the swap it is supposed to pay for never
  // happens. `burn`/`burn_from` destroy the input and buy nothing. Only a
  // `transfer` hands the input over in exchange for the output, so the single
  // authorised outflow has to be one. (`transfer_from` spends an allowance the
  // wallet never grants, so it is not on the list either.)
  if (only.fn !== 'transfer') {
    throw new AppError(
      'SWAP_ENVELOPE_MISMATCH',
      `swap envelope authorises ${only.fn}, not a transfer; an allowance or a burn ` +
        'never pays for a swap',
    );
  }
}
