/**
 * The Soroban RPC fallback chain (v1.3).
 *
 * Why this file exists: `prepareSorobanTransaction` is on the mandatory path
 * of every aggregator swap and every unprepared dApp Soroban transaction, and
 * until v1.3 Mainnet had exactly one endpoint behind it, a free service run
 * by a single person, with no ToS, no SLA, and no fallback. The chain fixes
 * the availability problem, but it introduces a subtler one: failing over on
 * the *wrong* kind of error hides real answers behind a wall of timeouts.
 *
 * So the tests below pin four things that must not drift:
 *  1. the order the endpoints are tried in, and that the user's own endpoint
 *     comes first,
 *  2. that a TRANSPORT failure advances to the next endpoint,
 *  3. that a REASONED failure (the simulation says no) does not,
 *  4. that the endpoint the user types in is https, is reachable under the
 *     packaged CSP, and never travels over `chrome.storage.sync`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import {
  ALCHEMY_SOROBAN_ORIGINS,
  CSP_SOROBAN_ORIGINS,
  MAINNET,
  TESTNET,
  allOriginsForNetwork,
  checkSorobanEndpoint,
  originsForNetwork,
  resolveNetwork,
  type NetworkConfig,
} from '../src/core/stellar/networks';
import {
  SOROBAN_STICKY_MS,
  isTransportFailure,
  orderedEndpoints,
  redactEndpoints,
  resetSorobanEndpointCache,
  withSorobanEndpoint,
} from '../src/core/stellar/soroban';
import { AppError } from '../src/core/errors';
import {
  DEFAULT_SETTINGS,
  effectiveNetworkId,
  isMainnetActive,
  mergeSettings,
  settingsSchema,
  type Settings,
} from '../src/core/settings';
import { rpcSchemas } from '../src/messaging/protocol';

const ALCHEMY = 'https://stellar-mainnet.g.alchemy.com/v2/super-secret-key';

function settings(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

/** An error shaped exactly like the SDK's HTTP failures (`err.response.status`). */
function httpError(status: number): Error {
  const err = new Error(`Request failed with status code ${status}`);
  (err as unknown as { response: { status: number } }).response = { status };
  return err;
}

/** A JSON-RPC error: a bare object, not an Error, see the SDK's `postObject`. */
function jsonRpcError(code: number, message: string): unknown {
  return { code, message };
}

beforeEach(() => {
  resetSorobanEndpointCache();
});

/* ------------------------------------------------------------ 1. the chain */

describe('the endpoint chain', () => {
  it('gives mainnet more than one endpoint, from more than one operator', () => {
    expect(MAINNET.sorobanRpcUrls.length).toBeGreaterThan(1);
    // rpc.lightsail.network and mainnet.sorobanrpc.com are the same operator;
    // a "chain" that shares one operator throughout fails as one unit.
    const hosts = MAINNET.sorobanRpcUrls.map((url) => new URL(url).hostname);
    const registrable = new Set(hosts.map((h) => h.split('.').slice(-2).join('.')));
    expect(registrable.size).toBeGreaterThan(1);
  });

  it('leads with the endpoint the operator actually advertises today', () => {
    // sorobanrpc.com's own homepage now points only at rpc.lightsail.network
    // (checked 2026-08-17); the older hostname stays one slot behind it.
    expect(MAINNET.sorobanRpcUrls[0]).toBe('https://rpc.lightsail.network');
    expect(MAINNET.sorobanRpcUrls).toContain('https://mainnet.sorobanrpc.com');
  });

  it('leads with SDF on testnet', () => {
    expect(TESTNET.sorobanRpcUrls[0]).toBe('https://soroban-testnet.stellar.org');
    expect(TESTNET.sorobanRpcUrls.length).toBeGreaterThan(1);
  });

  it('keeps `sorobanRpcUrl` pinned to the head of the chain', () => {
    for (const net of [MAINNET, TESTNET]) {
      expect(net.sorobanRpcUrl).toBe(net.sorobanRpcUrls[0]);
    }
  });

  it('uses https everywhere and never embeds a credential', () => {
    for (const net of [MAINNET, TESTNET]) {
      for (const url of net.sorobanRpcUrls) {
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        // A path, query or userinfo is where an API key would hide.
        expect(parsed.pathname).toBe('/');
        expect(parsed.search).toBe('');
        expect(parsed.username).toBe('');
      }
    }
  });

  it('tries the endpoints in the declared order', () => {
    expect(orderedEndpoints(MAINNET)).toEqual([...MAINNET.sorobanRpcUrls]);
  });
});

/* -------------------------------------------------- 2. the user's endpoint */

describe('a user-configured endpoint takes precedence', () => {
  it('is tried before the built-in chain', () => {
    const net = resolveNetwork('mainnet', undefined, ALCHEMY);
    expect(net.sorobanRpcUrls[0]).toBe(ALCHEMY);
    expect(net.sorobanRpcUrl).toBe(ALCHEMY);
    // ... and does not *replace* the chain: a typo or an expired key must
    // degrade to the public endpoints, not take Soroban down.
    expect([...net.sorobanRpcUrls]).toEqual([ALCHEMY, ...MAINNET.sorobanRpcUrls]);
    expect(orderedEndpoints(net)[0]).toBe(ALCHEMY);
  });

  it('is reached first by the broker, before any fallback', async () => {
    const net = resolveNetwork('mainnet', undefined, ALCHEMY);
    const seen: string[] = [];
    await withSorobanEndpoint(net, async (_server, endpoint) => {
      seen.push(endpoint);
      return 'ok';
    });
    expect(seen).toEqual([ALCHEMY]);
  });

  it('applies to testnet too, and is not duplicated if already in the chain', () => {
    expect(resolveNetwork('testnet', undefined, ALCHEMY).sorobanRpcUrls[0]).toBe(ALCHEMY);
    const already = resolveNetwork('testnet', undefined, TESTNET.sorobanRpcUrls[0]);
    expect([...already.sorobanRpcUrls]).toEqual([...TESTNET.sorobanRpcUrls]);
  });

  it('is a no-op when unset', () => {
    expect(resolveNetwork('mainnet', undefined, null)).toEqual(MAINNET);
    expect(resolveNetwork('mainnet')).toEqual(MAINNET);
  });

  it('is included in the host permissions the settings screen requests', () => {
    const origins = allOriginsForNetwork('mainnet', undefined, ALCHEMY);
    expect(origins).toContain(`${new URL(ALCHEMY).origin}/*`);
    for (const url of MAINNET.sorobanRpcUrls) {
      expect(origins).toContain(`${new URL(url).origin}/*`);
    }
    // The install-time/minimum set stays the primary endpoints only, so a
    // fresh install does not demand access to four RPC providers up front.
    expect(originsForNetwork('mainnet')).toHaveLength(2);
  });
});

/* ------------------------------------------------- 3. transport vs. reason */

describe('failover happens on transport failures only', () => {
  const cases: Array<[string, unknown]> = [
    ['HTTP 500', httpError(500)],
    ['HTTP 502', httpError(502)],
    ['HTTP 503', httpError(503)],
    ['HTTP 429 (rate limited)', httpError(429)],
    ['HTTP 408', httpError(408)],
    ['a fetch-level failure', new TypeError('Failed to fetch')],
    ['DNS failure', new Error('getaddrinfo ENOTFOUND rpc.example')],
    ['a connection reset', new Error('socket hang up')],
    ['the SDK timeout', Object.assign(new Error('Timeout'), { name: 'TimeoutError' })],
    ['a non-JSON answer (proxy error page)', new SyntaxError('Unexpected token < in JSON')],
  ];

  it.each(cases)('classifies %s as transport', (_label, err) => {
    expect(isTransportFailure(err)).toBe(true);
  });

  const reasoned: Array<[string, unknown]> = [
    ['HTTP 400', httpError(400)],
    ['HTTP 404', httpError(404)],
    ['a JSON-RPC error object', jsonRpcError(-32602, 'invalid parameters')],
    ['an unrecognised error', new Error('something we cannot place')],
  ];

  it.each(reasoned)('does NOT classify %s as transport', (_label, err) => {
    expect(isTransportFailure(err)).toBe(false);
  });

  it('walks the whole chain while endpoints fail on transport', async () => {
    const seen: string[] = [];
    const result = await withSorobanEndpoint(MAINNET, async (_server, endpoint) => {
      seen.push(endpoint);
      if (seen.length < 3) throw httpError(503);
      return 'answered';
    });
    expect(result).toBe('answered');
    expect(seen).toEqual(MAINNET.sorobanRpcUrls.slice(0, 3));
  });

  it('stops at the first endpoint on a reasoned failure', async () => {
    const seen: string[] = [];
    await expect(
      withSorobanEndpoint(MAINNET, async (_server, endpoint) => {
        seen.push(endpoint);
        throw jsonRpcError(-32602, 'invalid parameters');
      }),
    ).rejects.toBeInstanceOf(AppError);
    // The point of the whole exercise: one endpoint, one answer, no triple wait.
    expect(seen).toEqual([MAINNET.sorobanRpcUrls[0]]);
  });

  it('reports NETWORK_ERROR once every endpoint has failed on transport', async () => {
    const seen: string[] = [];
    const failure = await withSorobanEndpoint(MAINNET, async (_server, endpoint) => {
      seen.push(endpoint);
      throw httpError(502);
    }).catch((err: unknown) => err);
    expect(seen).toEqual([...MAINNET.sorobanRpcUrls]);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('NETWORK_ERROR');
  });

  it('keeps every failure inside the existing wire code space', async () => {
    // No new error code may appear without an i18n entry (§6). Everything this
    // module raises is NETWORK_ERROR.
    const err = await withSorobanEndpoint(MAINNET, async () => {
      throw httpError(500);
    }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('NETWORK_ERROR');
  });
});

/* ------------------------------------------------------- 4. sticky choice */

describe('the working endpoint is remembered, but not forever', () => {
  it('prefers the endpoint that last answered', async () => {
    await withSorobanEndpoint(MAINNET, async (_server, endpoint) => {
      if (endpoint === MAINNET.sorobanRpcUrls[0]) throw httpError(503);
      return 'ok';
    });
    expect(orderedEndpoints(MAINNET)[0]).toBe(MAINNET.sorobanRpcUrls[1]);

    const seen: string[] = [];
    await withSorobanEndpoint(MAINNET, async (_server, endpoint) => {
      seen.push(endpoint);
      return 'ok';
    });
    expect(seen).toEqual([MAINNET.sorobanRpcUrls[1]]);
  });

  it('lets the preference expire so the primary gets another chance', async () => {
    await withSorobanEndpoint(MAINNET, async (_server, endpoint) => {
      if (endpoint === MAINNET.sorobanRpcUrls[0]) throw httpError(503);
      return 'ok';
    });
    const later = Date.now() + SOROBAN_STICKY_MS + 1;
    expect(orderedEndpoints(MAINNET, later)).toEqual([...MAINNET.sorobanRpcUrls]);
  });

  it('drops the preference when that endpoint fails again', async () => {
    await withSorobanEndpoint(MAINNET, async (_server, endpoint) =>
      endpoint === MAINNET.sorobanRpcUrls[0] ? Promise.reject(httpError(503)) : 'ok',
    );
    expect(orderedEndpoints(MAINNET)[0]).toBe(MAINNET.sorobanRpcUrls[1]);
    await withSorobanEndpoint(MAINNET, async (_server, endpoint) =>
      endpoint === MAINNET.sorobanRpcUrls[1] ? Promise.reject(httpError(503)) : 'ok',
    );
    expect(orderedEndpoints(MAINNET)[0]).not.toBe(MAINNET.sorobanRpcUrls[1]);
  });

  it('never carries a preference from one chain to another', async () => {
    const withOverride = resolveNetwork('mainnet', undefined, ALCHEMY);
    await withSorobanEndpoint(MAINNET, async () => 'ok');
    // Different chain -> different key: the override is still tried first.
    expect(orderedEndpoints(withOverride)[0]).toBe(ALCHEMY);
  });
});

/* ------------------------------------------------------------ 5. timeouts */

describe('a hanging endpoint cannot block tx.build', () => {
  it('gives up and moves on instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const pending = withSorobanEndpoint(TESTNET, async (_server, endpoint) => {
        seen.push(endpoint);
        if (endpoint === TESTNET.sorobanRpcUrls[0]) {
          // A black hole: connection accepted, no answer, ever.
          return new Promise<string>(() => {});
        }
        return 'ok';
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe('ok');
      expect(seen[0]).toBe(TESTNET.sorobanRpcUrls[0]);
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* --------------------------------------------------------- 6. no key leak */

describe('the API key never leaves the device', () => {
  it('is redacted out of error details, origin kept', () => {
    const message = `Request to ${ALCHEMY} failed with status code 500`;
    const redacted = redactEndpoints(message);
    expect(redacted).not.toContain('super-secret-key');
    expect(redacted).toContain('https://stellar-mainnet.g.alchemy.com');
  });

  it('is redacted out of anything the broker throws', async () => {
    const err = await withSorobanEndpoint(TESTNET, async () => {
      throw new Error(`connect ECONNREFUSED ${ALCHEMY}`);
    }).catch((e: unknown) => e);
    expect(JSON.stringify((err as AppError).toWire())).not.toContain('super-secret-key');
  });

  it('is not echoed back when the protocol rejects it', () => {
    const parse = (): unknown =>
      rpcSchemas['settings.set'].params.parse({
        patch: { sorobanRpcOverride: 'http://stellar-mainnet.g.alchemy.com/v2/super-secret-key' },
      });
    expect(parse).toThrow();
    let raised: unknown;
    try {
      parse();
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(AppError);
    expect((raised as AppError).code).toBe('BAD_REQUEST');
    expect((raised as AppError).message).not.toContain('super-secret-key');
  });
});

/* ------------------------------------------------------- 7. input control */

describe('endpoint validation', () => {
  it('rejects http:', () => {
    expect(checkSorobanEndpoint('http://stellar-mainnet.g.alchemy.com/v2/k')).toBe('not-https');
    expect(settingsSchema.shape.sorobanRpcOverride.safeParse('http://example.org').success).toBe(
      false,
    );
    expect(() =>
      rpcSchemas['settings.set'].params.parse({
        patch: { sorobanRpcOverride: 'http://stellar-mainnet.g.alchemy.com/v2/k' },
      }),
    ).toThrow(AppError);
  });

  it('rejects anything that is not a URL', () => {
    expect(checkSorobanEndpoint('not a url')).toBe('not-a-url');
    expect(checkSorobanEndpoint('')).toBe('not-a-url');
  });

  it('rejects a host the packaged CSP cannot reach', () => {
    // MV3 fixes `connect-src` at package time: storing this would produce a
    // swap that dies with a CSP violation the user never sees.
    expect(checkSorobanEndpoint('https://rpc.attacker.example/v2/k')).toBe('not-in-csp');
    expect(() =>
      rpcSchemas['settings.set'].params.parse({
        patch: { sorobanRpcOverride: 'https://rpc.attacker.example' },
      }),
    ).toThrow(AppError);
  });

  it('accepts the Alchemy endpoints the owner has, key and all', () => {
    expect(checkSorobanEndpoint(ALCHEMY)).toBeNull();
    expect(checkSorobanEndpoint('https://stellar-testnet.g.alchemy.com/v2/k')).toBeNull();
    expect(
      rpcSchemas['settings.set'].params.parse({ patch: { sorobanRpcOverride: ALCHEMY } }),
    ).toEqual({ patch: { sorobanRpcOverride: ALCHEMY } });
  });

  it('accepts clearing the endpoint', () => {
    expect(
      rpcSchemas['settings.set'].params.parse({ patch: { sorobanRpcOverride: null } }),
    ).toEqual({ patch: { sorobanRpcOverride: null } });
    // An empty field means "remove", not "store an empty string".
    expect(
      rpcSchemas['settings.set'].params.parse({ patch: { sorobanRpcOverride: '' } }),
    ).toEqual({ patch: { sorobanRpcOverride: null } });
  });

  it('lists every built-in endpoint plus Alchemy as CSP-reachable', () => {
    for (const url of [...MAINNET.sorobanRpcUrls, ...TESTNET.sorobanRpcUrls]) {
      expect(checkSorobanEndpoint(url)).toBeNull();
    }
    for (const origin of ALCHEMY_SOROBAN_ORIGINS) {
      expect(CSP_SOROBAN_ORIGINS).toContain(origin);
    }
  });

  it('defaults to no override on a fresh install', () => {
    expect(DEFAULT_SETTINGS.sorobanRpcOverride).toBeNull();
    expect(mergeSettings(DEFAULT_SETTINGS, {}).sorobanRpcOverride).toBeNull();
  });
});

/* ------------------------------------- 8. custom network + public passphrase */

describe('a "custom" network carrying the public passphrase is mainnet', () => {
  const publicCustom = {
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://rpc.lightsail.network',
  };

  it('is flagged as mainnet by resolveNetwork', () => {
    const net: NetworkConfig = resolveNetwork('custom', publicCustom);
    expect(net.isMainnet).toBe(true);
    // ... while a genuinely custom passphrase is not.
    expect(
      resolveNetwork('custom', { ...publicCustom, passphrase: 'Some Private Net ; 2026' })
        .isMainnet,
    ).toBe(false);
  });

  it('is blocked by the same gate as networkId=mainnet', () => {
    const s = settings({
      mode: 'developer',
      networkId: 'custom',
      customNetwork: publicCustom,
      mainnetAcknowledged: false,
    });
    // Without the typed confirmation this must fall back, exactly like
    // networkId=mainnet does; a hand-edited or replicated storage.sync record
    // used to walk straight past the gate here.
    expect(effectiveNetworkId(s)).toBe('testnet');
    expect(isMainnetActive(s)).toBe(false);
  });

  it('is allowed once the gate has been passed, and then warns', () => {
    const s = settings({
      mode: 'developer',
      networkId: 'custom',
      customNetwork: publicCustom,
      mainnetAcknowledged: true,
    });
    expect(effectiveNetworkId(s)).toBe('custom');
    // The badge and the warning banner both hang off this.
    expect(isMainnetActive(s)).toBe(true);
  });

  it('still falls back for a beginner, acknowledged or not', () => {
    for (const acknowledged of [false, true]) {
      expect(
        effectiveNetworkId(
          settings({
            mode: 'beginner',
            networkId: 'custom',
            customNetwork: publicCustom,
            mainnetAcknowledged: acknowledged,
          }),
        ),
      ).toBe('testnet');
    }
  });

  it('does not disturb a non-public custom network', () => {
    const s = settings({
      mode: 'developer',
      networkId: 'custom',
      customNetwork: { ...publicCustom, passphrase: 'Some Private Net ; 2026' },
    });
    expect(effectiveNetworkId(s)).toBe('custom');
    expect(isMainnetActive(s)).toBe(false);
  });

  it('survives a round trip through the settings schema', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      mode: 'developer',
      networkId: 'custom',
      customNetwork: publicCustom,
    });
    expect(effectiveNetworkId(merged)).toBe('testnet');
    expect(effectiveNetworkId({ ...merged, mainnetAcknowledged: true })).toBe('custom');
  });
});
