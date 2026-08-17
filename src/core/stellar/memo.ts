/**
 * MEMO_TEXT validation.
 *
 * XDR defines MEMO_TEXT as up to 28 *bytes* of UTF-8, not 28 characters
 * (SECURITY-ANALYSE P2): "ää…" with 15 umlauts is 15 characters but 30 bytes
 * and would be rejected by the SDK / the network. All memo length checks in
 * the codebase go through this module so the limit is enforced in bytes
 * everywhere (Zod schema at the RPC edge, the transaction builder, the UI).
 */

export const MEMO_TEXT_MAX_BYTES = 28;

const encoder = new TextEncoder();

/** UTF-8 byte length of a memo string (what the XDR limit actually counts). */
export function memoTextByteLength(memo: string): number {
  return encoder.encode(memo).length;
}

/** True when `memo` fits into MEMO_TEXT's 28-byte XDR field. */
export function isValidMemoText(memo: string): boolean {
  return memoTextByteLength(memo) <= MEMO_TEXT_MAX_BYTES;
}
