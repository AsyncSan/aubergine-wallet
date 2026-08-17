/**
 * The one transaction whose outcome this wallet does not know.
 *
 * Written *before* the envelope is handed to Horizon and cleared only when the
 * network gives a definitive answer. Everything that could build a second
 * transaction consults it (`tx.build`), and the three send-like screens read it
 * when they mount, so the warning survives a closed popup.
 *
 * ## Where it lives, and why
 *
 * `storage.session`; an MV3 area that is *not* written to disk, survives the
 * service worker being torn down, and is dropped when the browser closes. That
 * matches the lifetime of the problem exactly: an envelope this wallet builds
 * is valid for `DEFAULT_TIMEOUT_SECONDS` = 180 s, so a record cannot outlive a
 * browser session in any meaningful way, and a stale lock in `storage.local`
 * after a crash would be worse than useless; it would block a wallet whose
 * transaction expired long ago.
 *
 * The fallbacks exist because this file must not be the reason a payment path
 * breaks: Firefox before 115 has no `storage.session`, and the handler test
 * suites stub `wxt/browser` with `local`/`sync` only. In that case the record
 * goes to `storage.local` under a key that is swept on read, and if there is no
 * extension storage at all (unit tests, a stripped runtime) it lives in module
 * memory, which is still correct for the duration of one worker.
 */
import { browser } from 'wxt/browser';
import { z } from 'zod';

const PENDING_KEY = 'submission.pending.v1';

export const pendingSubmissionSchema = z.object({
  /** Transaction hash, hex; the handle for `GET /transactions/{hash}`. */
  hash: z.string().min(1),
  /** Envelope `maxTime` in unix seconds; `'0'` = no upper timebound. */
  maxTimeUnix: z.string(),
  /** Which account submitted, so the guard can be account-scoped. */
  accountIndex: z.number().int().min(0),
  /** Network passphrase at submission time; a record never crosses networks. */
  networkPassphrase: z.string(),
  /** What the popup should say it was: `payment` | `swap` | `changeTrust`. */
  kind: z.enum(['payment', 'swap', 'changeTrust', 'unknown']).default('unknown'),
  createdAt: z.number(),
  /**
   * `false` while the POST is still in flight, `true` once it came back
   * without an answer. Both block a rebuild; the difference is only what the
   * UI says while the request may still be running.
   */
  answered: z.boolean().default(false),
});

export type PendingSubmission = z.infer<typeof pendingSubmissionSchema>;

type Area = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

/** Last resort: correct for one worker lifetime, lost when the worker dies. */
let memoryRecord: unknown;

const memoryArea: Area = {
  get: async (key) => (memoryRecord === undefined ? {} : { [key]: memoryRecord }),
  set: async (items) => {
    memoryRecord = items[PENDING_KEY];
  },
  remove: async () => {
    memoryRecord = undefined;
  },
};

function area(): Area {
  const storage = (browser as unknown as { storage?: Record<string, Area | undefined> })
    .storage;
  return storage?.['session'] ?? storage?.['local'] ?? memoryArea;
}

/**
 * How long past `maxTime` a record still blocks.
 *
 * After the timebound plus this grace, the envelope can no longer enter a
 * ledger (`tx_too_late`), so it cannot collide with a fresh one and the lock
 * has done its job. Slightly larger than `TX_LOOKUP_GRACE_MS` in `horizon.ts`
 * so the resolution poll always gets the chance to answer first.
 */
export const PENDING_GRACE_MS = 45_000;
/**
 * Ceiling for a record whose envelope has no upper timebound (`maxTime = 0`).
 * Nothing can prove such a transaction will never be included, so the lock
 * would otherwise be permanent. The wallet's own builder always sets a
 * timebound; this only covers foreign envelopes submitted through `tx.submit`.
 */
export const PENDING_MAX_LIFETIME_MS = 10 * 60_000;

/** True once the envelope can no longer be included, i.e. the lock may lift. */
export function pendingIsStale(record: PendingSubmission, now: number = Date.now()): boolean {
  const maxTime = Number(record.maxTimeUnix);
  if (Number.isFinite(maxTime) && maxTime > 0) return now > maxTime * 1000 + PENDING_GRACE_MS;
  return now > record.createdAt + PENDING_MAX_LIFETIME_MS;
}

export async function readPendingSubmission(
  now: number = Date.now(),
): Promise<PendingSubmission | null> {
  let raw: unknown;
  try {
    raw = (await area().get(PENDING_KEY))[PENDING_KEY];
  } catch {
    return null;
  }
  if (raw === undefined || raw === null) return null;
  const parsed = pendingSubmissionSchema.safeParse(raw);
  // An unparseable record is dropped rather than kept: unlike the keystore,
  // nothing is lost by forgetting it, and a permanent un-clearable block on
  // every payment would be a denial of service on the user's own money.
  if (!parsed.success) {
    await clearPendingSubmission();
    return null;
  }
  if (pendingIsStale(parsed.data, now)) {
    await clearPendingSubmission();
    return null;
  }
  return parsed.data;
}

export async function writePendingSubmission(record: PendingSubmission): Promise<void> {
  try {
    await area().set({ [PENDING_KEY]: pendingSubmissionSchema.parse(record) });
  } catch {
    /* Storage refusing a write must not stop the submission itself. */
  }
}

export async function clearPendingSubmission(): Promise<void> {
  try {
    await area().remove(PENDING_KEY);
  } catch {
    /* nothing to do; the record expires on read anyway */
  }
}

/** Test seam for the in-memory fallback. */
export function resetPendingSubmissionMemory(): void {
  memoryRecord = undefined;
}
