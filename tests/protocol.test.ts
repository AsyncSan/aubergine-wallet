/**
 * The RPC boundary from ARCHITECTURE.md §6: every method Zod-validated,
 * discriminated union, typed error codes instead of raw exception strings.
 */
import { describe, expect, it } from 'vitest';
import {
  RPC_METHODS,
  isRpcMethod,
  parseRequest,
  parseResult,
  rpcSchemas,
  wireErrorSchema,
} from '../src/messaging/protocol';
import { AppError, ERROR_CODES, errorI18nKey, toWireError, txFailed } from '../src/core/errors';

/** Exactly the surface §6 lists, plus the prompt plumbing the popup needs. */
const REQUIRED_METHODS = [
  'wallet.create',
  'wallet.importMnemonic',
  'wallet.unlock',
  'wallet.lock',
  'wallet.status',
  'account.list',
  'account.add',
  'account.select',
  'account.balances',
  'account.history',
  'tx.build',
  'tx.describe',
  'tx.sign',
  'tx.submit',
  'dapp.requestConnect',
  'dapp.signXdr',
  'settings.get',
  'settings.set',
] as const;

describe('RPC method table', () => {
  it('covers every method named in ARCHITECTURE.md §6', () => {
    for (const method of REQUIRED_METHODS) {
      expect(RPC_METHODS).toContain(method);
    }
  });

  it('declares a params and a result schema for every method', () => {
    for (const method of RPC_METHODS) {
      expect(rpcSchemas[method].params).toBeDefined();
      expect(rpcSchemas[method].result).toBeDefined();
    }
  });

  it('recognises only known methods', () => {
    expect(isRpcMethod('wallet.unlock')).toBe(true);
    expect(isRpcMethod('wallet.exportSecretKey')).toBe(false);
    expect(isRpcMethod('toString')).toBe(false);
  });

  it('never exposes a method that hands out secret key material', () => {
    // Invariant 1. `wallet.revealRecoveryPhrase` is the one audited, password
    // gated exception and is asserted separately below.
    const suspicious = RPC_METHODS.filter((m) =>
      /secret|privateKey|seed|export/iu.test(m),
    );
    expect(suspicious).toEqual([]);
  });

  it('password-gates the recovery phrase reveal', () => {
    const schema = rpcSchemas['wallet.revealRecoveryPhrase'].params;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ password: 'hunter2!' }).success).toBe(true);
  });
});

describe('parseRequest', () => {
  it('accepts a well-formed request', () => {
    const req = parseRequest({
      id: 'a1',
      method: 'wallet.unlock',
      params: { password: 'hunter2!' },
    });
    expect(req.method).toBe('wallet.unlock');
    expect(req.id).toBe('a1');
  });

  it('applies schema defaults', () => {
    const req = parseRequest({ id: 'a1', method: 'wallet.create', params: { password: 'hunter2!' } });
    expect(req.method).toBe('wallet.create');
    if (req.method === 'wallet.create') expect(req.params.strength).toBe(128);
  });

  it('treats a missing params object as empty', () => {
    const req = parseRequest({ id: 'a1', method: 'wallet.status' });
    expect(req.params).toEqual({});
  });

  it('rejects an unknown method', () => {
    expect(() => parseRequest({ id: 'a1', method: 'wallet.drainFunds', params: {} })).toThrow();
  });

  it('rejects a request without an id', () => {
    expect(() => parseRequest({ method: 'wallet.status', params: {} })).toThrow();
  });

  it('rejects params that fail validation', () => {
    expect(() =>
      parseRequest({ id: 'a1', method: 'wallet.create', params: { password: 'short' } }),
    ).toThrow();
    expect(() =>
      parseRequest({ id: 'a1', method: 'account.select', params: { index: -1 } }),
    ).toThrow();
    expect(() =>
      parseRequest({ id: 'a1', method: 'account.history', params: { limit: 1000 } }),
    ).toThrow();
  });

  it('validates the tx.build intent union', () => {
    const payment = parseRequest({
      id: 'a1',
      method: 'tx.build',
      params: {
        intent: { kind: 'payment', destination: 'G…', assetId: 'native', amount: '1' },
      },
    });
    expect(payment.method).toBe('tx.build');
    expect(() =>
      parseRequest({
        id: 'a1',
        method: 'tx.build',
        params: { intent: { kind: 'teleport', amount: '1' } },
      }),
    ).toThrow();
  });

  it('validates the swap intent and defaults its path to empty', () => {
    const swap = parseRequest({
      id: 'a1',
      method: 'tx.build',
      params: {
        intent: {
          kind: 'swap',
          sendAssetId: 'native',
          sendAmount: '5',
          destAssetId: 'USDC:GAY5',
          destMin: '2.4',
        },
      },
    });
    expect(swap.method).toBe('tx.build');
    if (swap.method === 'tx.build' && swap.params.intent.kind === 'swap') {
      expect(swap.params.intent.path).toEqual([]);
    }
    // destMin is the safety rail; an intent without one must not parse.
    expect(() =>
      parseRequest({
        id: 'a1',
        method: 'tx.build',
        params: {
          intent: { kind: 'swap', sendAssetId: 'native', sendAmount: '5', destAssetId: 'x' },
        },
      }),
    ).toThrow();
  });

  it('accepts a swap.quote request and result', () => {
    const request = parseRequest({
      id: 'q1',
      method: 'swap.quote',
      params: { sendAssetId: 'native', sendAmount: '5', destAssetId: 'USDC:GAY5' },
    });
    expect(request.method).toBe('swap.quote');
    expect(
      parseResult('swap.quote', { found: false, destAmount: '0', path: [] }).found,
    ).toBe(false);
  });

  it('rejects an over-long memo at the boundary', () => {
    expect(() =>
      parseRequest({
        id: 'a1',
        method: 'tx.build',
        params: {
          intent: {
            kind: 'payment',
            destination: 'G…',
            assetId: 'native',
            amount: '1',
            memo: 'x'.repeat(29),
          },
        },
      }),
    ).toThrow();
  });

  it('measures the memo limit in UTF-8 bytes, not characters (P2)', () => {
    const build = (memo: string) =>
      parseRequest({
        id: 'a1',
        method: 'tx.build',
        params: {
          intent: {
            kind: 'payment',
            destination: 'G…',
            assetId: 'native',
            amount: '1',
            memo,
          },
        },
      });
    // 15 umlauts = 15 characters but 30 UTF-8 bytes -> must fail.
    expect(() => build('ä'.repeat(15))).toThrow();
    // 7 four-byte emoji = 28 bytes -> exactly at the limit, must pass.
    expect(() => build('🚀'.repeat(7))).not.toThrow();
    expect(() => build('🚀'.repeat(8))).toThrow();
    // 14 umlauts = 28 bytes -> ok; 28 ASCII chars -> ok.
    expect(() => build('ä'.repeat(14))).not.toThrow();
    expect(() => build('x'.repeat(28))).not.toThrow();
  });
});

describe('parseResult', () => {
  it('validates a result against its declared schema', () => {
    const result = parseResult('wallet.status', {
      initialized: true,
      unlocked: false,
      autoLockAt: null,
    });
    expect(result.unlocked).toBe(false);
  });

  it('rejects a malformed result', () => {
    expect(() => parseResult('wallet.status', { initialized: 'yes' })).toThrow();
  });
});

describe('typed errors', () => {
  it('maps AppError to a wire error', () => {
    const wire = toWireError(new AppError('WALLET_LOCKED'));
    expect(wire).toEqual({ code: 'WALLET_LOCKED' });
    expect(wireErrorSchema.safeParse(wire).success).toBe(true);
  });

  it('supports the dynamic TX_FAILED:<result_code> member', () => {
    const wire = toWireError(txFailed('op_underfunded'));
    expect(wire.code).toBe('TX_FAILED:op_underfunded');
    expect(wireErrorSchema.safeParse(wire).success).toBe(true);
    // Adjusted: a result code we have a beginner text for now resolves to its
    // own key. `error.TX_FAILED` stayed the fallback and is asserted below.
    expect(errorI18nKey(wire.code)).toBe('error.txcode.op_underfunded');
    expect(errorI18nKey('TX_FAILED:op_never_heard_of_it')).toBe('error.TX_FAILED');
  });

  it('never leaks a raw exception as the code', () => {
    const wire = toWireError(new Error('ECONNREFUSED 127.0.0.1:8000'));
    expect(wire.code).toBe('INTERNAL_ERROR');
    expect(ERROR_CODES).toContain(wire.code);
  });

  it('handles non-Error throwables', () => {
    expect(toWireError('boom')).toEqual({ code: 'INTERNAL_ERROR', detail: 'boom' });
  });

  it('produces a translation key for every error code', () => {
    for (const code of ERROR_CODES) {
      expect(errorI18nKey(code)).toBe(`error.${code}`);
    }
  });
});

/**
 * The manual fee field used to be a bare `z.string()`: no format, no ceiling.
 * "100" with three zeros too many was built, signed and paid. §4 keeps the
 * override's *precedence* over the fee strategy; this is a format bound, not
 * a second ceiling.
 */
describe('the developer-mode fee override is format-bounded', () => {
  const build = (feeStroops: unknown): unknown =>
    parseRequest({
      id: 'a1',
      method: 'tx.build',
      params: {
        intent: {
          kind: 'payment',
          destination: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
          assetId: 'native',
          amount: '1',
          feeStroops,
        },
      },
    });

  it('accepts the values a developer plausibly means', () => {
    for (const fee of ['100', '1000', '100000', '9999999']) {
      expect(() => build(fee), fee).not.toThrow();
    }
  });

  it('rejects a fee with three zeros too many', () => {
    expect(() => build('100000000')).toThrow();
  });

  it('rejects anything that is not a plain positive integer', () => {
    for (const fee of ['', '0', '-100', '1e6', '10.5', '1 000', 'abc', ' 100']) {
      expect(() => build(fee), JSON.stringify(fee)).toThrow();
    }
  });

  it('rejects it with a translatable code rather than "unexpected error"', () => {
    try {
      build('100000000');
      throw new Error('expected a rejection');
    } catch (err) {
      expect(toWireError(err).code).toBe('BAD_REQUEST');
    }
  });

  it('leaves the field optional; the fee strategy is the normal path', () => {
    expect(() =>
      parseRequest({
        id: 'a1',
        method: 'tx.build',
        params: {
          intent: {
            kind: 'payment',
            destination: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
            assetId: 'native',
            amount: '1',
          },
        },
      }),
    ).not.toThrow();
  });
});

/**
 * The strength floor for a *new* vault is enforced at this boundary, not only
 * by the Continue button in Onboarding. `core/password-strength` explains the
 * calibration: the keystore blob can be taken and ground offline against
 * Argon2id, which buys ~15-20 bits, so the password has to carry the rest.
 * A rule that lives only in a `disabled` attribute is a suggestion.
 */
describe('the vault-creation password floor is enforced at the RPC edge', () => {
  const CREATION_METHODS = ['wallet.create', 'wallet.importMnemonic'] as const;
  const MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  function paramsFor(method: (typeof CREATION_METHODS)[number], password: string): unknown {
    return method === 'wallet.create' ? { password } : { password, mnemonic: MNEMONIC };
  }

  /**
   * The refusal is an `AppError` thrown out of the schema's `transform`, not a
   * ZodError issue, so it escapes `safeParse` rather than being reported by
   * it. That is the point: `toWireError` keeps the code only for `AppError`,
   * and a ZodError would reach the popup as `INTERNAL_ERROR`. Asserting the
   * *code* here is what stops that regression coming back.
   */
  function refusal(method: (typeof CREATION_METHODS)[number], password: string): AppError {
    try {
      rpcSchemas[method].params.parse(paramsFor(method, password));
    } catch (err) {
      return err as AppError;
    }
    throw new Error(`${password} was accepted by ${method}`);
  }

  for (const method of CREATION_METHODS) {
    it(`${method} refuses a password long enough but trivially guessable`, () => {
      // Eight characters clears the length floor and nothing else.
      for (const weak of ['password', 'passwort', 'qwertzui', '12345678', 'aaaaaaaa']) {
        const err = refusal(method, weak);
        expect(err, `${weak} was not refused with an AppError`).toBeInstanceOf(AppError);
        expect(err.code, weak).toBe('WEAK_PASSWORD');
      }
    });

    it(`${method} still accepts a password with real entropy`, () => {
      const parsed = rpcSchemas[method].params.safeParse(
        paramsFor(method, 'correct horse battery'),
      );
      expect(parsed.success).toBe(true);
    });

    it(`${method} still refuses anything under eight characters`, () => {
      const err = refusal(method, 'Tr0ub4d');
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('BAD_REQUEST');
    });

    /**
     * The whole reason the schema throws `AppError`: what the popup receives
     * has to be the reason, not `INTERNAL_ERROR`.
     */
    it(`${method} surfaces the refusal as a translatable wire code`, () => {
      const wire = toWireError(refusal(method, 'password'));
      expect(wire.code).toBe('WEAK_PASSWORD');
      expect(ERROR_CODES).toContain(wire.code);
      expect(errorI18nKey(wire.code)).toBe('error.WEAK_PASSWORD');
    });
  }

  /**
   * Verifying an *existing* password must never gain a strength rule: an early
   * adopter whose password predates the floor has to stay able to open, back
   * up and extend their own wallet.
   */
  it('does not apply the floor to methods that verify an existing password', () => {
    for (const method of ['wallet.unlock', 'wallet.revealRecoveryPhrase'] as const) {
      expect(rpcSchemas[method].params.safeParse({ password: 'password' }).success).toBe(true);
    }
    expect(
      rpcSchemas['account.add'].params.safeParse({ password: 'password', label: 'x' }).success,
    ).toBe(true);
  });
});
