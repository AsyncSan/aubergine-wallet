/**
 * Decode a Soroban `invokeHostFunction` operation into something a human can
 * check before signing, ARCHITECTURE.md §5.
 *
 * Until now the confirmation dialog said "Call a smart contract (call a
 * function)" and stopped there. That sentence is true of every contract call
 * ever built, which makes it worth nothing at the moment it matters: the user
 * cannot tell a swap from a token approval that hands an unknown address an
 * unbounded allowance. Both render identically. A wallet whose entire claim is
 * a plain-language preview cannot leave its single most dangerous operation as
 * the one it refuses to read.
 *
 * What this module does *not* do, deliberately:
 *
 *  - It does not fetch a contract spec, an ABI or a token symbol. That would
 *    mean a network request per confirmation to an endpoint chosen by whoever
 *    built the transaction, i.e. an oracle for "is this user about to sign",
 *    and §3/§4 rule it out. Everything here is decoded from the envelope the
 *    user already holds.
 *  - It does not interpret semantics. `transfer` is rendered as the symbol
 *    `transfer` because that is what the bytes say; the module never claims to
 *    know that a function called `transfer` transfers anything. Contracts are
 *    free to lie about their own function names and some do.
 *  - It never throws. A malformed sub-field degrades to `unknown` for that
 *    field alone; the caller keeps the fail-closed warning it already had.
 *
 * §8: no user-visible prose here. Types and kinds travel as i18n keys and the
 * renderer resolves them.
 */
import { Address, scValToNative, type xdr } from '@stellar/stellar-sdk';

/** SDK operation shape for the one operation this module reads. */
type InvokeHostFunctionOp = {
  readonly func: xdr.HostFunction;
  readonly auth?: readonly xdr.SorobanAuthorizationEntry[];
};

/**
 * Bounds on the rendered output.
 *
 * A contract argument is attacker-controlled data that lands in a 360 px
 * popup. Without a ceiling, a 2 MB `scvString` scrolls the confirm button off
 * the screen and a deeply nested map turns the describer into a stack
 * overflow — both of which end with a user who signs to make the dialog go
 * away. The limits are chosen so that every ordinary argument (address,
 * amount, symbol, small vec) survives intact and only genuinely abusive ones
 * are cut, visibly, with the ellipsis carrying that information.
 */
const MAX_DEPTH = 3;
const MAX_ITEMS = 8;
const MAX_VALUE_CHARS = 160;
/** Beyond this many arguments the list itself is the payload. */
const MAX_ARGS = 12;
/** Auth trees are unbounded in principle; this is what fits on one screen. */
const MAX_AUTH_ENTRIES = 8;
const MAX_AUTH_NODES = 12;
const MAX_AUTH_DEPTH = 4;

/** Same truncation as `tx-describe.ts`, see the note on ADDRESS_PREFIX there. */
const ADDRESS_PREFIX = 12;
const ADDRESS_SUFFIX = 12;

function shortAddress(address: string): string {
  if (address.length <= ADDRESS_PREFIX + ADDRESS_SUFFIX + 1) return address;
  return `${address.slice(0, ADDRESS_PREFIX)}…${address.slice(-ADDRESS_SUFFIX)}`;
}

/**
 * Display types for a decoded argument. Deliberately coarser than the 20-odd
 * `ScValType` variants: the user needs to know whether they are looking at a
 * number, an address or a blob, not whether the number is an `i128` or a
 * `u256`. Developer mode gets the exact XDR through the raw disclosure.
 */
export const SC_TYPE_KEYS = [
  'tx.scv.address',
  'tx.scv.number',
  'tx.scv.string',
  'tx.scv.symbol',
  'tx.scv.bool',
  'tx.scv.bytes',
  'tx.scv.list',
  'tx.scv.map',
  'tx.scv.void',
  'tx.scv.instance',
  'tx.scv.unknown',
] as const;

export type ScTypeKey = (typeof SC_TYPE_KEYS)[number];

const SC_TYPE_BY_SWITCH: Readonly<Record<string, ScTypeKey>> = {
  scvAddress: 'tx.scv.address',
  scvBool: 'tx.scv.bool',
  scvVoid: 'tx.scv.void',
  scvU32: 'tx.scv.number',
  scvI32: 'tx.scv.number',
  scvU64: 'tx.scv.number',
  scvI64: 'tx.scv.number',
  scvU128: 'tx.scv.number',
  scvI128: 'tx.scv.number',
  scvU256: 'tx.scv.number',
  scvI256: 'tx.scv.number',
  scvTimepoint: 'tx.scv.number',
  scvDuration: 'tx.scv.number',
  scvBytes: 'tx.scv.bytes',
  scvString: 'tx.scv.string',
  scvSymbol: 'tx.scv.symbol',
  scvVec: 'tx.scv.list',
  scvMap: 'tx.scv.map',
  scvContractInstance: 'tx.scv.instance',
  scvLedgerKeyContractInstance: 'tx.scv.instance',
  scvLedgerKeyNonce: 'tx.scv.number',
};

export interface ScArg {
  /** i18n key for the display type. */
  readonly typeKey: ScTypeKey;
  /** Rendered value, already bounded. Data, never prose. */
  readonly value: string;
  /** True when the rendering hit one of the bounds above. */
  readonly truncated: boolean;
}

export interface SorobanCall {
  /** `C…` contract id, or the empty string when the address would not decode. */
  readonly contractId: string;
  /** The invoked symbol, verbatim. */
  readonly functionName: string;
  readonly args: readonly ScArg[];
  /** Arguments dropped because the list exceeded `MAX_ARGS`. */
  readonly argsOmitted: number;
}

export type SorobanKind = 'invoke' | 'createContract' | 'uploadWasm' | 'unknown';

export interface SorobanAuthNode {
  readonly contractId: string;
  readonly functionName: string;
  /** 0 for the root invocation of an entry, 1 for its direct children, … */
  readonly depth: number;
}

export interface SorobanAuthEntry {
  /**
   * `sourceAccount` — covered by the signature the user is about to give.
   * `address` — a *separate* signature by another party is required or already
   * attached; the user is co-signing something they did not necessarily
   * originate.
   */
  readonly credential: 'sourceAccount' | 'address' | 'unknown';
  /** Present only for `address` credentials. */
  readonly address: string;
  readonly invocations: readonly SorobanAuthNode[];
  /** Nodes dropped because the tree exceeded the bounds above. */
  readonly nodesOmitted: number;
}

export interface SorobanInvocation {
  readonly opIndex: number;
  readonly kind: SorobanKind;
  /** Present for `invoke`, and for `createContract` with constructor args. */
  readonly call: SorobanCall | null;
  /** `createContract`: what the new contract will run. */
  readonly executableKey: string | null;
  /** `createContract` (wasm executable) and `uploadWasm`: the code identity. */
  readonly wasmHash: string | null;
  /** `uploadWasm`: size of the payload, so "how much code" is answerable. */
  readonly wasmByteLength: number | null;
  readonly auth: readonly SorobanAuthEntry[];
  /**
   * True when at least one field could not be decoded. The caller turns this
   * into a warning rather than presenting a partial reading as complete.
   */
  readonly partial: boolean;
}

function addressString(scAddress: xdr.ScAddress): string {
  try {
    return Address.fromScAddress(scAddress).toString();
  } catch {
    return '';
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bound(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_VALUE_CHARS) return { value, truncated: false };
  return { value: `${value.slice(0, MAX_VALUE_CHARS)}…`, truncated: true };
}

/**
 * Render a decoded native value.
 *
 * Recursion is depth-bounded rather than cycle-detected: `scValToNative`
 * produces a tree from a finite byte buffer, so it cannot contain a cycle, but
 * it *can* be arbitrarily deep, and depth is the resource that matters here.
 */
function renderNative(value: unknown, depth: number, state: { truncated: boolean }): string {
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return '…';
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'symbol') return value.description ?? '';
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_ITEMS);
    if (shown.length < value.length) state.truncated = true;
    const parts = shown.map((item) => renderNative(item, depth + 1, state));
    return `[${parts.join(', ')}${shown.length < value.length ? ', …' : ''}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, MAX_ITEMS);
    if (shown.length < entries.length) state.truncated = true;
    const parts = shown.map(([k, v]) => `${k}: ${renderNative(v, depth + 1, state)}`);
    return `{${parts.join(', ')}${shown.length < entries.length ? ', …' : ''}}`;
  }
  return '';
}

/** One argument, decoded and bounded. Never throws. */
export function describeScVal(scv: xdr.ScVal): ScArg {
  let switchName = '';
  try {
    switchName = scv.switch().name;
  } catch {
    return { typeKey: 'tx.scv.unknown', value: '', truncated: false };
  }
  const typeKey = SC_TYPE_BY_SWITCH[switchName] ?? 'tx.scv.unknown';

  // Addresses are the one type where the *canonical* strkey matters more than
  // whatever `scValToNative` decides to hand back, so they are read directly.
  if (typeKey === 'tx.scv.address') {
    try {
      const full = addressString(scv.address());
      return { typeKey, value: full === '' ? '' : shortAddress(full), truncated: false };
    } catch {
      return { typeKey, value: '', truncated: false };
    }
  }

  const state = { truncated: false };
  let rendered: string;
  try {
    rendered = renderNative(scValToNative(scv), 0, state);
  } catch {
    return { typeKey, value: '', truncated: false };
  }
  const { value, truncated } = bound(rendered);
  return { typeKey, value, truncated: truncated || state.truncated };
}

function describeInvokeArgs(args: xdr.InvokeContractArgs): SorobanCall {
  const contractId = addressString(args.contractAddress());
  let functionName = '';
  try {
    functionName = args.functionName().toString();
  } catch {
    functionName = '';
  }
  let raw: readonly xdr.ScVal[] = [];
  try {
    raw = args.args();
  } catch {
    raw = [];
  }
  const shown = raw.slice(0, MAX_ARGS);
  return {
    contractId,
    functionName,
    args: shown.map(describeScVal),
    argsOmitted: raw.length - shown.length,
  };
}

const EXECUTABLE_KEYS: Readonly<Record<string, string>> = {
  contractExecutableWasm: 'tx.term.executable.wasm',
  contractExecutableStellarAsset: 'tx.term.executable.stellarAsset',
};

/**
 * Flatten one authorization tree, breadth-first.
 *
 * Breadth-first and not depth-first on purpose: what the user needs to see
 * first is the *set* of contracts this signature reaches, and a depth-first
 * walk buries the second root child behind an entire sub-tree. Truncation
 * therefore drops the deepest, least surprising nodes rather than a sibling
 * that names an entirely different contract.
 */
function flattenAuth(root: xdr.SorobanAuthorizedInvocation): {
  nodes: SorobanAuthNode[];
  omitted: number;
} {
  const nodes: SorobanAuthNode[] = [];
  let omitted = 0;
  let frontier: Array<{ node: xdr.SorobanAuthorizedInvocation; depth: number }> = [
    { node: root, depth: 0 },
  ];
  while (frontier.length > 0) {
    const next: Array<{ node: xdr.SorobanAuthorizedInvocation; depth: number }> = [];
    for (const { node, depth } of frontier) {
      if (nodes.length >= MAX_AUTH_NODES) {
        omitted += 1;
        continue;
      }
      try {
        const fn = node.function();
        if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
          const args = fn.contractFn();
          nodes.push({
            contractId: addressString(args.contractAddress()),
            functionName: args.functionName().toString(),
            depth,
          });
        } else {
          // A create-contract authorization: no function name to show, but the
          // node still exists and hiding it would understate the tree.
          nodes.push({ contractId: '', functionName: '', depth });
        }
      } catch {
        nodes.push({ contractId: '', functionName: '', depth });
      }
      if (depth >= MAX_AUTH_DEPTH) continue;
      try {
        for (const sub of node.subInvocations()) next.push({ node: sub, depth: depth + 1 });
      } catch {
        /* a sub-tree we cannot read is reported by its absence, not by a throw */
      }
    }
    frontier = next;
  }
  return { nodes, omitted };
}

function describeAuthEntry(entry: xdr.SorobanAuthorizationEntry): SorobanAuthEntry {
  let credential: SorobanAuthEntry['credential'] = 'unknown';
  let address = '';
  try {
    const creds = entry.credentials();
    const name = creds.switch().name;
    if (name === 'sorobanCredentialsSourceAccount') {
      credential = 'sourceAccount';
    } else if (name === 'sorobanCredentialsAddress') {
      credential = 'address';
      address = addressString(creds.address().address());
    }
  } catch {
    credential = 'unknown';
  }
  let nodes: SorobanAuthNode[] = [];
  let nodesOmitted = 0;
  try {
    const flat = flattenAuth(entry.rootInvocation());
    nodes = flat.nodes;
    nodesOmitted = flat.omitted;
  } catch {
    nodes = [];
  }
  return {
    credential,
    address: address === '' ? '' : shortAddress(address),
    invocations: nodes,
    nodesOmitted,
  };
}

/**
 * Decode one `invokeHostFunction` operation. Returns `null` only when the
 * operation carries no readable host function at all, in which case the caller
 * keeps its existing fail-closed handling.
 */
export function describeInvokeHostFunction(
  op: InvokeHostFunctionOp,
  opIndex: number,
): SorobanInvocation {
  let switchName = '';
  let partial = false;
  try {
    switchName = op.func.switch().name;
  } catch {
    partial = true;
  }

  let kind: SorobanKind = 'unknown';
  let call: SorobanCall | null = null;
  let executableKey: string | null = null;
  let wasmHash: string | null = null;
  let wasmByteLength: number | null = null;

  try {
    switch (switchName) {
      case 'hostFunctionTypeInvokeContract': {
        kind = 'invoke';
        call = describeInvokeArgs(op.func.invokeContract());
        break;
      }
      case 'hostFunctionTypeCreateContract':
      case 'hostFunctionTypeCreateContractV2': {
        kind = 'createContract';
        const args =
          switchName === 'hostFunctionTypeCreateContractV2'
            ? op.func.createContractV2()
            : op.func.createContract();
        const exec = args.executable();
        executableKey = EXECUTABLE_KEYS[exec.switch().name] ?? 'tx.term.executable.unknown';
        if (exec.switch().name === 'contractExecutableWasm') {
          wasmHash = toHex(exec.wasmHash());
        }
        if (switchName === 'hostFunctionTypeCreateContractV2') {
          const ctor = (args as xdr.CreateContractArgsV2).constructorArgs();
          const shown = ctor.slice(0, MAX_ARGS);
          call = {
            contractId: '',
            functionName: '',
            args: shown.map(describeScVal),
            argsOmitted: ctor.length - shown.length,
          };
        }
        break;
      }
      case 'hostFunctionTypeUploadContractWasm': {
        kind = 'uploadWasm';
        const wasm = op.func.wasm();
        wasmByteLength = wasm.length;
        break;
      }
      default: {
        kind = 'unknown';
        partial = true;
      }
    }
  } catch {
    partial = true;
  }

  let auth: SorobanAuthEntry[] = [];
  try {
    const entries = op.auth ?? [];
    const shown = entries.slice(0, MAX_AUTH_ENTRIES);
    if (shown.length < entries.length) partial = true;
    auth = shown.map(describeAuthEntry);
  } catch {
    partial = true;
  }

  if (call !== null && call.argsOmitted > 0) partial = true;
  if (auth.some((e) => e.nodesOmitted > 0)) partial = true;

  return { opIndex, kind, call, executableKey, wasmHash, wasmByteLength, auth, partial };
}

/**
 * Contract ids the authorization tree reaches that are *not* the contract the
 * transaction visibly calls.
 *
 * This is the signal behind the classic approval drainer: the dialog shows a
 * call to a swap router, and buried in the auth tree is an `approve` on a
 * token contract granting an unrelated address an allowance that outlives the
 * swap by years. Both are legitimate shapes — every real swap authorises the
 * token contract too — so this is a `warn`, not a refusal. What the user gets
 * is the list, which is exactly what the confirmation was missing.
 */
export function foreignAuthContracts(invocation: SorobanInvocation): readonly string[] {
  const called = invocation.call?.contractId ?? '';
  const out: string[] = [];
  for (const entry of invocation.auth) {
    for (const node of entry.invocations) {
      if (node.contractId === '' || node.contractId === called) continue;
      if (!out.includes(node.contractId)) out.push(node.contractId);
    }
  }
  return out;
}
