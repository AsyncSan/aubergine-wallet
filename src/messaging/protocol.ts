/**
 * The API boundary between popup and background (ARCHITECTURE.md §6).
 *
 * This file is the *only* permitted coupling between the two contexts.
 * Every method is a discriminated-union member with a Zod schema for both its
 * parameters and its result, so a malformed message is rejected at the edge
 * instead of half-executing.
 *
 * Note on invariant 1: no result type in this file contains a secret key or a
 * seed. The single exception is `wallet.revealRecoveryPhrase`, which is
 * password-gated, explicitly user-initiated and exists because the user must be
 * able to write their recovery phrase down. Everything else that needs a key
 * (signing) happens inside the background.
 */
import { z } from 'zod';
import { AppError, ERROR_CODES } from '../core/errors';
import { accountMetaSchema } from '../core/keyring/account';
import { MIN_PASSWORD_SCORE, estimatePasswordStrength } from '../core/password-strength';
import { httpsEndpointSchema, settingsPatchSchema, settingsSchema } from '../core/settings';
import { checkSorobanEndpoint } from '../core/stellar/networks';
import { MEMO_TEXT_MAX_BYTES, isValidMemoText } from '../core/stellar/memo';

/* ------------------------------------------------------------------ shared */

const publicAccountSchema = accountMetaSchema.extend({
  publicKey: z.string(),
  path: z.string(),
});

const i18nMessageSchema = z.object({
  key: z.string(),
  params: z.record(z.union([z.string(), z.number()])).optional(),
});

const balanceEntrySchema = z.object({
  id: z.string(),
  code: z.string(),
  issuer: z.string().nullable(),
  balance: z.string(),
  limit: z.string().nullable(),
  isNative: z.boolean(),
  buyingLiabilities: z.string(),
  sellingLiabilities: z.string(),
});

const reserveBreakdownSchema = z.object({
  baseReserveXlm: z.string(),
  subentryCount: z.number(),
  numSponsoring: z.number(),
  numSponsored: z.number(),
  totalReservedXlm: z.string(),
  spendableXlm: z.string(),
  maxSendableXlm: z.string(),
});

const accountSnapshotSchema = z.object({
  accountId: z.string(),
  exists: z.boolean(),
  sequence: z.string(),
  balances: z.array(balanceEntrySchema),
  reserves: reserveBreakdownSchema,
  signers: z.array(z.object({ key: z.string(), weight: z.number(), type: z.string() })),
  thresholds: z.object({ low: z.number(), medium: z.number(), high: z.number() }),
  subentryCount: z.number(),
});

const historyEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: z.string(),
  successful: z.boolean(),
  transactionHash: z.string(),
  direction: z.enum(['in', 'out', 'self', 'other']),
  counterparty: z.string().nullable(),
  amount: z.string().nullable(),
  assetCode: z.string().nullable(),
});

const txDescriptionSchema = z.object({
  summary: i18nMessageSchema,
  effects: z.array(
    z.object({ opIndex: z.number(), opType: z.string(), message: i18nMessageSchema }),
  ),
  warnings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['info', 'warn', 'danger']),
      message: i18nMessageSchema,
      opIndex: z.number().optional(),
    }),
  ),
  raw: z.string(),
  translatable: z.boolean(),
  meta: z.object({
    network: z.string(),
    networkName: z.string(),
    source: z.string(),
    /** Total fee of the envelope (per-operation fee × operation count). */
    feeStroops: z.string(),
    feeXlm: z.string(),
    /** The per-operation half of the same number, see `TxMeta`. */
    feePerOperationStroops: z.string(),
    sequence: z.string(),
    operationCount: z.number(),
    memo: z.object({ type: z.string(), value: z.string() }).nullable(),
    timeBounds: z.object({ minTime: z.string(), maxTime: z.string() }).nullable(),
    isFeeBump: z.boolean(),
  }),
});

const emptySchema = z.object({});

/**
 * The password a *new* vault is created with (`wallet.create`,
 * `wallet.importMnemonic`). Not used by `wallet.unlock` / `account.add` /
 * `wallet.revealRecoveryPhrase`: those verify an existing password, and a
 * strength rule applied there would lock an early adopter out of their own
 * wallet.
 *
 * The strength floor is enforced *here*, at the edge, and not only by the
 * Continue button in `ui/screens/Onboarding.tsx`. `core/password-strength`
 * documents why the 8-character floor is not enough on its own, the keystore
 * blob can be taken and ground offline against Argon2id, which buys ~15-20
 * bits and no more, so the password has to carry the rest. A rule that lives
 * only in a `disabled` attribute is a suggestion; the vault is created in the
 * background, and this is the boundary the background actually checks.
 */
const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(256)
  .refine(
    (value) => estimatePasswordStrength(value).score >= MIN_PASSWORD_SCORE,
    'password is too easy to guess',
  );

/**
 * Developer-mode fee override, stroops **per operation**, as
 * `TransactionBuilder({ fee })` means it.
 *
 * The field used to be a bare `z.string()`: no format, no ceiling. "100000"
 * with three zeros too many built and signed a 10 XLM fee without a word, and
 * a non-numeric value reached the SDK as an untranslated exception. The bound
 * is a *format* bound on purpose; §4 gives the override precedence over the
 * fee strategy, and this must not quietly become a second, lower ceiling for
 * someone who knows what they are doing. 7 digits leave 9,999,999 stroops
 * (≈ 1 XLM) per operation, roughly a hundred times the wallet's own ceiling of
 * {@link MAX_FEE_PER_OPERATION_STROOPS} and far above any real surge, while a
 * typo of three orders of magnitude no longer parses. Anything above
 * {@link HIGH_FEE_FACTOR} × `BASE_FEE` is additionally shown as a warning in
 * the confirmation (`tx.warn.HIGH_FEE`), so a legal-but-odd value is visible
 * rather than merely permitted.
 */
export const FEE_OVERRIDE_RE = /^[1-9][0-9]{0,6}$/u;

const feeOverrideSchema = z.string().transform((value): string => {
  // An `AppError`, not a `ZodError`: §6 wants a code the popup can translate,
  // and `toWireError` would map a raw ZodError to "an unexpected error
  // occurred" for what is really "that is not a fee".
  if (!FEE_OVERRIDE_RE.test(value)) {
    throw new AppError('BAD_REQUEST', 'fee must be 1…9999999 stroops, digits only');
  }
  return value;
});

const buildIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('payment'),
    destination: z.string().min(1),
    assetId: z.string().min(1),
    amount: z.string().min(1),
    // MEMO_TEXT is limited to 28 UTF-8 *bytes*, not 28 characters (P2 fix).
    memo: z
      .string()
      .refine(isValidMemoText, `memo exceeds ${MEMO_TEXT_MAX_BYTES} UTF-8 bytes`)
      .optional(),
    feeStroops: feeOverrideSchema.optional(),
  }),
  z.object({
    kind: z.literal('changeTrust'),
    assetCode: z.string().min(1).max(12),
    issuer: z.string().min(1),
    limit: z.string().optional(),
    feeStroops: feeOverrideSchema.optional(),
  }),
  z.object({
    kind: z.literal('swap'),
    sendAssetId: z.string().min(1),
    sendAmount: z.string().min(1),
    destAssetId: z.string().min(1),
    /** The user's slippage floor; the network rejects anything below it. */
    destMin: z.string().min(1),
    /** Intermediate hops from the accepted quote (asset ids). */
    path: z.array(z.string().min(1)).max(5).default([]),
    /**
     * Execution route. `dex` builds the classic path payment locally;
     * `soroswap` builds via the aggregator from a background-cached quote,
     * the popup passes the opaque `quoteId` back, never quote contents.
     */
    route: z.enum(['dex', 'soroswap']).default('dex'),
    quoteId: z.string().optional(),
    feeStroops: feeOverrideSchema.optional(),
  }),
]);

export type BuildIntent = z.infer<typeof buildIntentSchema>;

/**
 * `settings.set`, with the endpoint override validated at the wire edge.
 *
 * The patch schema alone would reject a bad endpoint too, but as a `ZodError`,
 * which `toWireError` maps to `INTERNAL_ERROR`, i.e. "an unexpected error
 * occurred" for what is really "that URL is not https". §6 says errors travel
 * as codes the UI can translate, so the check throws an `AppError` from inside
 * the schema and the popup gets a `BAD_REQUEST` it already has a string for.
 *
 * The details never quote the rejected value: it is the field most likely to
 * contain an API key, and error strings are shown, forwarded and (in other
 * builds) logged.
 */
const sorobanRpcOverrideParamSchema = z
  .union([z.null(), z.string()])
  .transform((value): string | null => {
    if (value === null || value.length === 0) return null;
    if (!httpsEndpointSchema.safeParse(value).success) {
      throw new AppError('BAD_REQUEST', 'sorobanRpcOverride must be an https: URL');
    }
    /**
     * MV3 pins `connect-src` at package time, so an origin the manifest does
     * not name cannot be reached from any extension page, the request would
     * be blocked by the CSP with nothing to show for it. Refusing here is the
     * difference between "this provider is not supported" and a swap that
     * fails on the mandatory path for reasons the user cannot see.
     */
    if (checkSorobanEndpoint(value) === 'not-in-csp') {
      throw new AppError('BAD_REQUEST', 'sorobanRpcOverride host is not covered by connect-src');
    }
    return value;
  });

export const settingsSetPatchSchema = settingsPatchSchema.extend({
  sorobanRpcOverride: sorobanRpcOverrideParamSchema.optional(),
});

/* ----------------------------------------------------------- method table */

/**
 * The complete RPC surface. Adding a method here automatically types the client
 * and forces the background handler map to implement it.
 */
export const rpcSchemas = {
  'wallet.create': {
    params: z.object({
      password: passwordSchema,
      strength: z.union([z.literal(128), z.literal(256)]).default(128),
    }),
    result: z.object({ accounts: z.array(publicAccountSchema) }),
  },
  'wallet.importMnemonic': {
    params: z.object({
      password: passwordSchema,
      mnemonic: z.string().min(1),
      /** Optional BIP-39 passphrase ("25th word"). */
      bip39Passphrase: z.string().optional(),
    }),
    result: z.object({ accounts: z.array(publicAccountSchema) }),
  },
  'wallet.unlock': {
    params: z.object({ password: z.string().min(1) }),
    result: z.object({ accounts: z.array(publicAccountSchema) }),
  },
  'wallet.lock': {
    params: emptySchema,
    result: emptySchema,
  },
  'wallet.status': {
    params: emptySchema,
    result: z.object({
      initialized: z.boolean(),
      unlocked: z.boolean(),
      /** Epoch ms at which auto-lock fires, or null while locked. */
      autoLockAt: z.number().nullable(),
    }),
  },
  'wallet.revealRecoveryPhrase': {
    params: z.object({ password: z.string().min(1) }),
    result: z.object({
      mnemonic: z.string(),
      /**
       * The BIP-39 passphrase that belongs to the phrase, if one was set on
       * import. Without it the phrase alone restores a different wallet, so
       * hiding it would be the same trap as dropping it (finding 7).
       */
      bip39Passphrase: z.string().nullable(),
    }),
  },
  'wallet.reset': {
    params: z.object({ confirm: z.literal(true) }),
    result: emptySchema,
  },

  'account.list': {
    params: emptySchema,
    result: z.object({
      accounts: z.array(publicAccountSchema),
      selectedIndex: z.number().int().min(0),
    }),
  },
  /**
   * Adding an account re-encrypts the vault, which needs the password: the
   * background never keeps it. Without this the derived account would live in
   * RAM only and vanish on lock (finding 10).
   */
  'account.add': {
    params: z.object({
      label: z.string().max(64).default(''),
      password: z.string().min(1),
    }),
    result: z.object({ account: publicAccountSchema }),
  },
  'account.select': {
    params: z.object({ index: z.number().int().min(0) }),
    result: z.object({ selectedIndex: z.number().int().min(0) }),
  },
  'account.balances': {
    params: z.object({ index: z.number().int().min(0).optional() }),
    result: accountSnapshotSchema,
  },
  'account.history': {
    params: z.object({
      index: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    result: z.object({ entries: z.array(historyEntrySchema) }),
  },
  'account.fund': {
    params: z.object({ index: z.number().int().min(0).optional() }),
    result: emptySchema,
  },

  /**
   * Live DEX quote for the swap screen: "sending exactly this much, what comes
   * out?". `found: false` is the no-route answer and deliberately not an error,
   * an empty order book is a normal state the UI explains in plain language.
   */
  'swap.quote': {
    params: z.object({
      sendAssetId: z.string().min(1),
      sendAmount: z.string().min(1),
      destAssetId: z.string().min(1),
      /** User slippage tolerance in basis points (50 = 0.5 %). */
      slippageBps: z.number().int().min(1).max(1000).default(50),
    }),
    result: z.object({
      found: z.boolean(),
      /** Best of all sources; what the UI displays. */
      destAmount: z.string(),
      path: z.array(z.string()),
      /** Which source won. `dex` = classic path payment, `soroswap` = aggregator. */
      source: z.enum(['dex', 'soroswap']).default('dex'),
      /**
       * Handle for the background-cached aggregator quote (source `soroswap`).
       * Passed back verbatim in `tx.build`; contents never leave the background.
       */
      quoteId: z.string().nullable().default(null),
      /** Aggregator slippage floor (decimal units), when source is `soroswap`. */
      minReceived: z.string().nullable().default(null),
      priceImpactPct: z.string().nullable().default(null),
      /** Routing venue reported by the aggregator (e.g. `soroswap`, `phoenix`). */
      platform: z.string().nullable().default(null),
      /** Both raw answers, for the UI's "you save X" comparison line. */
      dexDestAmount: z.string().nullable().default(null),
      soroswapDestAmount: z.string().nullable().default(null),
    }),
  },

  'tx.build': {
    params: z.object({
      intent: buildIntentSchema,
      accountIndex: z.number().int().min(0).optional(),
    }),
    result: z.object({ xdr: z.string() }),
  },
  'tx.describe': {
    params: z.object({
      xdr: z.string().min(1),
      accountIndex: z.number().int().min(0).optional(),
      declaredNetworkPassphrase: z.string().optional(),
    }),
    result: txDescriptionSchema,
  },
  'tx.sign': {
    params: z.object({
      xdr: z.string().min(1),
      accountIndex: z.number().int().min(0).optional(),
    }),
    result: z.object({ signedXdr: z.string() }),
  },
  /**
   * Submit, with three possible outcomes rather than two.
   *
   * `outcome: 'success'`, in a ledger. A rejection by the network still
   * *throws* `TX_FAILED:<code>`, unchanged. `outcome: 'unknown'` is the new
   * one: the envelope is on its way and nobody can currently say whether it
   * arrived. It is a result, not an error, because the popup needs the two
   * facts an error cannot carry; the hash to look the payment up with and the
   * timebound that says how long the answer can still change.
   */
  'tx.submit': {
    params: z.object({ signedXdr: z.string().min(1) }),
    result: z.object({
      outcome: z.enum(['success', 'unknown']).default('success'),
      hash: z.string(),
      successful: z.boolean(),
      ledger: z.number().nullable(),
      /** Envelope `maxTime`, unix seconds; `'0'` = no upper timebound. */
      maxTimeUnix: z.string().default('0'),
      reason: z
        .enum(['timeout', 'server_error', 'throttled', 'transport', 'ambiguous'])
        .nullable()
        .default(null),
    }),
  },
  /**
   * The submission whose outcome is still open, if there is one. Read by the
   * send/swap/asset screens when they mount, so a closed popup, or a service
   * worker the browser tore down mid-request, does not lose the warning.
   */
  'tx.pendingSubmission': {
    params: emptySchema,
    result: z.object({
      pending: z
        .object({
          hash: z.string(),
          maxTimeUnix: z.string(),
          accountIndex: z.number().int().min(0),
          kind: z.enum(['payment', 'swap', 'changeTrust', 'unknown']),
          createdAt: z.number(),
          answered: z.boolean(),
        })
        .nullable(),
    }),
  },
  /**
   * One `GET /transactions/{hash}` against the network, interpreted against the
   * envelope's own timebound: `pending` while it can still be included,
   * `expired` only once it provably cannot be.
   */
  'tx.status': {
    params: z.object({
      hash: z.string().min(1),
      /*
       * There is deliberately no `maxTimeUnix` here. It used to be accepted and
       * *preferred* over the stored record, which made the deadline a caller's
       * choice: `maxTimeUnix: '1'` turned the next 404 into `expired`, cleared
       * the pending record and unlocked `tx.build` while the first envelope was
       * still valid. The popup only ever echoed back what the record already
       * said, so the parameter had no legitimate use; the deadline comes from
       * the envelope, and the background is the only place that knows it.
       */
    }),
    result: z.object({
      state: z.enum(['included', 'pending', 'expired', 'unknown']),
      successful: z.boolean().nullable(),
      ledger: z.number().nullable(),
      resultCode: z.string().nullable(),
    }),
  },

  'dapp.requestConnect': {
    params: z.object({ origin: z.string().min(1) }),
    result: z.object({ approved: z.boolean(), publicKey: z.string().nullable() }),
  },
  'dapp.signXdr': {
    params: z.object({
      origin: z.string().min(1),
      xdr: z.string().min(1),
      networkPassphrase: z.string().optional(),
      accountToSign: z.string().optional(),
    }),
    result: z.object({ signedXdr: z.string() }),
  },
  /** Popup -> background answer for a pending dApp prompt. */
  'dapp.resolvePrompt': {
    params: z.object({ requestId: z.string().min(1), approved: z.boolean() }),
    result: emptySchema,
  },
  'dapp.pendingPrompt': {
    params: emptySchema,
    result: z
      .object({
        requestId: z.string(),
        origin: z.string(),
        kind: z.enum(['connect', 'sign']),
        xdr: z.string().nullable(),
        /**
         * The network the *calling page* claims the envelope is for. Carried
         * to the popup so `tx.describe` can raise NETWORK_MISMATCH (finding 5).
         */
        declaredNetworkPassphrase: z.string().nullable(),
        /**
         * P2: the account that will sign (resolved from `accountToSign` or
         * the selection), so the dialog can display it. Null on connect.
         */
        signerPublicKey: z.string().nullable(),
        /** False when the page requested a non-active account; the UI warns. */
        signerIsSelected: z.boolean().nullable(),
        /**
         * The SEP-0005 index behind `signerPublicKey`. The popup passes it to
         * `tx.describe`, so the warnings are computed in the trust context of
         * the account that will actually sign. Without it the describer fell
         * back to the *selected* account, which let a page suppress
         * UNKNOWN_ISSUER simply by naming a different `accountToSign`.
         */
        signerAccountIndex: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
  },

  'settings.get': {
    params: emptySchema,
    result: settingsSchema,
  },
  'settings.set': {
    params: z.object({ patch: settingsSetPatchSchema }),
    result: settingsSchema,
  },
  /**
   * The mainnet gate: acknowledges the risk *and* switches the network, in one
   * write. The only way to raise `mainnetAcknowledged`, `settings.set` ignores
   * the flag, so a replayed or restored settings object can never switch a
   * wallet to real money on its own (§4 footnote 2).
   */
  'settings.acknowledgeMainnet': {
    params: z.object({ confirmation: z.literal('MAINNET') }),
    result: settingsSchema,
  },
} as const;

export type RpcSchemas = typeof rpcSchemas;
export type RpcMethod = keyof RpcSchemas;

export const RPC_METHODS = Object.keys(rpcSchemas) as RpcMethod[];

export type RpcParams<M extends RpcMethod> = z.infer<RpcSchemas[M]['params']>;
export type RpcParamsInput<M extends RpcMethod> = z.input<RpcSchemas[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<RpcSchemas[M]['result']>;

/** Discriminated request union, exactly what §6 asks for. */
export type RpcRequest = {
  [M in RpcMethod]: {
    readonly id: string;
    readonly method: M;
    readonly params: RpcParams<M>;
  };
}[RpcMethod];

export const wireErrorSchema = z.object({
  code: z.union([
    z.enum(ERROR_CODES),
    z.string().regex(/^TX_FAILED:/u),
  ]),
  detail: z.string().optional(),
});

export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | { readonly id: string; readonly ok: true; readonly result: RpcResult<M> }
  | { readonly id: string; readonly ok: false; readonly error: z.infer<typeof wireErrorSchema> };

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(rpcSchemas, value);
}

/** Validate an inbound request. Throws a ZodError the caller maps to BAD_REQUEST. */
export function parseRequest(raw: unknown): RpcRequest {
  const envelope = z
    .object({ id: z.string().min(1), method: z.string(), params: z.unknown() })
    .parse(raw);
  if (!isRpcMethod(envelope.method)) {
    throw new Error(`unknown RPC method: ${envelope.method}`);
  }
  const method = envelope.method;
  const params = rpcSchemas[method].params.parse(envelope.params ?? {});
  return { id: envelope.id, method, params } as RpcRequest;
}

/** Validate an outbound result against its declared schema. */
export function parseResult<M extends RpcMethod>(method: M, raw: unknown): RpcResult<M> {
  return rpcSchemas[method].result.parse(raw) as RpcResult<M>;
}

/* ------------------------------------------------- page <-> content script */

/** Messages exchanged between the injected provider and the content script. */
export const PROVIDER_CHANNEL = 'aubergine:provider';

export const providerRequestSchema = z.object({
  channel: z.literal(PROVIDER_CHANNEL),
  direction: z.literal('to-extension'),
  id: z.string().min(1),
  method: z.enum(['isConnected', 'getPublicKey', 'signTransaction', 'getNetwork']),
  payload: z.record(z.unknown()).optional(),
});

export type ProviderRequest = z.infer<typeof providerRequestSchema>;

export const providerResponseSchema = z.object({
  channel: z.literal(PROVIDER_CHANNEL),
  direction: z.literal('to-page'),
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type ProviderResponse = z.infer<typeof providerResponseSchema>;
