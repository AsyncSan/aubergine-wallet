/**
 * Lightweight password-strength estimation for the onboarding password step.
 *
 * Deliberately NOT zxcvbn: pulling ~400 kB of dictionaries into a wallet
 * bundle is its own supply-chain and size cost, and the popup only needs a
 * calibrated "is this worth protecting a seed phrase with?" answer. The
 * estimate is entropy-based with the three cheats that dominate real user
 * passwords taken away first: known common passwords, keyboard/alphabet
 * sequences, and repetition.
 *
 * Threat calibration: the keystore blob in `storage.local` can be taken and
 * ground offline against Argon2id (~0.5 s/guess on the owner's hardware, less
 * on an attacker's GPU farm). The KDF buys roughly 15–20 bits; the password
 * has to contribute the rest, which is why the create flow requires
 * {@link MIN_PASSWORD_SCORE} rather than only the 8-character floor.
 */

export interface PasswordStrength {
  /** 0 = trivially guessable … 4 = strong. */
  readonly score: 0 | 1 | 2 | 3 | 4;
  /** The entropy estimate the score was derived from. */
  readonly entropyBits: number;
}

/** The score `wallet.create` / import asks for before enabling the button. */
export const MIN_PASSWORD_SCORE = 2;

/**
 * The head of every real-world breach list, plus wallet-context words a user
 * of *this* product plausibly reaches for. Matched against the lowercased
 * password with trailing digits/symbols stripped, so `Password123!` and
 * `stellar2026` land here too.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'passwort', 'passwort1', 'password1', 'letmein', 'welcome',
  'admin', 'qwerty', 'qwertz', 'dragon', 'monkey', 'master', 'shadow',
  'superman', 'batman', 'trustno1', 'iloveyou', 'sunshine', 'princess',
  'football', 'baseball', 'soccer', 'hallo', 'geheim', 'secret', 'schatz',
  'aubergine', 'stellar', 'wallet', 'crypto', 'bitcoin', 'lumen', 'mnemonic',
  'seedphrase', 'blockchain', 'testnet', 'mainnet',
]);

/**
 * Alphabets a run can walk along in either direction. Both German and US
 * keyboard rows, because the UI ships in both locales.
 */
const SEQUENCE_ALPHABETS = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'qwertzuiop',
  'asdfghjkl',
  'zxcvbnm',
  'yxcvbnm',
];

/** True when `b` continues a run from `a`: same char, or adjacent in a row. */
function continuesSequence(a: string, b: string): boolean {
  if (a === b) return true;
  for (const alphabet of SEQUENCE_ALPHABETS) {
    const i = alphabet.indexOf(a);
    if (i === -1) continue;
    const j = alphabet.indexOf(b);
    if (j !== -1 && Math.abs(i - j) === 1) return true;
  }
  return false;
}

/** `abcabcabc` etc. carry the entropy of one block, not of the whole string. */
function shortestRepeatedBlockLength(password: string): number {
  for (let block = 1; block <= password.length / 2; block += 1) {
    if (password.length % block !== 0) continue;
    const candidate = password.slice(0, block);
    if (candidate.repeat(password.length / block) === password) return block;
  }
  return password.length;
}

export function estimatePasswordStrength(password: string): PasswordStrength {
  if (password.length === 0) return { score: 0, entropyBits: 0 };

  const lower = password.toLowerCase();
  const core = lower.replace(/[^a-zäöüß]+$/u, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(core)) {
    return { score: 0, entropyBits: 0 };
  }

  // Character pool from the classes actually used.
  let pool = 0;
  if (/[a-z]/u.test(password)) pool += 26;
  if (/[A-Z]/u.test(password)) pool += 26;
  if (/\d/u.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/u.test(password)) pool += 33;

  // Effective length: a character that merely continues a sequence or a repeat
  // ("aaaa", "abcd", "1234", "qwertz") adds far less than a fresh choice.
  const effective = shortestRepeatedBlockLength(password);
  let effectiveLength = 1;
  for (let i = 1; i < effective; i += 1) {
    const prev = lower[i - 1] as string;
    const curr = lower[i] as string;
    effectiveLength += continuesSequence(prev, curr) ? 0.4 : 1;
  }

  const entropyBits = effectiveLength * Math.log2(Math.max(pool, 2));

  let score: PasswordStrength['score'];
  if (entropyBits < 28) score = 0;
  else if (entropyBits < 36) score = 1;
  else if (entropyBits < 48) score = 2;
  else if (entropyBits < 60) score = 3;
  else score = 4;
  return { score, entropyBits };
}
