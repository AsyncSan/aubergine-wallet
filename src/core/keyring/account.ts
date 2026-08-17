/**
 * Account metadata. Deliberately free of any secret material so the whole
 * type can be sent to the popup (ARCHITECTURE.md §3, invariant 1).
 */
import { z } from 'zod';
import { stellarAccountPath } from '../crypto/mnemonic';

export const accountMetaSchema = z.object({
  /** SEP-0005 account index (`m/44'/148'/index'`). */
  index: z.number().int().min(0),
  /** User-chosen label; the UI falls back to an i18n default when empty. */
  label: z.string().max(64),
});

export type AccountMeta = z.infer<typeof accountMetaSchema>;

/** Account as exposed over the RPC boundary: metadata + public key only. */
export interface PublicAccount extends AccountMeta {
  readonly publicKey: string;
  readonly path: string;
}

export function toPublicAccount(meta: AccountMeta, publicKey: string): PublicAccount {
  return { ...meta, publicKey, path: stellarAccountPath(meta.index) };
}

export const vaultSchema = z.object({
  version: z.literal(1),
  /** BIP-39 recovery phrase. Only ever present inside the encrypted blob. */
  mnemonic: z.string().min(1),
  /**
   * Optional BIP-39 passphrase ("25th word"). Part of the derivation, so it
   * must be stored with the phrase; a wallet restored without it derives a
   * completely different, empty set of accounts (finding 7).
   */
  bip39Passphrase: z.string().optional(),
  accounts: z.array(accountMetaSchema).min(1),
});

export type Vault = z.infer<typeof vaultSchema>;
