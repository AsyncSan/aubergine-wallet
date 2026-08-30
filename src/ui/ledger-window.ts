/**
 * Handing a signature over to the Ledger window.
 *
 * Every flow that would otherwise call `api.signTx` needs the same three
 * lines when the signing account lives on a device, so they live here once.
 *
 * The window is opened as a real browser window rather than a tab: the
 * ceremony has to survive the user turning to the device, and the request id
 * is the only thing that travels in the URL — the window fetches the envelope
 * over RPC, so nothing about the transaction ends up in browser history.
 */
import { browser } from 'wxt/browser';
import { api } from '../messaging/client';
import type { PublicAccount } from '../core/keyring/account';

/** Does this account sign somewhere other than in the extension? */
export function signsOnDevice(account: PublicAccount | undefined): boolean {
  return account?.source === 'ledger';
}

/**
 * Can this browser reach a Ledger at all?
 *
 * Duplicated from `core/ledger/webhid` on purpose rather than imported: this
 * module is pulled into the popup bundle, and importing from `webhid` would
 * drag the whole Ledger SDK in with it for the sake of one `in` check. The
 * popup only ever needs to know *whether* to offer the button; the page that
 * actually talks to the device is the one that pays for the SDK.
 */
export function ledgerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 680;

/**
 * Authorise the signature in the background, then open the window that talks
 * to the device.
 *
 * Note the order. `ledger.beginSign` runs every guard first, so a transaction
 * that would be refused (developer-mode gate, an open submission) fails here,
 * in the screen the user is looking at, instead of opening a window that then
 * shows an error out of context.
 */
export async function startLedgerSigning(
  xdr: string,
  accountIndex?: number,
): Promise<void> {
  const request = await api.ledgerBeginSign(xdr, accountIndex);
  const url = `${browser.runtime.getURL('/ledger.html')}?request=${encodeURIComponent(
    request.requestId,
  )}`;
  try {
    await browser.windows.create({
      url,
      type: 'popup',
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    });
  } catch {
    // Some environments refuse `windows.create` (and Firefox never gets here
    // at all, having no WebHID). A tab still completes the ceremony.
    await browser.tabs.create({ url });
  }
}

/**
 * Open the window with no pending request: the account-management view.
 *
 * Same window, no request id. Enrolment needs the device exactly as much as
 * signing does, and for the same reason cannot happen in the popup.
 */
export async function openLedgerAccountWindow(): Promise<void> {
  const url = browser.runtime.getURL('/ledger.html');
  try {
    await browser.windows.create({
      url,
      type: 'popup',
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    });
  } catch {
    await browser.tabs.create({ url });
  }
}
