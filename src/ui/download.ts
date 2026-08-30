/**
 * Handing a file to the browser's downloader, from an extension page.
 *
 * Deliberately *not* `chrome.downloads`: that API needs the `downloads`
 * permission, which every user would have to accept at install ("Manage your
 * downloads") for a feature almost none of them use twice. An `<a download>`
 * on a blob URL needs no permission at all and is not blocked by the popup's
 * CSP — `default-src 'self'` governs fetches, and a download is neither a
 * fetch the page makes nor a navigation the policy covers.
 *
 * The blob never leaves the page: it is created, clicked and revoked in the
 * same document, so the plaintext lives in this renderer's memory and in the
 * file the user chose, nowhere in between.
 */

/** How long the object URL is kept alive after the click. */
const REVOKE_AFTER_MS = 60_000;

/**
 * Offer `text` as a download named `filename`.
 *
 * Returns false when the browser refuses outright, so the caller can say so
 * instead of leaving the user staring at a button that appeared to do nothing.
 * A *successful* return only means the download started; whether the user then
 * cancels the save dialog is not observable from here without the `downloads`
 * permission, and the UI is worded accordingly.
 */
export function downloadText(filename: string, text: string): boolean {
  let url: string | null = null;
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    // Revoking straight away can cancel a download that has not been handed
    // over yet; revoking never at all leaks the plaintext blob for the life of
    // the document. A minute is past both problems.
    if (url) {
      const held = url;
      setTimeout(() => URL.revokeObjectURL(held), REVOKE_AFTER_MS);
    }
  }
}
