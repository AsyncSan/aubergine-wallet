import { describe, expect, it } from 'vitest';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { describeTransaction, type DescribeContext } from '../src/core/stellar/tx-describe';
import {
  describeInvokeHostFunction,
  describeScVal,
  foreignAuthContracts,
} from '../src/core/stellar/soroban-describe';
import { translate } from '../src/i18n';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const HOLDER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ROUTER = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const ctx: DescribeContext = {
  networkPassphrase: Networks.TESTNET,
  networkName: 'testnet',
  accountId: SOURCE,
  currentSequence: '100',
};

function build(ops: xdr.Operation[]): string {
  const account = new Account(SOURCE, '100');
  let b = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) b = b.addOperation(op);
  return b.setTimeout(30).build().toXDR();
}

/** Decode the single operation of a freshly built envelope, as the wallet does. */
function decodeOnly(op: xdr.Operation) {
  const tx = TransactionBuilder.fromXDR(build([op]), Networks.TESTNET);
  const decoded = (tx as { operations: unknown[] }).operations[0];
  return describeInvokeHostFunction(
    decoded as Parameters<typeof describeInvokeHostFunction>[0],
    0,
  );
}

function contractFn(contract: string, fn: string, args: xdr.ScVal[] = []) {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: fn,
      args,
    }),
  );
}

describe('describeScVal', () => {
  it('reads an address as a strkey, not as whatever the native decoder returns', () => {
    const arg = describeScVal(new Address(HOLDER).toScVal());
    expect(arg.typeKey).toBe('tx.scv.address');
    expect(arg.value.startsWith('GBAW5XGWORWV')).toBe(true);
    expect(arg.value).toContain('…');
  });

  it('renders a 128-bit amount exactly, without going through a float', () => {
    const huge = 170141183460469231731687303715884105727n;
    const arg = describeScVal(nativeToScVal(huge, { type: 'i128' }));
    expect(arg.typeKey).toBe('tx.scv.number');
    expect(arg.value).toBe(huge.toString());
  });

  it('bounds an abusively long string instead of handing it to the popup', () => {
    const arg = describeScVal(nativeToScVal('A'.repeat(50_000)));
    expect(arg.truncated).toBe(true);
    expect(arg.value.length).toBeLessThan(200);
  });

  it('bounds a deeply nested structure rather than recursing into it', () => {
    let scv = nativeToScVal(1);
    for (let i = 0; i < 40; i += 1) scv = xdr.ScVal.scvVec([scv]);
    const arg = describeScVal(scv);
    expect(arg.typeKey).toBe('tx.scv.list');
    expect(arg.truncated).toBe(true);
    expect(arg.value.length).toBeLessThan(200);
  });

  it('has a translation for every display type it can emit', () => {
    const types: xdr.ScVal[] = [
      xdr.ScVal.scvVoid(),
      nativeToScVal(true),
      nativeToScVal(1),
      nativeToScVal('text'),
      nativeToScVal('sym', { type: 'symbol' }),
      nativeToScVal(Buffer.from([1, 2, 3])),
      xdr.ScVal.scvVec([nativeToScVal(1)]),
      new Address(HOLDER).toScVal(),
    ];
    for (const scv of types) {
      const { typeKey } = describeScVal(scv);
      expect(translate('de', typeKey)).not.toBe(typeKey);
      expect(translate('en', typeKey)).not.toBe(typeKey);
    }
  });
});

describe('describeInvokeHostFunction', () => {
  it('names the contract, the function and every argument', () => {
    const invocation = decodeOnly(
      Operation.invokeContractFunction({
        contract: ROUTER,
        function: 'swap',
        args: [new Address(SOURCE).toScVal(), nativeToScVal(1_000n, { type: 'i128' })],
      }),
    );
    expect(invocation.kind).toBe('invoke');
    expect(invocation.call?.contractId).toBe(ROUTER);
    expect(invocation.call?.functionName).toBe('swap');
    expect(invocation.call?.args.map((a) => a.typeKey)).toEqual([
      'tx.scv.address',
      'tx.scv.number',
    ]);
    expect(invocation.call?.args[1]?.value).toBe('1000');
    expect(invocation.partial).toBe(false);
  });

  it('reports an upload by size instead of pretending to read the code', () => {
    const invocation = decodeOnly(
      Operation.uploadContractWasm({ wasm: Buffer.alloc(2048, 7) }),
    );
    expect(invocation.kind).toBe('uploadWasm');
    expect(invocation.wasmByteLength).toBe(2048);
    expect(invocation.call).toBeNull();
  });

  it('survives a host function whose switch cannot be read', () => {
    const broken = {
      func: {
        switch() {
          throw new Error('malformed');
        },
      },
    } as unknown as Parameters<typeof describeInvokeHostFunction>[0];
    const invocation = describeInvokeHostFunction(broken, 3);
    expect(invocation.kind).toBe('unknown');
    expect(invocation.partial).toBe(true);
    expect(invocation.opIndex).toBe(3);
  });
});

describe('the authorization tree', () => {
  /**
   * The approval-drainer shape: the visible call is a swap on the router, and
   * the signature silently also covers an `approve` on a token contract. This
   * is the case the old one-line description could not distinguish from a
   * plain swap, so it is the one worth a test of its own.
   */
  function drainerOp(): xdr.Operation {
    const sub = new xdr.SorobanAuthorizedInvocation({
      function: contractFn(TOKEN, 'approve', [nativeToScVal(2n ** 64n - 1n, { type: 'u64' })]),
      subInvocations: [],
    });
    const root = new xdr.SorobanAuthorizedInvocation({
      function: contractFn(ROUTER, 'swap'),
      subInvocations: [sub],
    });
    return Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ROUTER).toScAddress(),
          functionName: 'swap',
          args: [],
        }),
      ),
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: root,
        }),
      ],
    });
  }

  it('flattens the tree breadth-first, keeping the depth of every node', () => {
    const invocation = decodeOnly(drainerOp());
    expect(invocation.auth).toHaveLength(1);
    expect(invocation.auth[0]?.credential).toBe('sourceAccount');
    expect(invocation.auth[0]?.invocations).toEqual([
      { contractId: ROUTER, functionName: 'swap', depth: 0 },
      { contractId: TOKEN, functionName: 'approve', depth: 1 },
    ]);
  });

  it('singles out the contract the summary never mentions', () => {
    expect(foreignAuthContracts(decodeOnly(drainerOp()))).toEqual([TOKEN]);
  });

  it('raises the warning on the whole description, with the contract named', () => {
    const d = describeTransaction(build([drainerOp()]), ctx);
    const warning = d.warnings.find((w) => w.code === 'SOROBAN_AUTH_FOREIGN_CONTRACT');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warn');
    const rendered = translate('de', warning!.message.key, warning!.message.params);
    expect(rendered).toContain('CDLZFC3SYJYD');
    expect(rendered).not.toContain('{');
  });

  it('says nothing when the tree stays inside the contract being called', () => {
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ROUTER).toScAddress(),
          functionName: 'swap',
          args: [],
        }),
      ),
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: contractFn(ROUTER, 'swap'),
            subInvocations: [],
          }),
        }),
      ],
    });
    const d = describeTransaction(build([op]), ctx);
    expect(d.warnings.map((w) => w.code)).not.toContain('SOROBAN_AUTH_FOREIGN_CONTRACT');
  });

  it('names the third party when someone else authorises part of the call', () => {
    const other = Keypair.random().publicKey();
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ROUTER).toScAddress(),
          functionName: 'swap',
          args: [],
        }),
      ),
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
              address: new Address(other).toScAddress(),
              nonce: xdr.Int64.fromString('1'),
              signatureExpirationLedger: 100,
              signature: xdr.ScVal.scvVoid(),
            }),
          ),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: contractFn(ROUTER, 'swap'),
            subInvocations: [],
          }),
        }),
      ],
    });
    const d = describeTransaction(build([op]), ctx);
    const warning = d.warnings.find((w) => w.code === 'SOROBAN_AUTH_THIRD_PARTY');
    expect(warning?.severity).toBe('info');
    expect(String(warning?.message.params?.addresses)).toContain(other.slice(0, 12));
  });
});

describe('the description as a whole', () => {
  it('carries no invocations for an envelope that never touches Soroban', () => {
    const op = Operation.bumpSequence({ bumpTo: '200' });
    expect(describeTransaction(build([op]), ctx).invocations).toEqual([]);
  });

  it('keeps the fail-closed unparseable path free of invocations', () => {
    expect(describeTransaction('not-xdr', ctx).invocations).toEqual([]);
  });

  it('has a translation for every new operation line and warning', () => {
    const keys = [
      'tx.op.invokeContract',
      'tx.op.createContract',
      'tx.op.uploadWasm',
      'tx.warn.SOROBAN_AUTH_FOREIGN_CONTRACT',
      'tx.warn.SOROBAN_AUTH_THIRD_PARTY',
      'tx.warn.SOROBAN_PARTIAL_DECODE',
      'tx.term.executable.wasm',
      'tx.term.executable.stellarAsset',
      'confirm.contractCall',
      'confirm.arguments',
      'confirm.authTitle',
      'confirm.contractCallHint',
    ];
    for (const key of keys) {
      for (const locale of ['de', 'en'] as const) {
        expect(translate(locale, key)).not.toBe(key);
      }
    }
  });
});
