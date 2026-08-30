/**
 * `core/backup-file`: the downloadable recovery-phrase backup.
 *
 * The interesting assertions are the ones about what the file name must *not*
 * be — that is the whole security argument for the feature, and it is exactly
 * the kind of thing a well-meaning later change ("give it a useful name") would
 * undo without noticing.
 */
import { describe, expect, it } from 'vitest';
import {
  FILE_NAME_ALPHABET,
  FILE_NAME_LENGTH,
  backupFileName,
  renderBackupFile,
} from '../src/core/backup-file';

const WORDS = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
];

const STRINGS = {
  title: 'Aubergine — recovery phrase',
  intro:
    'This file holds the recovery phrase of a Stellar wallet. These words alone restore the wallet on any device.',
  warnings: [
    'Anyone who reads these words can spend the entire balance.',
    'Keep this file offline, on a USB stick in a drawer for instance.',
  ],
  wordsHeading: 'The words, in this order',
  oneLineHeading: 'The same phrase on one line',
};

describe('backupFileName', () => {
  it('is a .txt name of random characters and nothing else', () => {
    const name = backupFileName();
    expect(name).toMatch(
      new RegExp(`^[${FILE_NAME_ALPHABET}]{${FILE_NAME_LENGTH}}\\.txt$`, 'u'),
    );
  });

  it('says nothing about what the file is', () => {
    // The point of the random name: a Downloads folder on a shared screen must
    // not advertise which file is worth stealing.
    const names = Array.from({ length: 200 }, backupFileName).join(' ').toLowerCase();
    for (const giveaway of [
      'aubergine',
      'wallet',
      'seed',
      'phrase',
      'satz',
      'backup',
      'recover',
      'stellar',
      'key',
    ]) {
      expect(names, giveaway).not.toContain(giveaway);
    }
  });

  it('cannot spell a word: the alphabet has no vowels', () => {
    for (const vowel of ['a', 'e', 'i', 'o', 'u']) {
      expect(FILE_NAME_ALPHABET).not.toContain(vowel);
    }
    // …nor the characters that get misread when someone types the name back.
    for (const ambiguous of ['l', 'o', 'u', 'i']) {
      expect(FILE_NAME_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('does not repeat itself', () => {
    const names = new Set(Array.from({ length: 500 }, backupFileName));
    expect(names.size).toBe(500);
  });
});

describe('renderBackupFile', () => {
  const file = renderBackupFile(WORDS, STRINGS);

  it('carries the whole phrase, numbered and as one line', () => {
    WORDS.forEach((word, i) => {
      expect(file).toContain(`${i + 1}. ${word}`);
    });
    expect(file).toContain(WORDS.join(' '));
  });

  it('carries the warnings, so the file warns even out of context', () => {
    for (const warning of STRINGS.warnings) {
      // Wrapped across lines, so compare on the whitespace-collapsed text.
      expect(file.replace(/\s+/gu, ' ')).toContain(warning);
    }
    expect(file).toContain(STRINGS.title);
  });

  it('uses CRLF and ends with a newline, for Windows Notepad', () => {
    expect(file.includes('\r\n')).toBe(true);
    expect(file.split('\r\n').some((line) => line.includes('\n'))).toBe(false);
    expect(file.endsWith('\r\n')).toBe(true);
  });

  it('wraps the prose to a width a plain-text viewer can show', () => {
    // Every line except one: the copy-paste line is the whole phrase and has
    // to stay a single line, otherwise pasting it back drags a newline in.
    const phrase = WORDS.join(' ');
    for (const line of file.split('\r\n')) {
      if (line === phrase) continue;
      expect(line.length, line).toBeLessThanOrEqual(76);
    }
    expect(file.split('\r\n')).toContain(phrase);
  });

  it('refuses to write a backup of nothing', () => {
    expect(() => renderBackupFile([], STRINGS)).toThrow(RangeError);
  });

  it('numbers a 24-word phrase in an aligned column', () => {
    const long = renderBackupFile(
      [...WORDS, ...WORDS],
      STRINGS,
    );
    expect(long).toContain('   1. abandon');
    expect(long).toContain('  24. accident');
  });
});
