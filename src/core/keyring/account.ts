/**
 * Account metadata. Deliberately free of any secret material so the whole
 * type can be sent to the popup (ARCHITECTURE.md §3, invariant 1).
 *
 * ## Two key sources, one slot space (vault v2)
 *
 * Until v1 an account *was* its SEP-0005 index: `index` addressed the account
 * everywhere (RPC params, `settings.selectedAccountIndex`) **and** named the
 * derivation path, because every key came from the one seed and could be
 * re-derived at will.
 *
 * A hardware account breaks that identity. Its key lives on the device, cannot
 * be derived here, and its path is chosen on the device's own account ladder —
 * so a seed account and a Ledger account both legitimately sit at
 * `m/44'/148'/0'` and would collide on a single number.
 *
 * v2 therefore splits the two meanings that `index` used to carry:
 *
 *  - `index` is the wallet-wide **slot id**. It is what every existing RPC and
 *    the selected-account setting address, and it never changes for an account
 *    that already exists.
 *  - `derivationIndex` is the **BIP path** position, unique per source.
 *
 * The migration sets `derivationIndex = index` for every v1 account, which is
 * the one property that matters: it is impossible for the upgrade to move a
 * user's funds to a different key.
 */
import { z } from 'zod';
import { stellarAccountPath } from '../crypto/mnemonic';

/** Where an account's signing key lives. */
export const ACCOUNT_SOURCES = ['seed', 'ledger'] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

/**
 * A Stellar public key in strkey form.
 *
 * Checked with a regex rather than the SDK's `StrKey` on purpose: this schema
 * validates the *vault*, which is parsed on every unlock in the background,
 * and a shape check is all that is needed to keep a malformed record out.
 * The authoritative check happens where it counts — `Keypair.fromPublicKey`
 * in the keyring, and `Transaction.addSignature`, which will not attach a
 * signature that does not verify under this key.
 */
export const publicKeyStrkey = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/u, 'not a Stellar public key');

const baseAccountFields = {
  /** Wallet-wide slot id. Stable for the life of the account. */
  index: z.number().int().min(0),
  /** User-chosen label; the UI falls back to an i18n default when empty. */
  label: z.string().max(64),
  /** Position on the BIP-44 path, `m/44'/148'/derivationIndex'`. */
  derivationIndex: z.number().int().min(0),
};

export const seedAccountMetaSchema = z.object({
  ...baseAccountFields,
  source: z.literal('seed'),
});

export const ledgerAccountMetaSchema = z.object({
  ...baseAccountFields,
  source: z.literal('ledger'),
  /**
   * The device's answer for this path, recorded at enrolment.
   *
   * A seed account has no such field because its key is re-derived on every
   * unlock and the derivation is the source of truth. For a Ledger account
   * there is nothing to re-derive without the device plugged in, so the public
   * key has to be stored — and it is then also the thing every later signature
   * is checked against, which is why enrolment verifies it before writing.
   */
  publicKey: publicKeyStrkey,
});

export const accountMetaSchema = z.discriminatedUnion('source', [
  seedAccountMetaSchema,
  ledgerAccountMetaSchema,
]);

export type SeedAccountMeta = z.infer<typeof seedAccountMetaSchema>;
export type LedgerAccountMeta = z.infer<typeof ledgerAccountMetaSchema>;
export type AccountMeta = z.infer<typeof accountMetaSchema>;

/** Account as exposed over the RPC boundary: metadata + public key only. */
export interface PublicAccount {
  readonly index: number;
  readonly label: string;
  readonly source: AccountSource;
  readonly derivationIndex: number;
  readonly publicKey: string;
  readonly path: string;
}

export function toPublicAccount(meta: AccountMeta, publicKey: string): PublicAccount {
  return {
    index: meta.index,
    label: meta.label,
    source: meta.source,
    derivationIndex: meta.derivationIndex,
    publicKey,
    // The path follows the *derivation* index, never the slot id. Getting this
    // wrong would print a path that does not address the key next to it.
    path: stellarAccountPath(meta.derivationIndex),
  };
}

/**
 * The wire form of {@link PublicAccount}.
 *
 * Declared here next to the type rather than in `messaging/protocol` so the
 * two cannot drift: a field added above and forgotten below would otherwise be
 * silently stripped on its way to the popup.
 */
export const publicAccountSchema = z.object({
  index: z.number().int().min(0),
  label: z.string().max(64),
  source: z.enum(ACCOUNT_SOURCES),
  derivationIndex: z.number().int().min(0),
  publicKey: publicKeyStrkey,
  path: z.string(),
});

/* ------------------------------------------------------------ the vault */

const vaultSecretFields = {
  /** BIP-39 recovery phrase. Only ever present inside the encrypted blob. */
  mnemonic: z.string().min(1),
  /**
   * Optional BIP-39 passphrase ("25th word"). Part of the derivation, so it
   * must be stored with the phrase; a wallet restored without it derives a
   * completely different, empty set of accounts (finding 7).
   */
  bip39Passphrase: z.string().optional(),
};

/** The v1 account record: slot id and derivation index were the same number. */
const legacyAccountMetaSchema = z.object({
  index: z.number().int().min(0),
  label: z.string().max(64),
});

const vaultV1Schema = z.object({
  version: z.literal(1),
  ...vaultSecretFields,
  accounts: z.array(legacyAccountMetaSchema).min(1),
});

const vaultV2Schema = z.object({
  version: z.literal(2),
  ...vaultSecretFields,
  accounts: z.array(accountMetaSchema).min(1),
});

export const VAULT_VERSION = 2;

/**
 * Read a vault of either version and hand back the current shape.
 *
 * One-way on purpose: a v1 blob is upgraded the first time it is opened and
 * written back by the caller. An older build could not read the result, which
 * is the normal cost of a schema change and strictly better than carrying two
 * account shapes through the rest of the codebase.
 */
export const vaultSchema = z
  .union([vaultV2Schema, vaultV1Schema])
  .transform((raw): VaultV2 => {
    if (raw.version === 2) return raw;
    return {
      ...raw,
      version: 2,
      accounts: raw.accounts.map((a) => ({
        index: a.index,
        label: a.label,
        source: 'seed' as const,
        // The whole migration rests on this line: v1 derived from `index`, so
        // the derivation index *is* the old index. Anything else here would
        // silently re-point a user's account at a key they have never used.
        derivationIndex: a.index,
      })),
    };
  });

type VaultV2 = z.infer<typeof vaultV2Schema>;
export type Vault = VaultV2;

/** The vault a freshly created or imported wallet starts with. */
export function newVault(
  mnemonic: string,
  bip39Passphrase?: string,
): Vault {
  return {
    version: VAULT_VERSION,
    mnemonic,
    ...(bip39Passphrase === undefined || bip39Passphrase === ''
      ? {}
      : { bip39Passphrase }),
    accounts: [{ index: 0, label: '', source: 'seed', derivationIndex: 0 }],
  };
}
