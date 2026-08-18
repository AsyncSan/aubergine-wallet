/**
 * Horizon / friendbot / Soroban mock, installed with `context.route` so that
 * requests made by the MV3 **service worker** are intercepted too (verified in
 * `specs/01-bootstrap.spec.ts`).
 *
 * There is no network route to the real Stellar testnet in this environment, so
 * every outbound call has to be answered here. Anything the extension asks for
 * that is not modelled below is answered with a 501 and recorded, so an
 * unmocked endpoint shows up as a loud failure rather than a silent hang.
 */
import type { BrowserContext, Route } from '@playwright/test';
import {
  Account,
  Address,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import {
  accountNotFound,
  accountRecord,
  emptyPathsPage,
  feeStats,
  friendbotAlreadyFunded,
  friendbotSuccess,
  latestLedgerPage,
  operationsPage,
  strictSendPathsPage,
  submitFailure,
  submitSuccess,
  transactionNotFound,
  transactionRecord,
  type AccountFixtureOptions,
} from './horizon-fixtures';

export type SubmitMode =
  | { readonly kind: 'success'; readonly hash?: string }
  | { readonly kind: 'failure'; readonly transactionCode: string; readonly operationCodes?: readonly string[] }
  | { readonly kind: 'network-error' };

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly postData: string | null;
}

/** Hosts the extension may legitimately talk to, per `networks.ts`. */
const STELLAR_HOST_GLOB = '**://*.stellar.org/**';
const EXTRA_HOST_GLOBS = ['**://*.sorobanrpc.com/**', '**://api.soroswap.finance/**'];

/**
 * The hash a real Horizon would answer a submission under: the one of the
 * envelope it was given. The fallback keeps an unparseable body from throwing
 * inside the route handler; a spec that submits garbage still gets an answer.
 */
function hashOfEnvelope(submittedXdr: string): string {
  try {
    return TransactionBuilder.fromXDR(submittedXdr, Networks.TESTNET)
      .hash()
      .toString('hex');
  } catch {
    return '9f2b7c1de4a05836bf1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718';
  }
}

/**
 * The Testnet Soroswap aggregator, DELIBERATELY HARD-CODED here instead of
 * imported from `src/core/stellar/soroswap`.
 *
 * Importing `SOROSWAP_ENTRIES` would make this mock follow every change to the
 * pinned list, so a wrong edit to the production constant would still produce a
 * green e2e run: the mock and the code under test would agree with each other
 * about something neither of them checks. Written out separately, the mock is
 * an independent second statement of the same claim, and a mutation of the
 * pinned id turns spec 19 red. Same reasoning as the hard-coded hash in the
 * submit mock.
 *
 * Source: github.com/soroswap/aggregator, `public/testnet.contracts.json`,
 * `ids.aggregator` (fetched 2026-08-17).
 */
const SOROSWAP_TESTNET_AGGREGATOR =
  'CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA';

/**
 * A stand-in for a pool/adapter the route passes through: some contract that
 * is neither the aggregator nor one of the two token SACs. It is the recipient
 * of the authorised `transfer`, exactly as in a real route, and it exists to
 * prove that the guard does NOT require the counterparty to be known, only the
 * token and the amount. Any `C…` id would do; the published Testnet router is
 * used because it is a real address and needs no invention.
 */
const SOROSWAP_TESTNET_ROUTE_HOP =
  'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD';

/** The `/quote` the aggregator last answered; `/quote/build` builds from it. */
export interface SoroswapQuoteMemo {
  readonly assetIn: string;
  readonly assetOut: string;
  readonly amountIn: string;
  readonly amountOutMin: string;
}

function i128(value: string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

function addr(contractOrAccount: string): xdr.ScVal {
  return Address.fromString(contractOrAccount).toScVal();
}

/**
 * The contract call a real aggregator build returns, in the shape the wallet's
 * envelope guard was written against:
 *
 *   swap_exact_tokens_for_tokens(token_in, token_out, amount_in,
 *                                amount_out_min, distribution, to, deadline)
 *
 * on the pinned Testnet aggregator, plus one authorization entry whose tree
 * carries the single `transfer(user, hop, amount_in)` that pays for the swap.
 *
 * WHY THIS SHAPE MATTERS. The previous version of this function called the XLM
 * SAC's `swap` with zero arguments. It predates the envelope guard of
 * 2026-08-17 and was rejected by it, correctly, so the aggregator route had no
 * working end-to-end coverage at all: the one spec that passed never built an
 * aggregator envelope. A mock that the guard refuses proves the guard says no;
 * only a mock it accepts proves the guard still says yes to a real swap, which
 * is the half that carries the risk of shipping a dead swap button.
 */
export function soroswapBuiltEnvelope(
  from: string,
  sequence: string,
  quote: SoroswapQuoteMemo,
): string {
  const args = [
    addr(quote.assetIn), //                                   0 token_in
    addr(quote.assetOut), //                                  1 token_out
    i128(quote.amountIn), //                                  2 amount_in
    i128(quote.amountOutMin), //                              3 amount_out_min
    xdr.ScVal.scvVec([
      //                                                      4 distribution
      xdr.ScVal.scvMap([
        // ScMap keys must be in ascending order; these already are.
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('is_exact_in'),
          val: xdr.ScVal.scvBool(true),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('parts'),
          val: xdr.ScVal.scvU32(1),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('path'),
          val: xdr.ScVal.scvVec([addr(quote.assetIn), addr(quote.assetOut)]),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('protocol_id'),
          val: xdr.ScVal.scvString('soroswap'),
        }),
      ]),
    ]),
    addr(from), //                                            5 to
    nativeToScVal(1_900_000_000, { type: 'u64' }), //         6 deadline
  ];

  const entryCall = new xdr.InvokeContractArgs({
    contractAddress: new Address(SOROSWAP_TESTNET_AGGREGATOR).toScAddress(),
    functionName: 'swap_exact_tokens_for_tokens',
    args,
  });

  /**
   * The payment leg, one level down in the auth tree exactly where a real
   * aggregator puts it: the user hands `amount_in` of the sold token to the
   * first hop. This is the single outflow the guard demands, and putting it in
   * a sub-invocation rather than at the root is deliberate, that is the
   * position the drain variant of the June report used.
   */
  const transferLeg = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(quote.assetIn).toScAddress(),
        functionName: 'transfer',
        args: [addr(from), addr(SOROSWAP_TESTNET_ROUTE_HOP), i128(quote.amountIn)],
      }),
    ),
    subInvocations: [],
  });

  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(entryCall),
      subInvocations: [transferLeg],
    }),
  });

  return new TransactionBuilder(new Account(from, sequence), {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(entryCall),
        auth: [auth],
      }),
    )
    .setSorobanData(new SorobanDataBuilder().setResourceFee('500000').build())
    .setTimeout(300)
    .build()
    .toXDR();
}

/**
 * Sentinel path the in-page/service-worker error hook posts to (never real).
 *
 * It lives under the Testnet Horizon origin on purpose: the P2-hardened
 * manifest pins `connect-src` to the built-in network origins, so a fetch to
 * a made-up host would now (correctly) be blocked by the CSP inside the
 * service worker. The path can never collide with real Horizon endpoints,
 * and the sink route is registered *after* the Horizon mock so it wins
 * (Playwright matches routes last-registered-first).
 */
export const LOG_SINK_URL = 'https://horizon-testnet.stellar.org/__e2e-log-sink__/log';

export class HorizonMock {
  /** Accounts that exist on the mocked network. */
  readonly accounts = new Map<string, AccountFixtureOptions>();
  /** Every request the extension made, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Endpoints we had no fixture for; a non-empty list is a test failure. */
  readonly unmocked: string[] = [];
  /** Base64 envelopes handed to `POST /transactions`. */
  readonly submitted: string[] = [];

  submitMode: SubmitMode = { kind: 'success' };
  friendbotMode: 'success' | 'already-funded' | 'error' = 'success';
  /** When true every Horizon call fails with a 503, to test the error paths. */
  horizonDown = false;
  /**
   * Flat conversion rate for `/paths/strict-send`: destination amount =
   * source amount × rate. `null` models an empty order book (no path).
   */
  pathRate: number | null = 0.5;
  /**
   * Flat rate for the Soroswap aggregator mock. `null` (the default) answers
   * 503: which the client treats as "source unavailable", existing specs
   * keep exercising the pure DEX path.
   */
  soroswapRate: number | null = null;
  /** Envelopes the Soroswap build endpoint handed out. */
  readonly soroswapBuilt: string[] = [];
  /**
   * The `/quote` this mock last answered. `/quote/build` builds its envelope
   * from it, the way a real aggregator does: the tokens and amounts in the
   * built call are the ones it quoted, not constants invented at build time.
   * That is what makes spec 19 able to fail, an envelope over the wrong token
   * or the wrong size is exactly what the guard exists to catch.
   */
  lastSoroswapQuote: SoroswapQuoteMemo | null = null;
  /**
   * What `GET /transactions/{hash}` answers; the lookup the wallet uses to
   * resolve a submission whose outcome it does not know. `not-found` (the
   * default) is Horizon's answer for a transaction it has not ingested, i.e.
   * exactly the "still open" case the double-payment guard has to survive.
   */
  txLookupMode: 'not-found' | 'included' | 'included-failed' = 'not-found';
  /** Hashes the extension looked up, in order. */
  readonly lookedUp: string[] = [];

  fund(accountId: string, options: AccountFixtureOptions = {}): void {
    this.accounts.set(accountId, options);
  }

  unfund(accountId: string): void {
    this.accounts.delete(accountId);
  }

  requestsMatching(pattern: string | RegExp): RecordedRequest[] {
    return this.requests.filter((r) =>
      typeof pattern === 'string' ? r.url.includes(pattern) : pattern.test(r.url),
    );
  }

  async install(context: BrowserContext): Promise<void> {
    const handler = (route: Route): Promise<void> => this.#handle(route);
    await context.route(STELLAR_HOST_GLOB, handler);
    for (const glob of EXTRA_HOST_GLOBS) await context.route(glob, handler);
  }

  async #handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    this.requests.push({
      method: request.method(),
      url: request.url(),
      postData: request.postData(),
    });

    // ---- friendbot -------------------------------------------------------
    if (url.hostname.startsWith('friendbot')) {
      const addr = url.searchParams.get('addr') ?? '';
      if (this.friendbotMode === 'error') {
        return json(route, 503, { title: 'Service Unavailable', status: 503 });
      }
      if (this.friendbotMode === 'already-funded') {
        return json(route, 400, friendbotAlreadyFunded(addr));
      }
      this.fund(addr, { xlm: '10000.0000000' });
      return json(route, 200, friendbotSuccess(addr));
    }

    // ---- Soroswap aggregator API ----------------------------------------
    if (url.hostname === 'api.soroswap.finance') {
      if (this.soroswapRate === null) {
        return json(route, 503, { error: 'soroswap disabled in this spec' });
      }
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      if (url.pathname === '/quote') {
        const amountIn = Number(body['amount'] ?? '0');
        const slippageBps = Number(body['slippageBps'] ?? 50);
        const amountOut = Math.floor(amountIn * this.soroswapRate);
        const threshold = Math.floor((amountOut * (10_000 - slippageBps)) / 10_000);
        this.lastSoroswapQuote = {
          assetIn: String(body['assetIn'] ?? ''),
          assetOut: String(body['assetOut'] ?? ''),
          amountIn: String(amountIn),
          amountOutMin: String(threshold),
        };
        return json(route, 200, {
          amountIn: String(amountIn),
          amountOut: String(amountOut),
          otherAmountThreshold: String(threshold),
          tradeType: 'EXACT_IN',
          platform: 'soroswap',
          priceImpactPct: '0.10',
        });
      }
      if (url.pathname === '/quote/build') {
        // Sequence-align with the account fixture so the built envelope is
        // exactly what a live aggregator would return for this account.
        const from = String(body['from'] ?? '');
        const sequence = this.accounts.get(from)?.sequence ?? '4611686044486139904';
        const quote = this.lastSoroswapQuote;
        if (quote === null) {
          // A build without a preceding quote is not a state a real client can
          // reach; answering it with an invented envelope would hide the bug.
          this.unmocked.push(`${request.method()} ${request.url()} (no preceding /quote)`);
          return json(route, 501, { title: 'build without quote', status: 501 });
        }
        const envelope = soroswapBuiltEnvelope(from, sequence, quote);
        this.soroswapBuilt.push(envelope);
        return json(route, 200, { xdr: envelope });
      }
      this.unmocked.push(`${request.method()} ${request.url()}`);
      return json(route, 501, { title: 'Not mocked in e2e', status: 501 });
    }

    if (this.horizonDown) {
      return json(route, 503, { title: 'Service Unavailable', status: 503 });
    }

    // ---- Soroban JSON-RPC ------------------------------------------------
    if (url.hostname.includes('soroban') || url.hostname.includes('sorobanrpc')) {
      return json(route, 200, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32_000, message: 'soroban simulation is not mocked in e2e' },
      });
    }

    // ---- Horizon ---------------------------------------------------------
    const path = url.pathname.replace(/\/+$/u, '');

    if (request.method() === 'POST' && path.endsWith('/transactions')) {
      const body = request.postData() ?? '';
      const xdr = decodeURIComponent(body.replace(/^tx=/u, ''));
      this.submitted.push(xdr);
      if (this.submitMode.kind === 'network-error') {
        return json(route, 503, { title: 'Service Unavailable', status: 503 });
      }
      if (this.submitMode.kind === 'failure') {
        return json(
          route,
          400,
          submitFailure(this.submitMode.transactionCode, this.submitMode.operationCodes ?? []),
        );
      }
      /**
       * A real Horizon answers under the hash of the transaction it was handed.
       * The wallet computes that hash itself before the request leaves and now
       * compares the two; an answer about some *other* transaction says
       * nothing about this one, so it is treated as an outcome it cannot know.
       * A fixed placeholder here would therefore make every successful
       * submission in these specs read as "ambiguous".
       */
      const hash = this.submitMode.hash ?? hashOfEnvelope(xdr);
      return json(route, 200, submitSuccess(hash));
    }

    const transaction = /^\/transactions\/([0-9a-f]{64})$/u.exec(path);
    if (transaction?.[1] && request.method() === 'GET') {
      const hash = transaction[1];
      this.lookedUp.push(hash);
      if (this.txLookupMode === 'not-found') {
        return json(route, 404, transactionNotFound(hash));
      }
      return json(route, 200, transactionRecord(hash, this.txLookupMode === 'included'));
    }

    const accountOps = /^\/accounts\/(G[A-Z2-7]{55})\/operations$/u.exec(path);
    if (accountOps?.[1]) {
      const accountId = accountOps[1];
      if (!this.accounts.has(accountId)) {
        return json(route, 404, accountNotFound(accountId));
      }
      return json(route, 200, operationsPage(accountId));
    }

    const account = /^\/accounts\/(G[A-Z2-7]{55}|M[A-Z2-7]+)$/u.exec(path);
    if (account?.[1]) {
      const accountId = account[1];
      const fixture = this.accounts.get(accountId);
      if (!fixture) return json(route, 404, accountNotFound(accountId));
      return json(route, 200, accountRecord(accountId, fixture));
    }

    if (path === '/paths/strict-send') {
      if (this.pathRate === null) return json(route, 200, emptyPathsPage());
      const sourceAmount = url.searchParams.get('source_amount') ?? '0';
      const source = {
        type: url.searchParams.get('source_asset_type') ?? 'native',
        code: url.searchParams.get('source_asset_code') ?? undefined,
        issuer: url.searchParams.get('source_asset_issuer') ?? undefined,
      };
      // The SDK sends `destination_assets` as `native` or `CODE:ISSUER`.
      const destRaw = (url.searchParams.get('destination_assets') ?? 'native').split(',')[0] ?? 'native';
      const dest =
        destRaw === 'native'
          ? { type: 'native' as const }
          : {
              type: (destRaw.split(':')[0] ?? '').length > 4 ? 'credit_alphanum12' : 'credit_alphanum4',
              code: destRaw.split(':')[0] ?? '',
              issuer: destRaw.split(':')[1] ?? '',
            };
      const destinationAmount = (Number(sourceAmount) * this.pathRate).toFixed(7);
      return json(
        route,
        200,
        strictSendPathsPage(source, sourceAmount, dest, destinationAmount),
      );
    }

    if (path === '/fee_stats') return json(route, 200, feeStats());
    if (path === '/ledgers') return json(route, 200, latestLedgerPage());
    if (path === '') {
      return json(route, 200, {
        horizon_version: 'e2e-mock',
        core_version: 'e2e-mock',
        network_passphrase: 'Test SDF Network ; September 2015',
      });
    }

    this.unmocked.push(`${request.method()} ${request.url()}`);
    return json(route, 501, { title: 'Not mocked in e2e', status: 501, path });
  }
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}
