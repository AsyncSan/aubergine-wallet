/**
 * The v1.2 Mainnet gate and the network-scoped curated asset list.
 *
 * Two things are worth locking down with tests, because both are the kind of
 * mistake that only shows up when real money is involved:
 *
 * 1. `effectiveNetworkId` must be fail-closed. Every path that could put a user
 *    on Mainnet without the typed confirmation; a plain `settings.set`, a
 *    restored backup, a mode switch, has to land on Testnet instead.
 * 2. The curated list must follow the network. Before v1.2 it did not, so a
 *    Mainnet user was offered Circle's *Testnet* issuer in "add asset".
 */
import { describe, expect, it } from 'vitest';
import {
  BEGINNER_NETWORK_IDS,
  DEFAULT_SETTINGS,
  effectiveNetworkId,
  isMainnetActive,
  mergeSettings,
  type Settings,
} from '../src/core/settings';
import {
  CURATED_MAINNET_ASSETS,
  CURATED_MAINNET_HOME_DOMAINS,
  CURATED_TESTNET_ASSETS,
  curatedAssetsFor,
  MAINNET,
  originsForNetwork,
} from '../src/core/stellar/networks';
import { StrKey } from '@stellar/stellar-sdk';

function settings(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('mainnet gate (effectiveNetworkId)', () => {
  it('defaults to testnet on a fresh install', () => {
    expect(effectiveNetworkId(DEFAULT_SETTINGS)).toBe('testnet');
    expect(isMainnetActive(DEFAULT_SETTINGS)).toBe(false);
    expect(DEFAULT_SETTINGS.mainnetAcknowledged).toBe(false);
  });

  it('ignores networkId=mainnet without the acknowledgement, in BOTH modes', () => {
    expect(effectiveNetworkId(settings({ networkId: 'mainnet' }))).toBe('testnet');
    expect(
      effectiveNetworkId(settings({ networkId: 'mainnet', mode: 'developer' })),
    ).toBe('testnet');
  });

  it('lets a beginner onto mainnet once acknowledged', () => {
    const s = settings({ networkId: 'mainnet', mainnetAcknowledged: true });
    expect(effectiveNetworkId(s)).toBe('mainnet');
    expect(isMainnetActive(s)).toBe(true);
  });

  it('keeps mainnet when developer mode is switched off', () => {
    const dev = settings({
      mode: 'developer',
      networkId: 'mainnet',
      mainnetAcknowledged: true,
    });
    expect(effectiveNetworkId({ ...dev, mode: 'beginner' })).toBe('mainnet');
  });

  it('pins beginners to testnet for developer-only networks', () => {
    expect(effectiveNetworkId(settings({ networkId: 'futurenet' }))).toBe('testnet');
    expect(
      effectiveNetworkId(
        settings({
          networkId: 'custom',
          customNetwork: {
            passphrase: 'x',
            horizonUrl: 'https://example.org',
            sorobanRpcUrl: 'https://example.org',
          },
        }),
      ),
    ).toBe('testnet');
    // ... while a developer still gets what they picked.
    expect(effectiveNetworkId(settings({ mode: 'developer', networkId: 'futurenet' }))).toBe(
      'futurenet',
    );
  });

  it('offers beginners exactly testnet and mainnet', () => {
    expect([...BEGINNER_NETWORK_IDS]).toEqual(['testnet', 'mainnet']);
  });

  it('survives a round trip through the settings schema', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      networkId: 'mainnet',
      mainnetAcknowledged: true,
    });
    expect(effectiveNetworkId(merged)).toBe('mainnet');
    // Revoking the acknowledgement alone is enough to fall back.
    expect(effectiveNetworkId(mergeSettings(merged, { mainnetAcknowledged: false }))).toBe(
      'testnet',
    );
  });
});

describe('curated assets follow the network', () => {
  it('serves the testnet list on testnet and the mainnet list on mainnet', () => {
    expect(curatedAssetsFor('testnet')).toEqual(CURATED_TESTNET_ASSETS);
    expect(curatedAssetsFor('mainnet')).toEqual(CURATED_MAINNET_ASSETS);
  });

  it('never mixes the two lists', () => {
    const testnetIssuers = new Set(CURATED_TESTNET_ASSETS.map((a) => a.issuer));
    for (const asset of CURATED_MAINNET_ASSETS) {
      expect(testnetIssuers.has(asset.issuer)).toBe(false);
    }
  });

  it('offers nothing on futurenet or a custom endpoint', () => {
    expect(curatedAssetsFor('futurenet')).toHaveLength(0);
    expect(curatedAssetsFor('custom')).toHaveLength(0);
  });

  it('has well-formed mainnet issuers with a declared home_domain', () => {
    expect(CURATED_MAINNET_ASSETS.length).toBeGreaterThan(0);
    for (const asset of CURATED_MAINNET_ASSETS) {
      expect(StrKey.isValidEd25519PublicKey(asset.issuer)).toBe(true);
      expect(/^[A-Z0-9]{1,12}$/u.test(asset.code)).toBe(true);
      // Every curated mainnet issuer must be checkable by the live run.
      expect(CURATED_MAINNET_HOME_DOMAINS[asset.issuer]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('mainnet host origins', () => {
  it('are not granted at install time and cover horizon + soroban rpc', () => {
    const origins = originsForNetwork('mainnet');
    expect(origins).toContain(`${new URL(MAINNET.horizonUrl).origin}/*`);
    expect(origins).toContain(`${new URL(MAINNET.sorobanRpcUrl).origin}/*`);
    // No friendbot on mainnet, nothing to ask for.
    expect(origins).toHaveLength(2);
  });
});
