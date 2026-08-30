/**
 * The downloadable recovery-phrase backup (`.txt`).
 *
 * Writing the phrase to a file is the single most dangerous thing this wallet
 * offers, and it is offered anyway: the alternative, in practice, is not "the
 * user writes it on paper", it is a screenshot in the camera roll or a note in
 * a password manager's free-text field. A file the wallet formats itself can at
 * least carry its own warning, and the flow around it (`Onboarding.tsx`) makes
 * the risk a thing the user has to read past rather than a stray click.
 *
 * Two decisions worth stating, because both look wrong at first glance:
 *
 *  - **The file name is random and says nothing.** Not `aubergine-backup.txt`,
 *    not `recovery-phrase.txt`. A name is metadata that survives everywhere the
 *    file goes — a Downloads folder shown on a shared screen, a cloud-sync
 *    notification, a directory listing in a support screenshot — and a name
 *    that announces "this is a seed phrase" turns every one of those into a
 *    pointer at the money. The random stem also cannot collide with an existing
 *    download, so a second save never silently becomes `… (1).txt`.
 *  - **The *contents* do say what they are.** The opposite trade-off, on
 *    purpose. Twelve BIP-39 words are recognisable as a seed phrase to anyone
 *    who would exploit them, so hiding the label buys nothing against an
 *    attacker, while it costs a great deal against the honest case: the person
 *    who finds this file in three years and has to work out what it unlocks.
 *
 * The prose is passed in already translated (§8: no user-visible string is
 * hardcoded), so this module stays a pure layout function and can be tested
 * without a locale.
 */
import { randomString } from './crypto/random';

/**
 * Digits and consonants only, Crockford-style.
 *
 * No vowels, so a random draw cannot spell a word — a backup called
 * `fatcash.txt` would be exactly the kind of pointer the random name exists to
 * avoid. No `i`/`l`/`o`/`u` either: the user has to be able to read this name
 * back off a screen to find the file again, and those are the characters that
 * get confused with `1` and `0`.
 */
export const FILE_NAME_ALPHABET = '0123456789bcdfghjkmnpqrstvwxz';

/**
 * 16 characters ≈ 78 bits. Absurd as a collision guard for one folder; the
 * point is that the name carries no structure at all — no date, no counter, no
 * prefix — because every one of those is a hint about what the file is and when
 * the wallet was made.
 */
export const FILE_NAME_LENGTH = 16;

/** Column the body text is wrapped at, for the plain-text viewers people have. */
const WRAP_AT = 72;

/** A fresh, meaningless `.txt` name. Never derived from the phrase. */
export function backupFileName(): string {
  return `${randomString(FILE_NAME_LENGTH, FILE_NAME_ALPHABET)}.txt`;
}

/** The translated prose that goes into the file. */
export interface BackupFileStrings {
  /** Headline, e.g. "Aubergine — recovery phrase". */
  readonly title: string;
  /** One paragraph saying what this file is and what it can do. */
  readonly intro: string;
  /** The danger notices, one paragraph each, rendered as a bulleted block. */
  readonly warnings: readonly string[];
  /** Heading above the numbered word list. */
  readonly wordsHeading: string;
  /** Heading above the same phrase on a single line. */
  readonly oneLineHeading: string;
}

/** Greedy wrap; `indent` is applied to the continuation lines as well. */
function wrap(text: string, indent = ''): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (indent.length + candidate.length > WRAP_AT && line !== '') {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}

function rule(label: string): string {
  const head = `--- ${label} `;
  return head + '-'.repeat(Math.max(3, WRAP_AT - head.length));
}

/**
 * Lay the file out.
 *
 * CRLF line endings: this file exists to be opened by a beginner on whatever
 * they have, and Windows Notepad older than 2018 renders LF-only text as one
 * endless line — which is to say it renders a recovery phrase as gibberish at
 * the exact moment somebody needs it. Every other editor on every platform
 * copes with CRLF.
 */
export function renderBackupFile(
  words: readonly string[],
  strings: BackupFileStrings,
): string {
  if (words.length === 0) throw new RangeError('a backup of no words is not a backup');

  const width = String(words.length).length;
  const lines: string[] = [
    '='.repeat(WRAP_AT),
    ` ${strings.title}`,
    '='.repeat(WRAP_AT),
    '',
    ...wrap(strings.intro),
    '',
  ];

  for (const warning of strings.warnings) {
    const wrapped = wrap(warning, '    ');
    lines.push(`  ! ${(wrapped[0] ?? '').trimStart()}`, ...wrapped.slice(1), '');
  }

  lines.push(rule(strings.wordsHeading), '');
  words.forEach((word, i) => {
    lines.push(`  ${String(i + 1).padStart(width, ' ')}. ${word}`);
  });
  lines.push('', rule(strings.oneLineHeading), '', words.join(' '), '');

  // Trailing newline: a file without one is a file some tools quietly truncate.
  return `${lines.join('\r\n')}\r\n`;
}
