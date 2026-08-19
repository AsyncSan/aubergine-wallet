/**
 * Background RPC handlers; the trusted core (ARCHITECTURE.md §3).
 *
 * Everything that touches key material happens here and nowhere else.
 * The handler map is typed against `rpcSchemas`, so a method added to the
 * protocol fails to compile until it is implemented.
 */
import { TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { AppError } from '../core/errors';
import { KEYSTORE_VERSION, decryptJson, encryptJson } from '../core/crypto/keystore';
import { generateMnemonic, normalizeMnemonic, validateMnemonic } from '../core/crypto/mnemonic';
import { Keyring } from '../core/keyring/keyring';
import { vaultSchema, type PublicAccount, type Vault } from '../core/keyring/account';
import {
  DEFAULT_SETTINGS,
  effectiveNetworkId,
  mergeSettings,
  type Settings,
} from '../core/settings';
import { resolveNetwork, type NetworkConfig } from '../core/stellar/networks';
import {
  assetIdsOf,
  chooseFee,
  envelopeIdentity,
  fetchAccount,
  fetchFeeStats,
  fetchHistory,
  findStrictSendPath,
  fundWithFriendbot,
  resolveSubmission,
  submitTransactionXdr,
  type AccountSnapshot,
} from '../core/stellar/horizon';
import {
  clearPendingSubmission,
  readPendingSubmission,
  writePendingSubmission,
  type PendingSubmission,
} from './pending-submission';
import {
  buildChangeTrustTransaction,
  buildPaymentTransaction,
  buildSwapTransaction,
} from '../core/stellar/tx-builder';
import {
  hasSorobanFootprint,
  isSorobanTransaction,
  prepareSorobanTransaction,
  resetSorobanEndpointCache,
} from '../core/stellar/soroban';
import {
  buildSoroswapSwap,
  expectationOf,
  fetchSoroswapQuote,
  soroswapConfigFromEnv,
  verifySoroswapEnvelope,
  type SoroswapQuote,
} from '../core/stellar/soroswap';
import {
  describeTransaction,
  type DescribeContext,
  type PathPaymentQuote,
  type TxDescription,
} from '../core/stellar/tx-describe';
import type { RpcMethod, RpcParams, RpcResult } from '../messaging/protocol';
import { AutoLock } from './autolock';
import { UnlockGuard } from './unlock-guard';
import {
  PromptQueue,
  normalizeOrigin,
  syncContentScriptRegistration,
} from './dapp';
import {
  clearKeystore,
  hasKeystore,
  keystoreIsUnreadable,
  readKeystore,
  readSettings,
  writeKeystore,
  writeSettings,
} from './storage';

/** Aggregator quotes are moment-in-time; building from a stale one is refused. */
const SOROSWAP_QUOTE_TTL_MS = 60_000;
/** How long an internally built swap may wait for its confirmation click. */
const INTERNAL_SWAP_TTL_MS = 10 * 60_000;

interface CachedSoroswapQuote {
  readonly quote: SoroswapQuote;
  readonly sendAssetId: string;
  readonly sendAmount: string;
  readonly destAssetId: string;
  readonly expiresAt: number;
}

/** Everything the handlers share. One instance per service-worker lifetime. */
export class BackgroundContext {
  readonly keyring = new Keyring();
  readonly prompts = new PromptQueue();
  readonly unlockGuard = new UnlockGuard();
  readonly autoLock: AutoLock;
  /** Optional at runtime: absent key -> DEX-only quotes, feature off. */
  readonly soroswap = soroswapConfigFromEnv();
  #settings: Settings = DEFAULT_SETTINGS;
  #settingsLoaded = false;
  /** Bumped on every local write; see `reloadSettings`. */
  #writeEpoch = 0;
  readonly #soroswapQuotes = new Map<string, CachedSoroswapQuote>();
  /**
   * §4 refinement (wallet-internal Soroban exception): tx hashes of swap
   * envelopes this background built itself via the aggregator. `tx.sign` may
   * sign these in beginner mode, once each. The dApp path (`dapp.signXdr`)
   * never consults this list; external contract calls stay developer-gated.
   */
  readonly #internalSorobanHashes = new Map<string, number>();

  cacheSoroswapQuote(entry: Omit<CachedSoroswapQuote, 'expiresAt'>): string {
    // Opportunistic sweep so an abandoned swap screen cannot grow the map.
    const now = Date.now();
    for (const [key, value] of this.#soroswapQuotes) {
      if (value.expiresAt <= now) this.#soroswapQuotes.delete(key);
    }
    const id = crypto.randomUUID();
    this.#soroswapQuotes.set(id, { ...entry, expiresAt: now + SOROSWAP_QUOTE_TTL_MS });
    return id;
  }

  /** Single use: one quote authorises one build (`take`, not `get`). */
  takeSoroswapQuote(id: string): CachedSoroswapQuote | null {
    const entry = this.#soroswapQuotes.get(id);
    if (!entry) return null;
    this.#soroswapQuotes.delete(id);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  markInternalSoroban(hashHex: string): void {
    const now = Date.now();
    for (const [key, expiry] of this.#internalSorobanHashes) {
      if (expiry <= now) this.#internalSorobanHashes.delete(key);
    }
    this.#internalSorobanHashes.set(hashHex, now + INTERNAL_SWAP_TTL_MS);
  }

  /** Single use: a hash grants exactly one beginner-mode signature. */
  consumeInternalSoroban(hashHex: string): boolean {
    const expiry = this.#internalSorobanHashes.get(hashHex);
    if (expiry === undefined) return false;
    this.#internalSorobanHashes.delete(hashHex);
    return expiry > Date.now();
  }

  constructor() {
    this.autoLock = new AutoLock(DEFAULT_SETTINGS.autoLockMinutes, () => {
      this.keyring.lock();
      this.prompts.rejectAll();
    });
  }

  async settings(): Promise<Settings> {
    if (!this.#settingsLoaded) {
      this.#settings = await readSettings();
      this.#settingsLoaded = true;
      this.autoLock.setMinutes(this.#settings.autoLockMinutes);
    }
    return this.#settings;
  }

  /**
   * Drop the per-worker settings cache and re-apply everything derived from it.
   *
   * Called when `chrome.storage` reports a change this worker did not make,
   * a second profile syncing the mode over `storage.sync`, or the user editing
   * settings in another window. Without it the cache lived for the whole worker
   * lifetime and a synced mode change simply never arrived.
   *
   * Security note: this must never *grant* anything. The connector is still
   * registered only through `syncContentScriptRegistration`, which fails closed
   * on `permissions.contains()`, so a mode change arriving from outside can
   * switch the UI to developer mode, but it cannot put a content script into
   * web pages the user has not granted access to.
   */
  async reloadSettings(): Promise<Settings> {
    /**
     * Every write fires `storage.onChanged`, including our own, so a reload is
     * always racing whatever the worker is doing next. Two writes in quick
     * succession (pass the mainnet gate, then switch the network) could have
     * the *first* reload finish after the *second* write and pin the stale
     * value in the cache; the wallet then reported a network it was no longer
     * on. The epoch makes a reload discard itself when a local write happened
     * while it was reading.
     */
    const epoch = this.#writeEpoch;
    const stored = await readSettings();
    if (epoch !== this.#writeEpoch) return this.#settings;
    this.#settings = stored;
    this.#settingsLoaded = true;
    this.autoLock.setMinutes(stored.autoLockMinutes);
    await syncContentScriptRegistration(stored.mode === 'developer');
    return stored;
  }

  async updateSettings(next: Settings): Promise<Settings> {
    this.#writeEpoch += 1;
    /**
     * The Soroban chain remembers which endpoint last worked. Changing the
     * network or the configured endpoint has to drop that memory, otherwise a
     * user who just corrected a typo keeps talking to whatever answered before.
     * (The cache keys on the chain contents, so this is belt and braces, but
     * the belt is one line.)
     */
    if (
      this.#settings.sorobanRpcOverride !== next.sorobanRpcOverride ||
      this.#settings.networkId !== next.networkId ||
      this.#settings.mode !== next.mode
    ) {
      resetSorobanEndpointCache();
    }
    this.#settings = next;
    this.#settingsLoaded = true;
    await writeSettings(next);
    this.autoLock.setMinutes(next.autoLockMinutes);
    await syncContentScriptRegistration(next.mode === 'developer');
    return next;
  }

  async network(): Promise<NetworkConfig> {
    const settings = await this.settings();
    return resolveNetwork(
      effectiveNetworkId(settings),
      settings.customNetwork ?? undefined,
      // Developer-mode only: a beginner has no way to set this, and a record
      // replicated from another profile cannot carry it either (it is stripped
      // from `storage.sync` in both directions, see `storage.ts`). Honouring it
      // in beginner mode would mean a mode switch silently changes which host
      // the wallet's Soroban traffic goes to.
      settings.mode === 'developer' ? settings.sorobanRpcOverride : null,
    );
  }

  /** Enforce the lock deadline before any authenticated operation. */
  requireUnlocked(): Keyring {
    if (this.autoLock.checkExpired() || !this.keyring.isUnlocked) {
      throw new AppError('WALLET_LOCKED');
    }
    return this.keyring;
  }

  async selectedIndex(): Promise<number> {
    return (await this.settings()).selectedAccountIndex;
  }

  async resolveIndex(index?: number): Promise<number> {
    return index ?? (await this.selectedIndex());
  }

  /** Persist the current vault under the given password. */
  async persistVault(vault: Vault, password: string): Promise<void> {
    await writeKeystore(await encryptJson(vaultSchema.parse(vault), password));
  }

  /**
   * The single password-checking chokepoint (unlock, reveal, account.add all
   * come through here), so the brute-force guard lives exactly here: refuse
   * while a lockout is active, count a wrong password, reset on success.
   */
  async loadVault(password: string): Promise<Vault> {
    const keystore = await readKeystore();
    if (keystore === 'unreadable') throw new AppError('KEYSTORE_UNREADABLE');
    if (!keystore) throw new AppError('NO_WALLET');
    // The guard serialises the attempts and owns the counting, so a burst of
    // parallel calls costs exactly as much as the same number of sequential
    // ones. Everything inside runs at most once at a time.
    return this.unlockGuard.attempt(async () => {
      const raw = await decryptJson(keystore, password);
      return vaultSchema.parse(raw);
    });
  }

  /* ------------------------------------------- the double-payment chokepoint */

  /**
   * The open submission *for the network this wallet is currently on*, or null.
   *
   * The passphrase comparison is the whole point and belongs here, not at each
   * call site: a record from another network can never collide with an envelope
   * built here (different sequence space, different Horizon), and its hash
   * would be looked up against the wrong network. Every reader, the guard,
   * `tx.pendingSubmission`, `tx.status`, goes through this one function, so
   * the refusal and the record the UI shows are always the same criterion (B12).
   */
  async pendingOnThisNetwork(): Promise<PendingSubmission | null> {
    const record = await readPendingSubmission();
    if (record === null) return null;
    const network = await this.network();
    return record.networkPassphrase === network.passphrase ? record : null;
  }

  /**
   * Which account a pending record belongs to; one rule for writers *and*
   * readers.
   *
   * It is the **source account of the envelope**, because that is what the
   * lock is about: two envelopes colliding over one sequence number, and a
   * sequence number belongs to the source account, never to whatever the popup
   * happens to have selected. Writing under `selectedIndex()` while checking
   * against `resolveIndex(params.accountIndex)` put the record on the wrong
   * account; the signing one stayed open and an uninvolved one was locked
   * (B5). An envelope this wallet holds no key for falls back to the selected
   * account: it could not have been signed here either, but the record must
   * still name something.
   */
  async accountIndexOfSource(sourceAccountId: string): Promise<number> {
    const known = this.knownAccountIndex(sourceAccountId);
    return known ?? this.selectedIndex();
  }

  /** The keyring index of an account id, or null when it is not ours. */
  knownAccountIndex(accountId: string): number | null {
    try {
      return this.keyring.indexOfPublicKey(accountId);
    } catch {
      return null;
    }
  }

  /**
   * The single gate between an open submission and a second payment.
   *
   * Modelled on `loadVault`: the unlock throttle does not sit in
   * `wallet.unlock`, it sits in the one function every password check passes
   * through, so no later caller can forget it. Same shape here. `tx.build`,
   * `tx.sign`, `tx.submit` and `dapp.signXdr` all come through this method,
   * the lock used to sit in `tx.build` alone, which left three other ways to
   * produce a fresh authorisation or a second envelope for the same account.
   *
   * Two scopes:
   *
   * - `accounts` set (a new *authorisation* is about to be created): a record
   *   blocks when it belongs to one of those accounts on this network. Another
   *   account cannot share a sequence number, another network cannot share a
   *   ledger.
   * - `accounts: null` (a submission is about to be *recorded*): any live
   *   record blocks, whatever account or network it names. Storage holds
   *   exactly one record and overwriting it destroys the hash of a transaction
   *   that can still be included, and that hash is the only handle anything
   *   has on it (B11). Refusing is recoverable; a lost hash is not.
   *
   * `envelopeHash` is the one exemption: re-signing or re-submitting the *same*
   * envelope is not a second payment, same hash, same sequence number, and the
   * network deduplicates it. (A Stellar transaction hash covers the envelope
   * without its signatures, so the unsigned envelope handed to `tx.sign` hashes
   * to the same value as the signed one handed to `tx.submit`.)
   */
  async assertNoOpenSubmission(scope: {
    readonly accounts: readonly number[] | null;
    readonly envelopeHash: string | null;
  }): Promise<void> {
    const record =
      scope.accounts === null ? await readPendingSubmission() : await this.pendingOnThisNetwork();
    if (record === null) return;
    if (scope.envelopeHash !== null && scope.envelopeHash === record.hash) return;
    if (scope.accounts !== null && !scope.accounts.includes(record.accountIndex)) return;
    throw new AppError('SUBMIT_OUTCOME_UNKNOWN', record.hash);
  }
}

/**
 * The domain types are `readonly`; the wire schemas are plain arrays. These two
 * adapters make the copy explicit instead of casting the difference away.
 */
function toWireSnapshot(snapshot: AccountSnapshot): RpcResult<'account.balances'> {
  return {
    ...snapshot,
    balances: [...snapshot.balances],
    signers: [...snapshot.signers],
  };
}

function toWireDescription(description: TxDescription): RpcResult<'tx.describe'> {
  return {
    ...description,
    effects: [...description.effects],
    warnings: [...description.warnings],
  };
}

type Handler<M extends RpcMethod> = (
  ctx: BackgroundContext,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;

type HandlerMap = { [M in RpcMethod]: Handler<M> };

/* ------------------------------------------------------------- helpers */

/**
 * The wallet accounts a signature over this envelope would commit: the one
 * whose key signs, plus, when it is one of ours, the one whose sequence
 * number the envelope consumes. Normally the same index; they differ only when
 * a caller signs for a source account other than its own.
 */
function accountsBoundBy(
  ctx: BackgroundContext,
  sourceAccountId: string,
  signerIndex: number,
): readonly number[] {
  const sourceIndex = ctx.knownAccountIndex(sourceAccountId);
  return sourceIndex === null || sourceIndex === signerIndex
    ? [signerIndex]
    : [signerIndex, sourceIndex];
}

async function unlockInto(
  ctx: BackgroundContext,
  vault: Vault,
): Promise<PublicAccount[]> {
  await ctx.keyring.unlock(vault);
  await ctx.autoLock.touch();
  return ctx.keyring.listAccounts();
}

async function snapshotFor(
  ctx: BackgroundContext,
  index: number,
): Promise<AccountSnapshot> {
  const keyring = ctx.requireUnlocked();
  const network = await ctx.network();
  return fetchAccount(network, keyring.publicKeyOf(index));
}

async function describeContextFor(
  ctx: BackgroundContext,
  index: number,
  declaredNetworkPassphrase?: string,
): Promise<DescribeContext> {
  const keyring = ctx.requireUnlocked();
  const network = await ctx.network();
  const accountId = keyring.publicKeyOf(index);
  const snapshot = await fetchAccount(network, accountId);

  // Everything the describer needs is resolved here, so `tx-describe` itself
  // stays a pure function (§5).
  const base: DescribeContext = {
    networkPassphrase: network.passphrase,
    networkName: network.id,
    accountId,
    ...(snapshot.exists ? { currentSequence: snapshot.sequence } : {}),
    knownAssets: assetIdsOf(snapshot),
    trustedIssuers: snapshot.balances
      .map((b) => b.issuer)
      .filter((issuer): issuer is string => issuer !== null),
    isMainnet: network.isMainnet,
  };
  return declaredNetworkPassphrase === undefined
    ? base
    : { ...base, declaredNetworkPassphrase };
}

/** Look up destination accounts referenced by the envelope, for the warnings. */
async function withDestinationExistence(
  ctx: BackgroundContext,
  xdr: string,
  base: DescribeContext,
): Promise<DescribeContext> {
  const network = await ctx.network();
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(xdr, network.passphrase);
    tx = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
  } catch {
    return base;
  }
  const destinations = new Set<string>();
  for (const op of tx.operations) {
    if ('destination' in op && typeof op.destination === 'string') {
      destinations.add(op.destination);
    }
  }
  const accountExists: Record<string, boolean> = {};
  const memoRequiredAccounts: string[] = [];
  for (const destination of destinations) {
    try {
      const snapshot = await fetchAccount(network, destination);
      accountExists[destination] = snapshot.exists;
      // SEP-29: collect flagged destinations so the describer can raise
      // MEMO_REQUIRED on memo-less transactions towards them.
      if (snapshot.exists && snapshot.memoRequired) memoRequiredAccounts.push(destination);
    } catch {
      /* leave unknown rather than claiming it does not exist */
    }
  }
  return {
    ...base,
    accountExists,
    ...(memoRequiredAccounts.length > 0 ? { memoRequiredAccounts } : {}),
  };
}

/**
 * Fresh DEX quotes for the strict-send path payments in an envelope, so the
 * describer can compare each op's `destMin` against what the books currently
 * yield and raise HIGH_SLIPPAGE (§5). A failed lookup leaves the op without a
 * quote, which the describer reports as SLIPPAGE_UNKNOWN, never sign around it.
 */
async function withPathPaymentQuotes(
  ctx: BackgroundContext,
  xdr: string,
  base: DescribeContext,
): Promise<DescribeContext> {
  const network = await ctx.network();
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(xdr, network.passphrase);
    tx = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
  } catch {
    return base;
  }
  const idOf = (asset: { isNative(): boolean; code: string; issuer: string | undefined }): string =>
    asset.isNative() ? 'native' : `${asset.code}:${asset.issuer ?? ''}`;
  const quotes: PathPaymentQuote[] = [];
  for (const [index, op] of tx.operations.entries()) {
    if (op.type !== 'pathPaymentStrictSend') continue;
    try {
      const quote = await findStrictSendPath(
        network,
        idOf(op.sendAsset),
        op.sendAmount,
        idOf(op.destAsset),
      );
      if (quote) quotes.push({ opIndex: index, expectedDestAmount: quote.destAmount });
    } catch {
      /* no quote -> the describer says "could not check", which is the truth */
    }
  }
  return quotes.length > 0 ? { ...base, pathPaymentQuotes: quotes } : base;
}

/**
 * The fee for one classic envelope this wallet builds itself.
 *
 * Order of precedence, deliberately: the developer-mode override wins
 * outright; it is the escape hatch for someone who knows what they are doing
 * and it must not be second-guessed by a network hint. Otherwise Horizon's
 * `/fee_stats` decides, and if that is unavailable the choice falls back to
 * `BASE_FEE` (`fetchFeeStats` answers `null` rather than throwing, so a
 * hiccup at the fee endpoint can never stop a payment from being built).
 *
 * The returned value is stroops **per operation**, which is what
 * `TransactionBuilder({ fee })` expects; all three builders below emit exactly
 * one operation, so `operationCount` is 1 and the envelope's total fee equals
 * this number. It is not applied to the Soroban/aggregator route, see there.
 */
async function feeForBuild(
  network: NetworkConfig,
  override: string | undefined,
  operationCount = 1,
): Promise<string> {
  if (override !== undefined && override.length > 0) return override;
  return chooseFee(await fetchFeeStats(network), operationCount).perOperationStroops;
}

/* ------------------------------------------------------------ handlers */

export const handlers: HandlerMap = {
  'wallet.create': async (ctx, params) => {
    // Unreadable beats "exists": the user must be told that their vault is
    // still there and must not be overwritten, not that they already have one.
    if (await keystoreIsUnreadable()) throw new AppError('KEYSTORE_UNREADABLE');
    if (await hasKeystore()) throw new AppError('WALLET_EXISTS');
    const mnemonic = generateMnemonic(params.strength);
    const vault: Vault = {
      version: 1,
      mnemonic,
      accounts: [{ index: 0, label: '' }],
    };
    await ctx.persistVault(vault, params.password);
    return { accounts: await unlockInto(ctx, vault) };
  },

  'wallet.importMnemonic': async (ctx, params) => {
    if (await keystoreIsUnreadable()) throw new AppError('KEYSTORE_UNREADABLE');
    if (await hasKeystore()) throw new AppError('WALLET_EXISTS');
    const mnemonic = normalizeMnemonic(params.mnemonic);
    if (!validateMnemonic(mnemonic)) throw new AppError('INVALID_MNEMONIC');
    // Finding 7: the BIP-39 passphrase is part of the derivation. It is stored
    // with the phrase and fed into `mnemonicToSeed` on every unlock, so a
    // 25th-word wallet restores to the accounts the user expects.
    const vault: Vault = {
      version: 1,
      mnemonic,
      ...(params.bip39Passphrase === undefined || params.bip39Passphrase === ''
        ? {}
        : { bip39Passphrase: params.bip39Passphrase }),
      accounts: [{ index: 0, label: '' }],
    };
    await ctx.persistVault(vault, params.password);
    return { accounts: await unlockInto(ctx, vault) };
  },

  'wallet.unlock': async (ctx, params) => {
    const vault = await ctx.loadVault(params.password);
    /**
     * Opportunistic keystore upgrade: a legacy blob (v1, header not bound as
     * GCM `additionalData`) is re-encrypted in the current format the moment
     * the owner proves the password. Best effort on purpose, a failed write
     * must not turn a *correct* password into a failed unlock; the v1 blob
     * stays readable and the next unlock tries again.
     */
    try {
      const stored = await readKeystore();
      if (stored !== null && stored !== 'unreadable' && stored.v !== KEYSTORE_VERSION) {
        await ctx.persistVault(vault, params.password);
      }
    } catch {
      /* keep the v1 blob; upgrading is not worth blocking an unlock */
    }
    return { accounts: await unlockInto(ctx, vault) };
  },

  'wallet.lock': async (ctx) => {
    ctx.keyring.lock();
    ctx.prompts.rejectAll();
    await ctx.autoLock.cancel();
    return {};
  },

  'wallet.status': async (ctx) => {
    const expired = ctx.autoLock.checkExpired();
    return {
      initialized: await hasKeystore(),
      unlocked: !expired && ctx.keyring.isUnlocked,
      autoLockAt: ctx.keyring.isUnlocked ? ctx.autoLock.deadline : null,
    };
  },

  /**
   * The one place a recovery phrase leaves the background, and only after the
   * user re-enters their password. Used by the onboarding backup screen and by
   * Settings -> show recovery phrase.
   */
  'wallet.revealRecoveryPhrase': async (ctx, params) => {
    const vault = await ctx.loadVault(params.password);
    return {
      mnemonic: vault.mnemonic,
      bip39Passphrase: vault.bip39Passphrase ?? null,
    };
  },

  'wallet.reset': async (ctx) => {
    ctx.keyring.lock();
    ctx.prompts.rejectAll();
    await ctx.autoLock.cancel();
    await clearKeystore();
    // The keystore is gone, so the throttle protects nothing anymore; a stale
    // lockout would only confuse the next onboarding.
    await ctx.unlockGuard.reset();
    // Same reasoning for the open-submission lock: it belongs to a wallet that
    // no longer exists, and it would block the first payment of the next one.
    await clearPendingSubmission();
    await ctx.updateSettings({ ...DEFAULT_SETTINGS });
    return {};
  },

  'account.list': async (ctx) => {
    const keyring = ctx.requireUnlocked();
    return {
      accounts: keyring.listAccounts(),
      selectedIndex: await ctx.selectedIndex(),
    };
  },

  /**
   * Finding 10: the vault has to be re-encrypted, otherwise the derived account
   * is RAM-only and disappears on the next lock. Re-encryption needs the
   * password, which the background deliberately does not retain, so the UI
   * asks for it, we re-decrypt, add, and write back. The password check is the
   * decryption itself (a wrong one throws BAD_PASSWORD before anything else).
   */
  'account.add': async (ctx, params) => {
    const keyring = ctx.requireUnlocked();
    const vault = await ctx.loadVault(params.password);
    const account = await keyring.addAccount(params.label);
    try {
      await ctx.persistVault({ ...vault, accounts: keyring.accountMetas() }, params.password);
    } catch (err) {
      // Never leave RAM and storage disagreeing: roll the account back.
      keyring.removeAccount(account.index);
      throw err;
    }
    await ctx.autoLock.touch();
    return { account };
  },

  'account.select': async (ctx, params) => {
    const keyring = ctx.requireUnlocked();
    keyring.publicKeyOf(params.index); // throws for an unknown index
    const settings = await ctx.settings();
    const next = await ctx.updateSettings(
      mergeSettings(settings, { selectedAccountIndex: params.index }),
    );
    return { selectedIndex: next.selectedAccountIndex };
  },

  /**
   * Reads deliberately do NOT `touch()` the auto-lock. The popup polls
   * balances every 30 s, so a wallet left open in a tab kept renewing its own
   * 15-minute deadline forever, auto-lock only ever fired for users who
   * closed the window anyway. The deadline is a bound on *unattended* access;
   * only operations a human actually initiates (unlock, build, sign, submit,
   * account.add) may extend it.
   */
  'account.balances': async (ctx, params) => {
    ctx.requireUnlocked();
    return toWireSnapshot(await snapshotFor(ctx, await ctx.resolveIndex(params.index)));
  },

  'account.history': async (ctx, params) => {
    const keyring = ctx.requireUnlocked();
    const index = await ctx.resolveIndex(params.index);
    const network = await ctx.network();
    return {
      entries: await fetchHistory(network, keyring.publicKeyOf(index), params.limit),
    };
  },

  'account.fund': async (ctx, params) => {
    const keyring = ctx.requireUnlocked();
    const network = await ctx.network();
    const index = await ctx.resolveIndex(params.index);
    await fundWithFriendbot(network, keyring.publicKeyOf(index));
    return {};
  },

  'tx.build': async (ctx, params) => {
    const keyring = ctx.requireUnlocked();
    await ctx.autoLock.touch();
    const settings = await ctx.settings();
    const network = await ctx.network();
    const index = await ctx.resolveIndex(params.accountIndex);
    /**
     * The double-payment guard, first of four call sites. Building is where
     * the damage is done, `tx.build` fetches a *fresh* sequence number, so if
     * the first payment does get included the second one is seq+1 and both go
     * through. The rule itself lives in `assertNoOpenSubmission`; the record
     * lifts itself once the envelope's timebound has passed (`pendingIsStale`),
     * so a wallet can never be locked out permanently.
     */
    await ctx.assertNoOpenSubmission({ accounts: [index], envelopeHash: null });
    const source = keyring.publicKeyOf(index);
    const snapshot = await fetchAccount(network, source);
    if (!snapshot.exists) throw new AppError('ACCOUNT_NOT_FOUND', source);

    // §4: a manual fee is a developer-mode capability only.
    const feeAllowed = settings.mode === 'developer';

    if (params.intent.kind === 'payment') {
      const destination = await fetchAccount(network, params.intent.destination);
      // SEP-29 fail-closed: never even build a memo-less payment towards an
      // account that has declared `config.memo_required`, the classic
      // exchange-deposit loss. The UI surfaces the error and asks for a memo.
      if (
        destination.exists &&
        destination.memoRequired &&
        (params.intent.memo === undefined || params.intent.memo.length === 0)
      ) {
        throw new AppError('MEMO_REQUIRED', params.intent.destination);
      }
      const feeStroops = await feeForBuild(
        network,
        feeAllowed ? params.intent.feeStroops : undefined,
      );
      return {
        xdr: buildPaymentTransaction(network, source, snapshot.sequence, {
          destination: params.intent.destination,
          assetId: params.intent.assetId,
          amount: params.intent.amount,
          destinationExists: destination.exists,
          ...(params.intent.memo === undefined ? {} : { memo: params.intent.memo }),
          feeStroops,
        }),
      };
    }

    if (params.intent.kind === 'swap') {
      if (params.intent.route === 'soroswap') {
        // Aggregator route: rebuild from the quote *we* cached, the popup
        // only ever hands back the opaque id, so a tampered popup cannot
        // smuggle altered amounts or a foreign recipient into the build.
        if (ctx.soroswap === null) {
          throw new AppError('BAD_REQUEST', 'soroswap route requested but not configured');
        }
        const cached =
          params.intent.quoteId === undefined ? null : ctx.takeSoroswapQuote(params.intent.quoteId);
        if (
          cached === null ||
          cached.sendAssetId !== params.intent.sendAssetId ||
          cached.sendAmount !== params.intent.sendAmount ||
          cached.destAssetId !== params.intent.destAssetId
        ) {
          throw new AppError('QUOTE_EXPIRED');
        }
        const built = await buildSoroswapSwap(ctx.soroswap, network, cached.quote, source);
        let finalXdr = built.xdr;
        let finalTx = built.tx;
        // An unprepared envelope has no resource footprint and would fail on
        // submission; preparing is a read-only RPC round trip, mode-independent.
        if (!hasSorobanFootprint(built.tx)) {
          const { preparedXdr, summary } = await prepareSorobanTransaction(network, built.xdr);
          if (!summary.ok) {
            throw new AppError('SOROBAN_SIMULATION_FAILED', summary.error ?? 'simulation failed');
          }
          finalXdr = preparedXdr;
          // Preparation is not a formality: the RPC server sets the resource fee
          // and copies its own `auth` entries into the operation. Those become
          // part of what the signature covers, so the prepared envelope has to
          // pass exactly the same checks as the one the aggregator sent, the
          // fee ceiling included, which the pre-preparation check cannot see.
          finalTx = verifySoroswapEnvelope(
            preparedXdr,
            network,
            source,
            expectationOf(cached.quote),
          );
        }
        // §4 refinement: exactly these bytes may be signed once in beginner mode.
        ctx.markInternalSoroban(finalTx.hash().toString('hex'));
        /**
         * No fee strategy on this branch, on purpose. A Soroban envelope's fee
         * is inclusion fee + resource fee, and the resource half is set by the
         * simulation (`prepareTransaction` rewrites `fee` to
         * `classicFee + minResourceFee`). Raising the inclusion half here would
         * be measured against `MAX_SOROSWAP_FEE_STROOPS`, which is a ceiling on
         * the *total*, so a classic-fee ceiling applied to it would compare two
         * different quantities. The aggregator sets the inclusion fee and
         * `verifySoroswapEnvelope` bounds the total; that stays the contract.
         */
        return { xdr: finalXdr };
      }
      const feeStroops = await feeForBuild(
        network,
        feeAllowed ? params.intent.feeStroops : undefined,
      );
      return {
        xdr: buildSwapTransaction(network, source, snapshot.sequence, {
          sendAssetId: params.intent.sendAssetId,
          sendAmount: params.intent.sendAmount,
          destAssetId: params.intent.destAssetId,
          destMin: params.intent.destMin,
          path: params.intent.path,
          feeStroops,
        }),
      };
    }

    const feeStroops = await feeForBuild(
      network,
      feeAllowed ? params.intent.feeStroops : undefined,
    );
    return {
      xdr: buildChangeTrustTransaction(network, source, snapshot.sequence, {
        assetCode: params.intent.assetCode,
        issuer: params.intent.issuer,
        ...(params.intent.limit === undefined ? {} : { limit: params.intent.limit }),
        feeStroops,
      }),
    };
  },

  'tx.describe': async (ctx, params) => {
    const index = await ctx.resolveIndex(params.accountIndex);
    const base = await describeContextFor(ctx, index, params.declaredNetworkPassphrase);
    const withDest = await withDestinationExistence(ctx, params.xdr, base);
    const withQuotes = await withPathPaymentQuotes(ctx, params.xdr, withDest);
    return toWireDescription(describeTransaction(params.xdr, withQuotes));
  },

  /**
   * Quote for the swap screen. No key material is involved, this is a
   * read-only "what would I get" question, but it runs in the background so
   * the popup never talks to a third party directly.
   *
   * On rate limiting, precisely: only the DEX branch is throttled. It goes
   * through `findStrictSendPath` -> `limited()` -> the shared bucket in
   * `core/net/limiter.ts`. The Soroswap branch calls the aggregator with a
   * bare `fetch` in `soroswap.ts` and is bounded by its own timeout alone,
   * it is a different host with a different quota, but it is not "behind the
   * limiter", and the previous comment claiming both were is simply wrong.
   */
  'swap.quote': async (ctx, params) => {
    const network = await ctx.network();
    // Both sources race in parallel; either failing alone must not break the
    // screen. The DEX quote is the baseline, the aggregator an upgrade on top.
    const [dexSettled, soroswapSettled] = await Promise.allSettled([
      findStrictSendPath(network, params.sendAssetId, params.sendAmount, params.destAssetId),
      ctx.soroswap === null
        ? Promise.resolve(null)
        : fetchSoroswapQuote(
            ctx.soroswap,
            network,
            params.sendAssetId,
            params.sendAmount,
            params.destAssetId,
            params.slippageBps,
          ),
    ]);
    const dex = dexSettled.status === 'fulfilled' ? dexSettled.value : null;
    const soroswap = soroswapSettled.status === 'fulfilled' ? soroswapSettled.value : null;
    // Surface a real transport failure only when *no* source delivered.
    if (dex === null && soroswap === null && dexSettled.status === 'rejected') {
      throw dexSettled.reason;
    }

    const dexAmount = dex?.destAmount ?? null;
    const soroswapAmount = soroswap?.destAmount ?? null;
    const empty = {
      source: 'dex' as const,
      quoteId: null,
      minReceived: null,
      priceImpactPct: null,
      platform: null,
      dexDestAmount: dexAmount,
      soroswapDestAmount: soroswapAmount,
    };
    if (dex === null && soroswap === null) {
      return { ...empty, found: false, destAmount: '0', path: [] };
    }

    const soroswapWins =
      soroswap !== null && (dex === null || Number(soroswap.destAmount) > Number(dex.destAmount));
    if (soroswapWins) {
      const quoteId = ctx.cacheSoroswapQuote({
        quote: soroswap,
        sendAssetId: params.sendAssetId,
        sendAmount: params.sendAmount,
        destAssetId: params.destAssetId,
      });
      return {
        ...empty,
        found: true,
        destAmount: soroswap.destAmount,
        path: [],
        source: 'soroswap',
        quoteId,
        minReceived: soroswap.minReceived,
        priceImpactPct: soroswap.priceImpactPct,
        platform: soroswap.platform,
      };
    }
    // dex !== null here: soroswapWins was false, so dex carried the quote.
    if (dex === null) return { ...empty, found: false, destAmount: '0', path: [] };
    return { ...empty, found: true, destAmount: dex.destAmount, path: [...dex.path] };
  },

  /**
   * Signing. The keypair is derived, used and dropped inside `Keyring`;
   * only the signed envelope comes back (invariant 1).
   */
  'tx.sign': async (ctx, params) => {
    const keyring = ctx.requireUnlocked();
    await ctx.autoLock.touch();
    const settings = await ctx.settings();
    const network = await ctx.network();
    const index = await ctx.resolveIndex(params.accountIndex);
    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(params.xdr, network.passphrase);
      if ('innerTransaction' in parsed) {
        throw new AppError('UNSUPPORTED_OPERATION', 'fee-bump signing is not supported yet');
      }
      tx = parsed;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('BAD_REQUEST', 'malformed transaction envelope');
    }
    // §4 row 3 (refined): *external* contract calls are a developer-mode
    // capability, enforced here as well as in the UI, so a tampered popup
    // cannot reach it either. The one exception is a swap envelope this
    // background built itself via the aggregator: its hash was allow-listed at
    // build time and grants exactly one signature (wallet-internal exception).
    if (isSorobanTransaction(tx) && settings.mode !== 'developer') {
      const isInternalSwap = ctx.consumeInternalSoroban(tx.hash().toString('hex'));
      if (!isInternalSwap) {
        throw new AppError('DEVELOPER_MODE_REQUIRED', 'soroban invocation in beginner mode');
      }
    }
    /**
     * Second call site (B2). A signature *is* the authorisation, an envelope
     * built before the first submission went open, or one handed in from
     * anywhere else, becomes spendable the moment it is signed, and the popup
     * is not the only thing that can call this. Both the account that signs and
     * the account the envelope draws its sequence number from are checked; the
     * envelope in hand is exempt, because signing the very same bytes twice
     * produces the same transaction, not a second one.
     */
    await ctx.assertNoOpenSubmission({
      accounts: accountsBoundBy(ctx, tx.source, index),
      envelopeHash: tx.hash().toString('hex'),
    });
    return { signedXdr: await keyring.signTransaction(tx, index) };
  },

  /**
   * Submit, and remember what was submitted *before* it leaves.
   *
   * The record is written first on purpose. If the service worker is torn down
   * while the POST is in flight (MV3 may do that at any moment, and a 60 s
   * request is a long moment), nothing here gets to run its `catch`: the
   * popup's RPC call simply never comes back. The record is then the only
   * trace that a transaction exists at all, and it is what the popup finds
   * when it asks `tx.pendingSubmission` after its own timeout.
   */
  'tx.submit': async (ctx, params) => {
    ctx.requireUnlocked();
    await ctx.autoLock.touch();
    const network = await ctx.network();
    const identity = await envelopeIdentity(network, params.signedXdr);
    /**
     * Third call site, and the one the whole guard was missing (B1/B11).
     *
     * `tx.submit` used to write its record unconditionally. A second submit
     * therefore *overwrote* the first record with its own hash, the first,
     * unresolved transaction lost the only handle anything had on it, and
     * then *cleared* the record when the second one succeeded, unlocking
     * `tx.build` while the first envelope could still enter a ledger until its
     * `maxTime`. That is precisely the double payment this file exists to
     * prevent, reached by skipping `tx.build` entirely.
     *
     * What happens now: the same envelope passes (same hash, same sequence
     * number; the network deduplicates it, and a user retrying a submission
     * that timed out is doing the right thing). Any *other* envelope is
     * refused with SUBMIT_OUTCOME_UNKNOWN while a record is open, whatever
     * account or network that record names, because storage holds one record
     * and overwriting it is unrecoverable. The refusal lifts by itself when the
     * record resolves or its timebound expires.
     */
    await ctx.assertNoOpenSubmission({ accounts: null, envelopeHash: identity.hash });
    /**
     * B5: the record is keyed by the envelope's own source account, the same
     * quantity every check resolves, not by whatever the popup has selected.
     */
    const index = await ctx.accountIndexOfSource(identity.sourceAccount);
    /**
     * A resubmission keeps the original `createdAt`. Otherwise re-submitting a
     * timebound-less envelope would push `PENDING_MAX_LIFETIME_MS` out again on
     * every attempt and the record could be kept alive indefinitely.
     */
    const prior = await readPendingSubmission();
    const resubmission = prior !== null && prior.hash === identity.hash;
    const createdAt = resubmission ? prior.createdAt : Date.now();
    await writePendingSubmission({
      hash: identity.hash,
      maxTimeUnix: identity.maxTimeUnix,
      accountIndex: index,
      networkPassphrase: network.passphrase,
      kind: 'unknown',
      createdAt,
      answered: false,
    });
    let result;
    try {
      result = await submitTransactionXdr(network, params.signedXdr);
    } catch (err) {
      /**
       * A result code from the network is a *reasoned* rejection: nothing was
       * applied, the sequence number was not consumed, and the user may retry.
       * Holding the lock here would be the mirror image of the original bug.
       *
       * Except on a resubmission. If this envelope was already out there with
       * an unknown outcome, a rejection of *this* attempt says nothing about
       * the first one, `tx_bad_seq` on a retry is exactly what an earlier
       * attempt still sitting in front of consensus looks like. The record
       * stays and `tx.status` resolves it.
       */
      if (!resubmission) await clearPendingSubmission();
      throw err;
    }
    if (result.outcome === 'success') {
      // A ledger is a final answer for this hash, resubmission or not.
      await clearPendingSubmission();
      return result;
    }
    await writePendingSubmission({
      hash: result.hash,
      maxTimeUnix: result.maxTimeUnix,
      accountIndex: index,
      networkPassphrase: network.passphrase,
      kind: 'unknown',
      createdAt,
      answered: true,
    });
    return result;
  },

  'tx.pendingSubmission': async (ctx) => {
    ctx.requireUnlocked();
    // A record from another network says nothing about this one, and its hash
    // would be looked up against the wrong Horizon. Same reader as the guard,
    // so the answer and the refusal can never disagree.
    const record = await ctx.pendingOnThisNetwork();
    if (record === null) return { pending: null };
    return {
      pending: {
        hash: record.hash,
        maxTimeUnix: record.maxTimeUnix,
        accountIndex: record.accountIndex,
        kind: record.kind,
        createdAt: record.createdAt,
        answered: record.answered,
      },
    };
  },

  /**
   * Resolve one pending submission by asking Horizon for the hash.
   *
   * Deliberately *pull*, not push: the popup drives it. A background loop would
   * have to survive the service worker being killed between two polls, which
   * MV3 does not promise for `setTimeout`; the only tool that does is
   * `chrome.alarms`, whose floor of one minute is coarser than the 180 s window
   * it would have to cover. One RPC per poll, on the other hand, wakes the
   * worker for exactly the time a single Horizon GET takes. What is lost when
   * the popup closes is only the *automatic* resolution; the record survives in
   * session storage and the next open resumes it.
   */
  'tx.status': async (ctx, params) => {
    ctx.requireUnlocked();
    const network = await ctx.network();
    const record = await ctx.pendingOnThisNetwork();
    const mine = record !== null && record.hash === params.hash;
    /**
     * B13b: the deadline comes from the stored record, never from the caller.
     * `tx.status` used to prefer `params.maxTimeUnix`, so `maxTimeUnix: '1'`
     * made the very next 404 read as `expired`, cleared the record and let
     * `tx.build` build again, up to 180 s before the first envelope had
     * stopped being valid. The parameter had no legitimate use (the popup only
     * ever echoed back what the record already said) and is gone from the
     * schema; a transaction is valid exactly as long as its own timebound says.
     *
     * A hash this wallet has no record for gets `'0'`: nothing here can prove
     * such an envelope will never be included, so the answer stays `pending`.
     */
    const maxTimeUnix = mine ? record.maxTimeUnix : '0';
    const resolution = await resolveSubmission(network, params.hash, maxTimeUnix);
    // Only these two are final answers, so only these two lift the lock:
    // `included` means the user can see what happened, `expired` means the
    // envelope can never enter a ledger and a fresh transaction cannot collide
    // with it. `pending` and `unknown` are "still no answer" and must keep it.
    if (mine && (resolution.state === 'included' || resolution.state === 'expired')) {
      await clearPendingSubmission();
    }
    return resolution;
  },

  'dapp.requestConnect': async (ctx, params) => {
    const settings = await ctx.settings();
    if (settings.mode !== 'developer') throw new AppError('DEVELOPER_MODE_REQUIRED');
    const origin = normalizeOrigin(params.origin);

    /**
     * The lock check comes *after* the approval check, deliberately.
     *
     * `requireUnlocked()` used to run first, which handed every page in the
     * browser the oracle that `isConnected` was hardened to remove
     * (`entrypoints/background.ts`): an unapproved origin got WALLET_LOCKED
     * while locked and a prompt while unlocked, so polling `getPublicKey()`
     * on a timer told a hostile page the exact moment the user unlocked their
     * wallet, the targeting signal a phishing page wants most.
     *
     * An origin the user has already approved is a different matter: it needs
     * the public key, so it necessarily learns the wallet is unlocked. An
     * origin the user has *not* approved reaches the prompt either way and
     * learns nothing without a human acting.
     */
    if (settings.allowedOrigins.includes(origin)) {
      const keyring = ctx.requireUnlocked();
      return { approved: true, publicKey: keyring.publicKeyOf(await ctx.selectedIndex()) };
    }
    const approved = await ctx.prompts.ask('connect', origin, null);
    if (!approved) return { approved: false, publicKey: null };
    /**
     * Re-read the settings: `settings` above is a snapshot from before a wait
     * that can last two minutes. Writing the merged *snapshot* back was a lost
     * update on a security-relevant record, anything the user changed while
     * the prompt was open (revoking another origin, tightening the auto-lock,
     * leaving developer mode) was silently rolled back by the approval, and
     * because settings live in `storage.sync` the rollback propagated to the
     * user's other profiles.
     */
    const current = await ctx.settings();
    // The preconditions have to hold *now*, not when the page asked.
    if (current.mode !== 'developer') throw new AppError('DEVELOPER_MODE_REQUIRED');
    const keyring = ctx.requireUnlocked();
    if (!current.allowedOrigins.includes(origin)) {
      await ctx.updateSettings(
        mergeSettings(current, { allowedOrigins: [...current.allowedOrigins, origin] }),
      );
    }
    return { approved: true, publicKey: keyring.publicKeyOf(await ctx.selectedIndex()) };
  },

  'dapp.signXdr': async (ctx, params) => {
    const settings = await ctx.settings();
    if (settings.mode !== 'developer') throw new AppError('DEVELOPER_MODE_REQUIRED');
    const origin = normalizeOrigin(params.origin);
    /**
     * Refused before the lock state is ever consulted, and before any work is
     * done. The old order (`requireUnlocked()` first) meant an unapproved
     * origin got WALLET_LOCKED while locked and USER_REJECTED while unlocked,
     * both instantly, with no prompt, no badge and nothing the user could
     * see, and outside the prompt-queue caps because no prompt was ever
     * queued. A page could poll this on a timer and watch for the moment the
     * wallet came unlocked. Same oracle `isConnected` was hardened against,
     * reached through a different method.
     */
    if (!settings.allowedOrigins.includes(origin)) throw new AppError('USER_REJECTED');
    const keyring = ctx.requireUnlocked();

    const network = await ctx.network();
    const parsedIncoming = TransactionBuilder.fromXDR(params.xdr, network.passphrase);
    if ('innerTransaction' in parsedIncoming) {
      throw new AppError('UNSUPPORTED_OPERATION', 'fee-bump signing is not supported yet');
    }

    /**
     * §4 row 3: contract calls are allowed here (this path is developer-mode
     * only). An unprepared Soroban envelope has no resource footprint and would
     * fail on submission, so we simulate it first and, crucially, let the
     * user confirm the *prepared* envelope, i.e. exactly the bytes we sign.
     * A failed simulation is surfaced, never signed around (§5 fail-closed).
     */
    let xdrToSign = params.xdr;
    if (isSorobanTransaction(parsedIncoming) && !hasSorobanFootprint(parsedIncoming)) {
      const { preparedXdr, summary } = await prepareSorobanTransaction(network, params.xdr);
      if (!summary.ok) {
        throw new AppError('SOROBAN_SIMULATION_FAILED', summary.error ?? 'simulation failed');
      }
      xdrToSign = preparedXdr;
    }

    // P2: resolve the signing account *before* the prompt. An unknown
    // `accountToSign` now fails fast (BAD_REQUEST) instead of after the user
    // already approved, and the dialog can show exactly which account the
    // page asked to sign with.
    /**
     * An unknown `accountToSign` answers with USER_REJECTED, not with
     * "unknown public key": the explicit error let an approved dApp sweep a
     * list of candidate addresses and learn which ones this wallet controls,
     * at no cost and with no user-visible signal. (A timing difference
     * remains; a real signer costs a prompt, but nothing is disclosed
     * outright, and the global prompt cap bounds the sweep.)
     */
    let index: number;
    try {
      index =
        params.accountToSign === undefined
          ? await ctx.selectedIndex()
          : keyring.indexOfPublicKey(params.accountToSign);
    } catch {
      throw new AppError('USER_REJECTED');
    }
    const signer = {
      publicKey: keyring.publicKeyOf(index),
      isSelected: index === (await ctx.selectedIndex()),
      index,
    };

    /**
     * Fourth call site (B3). This is the shortest route around the old guard:
     * an approved origin in developer mode hands over an envelope it built
     * itself, with a sequence number it fetched itself, and submits it itself,
     * `tx.build` never sees any of it. Checked *before* the prompt, so the user
     * is not asked to approve something that will be refused anyway, and again
     * with the same rule everything else uses.
     */
    await ctx.assertNoOpenSubmission({
      accounts: accountsBoundBy(ctx, parsedIncoming.source, index),
      envelopeHash: parsedIncoming.hash().toString('hex'),
    });

    // Invariant 5: no signature without an explicit human confirmation. The
    // page-declared passphrase travels with the prompt so the confirmation
    // dialog can show a NETWORK_MISMATCH warning (finding 5).
    const approved = await ctx.prompts.ask(
      'sign',
      origin,
      xdrToSign,
      params.networkPassphrase ?? null,
      signer,
    );
    if (!approved) throw new AppError('USER_REJECTED');

    const parsed = TransactionBuilder.fromXDR(xdrToSign, network.passphrase);
    if ('innerTransaction' in parsed) {
      throw new AppError('UNSUPPORTED_OPERATION', 'fee-bump signing is not supported yet');
    }
    return { signedXdr: await keyring.signTransaction(parsed, index) };
  },

  'dapp.resolvePrompt': async (ctx, params) => {
    ctx.prompts.resolve(params.requestId, params.approved);
    return {};
  },

  'dapp.pendingPrompt': async (ctx) => ctx.prompts.pending,

  'settings.get': async (ctx) => ctx.settings(),

  'settings.set': async (ctx, params) => {
    const current = await ctx.settings();
    /**
     * §4 footnote 2: `mainnetAcknowledged` is the gate between a beginner and
     * real money, and only the typed-confirmation flow
     * (`settings.acknowledgeMainnet`) may raise it. It is part of the partial
     * patch schema, though, so a restored backup or a migration replaying the
     * whole settings object could carry the flag straight back in. Raising it
     * here is therefore ignored; *lowering* it (leaving mainnet) stays allowed,
     * because giving the capability up must always be possible.
     */
    let patch = params.patch;
    if (patch.mainnetAcknowledged === true) {
      const { mainnetAcknowledged: _raised, ...rest } = patch;
      patch = rest;
    }
    const next = mergeSettings(current, patch);
    return ctx.updateSettings(next);
  },

  'settings.acknowledgeMainnet': async (ctx, params) => {
    // The literal is already enforced by the schema; keep the check anyway so
    // the invariant is visible at the place that grants the capability.
    if (params.confirmation !== 'MAINNET') throw new AppError('BAD_REQUEST');
    const current = await ctx.settings();
    // Acknowledging and switching are one write: passing the gate *is* the
    // switch, and two writes would race each other through `storage.onChanged`.
    return ctx.updateSettings(
      mergeSettings(current, { mainnetAcknowledged: true, networkId: 'mainnet' }),
    );
  },
};
