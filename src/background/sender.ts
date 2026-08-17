/**
 * Message-sender classification (finding 8).
 *
 * `sender.id === runtime.id` is **not** a context check: a content script runs
 * inside a web page but still carries the extension's own id. Anything that
 * distinguishes "our popup" from "our relay in a hostile page" has to look at
 * the tab and the URL:
 *
 *  - the sender URL is one of our own extension pages **and** it is not framed
 *    by someone else -> an extension page (popup/options), which may use the
 *    full RPC surface,
 *  - a tab with any other URL -> our content-script relay inside a web page,
 *    which may only use the four page-provider methods,
 *  - anything else -> unknown, and gets nothing.
 *
 * Why the URL and not `sender.tab`: an extension page hosted in a *tab* (the
 * popup opened in a normal tab, an expanded view, an options page) also carries
 * `sender.tab`, so keying on the tab alone locked the real UI out of its own
 * background. A content script never reports an extension URL, it reports the
 * web page's URL, so the URL is the discriminator that actually separates the
 * two. `frameId` keeps the iframe case out: a web page could frame a
 * web-accessible extension document, and a framed document is never trusted.
 *
 * Kept free of `wxt/browser` so it is directly unit-testable.
 */

export type SenderContext = 'extension-page' | 'content-script' | 'unknown';

/** The subset of `Runtime.MessageSender` this decision depends on. */
export interface SenderLike {
  readonly id?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
  /** 0 for the top-level document of a tab, > 0 for a sub-frame. */
  readonly frameId?: number | undefined;
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
}

export function classifySender(
  sender: SenderLike | undefined | null,
  runtimeId: string,
  extensionBaseUrl: string,
): SenderContext {
  if (!sender) return 'unknown';
  // A foreign extension (or a page reached via externally_connectable, which we
  // do not declare) is never trusted, whatever else it claims.
  if (sender.id !== runtimeId) return 'unknown';

  const base = extensionBaseUrl.endsWith('/') ? extensionBaseUrl : `${extensionBaseUrl}/`;
  const isOwnPage = typeof sender.url === 'string' && sender.url.startsWith(base);

  if (isOwnPage) {
    // Top-level document of a tab (frameId 0) or a frame-less context such as
    // the action popup: our own UI. A framed extension document is not, because
    // a hostile page could be the frame's embedder.
    const framed = sender.tab !== undefined && (sender.frameId ?? 0) !== 0;
    return framed ? 'unknown' : 'extension-page';
  }

  // A tab with a non-extension URL: our content-script relay inside a page.
  if (sender.tab !== undefined) return 'content-script';

  return 'unknown';
}
