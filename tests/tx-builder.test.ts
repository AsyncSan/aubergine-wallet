import { describe, expect, it } from 'vitest';
import { Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  assertValidAddress,
  assertValidAmount,
  buildChangeTrustTransaction,
  buildPaymentTransaction,
  buildSwapTransaction,
} from '../src/core/stellar/tx-builder';
import { TESTNET } from '../src/core/stellar/networks';
import { AppError } from '../src/core/errors';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const DEST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ISSUER = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';

/** The builder under test never produces fee bumps, so narrow the union once. */
function parse(xdr: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  if (!(tx instanceof Transaction)) throw new Error('expected a plain transaction');
  return tx;
}

describe('validation helpers', () => {
  it('accepts a valid ed25519 address', () => {
    expect(() => assertValidAddress(SOURCE)).not.toThrow();
  });

  it('rejects a malformed address with INVALID_ADDRESS', () => {
    try {
      assertValidAddress('not-an-address');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('INVALID_ADDRESS');
    }
  });

  it('accepts amounts with up to seven decimals', () => {
    expect(() => assertValidAmount('1')).not.toThrow();
    expect(() => assertValidAmount('0.0000001')).not.toThrow();
  });

  it('rejects zero, negative and over-precise amounts', () => {
    for (const bad of ['0', '-1', '1.00000001', 'abc', '']) {
      expect(() => assertValidAmount(bad), bad).toThrow(AppError);
    }
  });
});

describe('buildPaymentTransaction', () => {
  it('builds a payment for an existing destination', () => {
    const xdr = buildPaymentTransaction(TESTNET, SOURCE, '100', {
      destination: DEST,
      assetId: 'native',
      amount: '12.5',
      destinationExists: true,
    });
    const tx = parse(xdr);
    expect(tx.operations[0]?.type).toBe('payment');
    expect(tx.source).toBe(SOURCE);
    expect(tx.sequence).toBe('101');
  });

  it('builds createAccount when the destination does not exist yet', () => {
    const xdr = buildPaymentTransaction(TESTNET, SOURCE, '100', {
      destination: DEST,
      assetId: 'native',
      amount: '5',
      destinationExists: false,
    });
    const tx = parse(xdr);
    expect(tx.operations[0]?.type).toBe('createAccount');
  });

  it('refuses to fund a new account below the minimum starting balance', () => {
    expect(() =>
      buildPaymentTransaction(TESTNET, SOURCE, '100', {
        destination: DEST,
        assetId: 'native',
        amount: '0.5',
        destinationExists: false,
      }),
    ).toThrow(AppError);
  });

  it('refuses a non-native asset to a non-existent account', () => {
    try {
      buildPaymentTransaction(TESTNET, SOURCE, '100', {
        destination: DEST,
        assetId: `USDC:${ISSUER}`,
        amount: '5',
        destinationExists: false,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('ACCOUNT_NOT_FOUND');
    }
  });

  it('attaches a text memo when given', () => {
    const xdr = buildPaymentTransaction(TESTNET, SOURCE, '100', {
      destination: DEST,
      assetId: 'native',
      amount: '1',
      memo: 'invoice 7',
      destinationExists: true,
    });
    const tx = parse(xdr);
    expect(tx.memo.type).toBe('text');
  });

  it('rejects a memo over 28 UTF-8 bytes with INVALID_MEMO (P2)', () => {
    const build = (memo: string) =>
      buildPaymentTransaction(TESTNET, SOURCE, '100', {
        destination: DEST,
        assetId: 'native',
        amount: '1',
        memo,
        destinationExists: true,
      });
    // 15 characters, 30 bytes: passed the old character check, breaks XDR.
    try {
      build('ä'.repeat(15));
      expect.unreachable('multi-byte memo above 28 bytes must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_MEMO');
    }
    // Exactly 28 bytes of multi-byte text is fine.
    expect(parse(build('ä'.repeat(14))).memo.type).toBe('text');
  });

  it('honours a manual fee override', () => {
    const xdr = buildPaymentTransaction(TESTNET, SOURCE, '100', {
      destination: DEST,
      assetId: 'native',
      amount: '1',
      destinationExists: true,
      feeStroops: '5000',
    });
    expect(parse(xdr).fee).toBe('5000');
  });

  it('uses the base fee by default', () => {
    const xdr = buildPaymentTransaction(TESTNET, SOURCE, '100', {
      destination: DEST,
      assetId: 'native',
      amount: '1',
      destinationExists: true,
    });
    expect(parse(xdr).fee).toBe('100');
  });

  it('builds a non-native payment', () => {
    const xdr = buildPaymentTransaction(TESTNET, SOURCE, '100', {
      destination: DEST,
      assetId: `USDC:${ISSUER}`,
      amount: '10',
      destinationExists: true,
    });
    const tx = parse(xdr);
    const op = tx.operations[0];
    expect(op?.type).toBe('payment');
    if (op?.type === 'payment') expect(op.asset.getCode()).toBe('USDC');
  });

  it('rejects an invalid destination before building', () => {
    expect(() =>
      buildPaymentTransaction(TESTNET, SOURCE, '100', {
        destination: 'nope',
        assetId: 'native',
        amount: '1',
        destinationExists: true,
      }),
    ).toThrow(AppError);
  });
});

describe('buildChangeTrustTransaction', () => {
  it('builds a trustline with an explicit limit', () => {
    const xdr = buildChangeTrustTransaction(TESTNET, SOURCE, '100', {
      assetCode: 'USDC',
      issuer: ISSUER,
      limit: '1000',
    });
    const tx = parse(xdr);
    const op = tx.operations[0];
    expect(op?.type).toBe('changeTrust');
    // The SDK normalises limits to seven decimals.
    if (op?.type === 'changeTrust') expect(op.limit).toBe('1000.0000000');
  });

  it('builds a trustline removal with limit 0', () => {
    const xdr = buildChangeTrustTransaction(TESTNET, SOURCE, '100', {
      assetCode: 'USDC',
      issuer: ISSUER,
      limit: '0',
    });
    const tx = parse(xdr);
    const op = tx.operations[0];
    if (op?.type === 'changeTrust') expect(Number(op.limit)).toBe(0);
  });

  it('rejects a malformed issuer', () => {
    expect(() =>
      buildChangeTrustTransaction(TESTNET, SOURCE, '100', {
        assetCode: 'USDC',
        issuer: 'nope',
      }),
    ).toThrow(AppError);
  });
});

describe('buildSwapTransaction', () => {
  it('builds a strict-send path payment back to the source account', () => {
    const xdr = buildSwapTransaction(TESTNET, SOURCE, '100', {
      sendAssetId: 'native',
      sendAmount: '25',
      destAssetId: `USDC:${ISSUER}`,
      destMin: '11.9400000',
      path: [],
    });
    const tx = parse(xdr);
    const op = tx.operations[0];
    expect(op?.type).toBe('pathPaymentStrictSend');
    if (op?.type === 'pathPaymentStrictSend') {
      // A swap delivers to yourself; that IS the safety property.
      expect(op.destination).toBe(SOURCE);
      expect(op.sendAsset.isNative()).toBe(true);
      // The SDK normalises amounts to seven decimals.
      expect(op.sendAmount).toBe('25.0000000');
      expect(op.destAsset.code).toBe('USDC');
      expect(op.destAsset.issuer).toBe(ISSUER);
      expect(op.destMin).toBe('11.9400000');
      expect(op.path).toHaveLength(0);
    }
    expect(tx.source).toBe(SOURCE);
    expect(tx.sequence).toBe('101');
  });

  it('threads the quoted intermediate hops through', () => {
    const xdr = buildSwapTransaction(TESTNET, SOURCE, '100', {
      sendAssetId: `USDC:${ISSUER}`,
      sendAmount: '3',
      destAssetId: 'native',
      destMin: '1',
      path: ['native', `SRT:${DEST}`],
    });
    const tx = parse(xdr);
    const op = tx.operations[0];
    if (op?.type === 'pathPaymentStrictSend') {
      expect(op.path).toHaveLength(2);
      expect(op.path[0]?.isNative()).toBe(true);
      expect(op.path[1]?.code).toBe('SRT');
    }
  });

  it('refuses to swap an asset into itself', () => {
    try {
      buildSwapTransaction(TESTNET, SOURCE, '100', {
        sendAssetId: 'native',
        sendAmount: '1',
        destAssetId: 'native',
        destMin: '1',
        path: [],
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('BAD_REQUEST');
    }
  });

  it('rejects invalid amounts and floors', () => {
    for (const [sendAmount, destMin] of [
      ['0', '1'],
      ['1', '0'],
      ['1.00000001', '1'],
      ['abc', '1'],
    ] as const) {
      expect(() =>
        buildSwapTransaction(TESTNET, SOURCE, '100', {
          sendAssetId: 'native',
          sendAmount,
          destAssetId: `USDC:${ISSUER}`,
          destMin,
          path: [],
        }),
      ).toThrow(AppError);
    }
  });
});
