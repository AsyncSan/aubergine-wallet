/**
 * The password-strength estimator that gates wallet creation.
 *
 * The old inline heuristic scored by checkbox ("has an uppercase? +1") and
 * rated `Password1!` as strong. These tests pin the failure modes the
 * estimator exists to catch: breach-list passwords, sequences, repetition,
 * and that the gate threshold sits where the UI copy promises.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_SCORE,
  estimatePasswordStrength,
} from '../src/core/password-strength';

const score = (pw: string): number => estimatePasswordStrength(pw).score;

describe('estimatePasswordStrength', () => {
  it('rates the empty password 0', () => {
    expect(score('')).toBe(0);
  });

  it('rates breach-list passwords 0, including cased/suffixed variants', () => {
    for (const pw of ['password', 'Password123!', 'passwort1', 'qwertz', 'iloveyou']) {
      expect(score(pw), pw).toBe(0);
    }
  });

  it('rates wallet-context words 0; the product name is not a password', () => {
    for (const pw of ['aubergine', 'Aubergine2026', 'stellar', 'seedphrase1']) {
      expect(score(pw), pw).toBe(0);
    }
  });

  it('rates pure sequences and repeats far below the gate', () => {
    for (const pw of ['12345678', 'abcdefgh', 'aaaaaaaa', 'qwertzuiop', 'abcabcabc']) {
      expect(score(pw), pw).toBeLessThan(MIN_PASSWORD_SCORE);
    }
  });

  it('does not let a repeated block masquerade as length', () => {
    // Same 4 characters twice: the entropy of the block, not of 8 chars.
    expect(score('aB3!aB3!')).toBeLessThan(score('aB3!xQ9?'));
  });

  it('passes the gate for reasonable human passwords', () => {
    for (const pw of ['blaue Tasse Kaffee 7', 'Wintergarten#42', 'mango-Turbine-9']) {
      expect(score(pw), pw).toBeGreaterThanOrEqual(MIN_PASSWORD_SCORE);
    }
  });

  it('rates long passphrases as strong', () => {
    expect(score('correct-horse-battery-staple-9')).toBe(4);
    expect(score('vier braune Igel tanzen leise am Ufer')).toBe(4);
  });

  it('is monotone in added entropy for a fixed base', () => {
    const base = estimatePasswordStrength('Wintergarten').entropyBits;
    const more = estimatePasswordStrength('Wintergarten#42').entropyBits;
    expect(more).toBeGreaterThan(base);
  });

  it('keeps the e2e fixture password above the gate', () => {
    // e2e/support/flows.ts drives onboarding with this password; if the gate
    // ever rejects it the whole e2e suite dies at the first screen.
    expect(score('correct-horse-battery-staple-9')).toBeGreaterThanOrEqual(
      MIN_PASSWORD_SCORE,
    );
  });
});
