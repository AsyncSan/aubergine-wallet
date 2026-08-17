/**
 * Finding 8: the internal RPC surface must be unreachable from a content
 * script, even though a content script carries the extension's own id.
 */
import { describe, expect, it } from 'vitest';
import { classifySender, type SenderLike } from '../src/background/sender';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const BASE = `chrome-extension://${ID}/`;

describe('classifySender', () => {
  it('accepts an extension page (popup)', () => {
    const sender: SenderLike = { id: ID, url: `${BASE}popup.html` };
    expect(classifySender(sender, ID, BASE)).toBe('extension-page');
  });

  it('accepts an extension page when the base URL has no trailing slash', () => {
    const sender: SenderLike = { id: ID, url: `${BASE}popup.html` };
    expect(classifySender(sender, ID, `chrome-extension://${ID}`)).toBe('extension-page');
  });

  it('classifies our content script as a content script, not an extension page', () => {
    const sender: SenderLike = {
      id: ID,
      tab: { id: 42 },
      url: 'https://dapp.example/index.html',
      origin: 'https://dapp.example',
    };
    expect(classifySender(sender, ID, BASE)).toBe('content-script');
  });

  it('does not let a tab-less sender in on the id alone', () => {
    // This is exactly what the old `sender.id === runtime.id` check accepted.
    const sender: SenderLike = { id: ID, url: 'https://dapp.example/' };
    expect(classifySender(sender, ID, BASE)).toBe('unknown');
  });

  it('rejects a URL that only starts with something similar', () => {
    const sender: SenderLike = { id: ID, url: `chrome-extension://${ID}evil/popup.html` };
    expect(classifySender(sender, ID, BASE)).toBe('unknown');
  });

  it('rejects another extension', () => {
    const sender: SenderLike = { id: 'someotherextensionid', url: `${BASE}popup.html` };
    expect(classifySender(sender, ID, BASE)).toBe('unknown');
  });

  it('rejects a missing sender and a sender without a URL', () => {
    expect(classifySender(undefined, ID, BASE)).toBe('unknown');
    expect(classifySender(null, ID, BASE)).toBe('unknown');
    expect(classifySender({ id: ID }, ID, BASE)).toBe('unknown');
  });

  it('accepts our own page as the top-level document of a tab', () => {
    // The popup opened in a normal tab (and any expanded view) reports a tab
    // with frameId 0. Refusing it locked the real UI out of its own background.
    const sender: SenderLike = { id: ID, tab: { id: 7 }, frameId: 0, url: `${BASE}popup.html` };
    expect(classifySender(sender, ID, BASE)).toBe('extension-page');
  });

  it('refuses an extension document that a page has framed', () => {
    // A web page may embed a web-accessible resource; a framed document is
    // never trusted with the full RPC surface.
    const sender: SenderLike = { id: ID, tab: { id: 7 }, frameId: 3, url: `${BASE}popup.html` };
    expect(classifySender(sender, ID, BASE)).toBe('unknown');
  });
});
