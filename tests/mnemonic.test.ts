/**
 * SEP-0005 conformance.
 *
 * Vectors copied verbatim from
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
 */
import { describe, expect, it } from 'vitest';
import {
  derivePath,
  deriveStellarKeypair,
  deriveStellarPublicKey,
  generateMnemonic,
  mnemonicToSeed,
  mnemonicWordCountValid,
  normalizeMnemonic,
  stellarAccountPath,
  unknownWordIndexes,
  validateMnemonic,
} from '../src/core/crypto/mnemonic';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

interface Vector {
  readonly name: string;
  readonly mnemonic: string;
  readonly passphrase?: string;
  readonly seed: string;
  readonly rootKey: string;
  readonly accounts: ReadonlyArray<readonly [string, string]>;
}

const VECTORS: readonly Vector[] = [
  {
    name: 'SEP-0005 Test 1 (12 words)',
    mnemonic:
      'illness spike retreat truth genius clock brain pass fit cave bargain toe',
    seed: 'e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497ee4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186',
    rootKey: 'e0eec84fe165cd427cb7bc9b6cfdef0555aa1cb6f9043ff1fe986c3c8ddd22e3',
    accounts: [
      [
        'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
        'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      ],
      [
        'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
        'SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS',
      ],
      [
        'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW',
        'SDAILLEZCSA67DUEP3XUPZJ7NYG7KGVRM46XA7K5QWWUIGADUZCZWTJP',
      ],
      [
        'GAOD5NRAEORFE34G5D4EOSKIJB6V4Z2FGPBCJNQI6MNICVITE6CSYIAE',
        'SBMWLNV75BPI2VB4G27RWOMABVRTSSF7352CCYGVELZDSHCXWCYFKXIX',
      ],
      [
        'GBCUXLFLSL2JE3NWLHAWXQZN6SQC6577YMAU3M3BEMWKYPFWXBSRCWV4',
        'SCPCY3CEHMOP2TADSV2ERNNZBNHBGP4V32VGOORIEV6QJLXD5NMCJUXI',
      ],
    ],
  },
  {
    name: 'SEP-0005 Test 2 (15 words)',
    mnemonic:
      'resource asthma orphan phone ice canvas fire useful arch jewel impose vague theory cushion top',
    seed: '7b36d4e725b48695c3ffd2b4b317d5552cb157c1a26c46d36a05317f0d3053eb8b3b6496ba39ebd9312d10e3f9937b47a6790541e7c577da027a564862e92811',
    rootKey: '2e5d4e6b54a4b96c5e887c9ec92f619a3c134d8b1059dcef15c1a9b228ae3751',
    accounts: [
      [
        'GAVXVW5MCK7Q66RIBWZZKZEDQTRXWCZUP4DIIFXCCENGW2P6W4OA34RH',
        'SAKS7I2PNDBE5SJSUSU2XLJ7K5XJ3V3K4UDFAHMSBQYPOKE247VHAGDB',
      ],
      [
        'GDFCYVCICATX5YPJUDS22KM2GW5QU2KKSPPPT2IC5AQIU6TP3BZSLR5K',
        'SAZ2H5GLAVWCUWNPQMB6I3OHRI63T2ACUUAWSH7NAGYYPXGIOPLPW3Q4',
      ],
    ],
  },
  {
    name: 'SEP-0005 Test 4 (24 words + BIP-39 passphrase)',
    mnemonic:
      'cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube',
    passphrase: 'p4ssphr4se',
    seed: 'd425d39998fb42ce4cf31425f0eaec2f0a68f47655ea030d6d26e70200d8ff8bd4326b4bdf562ea8640a1501ae93ccd0fd7992116da5dfa24900e570a742a489',
    rootKey: 'c83c61dc97d37832f0f20e258c3ba4040a258800fd14abaff124a4dee114b17e',
    accounts: [
      [
        'GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ',
        'SAFWTGXVS7ELMNCXELFWCFZOPMHUZ5LXNBGUVRCY3FHLFPXK4QPXYP2X',
      ],
      [
        'GDY47CJARRHHL66JH3RJURDYXAMIQ5DMXZLP3TDAUJ6IN2GUOFX4OJOC',
        'SBQPDFUGLMWJYEYXFRM5TQX3AX2BR47WKI4FDS7EJQUSEUUVY72MZPJF',
      ],
    ],
  },
  {
    name: 'SEP-0005 Test 5 (all-zero entropy)',
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    seed: '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
    rootKey: '03df7921b4f789040e361d07d5e4eddad277c376350d7b5d585400a0ef18f2f5',
    accounts: [
      [
        'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX',
        'SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ',
      ],
      [
        'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV',
        'SCHDCVCWGAKGIMTORV6K5DYYV3BY4WG3RA4M6MCBGJLHUCWU2MC6DL66',
      ],
    ],
  },
];

describe('BIP-39 seed derivation', () => {
  for (const v of VECTORS) {
    it(`${v.name}: produces the documented BIP-39 seed`, async () => {
      const seed = await mnemonicToSeed(v.mnemonic, v.passphrase ?? '');
      expect(hex(seed)).toBe(v.seed);
    });
  }
});

describe('SLIP-0010 / SEP-0005 derivation', () => {
  for (const v of VECTORS) {
    it(`${v.name}: derives the documented m/44'/148' root key`, async () => {
      const seed = await mnemonicToSeed(v.mnemonic, v.passphrase ?? '');
      const node = await derivePath(seed, "m/44'/148'");
      expect(hex(node.key)).toBe(v.rootKey);
    });

    it(`${v.name}: derives the documented Stellar accounts`, async () => {
      const seed = await mnemonicToSeed(v.mnemonic, v.passphrase ?? '');
      for (let i = 0; i < v.accounts.length; i++) {
        const entry = v.accounts[i];
        expect(entry).toBeDefined();
        const [publicKey, secretKey] = entry as readonly [string, string];
        const kp = await deriveStellarKeypair(seed, i);
        expect(kp.publicKey()).toBe(publicKey);
        expect(kp.secret()).toBe(secretKey);
      }
    });
  }

  it('exposes public-key-only derivation for the popup boundary', async () => {
    const seed = await mnemonicToSeed(VECTORS[0]!.mnemonic);
    expect(await deriveStellarPublicKey(seed, 0)).toBe(VECTORS[0]!.accounts[0]![0]);
  });

  it('builds the SEP-0005 path string', () => {
    expect(stellarAccountPath(0)).toBe("m/44'/148'/0'");
    expect(stellarAccountPath(7)).toBe("m/44'/148'/7'");
  });

  it('rejects non-hardened paths (ed25519 restriction)', async () => {
    const seed = await mnemonicToSeed(VECTORS[0]!.mnemonic);
    await expect(derivePath(seed, "m/44'/148/0'")).rejects.toThrow();
    await expect(derivePath(seed, 'nonsense')).rejects.toThrow();
  });
});

describe('mnemonic generation and validation', () => {
  it('generates a valid 12-word phrase by default', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('generates a valid 24-word phrase at 256 bits', () => {
    const m = generateMnemonic(256);
    expect(m.split(' ')).toHaveLength(24);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('generates a different phrase every time', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic());
  });

  it('accepts the SEP-0005 vectors', () => {
    for (const v of VECTORS) expect(validateMnemonic(v.mnemonic)).toBe(true);
  });

  it('rejects a phrase with a broken checksum', () => {
    expect(
      validateMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
      ),
    ).toBe(false);
  });

  it('rejects a phrase with a non-wordlist word', () => {
    expect(validateMnemonic('illness spike retreat truth genius clock brain pass fit cave bargain zzzz')).toBe(
      false,
    );
    expect(unknownWordIndexes('illness spike zzzz')).toEqual([2]);
  });

  it('normalises casing and whitespace on import', () => {
    const messy = `  ILLNESS  spike\tretreat truth genius clock
      brain pass fit cave bargain TOE `;
    expect(normalizeMnemonic(messy)).toBe(VECTORS[0]!.mnemonic);
    expect(validateMnemonic(messy)).toBe(true);
  });

  it('checks word counts', () => {
    expect(mnemonicWordCountValid(VECTORS[0]!.mnemonic)).toBe(true);
    expect(mnemonicWordCountValid('one two three')).toBe(false);
  });

  it('derives different accounts for different indexes', async () => {
    const seed = await mnemonicToSeed(VECTORS[0]!.mnemonic);
    const a = await deriveStellarPublicKey(seed, 0);
    const b = await deriveStellarPublicKey(seed, 1);
    expect(a).not.toBe(b);
  });

  it('treats the BIP-39 passphrase as key material', async () => {
    const withPass = await mnemonicToSeed(VECTORS[0]!.mnemonic, 'x');
    const without = await mnemonicToSeed(VECTORS[0]!.mnemonic);
    expect(hex(withPass)).not.toBe(hex(without));
  });
});
