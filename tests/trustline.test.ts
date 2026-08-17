/**
 * Asset approval / trustline flow; §4 row 5, verification finding 3.
 *
 * Covers the whole chain the UI walks: curated list -> `tx.build` intent ->
 * envelope -> plain-language description, for both the beginner path (curated
 * issuer, no limit) and the developer path (any issuer, editable limit,
 * including the removal case `limit: 0`).
 */
import { describe, expect, it } from 'vitest';
import { Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import { CURATED_TESTNET_ASSETS, TESTNET } from '../src/core/stellar/networks';
import { buildChangeTrustTransaction } from '../src/core/stellar/tx-builder';
import { describeTransaction, type DescribeContext } from '../src/core/stellar/tx-describe';
import { rpcSchemas } from '../src/messaging/protocol';
import { AppError } from '../src/core/errors';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const SEQUENCE = '100';

function ctx(overrides: Partial<DescribeContext> = {}): DescribeContext {
  return {
    networkPassphrase: Networks.TESTNET,
    networkName: 'testnet',
    accountId: SOURCE,
    isMainnet: false,
    ...overrides,
  };
}

describe('curated asset list (beginner mode)', () => {
  it('is non-empty and contains Circle USDC', () => {
    expect(CURATED_TESTNET_ASSETS.length).toBeGreaterThan(0);
    expect(CURATED_TESTNET_ASSETS.map((a) => a.code)).toContain('USDC');
  });

  it('only lists structurally valid issuers and asset codes', () => {
    for (const asset of CURATED_TESTNET_ASSETS) {
      expect(StrKey.isValidEd25519PublicKey(asset.issuer), asset.code).toBe(true);
      expect(asset.code).toMatch(/^[A-Za-z0-9]{1,12}$/u);
      expect(asset.name.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate code/issuer pairs', () => {
    const ids = CURATED_TESTNET_ASSETS.map((a) => `${a.code}:${a.issuer}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('changeTrust build intent (the protocol boundary)', () => {
  it('accepts the beginner shape: code plus curated issuer, no limit', () => {
    const asset = CURATED_TESTNET_ASSETS[0];
    expect(asset).toBeDefined();
    const parsed = rpcSchemas['tx.build'].params.parse({
      intent: { kind: 'changeTrust', assetCode: asset!.code, issuer: asset!.issuer },
    });
    expect(parsed.intent.kind).toBe('changeTrust');
  });

  it('accepts the developer shape: any issuer plus an explicit limit', () => {
    const parsed = rpcSchemas['tx.build'].params.parse({
      intent: {
        kind: 'changeTrust',
        assetCode: 'ABCD',
        issuer: SOURCE,
        limit: '250.5',
        feeStroops: '200',
      },
    });
    expect(parsed.intent).toMatchObject({ limit: '250.5', feeStroops: '200' });
  });

  it('rejects an asset code longer than 12 characters', () => {
    expect(
      rpcSchemas['tx.build'].params.safeParse({
        intent: { kind: 'changeTrust', assetCode: 'THIRTEENCHARS', issuer: SOURCE },
      }).success,
    ).toBe(false);
  });
});

describe('changeTrust envelope', () => {
  it('builds a signable envelope for a curated asset', () => {
    const asset = CURATED_TESTNET_ASSETS[0]!;
    const xdr = buildChangeTrustTransaction(TESTNET, SOURCE, SEQUENCE, {
      assetCode: asset.code,
      issuer: asset.issuer,
    });
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    expect('operations' in tx && tx.operations).toHaveLength(1);
    expect(tx.operations[0]?.type).toBe('changeTrust');
  });

  it('refuses a malformed issuer instead of building something unsignable', () => {
    expect(() =>
      buildChangeTrustTransaction(TESTNET, SOURCE, SEQUENCE, {
        assetCode: 'USDC',
        issuer: 'not-an-address',
      }),
    ).toThrow(AppError);
  });
});

describe('plain-language description of the approval (§5)', () => {
  it('describes adding a trustline in words and stays confirmable', () => {
    const asset = CURATED_TESTNET_ASSETS[0]!;
    const xdr = buildChangeTrustTransaction(TESTNET, SOURCE, SEQUENCE, {
      assetCode: asset.code,
      issuer: asset.issuer,
    });
    const description = describeTransaction(xdr, ctx());
    expect(description.translatable).toBe(true);
    expect(description.effects[0]?.message.key).toBe('tx.op.changeTrust.add');
    expect(description.meta.networkName).toBe('testnet');
  });

  it('warns about an unknown issuer for a free-issuer approval', () => {
    const xdr = buildChangeTrustTransaction(TESTNET, SOURCE, SEQUENCE, {
      assetCode: 'ABCD',
      issuer: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
    });
    const description = describeTransaction(xdr, ctx({ trustedIssuers: [] }));
    expect(description.warnings.map((w) => w.code)).toContain('UNKNOWN_ISSUER');
  });

  it('flags limit 0 as a trustline removal (danger, §5)', () => {
    const asset = CURATED_TESTNET_ASSETS[0]!;
    const xdr = buildChangeTrustTransaction(TESTNET, SOURCE, SEQUENCE, {
      assetCode: asset.code,
      issuer: asset.issuer,
      limit: '0',
    });
    const description = describeTransaction(xdr, ctx());
    expect(description.effects[0]?.message.key).toBe('tx.op.changeTrust.remove');
    expect(description.warnings.map((w) => w.code)).toContain('TRUSTLINE_REMOVAL');
  });
});
