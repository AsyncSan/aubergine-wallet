/**
 * Packaging contract for the two store artefacts.
 *
 * These four things are invisible in unit tests of the domain logic but decide
 * whether the extension can be published at all, and one of them is a security
 * property:
 *
 *  - **Icons.** Neither manifest had an `icons` block or `action.default_icon`,
 *    so the toolbar showed the browser's generic placeholder, for a wallet
 *    that means a copycat extension is visually indistinguishable, and the
 *    dApp badge painted in `src/background/dapp.ts` sits on nothing. Chrome
 *    Web Store additionally requires a 128x128.
 *  - **`use_dynamic_url`.** `inject.js` is web-accessible to every http(s)
 *    origin. Without a dynamic URL any site can fetch it under the published
 *    (fixed) extension id and fingerprint the wallet, including beginner-mode
 *    users, who never register a content script at all (invariant 7).
 *  - **The gecko id** is permanent after the first AMO upload and must not be
 *    an IANA-reserved documentation domain.
 *  - **The AMO sources zip** must let a reviewer reproduce the build *and* run
 *    `npm test`, without shipping Playwright output or a `.env.local`.
 */
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { glob } from 'tinyglobby';
import { describe, expect, it } from 'vitest';
import config from '../wxt.config';
import { DAPP_CONNECTOR_ORIGINS } from '../src/core/stellar/networks';

const ROOT = join(__dirname, '..');

type GeneratedManifest = {
  version?: string;
  minimum_chrome_version?: string;
  icons?: Record<string, string>;
  action?: { default_icon?: Record<string, string>; default_title?: string };
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
  optional_host_permissions?: string[];
  host_permissions?: string[];
  web_accessible_resources?: {
    resources: string[];
    matches: string[];
    use_dynamic_url?: boolean;
  }[];
};

type ManifestFn = (env: {
  browser: string;
  manifestVersion: 3;
  command: 'build';
}) => GeneratedManifest;

function manifestFor(browser: string): GeneratedManifest {
  return (config.manifest as unknown as ManifestFn)({
    browser,
    manifestVersion: 3,
    command: 'build',
  });
}

/** Read a PNG's real pixel dimensions out of its IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 8).toString('hex'), `${path} is not a PNG`).toBe('89504e470d0a1a0a');
  expect(buf.subarray(12, 16).toString('ascii'), `${path} has no IHDR`).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const REQUIRED_ICON_SIZES = [16, 32, 48, 128] as const;

describe('icons', () => {
  it.each(REQUIRED_ICON_SIZES)('ships a real %ipx PNG in public/icon', (size) => {
    const path = join(ROOT, 'public', 'icon', `${size}.png`);
    expect(existsSync(path), `${path} is missing`).toBe(true);
    expect(pngSize(path)).toEqual({ width: size, height: size });
  });

  it('wires every size into action.default_icon', () => {
    for (const browser of ['chrome', 'firefox']) {
      const icon = manifestFor(browser).action?.default_icon;
      expect(icon, `${browser}: action.default_icon missing`).toBeDefined();
      for (const size of REQUIRED_ICON_SIZES) {
        expect(icon?.[String(size)]).toBe(`icon/${size}.png`);
      }
    }
  });

  it('emits an icons block and the files into both build outputs', () => {
    for (const dir of builtManifests()) {
      const { manifest, path } = dir;
      expect(manifest.icons, `${path}: no top-level icons block`).toBeDefined();
      expect(manifest.action?.default_icon, `${path}: no action.default_icon`).toBeDefined();
      // Chrome Web Store requires a 128x128 store icon.
      expect(Object.keys(manifest.icons ?? {})).toContain('128');
      for (const file of Object.values(manifest.icons ?? {})) {
        const onDisk = join(dirname(path), file);
        expect(existsSync(onDisk), `${path} points at missing ${file}`).toBe(true);
      }
      for (const file of Object.values(manifest.action?.default_icon ?? {})) {
        expect(existsSync(join(dirname(path), file)), `missing ${file}`).toBe(true);
      }
    }
  });
});

describe('web_accessible_resources', () => {
  it('hides inject.js behind a dynamic URL on Chrome', () => {
    const war = manifestFor('chrome').web_accessible_resources ?? [];
    const entry = war.find((r) => r.resources.includes('inject.js'));
    expect(entry, 'inject.js is not web-accessible; the dApp provider cannot load').toBeDefined();
    expect(entry?.use_dynamic_url, 'any site can probe inject.js and fingerprint the wallet').toBe(
      true,
    );
    // The content script still needs page access to inject the provider, but
    // only on the origins it can actually run on.
    expect(entry?.matches).toEqual([...DAPP_CONNECTOR_ORIGINS]);
  });

  it('omits the Chrome-only key on Firefox, which randomises the origin anyway', () => {
    const entry = (manifestFor('firefox').web_accessible_resources ?? []).find((r) =>
      r.resources.includes('inject.js'),
    );
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('use_dynamic_url');
  });

  it('keeps what was actually generated in sync', () => {
    for (const { manifest, path } of builtManifests()) {
      const entry = (manifest.web_accessible_resources ?? []).find((r) =>
        r.resources.includes('inject.js'),
      );
      expect(entry, `${path}: inject.js is not web-accessible`).toBeDefined();
      if (path.includes('chrome')) expect(entry?.use_dynamic_url).toBe(true);
    }
  });
});

describe('dApp connector host access', () => {
  /**
   * The three lists have to agree or the feature breaks in a way no unit test
   * of the domain logic would notice: `chrome.permissions.request()` rejects a
   * pattern that is not in `optional_host_permissions`, and `inject.js` is
   * unreachable from an origin missing from `web_accessible_resources`.
   */
  it.each(['chrome', 'firefox'])(
    'offers exactly the patterns the connector requests (%s)',
    (browser) => {
      const manifest = manifestFor(browser);
      for (const pattern of DAPP_CONNECTOR_ORIGINS) {
        expect(
          manifest.optional_host_permissions ?? [],
          `permissions.request() would be rejected for ${pattern}`,
        ).toContain(pattern);
      }
      const entry = (manifest.web_accessible_resources ?? []).find((r) =>
        r.resources.includes('inject.js'),
      );
      expect(entry?.matches).toEqual([...DAPP_CONNECTOR_ORIGINS]);
    },
  );

  /**
   * The finding this replaces: `http://*` was granted alongside `https://*`.
   * On a plaintext page an attacker on the network path writes the page, so
   * they can call `signTransaction`, and the confirmation prompt is then the
   * only remaining defence. Loopback is exempt — owning it means owning the
   * machine — and the e2e dApp is served from 127.0.0.1.
   */
  it.each(['chrome', 'firefox'])('never asks for plaintext http beyond loopback (%s)', (browser) => {
    const manifest = manifestFor(browser);
    const patterns = [
      ...(manifest.host_permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
      ...(manifest.web_accessible_resources ?? []).flatMap((r) => r.matches),
    ];
    const loopback = /^http:\/\/(localhost|127\.0\.0\.1)\//u;
    for (const pattern of patterns) {
      if (!pattern.startsWith('http://')) continue;
      expect(pattern, `${pattern} exposes the provider to a plaintext origin`).toMatch(loopback);
    }
  });
});

describe('browser_specific_settings.gecko strict_min_version', () => {
  /**
   * `data_collection_permissions` is understood by Firefox Desktop from 140
   * but by Firefox for Android only from 142. With 140 here, addons-linter
   * raises KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION on every upload.
   */
  it('is at least 142, the Android floor for the data collection declaration', () => {
    const gecko = manifestFor('firefox').browser_specific_settings?.gecko;
    const version = gecko?.strict_min_version;
    expect(version, 'no strict_min_version; AMO cannot tell what we support').toBeDefined();
    const major = Number.parseInt((version ?? '0').split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(142);
  });

  it('is absent on Chrome, which has no gecko block at all', () => {
    expect(manifestFor('chrome').browser_specific_settings).toBeUndefined();
  });
});

describe('browser_specific_settings.gecko.id', () => {
  const RESERVED = /@(.+\.)?(example\.(com|org|net)|test|invalid|localhost|example)$/u;

  it('is the real product domain, not a documentation placeholder', () => {
    const id = manifestFor('firefox').browser_specific_settings?.gecko?.id;
    expect(id).toBe('wallet@aubergine.tech');
    // Permanent after the first AMO upload: a reserved domain can never be
    // verified and cannot be changed later without losing the listing.
    expect(id).not.toMatch(RESERVED);
  });

  it('is not emitted for Chrome', () => {
    expect(manifestFor('chrome').browser_specific_settings).toBeUndefined();
  });
});

/** The single source of truth for the version, as npm and WXT both read it. */
function pkgVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string })
    .version;
}

/**
 * Two numbers a store reviewer reads and neither unit nor e2e tests can see.
 *
 *  - **The version.** A store version can only ever go up. Publishing 0.x
 *    would mean the listing carries "preview" forever, or a jump that loses
 *    the update path. It also has to match `package.json`, because that is
 *    what `npm run zip` names the artefacts after.
 *  - **`minimum_chrome_version`.** Without it Chrome installs the package on
 *    browsers that cannot parse it: the Vite build targets `chrome110`, so on
 *    Chrome 109 the user gets a wallet that fails at load with a syntax error
 *    rather than a message saying the browser is too old.
 */
describe('version and minimum browser', () => {
  it('matches package.json in both artefacts', () => {
    for (const browser of ['chrome', 'firefox']) {
      expect(manifestFor(browser).version, `${browser} manifest version drifted`).toBe(
        pkgVersion(),
      );
    }
  });

  it('is at least 1.0.0; the store never takes a version back down', () => {
    const major = Number.parseInt(pkgVersion().split('.')[0] ?? '0', 10);
    expect(major, `version ${pkgVersion()} still reads as a preview`).toBeGreaterThanOrEqual(1);
  });

  it('declares minimum_chrome_version, and not below the Vite build target', () => {
    const declared = manifestFor('chrome').minimum_chrome_version;
    expect(
      declared,
      'no minimum_chrome_version; Chrome would install on browsers the build broke',
    ).toBeDefined();

    // `vite.build.target` is the only place that says which syntax we emit.
    // Reading it here is what turns the manifest number into a checked claim
    // instead of a comment: raise the target and this test goes red.
    const viteConfig = (config.vite as unknown as () => { build?: { target?: string } })();
    const target = viteConfig.build?.target ?? '';
    const targeted = Number.parseInt(target.replace(/^chrome/u, ''), 10);
    expect(targeted, `build target ${target} is not a chrome<N> target`).toBeGreaterThan(0);
    expect(Number.parseInt(declared ?? '0', 10)).toBeGreaterThanOrEqual(targeted);
  });

  it('does not put minimum_chrome_version into the Firefox manifest', () => {
    expect(manifestFor('firefox').minimum_chrome_version).toBeUndefined();
  });
});

/**
 * WXT merges its own `excludeSources` defaults with ours and offers no way to
 * drop them, so `wxt.config.ts` removes two of them in a `config:resolved`
 * hook. If a WXT upgrade renames those patterns the hook silently stops
 * working and the sources zip loses the test suite again, hence the canary.
 */
describe('AMO sources zip', () => {
  const WXT_TEST_EXCLUDES = ['**/__tests__/**', '**/*.+(test|spec).?(c|m)+(j|t)s?(x)'];
  const WXT_OTHER_DEFAULTS = ['**/node_modules', '**/web-ext.config.ts', '.output/**'];

  it("canary: WXT's hard-coded test exclusions still read as we expect", () => {
    const source = readFileSync(
      join(ROOT, 'node_modules', 'wxt', 'dist', 'core', 'resolve-config.mjs'),
      'utf8',
    );
    for (const pattern of WXT_TEST_EXCLUDES) {
      expect(
        source,
        `WXT no longer excludes ${pattern}; re-check the config:resolved hook in wxt.config.ts`,
      ).toContain(pattern);
    }
  });

  it('the config:resolved hook removes exactly the test exclusions', () => {
    const hook: ((wxt: unknown) => void) | undefined = (
      config.hooks as Record<string, (wxt: unknown) => void>
    )['config:resolved'];
    expect(hook, 'config:resolved hook is gone; the sources zip loses tests/').toBeTypeOf(
      'function',
    );
    if (!hook) return;
    const fake = {
      config: { zip: { excludeSources: [...WXT_OTHER_DEFAULTS, ...WXT_TEST_EXCLUDES] } },
    };
    hook(fake);
    expect(fake.config.zip.excludeSources).toEqual(WXT_OTHER_DEFAULTS);
  });

  it('includes tests and build config, excludes secrets and Playwright output', async () => {
    const exclude = [
      ...WXT_OTHER_DEFAULTS,
      ...WXT_TEST_EXCLUDES,
      ...((config.zip?.excludeSources ?? []) as string[]),
    ].filter((pattern) => !WXT_TEST_EXCLUDES.includes(pattern));

    // A miniature of the repo, so the assertion does not depend on which
    // generated directories happen to exist in this working copy.
    const dir = mkdtempSync(join(tmpdir(), 'sources-zip-'));
    const files = [
      'package.json',
      'wxt.config.ts',
      '.gitignore',
      '.env.example',
      '.env.local',
      '.env.production.local',
      'tests/csp.test.ts',
      'e2e/specs/01-bootstrap.spec.ts',
      'integration/testnet.test.ts',
      'src/core/keyring/keyring.ts',
      'public/icon/128.png',
      'test-results/run/error-context.md',
      'e2e-shots/site/home.png',
      'e2e/screenshots/01-onboarding.png',
      'playwright-report/index.html',
      '.wxt/tsconfig.json',
      '.output/chrome-mv3/manifest.json',
      'node_modules/foo/index.js',
      'aubergine-extension-0.1.0-sources.zip',
    ];
    for (const file of files) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), '');
    }

    const zipped = await glob(['**/*'], {
      cwd: dir,
      ignore: exclude,
      onlyFiles: true,
      dot: config.zip?.dotSources ?? false,
    });
    const sorted = [...zipped].sort();

    // A reviewer must be able to run the suite and read the build config.
    expect(sorted).toEqual([
      '.env.example',
      '.gitignore',
      'e2e/specs/01-bootstrap.spec.ts',
      'integration/testnet.test.ts',
      'package.json',
      'public/icon/128.png',
      'src/core/keyring/keyring.ts',
      'tests/csp.test.ts',
      'wxt.config.ts',
    ]);
  });

  it('the generated sources zip matches that shape', () => {
    // Derived, never hard-coded: with a literal version here the file stops
    // existing after the next version bump and the whole assertion below
    // silently turns into a no-op.
    const zip = join(ROOT, '.output', `aubergine-extension-${pkgVersion()}-sources.zip`);
    if (!existsSync(zip)) return; // only produced by `npm run zip`
    const raw = readFileSync(zip);
    const names = [...raw.toString('latin1').matchAll(/PK\x03\x04[\s\S]{22}/gu)].map((m) => {
      const at = m.index + 26;
      const nameLen = raw.readUInt16LE(at);
      return raw.subarray(at + 4, at + 4 + nameLen).toString('utf8');
    });
    expect(names.some((n) => n.startsWith('tests/') && n.endsWith('.test.ts'))).toBe(true);
    expect(names.some((n) => n.startsWith('e2e/specs/'))).toBe(true);
    expect(names).toContain('.gitignore');
    for (const forbidden of ['test-results/', 'e2e-shots/', 'e2e/screenshots/', 'node_modules/']) {
      expect(
        names.filter((n) => n.startsWith(forbidden)),
        `sources zip still ships ${forbidden}`,
      ).toEqual([]);
    }
    expect(names.filter((n) => n.endsWith('.env.local'))).toEqual([]);
  });
});

function builtManifests(): { manifest: GeneratedManifest; path: string }[] {
  const out: { manifest: GeneratedManifest; path: string }[] = [];
  for (const dir of ['chrome-mv3', 'firefox-mv3']) {
    const path = join(ROOT, '.output', dir, 'manifest.json');
    if (!existsSync(path)) continue;
    out.push({ manifest: JSON.parse(readFileSync(path, 'utf8')) as GeneratedManifest, path });
  }
  return out;
}
