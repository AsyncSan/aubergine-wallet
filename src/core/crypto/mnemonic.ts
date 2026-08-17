/**
 * BIP-39 recovery phrases and SEP-0005 key derivation (m/44'/148'/i').
 *
 * The BIP-39 word/entropy mapping comes from @scure/bip39 (audited, dependency
 * free, no Node built-ins). Seed stretching and the SLIP-0010 ed25519 chain are
 * done with WebCrypto so the raw material stays in buffers we can zeroize
 * (ARCHITECTURE.md §3, invariant 6). The final account key is handed to the
 * Stellar SDK's `Keypair.fromRawEd25519Seed`.
 */
import { Buffer } from 'buffer';
import {
  generateMnemonic as scureGenerate,
  mnemonicToEntropy,
  validateMnemonic as scureValidate,
} from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { Keypair } from '@stellar/stellar-sdk';
import { zeroize } from './zeroize';

export type MnemonicStrength = 128 | 256;

/** SEP-0005 coin type for Stellar. */
export const STELLAR_COIN_TYPE = 148;
const HARDENED_OFFSET = 0x80000000;
const BIP39_PBKDF2_ITERATIONS = 2048;
const SEED_BITS = 512;

export const ENGLISH_WORDLIST: readonly string[] = englishWordlist;

/** Generate a 12-word (128 bit) or 24-word (256 bit) recovery phrase. */
export function generateMnemonic(strength: MnemonicStrength = 128): string {
  return scureGenerate(englishWordlist, strength);
}

/** Normalise user input: trim, collapse whitespace, lowercase, NFKD. */
export function normalizeMnemonic(input: string): string {
  return input.normalize('NFKD').trim().toLowerCase().split(/\s+/u).join(' ');
}

export function validateMnemonic(mnemonic: string): boolean {
  try {
    return scureValidate(normalizeMnemonic(mnemonic), englishWordlist);
  } catch {
    return false;
  }
}

/**
 * Word count is only valid for 12/15/18/21/24. Used by the import screen to
 * give a precise hint before running the (more expensive) checksum check.
 */
export function mnemonicWordCountValid(mnemonic: string): boolean {
  const words = normalizeMnemonic(mnemonic).split(' ').filter(Boolean).length;
  return [12, 15, 18, 21, 24].includes(words);
}

/** Returns the indexes of words that are not in the BIP-39 English wordlist. */
export function unknownWordIndexes(mnemonic: string): number[] {
  const words = normalizeMnemonic(mnemonic).split(' ').filter(Boolean);
  const out: number[] = [];
  words.forEach((w, i) => {
    if (!englishWordlist.includes(w)) out.push(i);
  });
  return out;
}

/** Exposed so the "verify your phrase" step can check without re-deriving. */
export function mnemonicChecksumBytes(mnemonic: string): Uint8Array {
  return mnemonicToEntropy(normalizeMnemonic(mnemonic), englishWordlist);
}

/**
 * BIP-39 seed: PBKDF2-HMAC-SHA-512, 2048 iterations,
 * salt = "mnemonic" + optional passphrase, both NFKD.
 */
export async function mnemonicToSeed(
  mnemonic: string,
  passphrase = '',
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const pw = enc.encode(normalizeMnemonic(mnemonic));
  const salt = enc.encode(`mnemonic${passphrase.normalize('NFKD')}`);
  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      pw as unknown as BufferSource,
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt as unknown as BufferSource,
        iterations: BIP39_PBKDF2_ITERATIONS,
        hash: 'SHA-512',
      },
      baseKey,
      SEED_BITS,
    );
    return new Uint8Array(bits);
  } finally {
    zeroize(pw, salt);
  }
}

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data as unknown as BufferSource);
  return new Uint8Array(sig);
}

export interface Slip10Node {
  readonly key: Uint8Array;
  readonly chainCode: Uint8Array;
}

const ED25519_CURVE = new TextEncoder().encode('ed25519 seed');

/**
 * SLIP-0010 master node for ed25519.
 * Caller must zeroize `key` and `chainCode`.
 */
export async function slip10MasterFromSeed(seed: Uint8Array): Promise<Slip10Node> {
  const I = await hmacSha512(ED25519_CURVE, seed);
  const node = { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  zeroize(I);
  return node;
}

/**
 * SLIP-0010 hardened child derivation for ed25519.
 * ed25519 supports hardened derivation only, which is exactly what SEP-0005 uses.
 */
export async function slip10DeriveHardened(
  node: Slip10Node,
  index: number,
): Promise<Slip10Node> {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new RangeError(`invalid derivation index: ${index}`);
  }
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(node.key, 1);
  const hardened = (index + HARDENED_OFFSET) >>> 0;
  data[33] = (hardened >>> 24) & 0xff;
  data[34] = (hardened >>> 16) & 0xff;
  data[35] = (hardened >>> 8) & 0xff;
  data[36] = hardened & 0xff;
  const I = await hmacSha512(node.chainCode, data);
  zeroize(data);
  const child = { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  zeroize(I);
  return child;
}

/**
 * Derive along a SEP-0005 style path, e.g. `m/44'/148'/0'`.
 * Only hardened segments are accepted (ed25519 restriction).
 */
export async function derivePath(seed: Uint8Array, path: string): Promise<Slip10Node> {
  const trimmed = path.trim();
  if (!/^m(\/\d+')*$/u.test(trimmed)) {
    throw new Error(`unsupported derivation path (hardened segments only): ${path}`);
  }
  let node = await slip10MasterFromSeed(seed);
  const segments = trimmed.split('/').slice(1);
  for (const segment of segments) {
    const index = Number.parseInt(segment.slice(0, -1), 10);
    const next = await slip10DeriveHardened(node, index);
    zeroize(node.key, node.chainCode);
    node = next;
  }
  return node;
}

export function stellarAccountPath(index: number): string {
  return `m/44'/${STELLAR_COIN_TYPE}'/${index}'`;
}

/**
 * SEP-0005 account key at `m/44'/148'/index'`.
 * Returns a Stellar SDK Keypair, background context only (invariant 1).
 */
export async function deriveStellarKeypair(
  seed: Uint8Array,
  index: number,
): Promise<Keypair> {
  const node = await derivePath(seed, stellarAccountPath(index));
  try {
    return Keypair.fromRawEd25519Seed(Buffer.from(node.key));
  } finally {
    zeroize(node.key, node.chainCode);
  }
}

/** Public key only, safe to hand to the popup. */
export async function deriveStellarPublicKey(
  seed: Uint8Array,
  index: number,
): Promise<string> {
  const kp = await deriveStellarKeypair(seed, index);
  return kp.publicKey();
}
