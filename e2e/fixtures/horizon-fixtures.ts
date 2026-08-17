/**
 * Horizon response fixtures.
 *
 * Kept in one file on purpose: every shape here is a *recorded-looking* Horizon
 * payload, so it can be swapped for a real captured response later without
 * touching the tests. Nothing in here talks to the network, this environment
 * has no route to horizon-testnet.stellar.org at all.
 *
 * Sources for the shapes: Horizon `/accounts/{id}`, `/accounts/{id}/operations`,
 * `POST /transactions`, `/fee_stats`, `/ledgers` as documented at
 * developers.stellar.org (Horizon 2.x).
 */

export interface AssetBalanceFixture {
  readonly code: string;
  readonly issuer: string;
  readonly balance: string;
  readonly limit?: string;
}

export interface AccountFixtureOptions {
  readonly sequence?: string;
  readonly xlm?: string;
  readonly assets?: readonly AssetBalanceFixture[];
  readonly subentryCount?: number;
  readonly signers?: ReadonlyArray<{ key: string; weight: number; type: string }>;
  readonly thresholds?: { low: number; medium: number; high: number };
  /** Sets `data["config.memo_required"]`, which the SDK checks before submit. */
  readonly memoRequired?: boolean;
}

/** A funded account, XLM plus (optionally) further assets. */
export function accountRecord(
  accountId: string,
  options: AccountFixtureOptions = {},
): Record<string, unknown> {
  const sequence = options.sequence ?? '4611686044486139904';
  const xlm = options.xlm ?? '10000.0000000';
  const assets = options.assets ?? [];
  const subentryCount = options.subentryCount ?? assets.length;
  const signers = options.signers ?? [
    { key: accountId, weight: 1, type: 'ed25519_public_key' },
  ];
  const thresholds = options.thresholds ?? { low: 0, medium: 0, high: 0 };

  return {
    _links: {
      self: { href: `https://horizon-testnet.stellar.org/accounts/${accountId}` },
      transactions: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/transactions{?cursor,limit,order}`,
        templated: true,
      },
      operations: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/operations{?cursor,limit,order}`,
        templated: true,
      },
      payments: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/payments{?cursor,limit,order}`,
        templated: true,
      },
      effects: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/effects{?cursor,limit,order}`,
        templated: true,
      },
      offers: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/offers{?cursor,limit,order}`,
        templated: true,
      },
      trades: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/trades{?cursor,limit,order}`,
        templated: true,
      },
      data: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/data/{key}`,
        templated: true,
      },
    },
    id: accountId,
    account_id: accountId,
    sequence,
    sequence_ledger: 1_234_567,
    sequence_time: '1754400000',
    subentry_count: subentryCount,
    last_modified_ledger: 1_234_567,
    last_modified_time: '2026-08-05T10:00:00Z',
    num_sponsoring: 0,
    num_sponsored: 0,
    thresholds: {
      low_threshold: thresholds.low,
      med_threshold: thresholds.medium,
      high_threshold: thresholds.high,
    },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances: [
      ...assets.map((asset) => ({
        balance: asset.balance,
        limit: asset.limit ?? '922337203685.4775807',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        last_modified_ledger: 1_234_500,
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
        asset_type: asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
        asset_code: asset.code,
        asset_issuer: asset.issuer,
      })),
      {
        balance: xlm,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        asset_type: 'native',
      },
    ],
    signers: signers.map((signer) => ({ ...signer })),
    data: options.memoRequired ? { 'config.memo_required': 'MQ==' } : {},
    paging_token: accountId,
  };
}

/** Horizon's 404 for an account that has never been funded. */
export function accountNotFound(accountId: string): Record<string, unknown> {
  return {
    type: 'https://stellar.org/horizon-errors/not_found',
    title: 'Resource Missing',
    status: 404,
    detail:
      'The resource at the url requested was not found. This usually occurs for one of two reasons: The url requested is not valid, or no data in our database could be found with the parameters provided.',
    extras: { account_id: accountId },
  };
}

/**
 * `GET /transactions/{hash}`, 404.
 *
 * The answer Horizon gives for a transaction it has not ingested yet, which is
 * the normal state for the first seconds after a submission. The wallet reads
 * it as "not yet", not as "never", only the envelope's own timebound turns it
 * into a final answer (see `resolveSubmission`).
 */
export function transactionNotFound(hash: string): Record<string, unknown> {
  return {
    type: 'https://stellar.org/horizon-errors/not_found',
    title: 'Resource Missing',
    status: 404,
    detail: 'The resource at the url requested was not found.',
    extras: { transaction_hash: hash },
  };
}

/** `GET /transactions/{hash}`; the transaction made it into a ledger. */
export function transactionRecord(
  hash: string,
  successful = true,
  ledger = 1_234_568,
): Record<string, unknown> {
  return {
    id: hash,
    paging_token: '5304108482424832',
    successful,
    hash,
    ledger,
    created_at: '2026-08-06T09:00:00Z',
    source_account: '',
    fee_charged: '100',
    max_fee: '100',
    operation_count: 1,
    envelope_xdr: '',
    result_meta_xdr: '',
    ...(successful ? {} : { extras: { result_codes: { transaction: 'tx_failed' } } }),
  };
}

/** `GET /accounts/{id}/operations`; one inbound create_account, one payment out. */
export function operationsPage(
  accountId: string,
  counterparty = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
): Record<string, unknown> {
  return {
    _links: {
      self: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/operations?cursor=&limit=20&order=desc`,
      },
      next: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/operations?cursor=2&limit=20&order=desc`,
      },
      prev: {
        href: `https://horizon-testnet.stellar.org/accounts/${accountId}/operations?cursor=1&limit=20&order=asc`,
      },
    },
    _embedded: {
      records: [
        {
          _links: { self: { href: 'https://horizon-testnet.stellar.org/operations/2' } },
          id: '2',
          paging_token: '2',
          transaction_successful: true,
          source_account: accountId,
          type: 'payment',
          type_i: 1,
          created_at: '2026-08-05T12:00:00Z',
          transaction_hash:
            'b5c2f0a3e9d84f7c1a6b0d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6',
          asset_type: 'native',
          from: accountId,
          to: counterparty,
          amount: '25.0000000',
        },
        {
          _links: { self: { href: 'https://horizon-testnet.stellar.org/operations/1' } },
          id: '1',
          paging_token: '1',
          transaction_successful: true,
          source_account: counterparty,
          type: 'create_account',
          type_i: 0,
          created_at: '2026-08-05T11:00:00Z',
          transaction_hash:
            'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
          starting_balance: '10000.0000000',
          funder: counterparty,
          account: accountId,
        },
      ],
    },
  };
}

/** `POST /transactions`, accepted. */
export function submitSuccess(hash: string, ledger = 1_234_568): Record<string, unknown> {
  return {
    _links: { transaction: { href: `https://horizon-testnet.stellar.org/transactions/${hash}` } },
    id: hash,
    paging_token: '5304108482424832',
    successful: true,
    hash,
    ledger,
    created_at: '2026-08-06T09:00:00Z',
    source_account: '',
    fee_charged: '100',
    max_fee: '100',
    operation_count: 1,
    envelope_xdr: '',
    // No `result_xdr`: the SDK then returns the body verbatim, which is exactly
    // the shape `submitTransactionXdr` reads (hash/successful/ledger).
    result_meta_xdr: '',
  };
}

/** `POST /transactions`, rejected by the network with a transaction result code. */
export function submitFailure(
  transactionCode = 'tx_insufficient_balance',
  operationCodes: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: 'https://stellar.org/horizon-errors/transaction_failed',
    title: 'Transaction Failed',
    status: 400,
    detail:
      'The transaction failed when submitted to the stellar network. The `extras.result_codes` field on this response contains further details. Descriptions of each code can be found at: https://developers.stellar.org/api/errors/http-status-codes/horizon-specific/transaction-failed/',
    extras: {
      envelope_xdr: '',
      result_codes: {
        transaction: transactionCode,
        ...(operationCodes.length > 0 ? { operations: [...operationCodes] } : {}),
      },
      result_xdr: 'AAAAAAAAAGT/////AAAAAA==',
    },
  };
}

export interface FeeStatsFixtureOptions {
  /** 0…1. At or above 0.5 the wallet's fee strategy adds surge headroom. */
  readonly capacityUsage?: string;
  /** Overrides for `fee_charged`; the distribution the wallet actually reads. */
  readonly feeCharged?: Readonly<Record<string, string>>;
}

/**
 * `GET /fee_stats`.
 *
 * No longer decoration: since the fee strategy landed, `fetchFeeStats` calls
 * this endpoint on every `tx.build`, and `chooseFee` derives the envelope's
 * fee from `fee_charged` plus `ledger_capacity_usage`. The defaults below are
 * a calm ledger, which yields exactly `BASE_FEE` (100), the fee every
 * existing spec asserts. Pass `feeCharged`/`capacityUsage` to model a surge.
 *
 * `max_fee` stays in the payload because Horizon sends it, but the wallet
 * deliberately does not price from it (those are bids, not charges).
 */
export function feeStats(options: FeeStatsFixtureOptions = {}): Record<string, unknown> {
  return {
    last_ledger: '1234567',
    last_ledger_base_fee: '100',
    ledger_capacity_usage: options.capacityUsage ?? '0.03',
    fee_charged: {
      max: '100',
      min: '100',
      mode: '100',
      p10: '100',
      p20: '100',
      p30: '100',
      p40: '100',
      p50: '100',
      p60: '100',
      p70: '100',
      p80: '100',
      p90: '100',
      p95: '100',
      p99: '100',
      ...(options.feeCharged ?? {}),
    },
    max_fee: {
      max: '100000',
      min: '100',
      mode: '100',
      p10: '100',
      p20: '100',
      p30: '100',
      p40: '100',
      p50: '100',
      p60: '100',
      p70: '100',
      p80: '100',
      p90: '5000',
      p95: '10000',
      p99: '100000',
    },
  };
}

/** `GET /ledgers?order=desc&limit=1`. */
export function latestLedgerPage(): Record<string, unknown> {
  return {
    _links: { self: { href: 'https://horizon-testnet.stellar.org/ledgers?limit=1&order=desc' } },
    _embedded: {
      records: [
        {
          id: 'f0c0b7a1',
          paging_token: '5304108482424832',
          hash: 'f0c0b7a1',
          sequence: 1_234_567,
          successful_transaction_count: 3,
          failed_transaction_count: 0,
          operation_count: 4,
          closed_at: '2026-08-06T09:00:00Z',
          base_fee_in_stroops: 100,
          base_reserve_in_stroops: 5_000_000,
          max_tx_set_size: 1000,
          protocol_version: 22,
        },
      ],
    },
  };
}

/** Friendbot's success payload (it returns the funding transaction). */
export function friendbotSuccess(accountId: string): Record<string, unknown> {
  return {
    _links: {
      transaction: {
        href: 'https://horizon-testnet.stellar.org/transactions/friendbot-tx-hash',
      },
    },
    hash: 'ff11223344556677889900aabbccddeeff00112233445566778899aabbccddee',
    ledger: 1_234_569,
    successful: true,
    source_account: 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR',
    envelope_xdr: '',
    result_xdr: '',
    result_meta_xdr: '',
    extras: { funded_account: accountId },
  };
}

/** Friendbot's error when the account already exists. */
export function friendbotAlreadyFunded(accountId: string): Record<string, unknown> {
  return {
    type: 'https://stellar.org/horizon-errors/bad_request',
    title: 'Bad Request',
    status: 400,
    detail: 'createAccountAlreadyExist (op #0)',
    extras: { account_id: accountId },
  };
}

/**
 * `GET /paths/strict-send`; one best path, computed from a flat mock rate.
 * Asset params arrive as `native` or `CODE:ISSUER` (from `destination_assets`).
 */
export function strictSendPathsPage(
  sourceAsset: { type: string; code?: string; issuer?: string },
  sourceAmount: string,
  destinationAsset: { type: string; code?: string; issuer?: string },
  destinationAmount: string,
): Record<string, unknown> {
  return {
    _embedded: {
      records: [
        {
          source_asset_type: sourceAsset.type,
          ...(sourceAsset.code ? { source_asset_code: sourceAsset.code } : {}),
          ...(sourceAsset.issuer ? { source_asset_issuer: sourceAsset.issuer } : {}),
          source_amount: sourceAmount,
          destination_asset_type: destinationAsset.type,
          ...(destinationAsset.code ? { destination_asset_code: destinationAsset.code } : {}),
          ...(destinationAsset.issuer ? { destination_asset_issuer: destinationAsset.issuer } : {}),
          destination_amount: destinationAmount,
          path: [],
        },
      ],
    },
  };
}

export function emptyPathsPage(): Record<string, unknown> {
  return { _embedded: { records: [] } };
}
