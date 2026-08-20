# Aubergine: Architektur-Framework / Architecture Framework

*Version 1.3, August 2026. Verbindlicher Vertrag für alle Arbeitsstränge (Extension, Docs, Website).*
*Binding contract for all workstreams (extension, docs, website).*

> **Produktname:** `Aubergine`. Der Arbeitstitel war `StellarWallet`; die Umbenennung ist erfolgt.
> Der Name steht **nirgends hartcodiert** im Quelltext, sondern wird ausschließlich aus
> `src/core/brand.ts` gelesen. Eine weitere Umbenennung ist eine Datei.

---

## 1. Leitentscheidungen (die "Warums")

| Entscheidung | Wahl | Begründung |
|---|---|---|
| Extension-Framework | **WXT 0.21** | Ein Codebase → Chrome MV3 **und** Firefox MV3. Nimmt Manifest-Divergenz, HMR und Cross-Browser-Polyfill ab. Alternative (@crxjs/vite-plugin) deckt Firefox schlechter ab. |
| UI | **React 19 + TypeScript 5 (strict)** | Größter Talent-Pool für spätere Contributor; Freighter/xBull setzen ebenfalls auf React → vertraute Codebasis für SCF-Reviewer. |
| Styling | **Tailwind CSS v4 + CSS-Variablen-Tokens** | Design-Tokens sind zwischen Extension und Website teilbar (siehe §7). Kein CSS-in-JS wegen MV3-CSP. |
| Chain-SDK | **@stellar/stellar-sdk 16.x** | Offizielles SDK, enthält Horizon-Client **und** `rpc`-Modul für Soroban. Kein separater Soroban-Client nötig. |
| State | **Zustand + TanStack Query** | Zustand für UI/Settings, TanStack Query für alles Netzwerk-Abgeleitete (Balances, Historie) inkl. Caching/Retry. Kein Redux-Overhead. |
| Krypto | **WebCrypto (AES-256-GCM) + Argon2id (hash-wasm)** | Argon2id ist gegen GPU-Bruteforce widerstandsfähiger als PBKDF2; hash-wasm läuft unter MV3-CSP ohne `eval`. Fallback PBKDF2-SHA-512 (600 000 Iterationen) wenn WASM blockiert. |
| Build/Test | **Vitest + Playwright** | Vitest für Domain-Logik (crypto, tx-builder), Playwright für den Extension-E2E-Smoke-Test auf Testnet. |
| Website | **Astro 5 + Tailwind v4** | Statisch, null JS im Default-Pfad → schnell, gut indexierbar, kein Tracking. i18n-Routing ist eingebaut. |

**Nicht-Ziele in Phase 1:** Mobile-App, Mainnet-Freigabe, Fiat-Anchor-Integration (nur Interface-Stub),
Hardware-Wallet-Support, Multisig-Ausführung (nur Anzeige).

---

## 2. Repository-Struktur

```
aubergine-wallet/
├── ARCHITECTURE.md          ← dieses Dokument, Single Source of Truth
├── README.md                ← Einstieg, zweisprachig
├── (dieses Repository)      Extension
│   ├── wxt.config.ts
│   ├── package.json
│   ├── entrypoints/
│   │   ├── background.ts        Service Worker: Keyring, Signieren, RPC-Broker
│   │   ├── popup/               React-App (Haupt-UI)
│   │   ├── content.ts           Injiziert Provider in Webseiten (nur Dev-Modus)
│   │   └── inject.ts            window.aubergine Provider (MAIN world)
│   ├── src/
│   │   ├── core/            ← chain- & UI-freie Domänenlogik, 100 % unit-getestet
│   │   │   ├── crypto/          keystore.ts, kdf.ts, mnemonic.ts
│   │   │   ├── stellar/         horizon.ts, soroban.ts, tx-builder.ts, tx-describe.ts
│   │   │   └── keyring/         keyring.ts (in-memory), account.ts
│   │   ├── messaging/       ← typisierter RPC-Kanal Popup ⇄ Background
│   │   │   ├── protocol.ts      Request/Response-Union-Typen (die API-Grenze!)
│   │   │   └── client.ts
│   │   ├── state/           Zustand-Stores + TanStack-Query-Hooks
│   │   ├── ui/              Komponenten, Screens, Design-Tokens
│   │   └── i18n/            de.json, en.json, useT()
│   └── tests/
├── website/                 Astro, eigenes Repository
│   └── src/pages/{de,en}/
├── docs/                    Recherche und Positionierung
│   ├── de/  und  en/
│   └── (bestehend: marktrecherche.md, positionierung-foerderung.md, product-one-pager.md)
└── brand/                   ← geteilt: Name, Claim, Farben, Logo-SVG
```

**Ownership-Regel:** Jeder Agent schreibt **ausschließlich** in seinen Ordner. `brand/` und
`ARCHITECTURE.md` werden von allen **nur gelesen**. Das ist die einzige Regel, die parallele
Arbeit ohne Konflikte garantiert.

---

## 3. Prozess- & Vertrauensmodell (das Sicherheitsfundament)

```
┌─────────────────────────────────────────────────────────────┐
│ WEBSEITE (untrusted)                                        │
│   window.aubergine  ──postMessage──▶  content.ts        │
└─────────────────────────────────────────────────────────────┘
                                              │ chrome.runtime
┌─────────────────────────────────────────────▼───────────────┐
│ BACKGROUND / SERVICE WORKER  (einziger Ort mit Schlüsseln)  │
│   • Keyring: entschlüsselte Seeds NUR im RAM, nie in Storage │
│   • Auto-Lock-Timer (Default 15 min, konfigurierbar)         │
│   • Signiert Transaktionen, gibt NIE einen Secret Key raus   │
│   • Broker für Horizon/Soroban-RPC (zentrales Rate-Limiting) │
└─────────────────────────────────────────────▲───────────────┘
                                              │ typed RPC
┌─────────────────────────────────────────────┴───────────────┐
│ POPUP (React), hält NIEMALS einen Secret Key                │
│   Zeigt an, fragt Passwort ab, rendert Bestätigungsdialoge   │
└─────────────────────────────────────────────────────────────┘
```

**Invarianten, nicht verhandelbar, jede PR wird daran gemessen:**

1. Ein entschlüsselter Secret Key oder Seed verlässt niemals den Background-Kontext. **Einzige
   Ausnahme (v1.1):** `wallet.revealRecoveryPhrase` gibt den Wiederherstellungssatz an das Popup,
   ausschließlich nutzerinitiiert, mit erneuter Passworteingabe, frisch aus dem Keystore
   entschlüsselt. Ohne diese Ausnahme kann der Nutzer kein Backup anlegen. Jeder weitere
   Export-Pfad ist verboten. Die Anzeige blendet sich nach 60 s automatisch aus (v1.3).
2. Nichts Unverschlüsseltes wird persistiert. `chrome.storage.local` enthält ausschließlich
   den Ciphertext-Blob (`{v, kdf, params, salt, iv, ct}`) plus nicht-sensible Settings.
   **Keystore v2 (v1.3):** Der KDF-Header (`v`, `kdf`, `params`, `salt`) ist als AES-GCM
   `additionalData` an den Ciphertext gebunden (`keystoreAad` in `core/crypto/keystore.ts`),
   ein manipulierter Header (herabgesetzte Argon2-Parameter, Downgrade-Relabel auf v1) lässt
   die Entschlüsselung fehlschlagen. v1-Blobs bleiben lesbar und werden beim nächsten
   erfolgreichen Unlock opportunistisch auf v2 re-encryptet (best effort, ein fehlgeschlagener
   Write blockiert nie einen korrekten Unlock).
3. Kein Remote-Code, kein CDN, kein `eval`, keine dynamischen `import()` von externen URLs.
   (Harte Anforderung von Chrome Web Store **und** AMO-Review.)
4. Kein Telemetrie-, Analytics- oder Crash-Reporting-Call. Netzwerkverkehr geht ausschließlich an
   die vom Nutzer konfigurierten Horizon-/Soroban-Endpunkte.
5. Jede signierende Aktion braucht eine explizite, menschenlesbare Bestätigung (§5).
6. Zeroization: Schlüsselmaterial in `Uint8Array` halten und nach Gebrauch mit `.fill(0)` löschen.
   **Nicht absolut (v1.1):** Seeds und AES-Schlüssel sind zeroisierbar, Wiederherstellungssatz und
   Passwort laufen als JS-Strings durch die Runtime und sind dort nicht zuverlässig löschbar. Ziel
   ist minimale Lebensdauer, nicht Garantie, Docs und Website müssen es genau so darstellen.
7. Content-Script wird **nur bei aktivem Entwickler-Modus** registriert (`chrome.scripting`
   dynamisch), nicht statisch im Manifest. Einsteiger haben keine Angriffsfläche über Webseiten.
8. Auto-Lock verlängert sich **nur durch Nutzeraktionen** (v1.3): Unlock, `tx.build`/`tx.sign`/
   `tx.submit`, `account.add`. Read-Handler (`account.balances`, `account.history`) berühren den
   Timer nie, sonst hielte das 30-s-Balance-Polling eines offenen Popups die Wallet unbegrenzt
   entsperrt.
9. Passwort-Gate (v1.3): Onboarding verlangt für Create **und** Import einen Mindest-Score
   (`MIN_PASSWORD_SCORE = 2`) aus dem entropiebasierten Estimator in `core/password-strength.ts`
   (dependency-frei, bewusst kein zxcvbn, Bundle- und Supply-Chain-Kosten). Die Regel lebt
   **nicht nur** im `disabled`-Attribut des Continue-Buttons, sondern im `passwordSchema` in
   `messaging/protocol.ts`, also an der Grenze, die der Background tatsächlich prüft. Eine
   Ablehnung dort ist ein `WEAK_PASSWORD` (Längen-Grenzen: `BAD_REQUEST`), kein `ZodError`,
   sonst käme sie nach §6 als `INTERNAL_ERROR` in der UI an. Verifikation eines **bestehenden**
   Passworts (`wallet.unlock`, `account.add`, `wallet.revealRecoveryPhrase`) bekommt die Regel
   bewusst nicht: sie würde frühe Nutzer aus der eigenen Wallet aussperren.

**Bedrohungsmodell, das Phase 1 abdeckt:** bösartige Webseite, Phishing-dApp, Diebstahl der
Extension-Storage-Datei bei gesperrtem Wallet, versehentliche Fehlsignierung durch unklares UI.
**Nicht abgedeckt:** kompromittiertes Betriebssystem, bösartige andere Extension mit
Debugger-Zugriff, physischer Zugriff bei entsperrtem Wallet.

---

## 4. Modus-Umschalter; das Kernstück der Differenzierung

Ein einziges Setting `mode: 'beginner' | 'developer'` in `chrome.storage.sync`, gelesen über
`useMode()`. Kein zweiter Build, kein zweites Produkt.

| Oberfläche | Einsteiger | Entwickler |
|---|---|---|
| Netzwerkauswahl | Testnet / Mainnet, Mainnet nur hinter dem Tipp-Gate² (v1.2) | Testnet / Futurenet / Mainnet, Mainnet ebenfalls hinter dem Gate. *Ein eigener Soroban-RPC-Endpunkt ist eintragbar, ein vollständig eigenes Netzwerk nicht auswählbar* |
| Transaktionsansicht | nur Klartext-Zusammenfassung | Klartext **+ ausklappbares XDR/Base64** |
| Soroban-Contract-Aufrufe | **extern** blockiert mit Hinweistext¹ | erlaubt, mit Argument-Dekodierung |
| dApp-Connector | deaktiviert (kein Content-Script) | aktiv, mit Origin-Freigabeliste |
| Trustlines | „Asset hinzufügen" (kuratierte Liste) | beliebiger Issuer, Limit editierbar |
| Multisig | verborgen | Signer-Übersicht (Anzeige, Phase 1) |
| Fee | automatisch | manuell überschreibbar |
| Reserves | erklärt als „reserviert für dein Konto" | numerische Aufschlüsselung |

¹ **Wallet-interne Ausnahme (v1.1, Nutzer-Entscheidung 08.08.2026):** Die Soroban-Blockade
im Einsteiger-Modus gilt für *externe* Envelopes (dApp-Connector, eingefügtes XDR). Swap-Envelopes,
die der Background selbst über die Soroswap-Aggregator-API baut, sind davon ausgenommen:
`tx.build` verifiziert das Envelope (Source-Account, nur `invokeHostFunction`-Operationen,
Fee-Obergrenze), merkt sich den Transaktions-Hash in einer Single-Use-Allowlist, und `tx.sign`
signiert im Einsteiger-Modus ausschließlich exakt diese Bytes, genau einmal. Der dApp-Pfad
(`dapp.signXdr`) konsultiert die Allowlist nie. Quote-Integrität: Der Popup wählt Quotes nur
über eine opake `quoteId`; Inhalte der Quote verlassen den Background nicht und ein Build aus
einer abgelaufenen/fremden Quote wird mit `QUOTE_EXPIRED` verweigert (TTL 60 s, Single-Use).
Tests: `tests/swap-routing.test.ts`, `tests/soroswap.test.ts`, `e2e/specs/19-swap-soroswap.spec.ts`.

² **Mainnet-Gate (v1.2, Nutzer-Entscheidung 11.08.2026):** Der Einsteiger-Modus ist nicht mehr
fest auf Testnet verdrahtet, sonst bleibt genau der Pfad ungetestet, den echte Nutzer gehen.
Stattdessen zwei fail-closed Schranken in `effectiveNetworkId()`:

1. `networkId: 'mainnet'` wirkt **nur zusammen mit** `mainnetAcknowledged: true`. Dieses Flag setzt
   ausschließlich das Gate in den Einstellungen (Tippbestätigung „MAINNET", Muster wie beim
   H4-Reset). Ein bloßes `settings.set`, Migration, wiederhergestelltes Backup, fehlerhafter
   Aufrufer, landet damit auf Testnet, nicht auf echtem Geld. Die Schranke gilt in **beiden**
   Modi, nicht nur im Einsteiger-Modus.
2. Der Einsteiger-Modus akzeptiert nur `BEGINNER_NETWORK_IDS` (Testnet, Mainnet). Futurenet und
   eigene Endpunkte bleiben Debug-Oberflächen und fallen still auf Testnet zurück.

**Sicherheits-Freigaben syncen nie (v1.3):** `mainnetAcknowledged`, `allowedOrigins` und
`developerModeAcknowledged` sind strikt local-only (`LOCAL_ONLY_SETTINGS_KEYS` in
`src/background/storage.ts`); sie werden nie nach `chrome.storage.sync` geschrieben **und**
beim Lesen aus sync ignoriert. Ein synchronisiertes oder wiederhergestelltes Settings-Record
kann das Mainnet-Gate also auf keiner anderen Installation öffnen; jede Freigabe gilt nur auf
dem Gerät, auf dem sie erteilt wurde. Präferenzen (`mode`, Sprache, Theme, `networkId`) syncen
weiter. Neue sicherheitsrelevante Settings-Felder müssen in diese Liste aufgenommen werden.

Begleitend: Host-Permissions für Mainnet werden weiterhin erst bei der Nutzergeste angefragt
(Finding B) und beim Verlassen von Mainnet zusammen mit dem Flag zurückgegeben; die Kopfzeile
zeigt auf Mainnet einen **roten Dauer-Badge** („Hauptnetzwerk · echtes Geld") statt gar keinem;
die kuratierte Assetliste ist netzabhängig (`curatedAssetsFor`), vorher wurden auf Mainnet
Testnet-Issuer angeboten. Tests: `tests/mainnet-gate.test.ts`, `e2e/specs/20-mainnet-gate.spec.ts`,
Live-Beleg: `MAINNET-TEST.md` / `MAINNET-RESULTS.md`.

**UI-Regel:** Der Wechsel ist ein bewusster Akt (Settings → „Entwickler-Modus", mit Warnhinweis)
und danach **dauerhaft sichtbar** (persistenter Badge in der Kopfzeile). Nie automatisch umschalten.
Für Mainnet gilt dieselbe Regel ein zweites Mal: bewusster Akt, dauerhaft sichtbar.

---

## 5. Transaktions-Klartextvorschau (`core/stellar/tx-describe.ts`)

Der wichtigste einzelne Differenzierungsbaustein. Reine Funktion, keine Netzwerk-Seiteneffekte:

```ts
describeTransaction(xdr: string, ctx: DescribeContext): TxDescription
// → { summary: I18nKey+Params, effects: Effect[], warnings: Warning[], raw: string }
```

Muss für jede Operation eine Klartextzeile liefern und mindestens diese Warnungen erkennen:
`SET_OPTIONS` ändert Signer/Schwellenwerte · `CHANGE_TRUST` mit `limit: 0` (Trustline-Löschung) ·
`ACCOUNT_MERGE` (Konto wird geleert) · Path-Payment mit >2 % Slippage · unbekannter Asset-Issuer ·
Empfänger-Konto existiert nicht (→ Mindestreserve fällig) · `sequence`-Sprung.
Für jede Warnung existiert ein DE- und EN-Text. **Unbekannte Operation ⇒ Fail-closed:**
Warnung „Diese Operation können wir nicht in Klartext übersetzen" statt stiller Durchreiche.

### 1.1 Passkey-Entsperrung (`core/crypto/passkey.ts`, 20.08.2026)

**Additiv, nicht ersetzend.** Der Keystore aus §1 bleibt Byte für Byte, was er war. Danebengelegt
wird ein zweiter Datensatz (`passkey.v1`), der einen zufälligen **Vault-Key** zweimal verpackt:
einmal mit dem passwortabgeleiteten Schlüssel (gewöhnliches Keystore-Blob), einmal mit
HKDF-SHA-256 über die **PRF-Ausgabe** des Authenticators. Der Vault liegt unter diesem Vault-Key.
Beide Wege öffnen; keiner lässt sich aus dem anderen berechnen. Geht hier irgendetwas kaputt,
kostet das eine Neueinrichtung — nicht die Wallet.

**PRF oder gar nichts.** Ein Passkey ohne die `prf`-Erweiterung *bestätigt* nur Anwesenheit; er
erzeugt kein Schlüsselmaterial. Ihn trotzdem zum Entsperren zu benutzen hieße, das Entsperr-
geheimnis irgendwo abzulegen, wo die Assertion es erreicht — in einer Extension also in
`storage.local`, direkt neben dem Ciphertext, den es schützen soll. Das ist keine Verschlüsselung,
sondern ein Schloss mit angeklebtem Schlüssel. Kann der Authenticator kein PRF, bietet diese
Wallet gar keine Passkey-Entsperrung an und sagt das auch.

**Das PRF-Salt ist ein lokales Geheimnis.** WebAuthn bindet ein Credential an eine RP-ID, und eine
Extension darf nur eine RP-ID beanspruchen, für die sie eine Host-Berechtigung hält — also die
eigene Domain. Ein Skript auf `aubergine.tech` könnte denselben Authenticator dasselbe PRF
auswerten lassen und bekäme bei *bekanntem* Salt exakt unseren Wrapping-Schlüssel. Das Salt sind
deshalb 32 Zufallsbytes aus der Einrichtung, die nur im Extension-Storage liegen: wer sie lesen
kann, liest den Ciphertext daneben ohnehin.

`https://aubergine.tech/*` steht in `optional_host_permissions`, nicht in `host_permissions` — die
Installation bleibt sauber, die Berechtigung wird aus dem Klick angefragt, der das Feature
einschaltet. Das Einrichten verlangt zusätzlich das Passwort: einen zweiten Schlüssel zur Wallet
darf nur hinzufügen, wer den ersten hat.

**Kein Throttle auf dem Passkey-Pfad.** Die Bremse in `unlock-guard.ts` verteuert *Raten*, und an
32 Byte PRF-Ausgabe eines Authenticators, der vorher User-Verification verlangt hat, ist nichts zu
raten. Würde sie hier zählen, könnte ein veralteter Datensatz die Versuche aufbrauchen, die der
Nutzer für das Passwort braucht — den Weg, der noch funktioniert.

`persistVault()` ist die einzige Stelle, die vom Passkey weiß: sie holt den Vault-Key aus dem
*Passwort*-Wrapper und schreibt die Passkey-Kopie mit, damit `account.add` niemandem mitten in
einer unbeteiligten Aktion einen Fingerabdruck abverlangt. Best effort und *nach* dem
Keystore-Schreiben, damit ein Fehler dort nie ein erfolgreiches `account.add` in einen Fehlschlag
verwandelt. Tests: `tests/passkey.test.ts`.

Bekannte Grenze: Firefox schließt das Extension-Popup, sobald die Credential-Abfrage erscheint
(bugzil.la/2026687). Die Wallet erkennt das und bietet an, sich vorher in einem Tab zu öffnen,
statt den Nutzer einen stillen Fehlschlag entdecken zu lassen.

---

### 5.1 Soroban-Aufrufe (`core/stellar/soroban-describe.ts`, 20.08.2026)

Die Modus-Tabelle in §4 versprach für den Entwickler-Modus „erlaubt, mit Argument-Dekodierung".
Dekodiert wurde bis hierher nichts: jeder Contract-Aufruf, den es je gab, erzeugte dieselbe Zeile
„Smart Contract aufrufen (Funktion aufrufen)". Genau die Unterscheidung, für die die Bestätigung
existiert — ein Swap gegen eine Token-Freigabe mit unbegrenztem Allowance an eine fremde Adresse —
war damit nicht möglich, und für eine Wallet, deren gesamtes Versprechen die Klartextvorschau ist,
war das die teuerste Lücke im Produkt.

`describeInvokeHostFunction()` liest aus dem Envelope, das der Nutzer ohnehin schon hält:
Contract-ID, Funktionssymbol, jedes Argument mit Anzeigetyp (`tx.scv.*`), bei `createContract`
das Executable und den WASM-Hash, bei `uploadContractWasm` die Größe. Dazu den **Autorisierungs-
baum** jedes `SorobanAuthorizationEntry`, breitensuchend abgeflacht, mit Tiefe je Knoten.

Drei Grenzen, die keine Implementierungsdetails sind, sondern die Entwurfsentscheidung:

- **Kein Netzwerkzugriff, keine Contract-Spec, kein ABI, kein Token-Symbol.** Ein Abruf pro
  Bestätigung an einen Endpunkt, den der Ersteller der Transaktion aussucht, wäre ein Orakel für
  „dieser Nutzer signiert gerade" — §3 und §4 schließen das aus.
- **Keine Semantik.** `transfer` wird als Symbol `transfer` gerendert, weil das in den Bytes steht.
  Das Modul behauptet nie zu wissen, dass eine so benannte Funktion etwas überträgt.
- **Harte Schranken** auf Tiefe, Anzahl und Länge jedes gerenderten Werts. Argumente sind
  angreiferkontrollierte Daten in einem 360-px-Popup; ohne Deckel schiebt ein 2-MB-`scvString` den
  Bestätigen-Knopf aus dem Bild und ein Nutzer signiert, damit der Dialog verschwindet.

Neue Warnungen: `SOROBAN_AUTH_FOREIGN_CONTRACT` (die Unterschrift deckt Contracts ab, die die
Zusammenfassung nicht nennt — die Drainer-Form), `SOROBAN_AUTH_THIRD_PARTY` (ein Teil wird von
einer fremden Adresse freigegeben), `SOROBAN_PARTIAL_DECODE` (fail-closed, weich: das Fragment
wird nicht als vollständige Lesart präsentiert).

Der Abschnitt wird in **beiden** Modi gerendert, anders als XDR-Disclosure und Reserve-Aufschlüsselung.
Wer im Einsteiger-Modus überhaupt vor diesem Dialog steht, soll gerade nicht die wenigsten
Informationen bekommen. Tests: `tests/soroban-describe.test.ts`.

---

## 6. Nachrichtenprotokoll (die harte Schnittstelle zwischen den Kontexten)

`src/messaging/protocol.ts` ist die einzige erlaubte Kopplung zwischen Popup und Background.
Discriminated Union, keine `any`, jede Methode mit Zod-Schema validiert:

```
wallet.create | wallet.importMnemonic | wallet.unlock | wallet.lock | wallet.status
account.list  | account.add | account.select | account.balances | account.history
tx.build | tx.describe | tx.sign | tx.submit
dapp.requestConnect | dapp.signXdr        (nur Entwickler-Modus)
settings.get | settings.set
```

Fehler werden als typisierte Codes zurückgegeben (`WALLET_LOCKED`, `BAD_PASSWORD`,
`WEAK_PASSWORD`, `USER_REJECTED`, `NETWORK_ERROR`, `TX_FAILED:<result_code>`), nie als rohe
Exception-Strings, damit die UI sie übersetzen kann.

Konsequenz für Validierung an der Grenze: eine Schema-Regel, die eine **fachliche** Ablehnung
ausdrückt, wirft einen `AppError` aus einem `.transform`, keinen `ZodError` aus einem
`.refine`. `toWireError` erhält `.code` nur für `AppError`; ein roher `ZodError` fällt auf
`INTERNAL_ERROR` zurück und die UI zeigt „ein unerwarteter Fehler ist aufgetreten" für etwas,
das in Wahrheit „das ist keine Gebühr" oder „dieses Passwort ist zu leicht zu erraten" heißt.
So gebaut: `passwordSchema`, `feeOverrideSchema`, `sorobanRpcOverrideParamSchema`. Jeder Code
braucht einen Eintrag in **beiden** Katalogen (`i18n/en.json`, `i18n/de.json`), `i18n.test.ts`
erzwingt das.

Der injizierte Webseiten-Provider (`window.aubergine`) folgt der Freighter-artigen Signatur
(`isConnected`, `getPublicKey`, `signTransaction`, `getNetwork`), damit bestehende Stellar-dApps
ohne Anpassung funktionieren, bewusste Interoperabilitäts-Entscheidung, kein neuer Standard.

---

## 7. Design-Tokens & Marke (geteilt zwischen Extension und Website)

`brand/tokens.json` → generiert CSS-Variablen für beide Seiten. Erste Fassung:

```
--sw-bg #0B0E14   --sw-surface #151A23   --sw-border #232B38
--sw-text #E8ECF3 --sw-muted #94A3B8
--sw-accent #4C8DFF (Aktion)   --sw-success #2ED3A0   --sw-warn #FFB020   --sw-danger #FF5C5C
Schrift: Inter (self-hosted, WOFF2; kein Google-Fonts-CDN wegen DSGVO)
Radius 12px · Popup 360×600px
```

Hell-Modus ist Pflicht (`prefers-color-scheme`), Kontrast mindestens WCAG AA.

---

## 8. Sprache & Terminologie

Alles zweisprachig **DE + EN**. Code, Bezeichner und Code-Kommentare auf Englisch;
nutzersichtbare Strings ausschließlich über i18n-Keys, nie hartcodiert.

Verbindliches Glossar (Einsteiger-Modus vermeidet die Fachbegriffe links):

| Fachbegriff | DE (Einsteiger) | EN (beginner) |
|---|---|---|
| Secret Key / Seed | Wiederherstellungsschlüssel | recovery key |
| Mnemonic (12/24 Wörter) | Wiederherstellungssatz | recovery phrase |
| Trustline | Asset-Freigabe | asset approval |
| Base Reserve | reservierter Kontobetrag | reserved account balance |
| Sign | bestätigen | confirm |
| Testnet | Testnetzwerk (kein echtes Geld) | test network (no real money) |

---

## 9. Qualitäts-Gates (Definition of Done pro Strang)

- **Extension:** `npm run build` erzeugt Chrome- **und** Firefox-Artefakt; `npx tsc --noEmit` und
  `npm test` grün; `core/crypto` und `core/stellar/tx-describe` haben Unit-Tests; kein `any`
  in `core/`; Extension lässt sich entpackt laden und ein Testnet-Payment durchführen.
  *Paketmanager ist npm mit `package-lock.json`, verbindlich, weil die AMO-Quelltextprüfung
  reproduzierbare Build-Kommandos und den passenden Lockfile verlangt (v1.1).*
- **Docs:** jedes Dokument existiert in `docs/de/` und `docs/en/` mit identischer Struktur;
  keine Behauptung über Features, die §4 nicht deckt.
- **Website:** `npm run build` grün, Lighthouse-tauglich (kein Render-Blocking-JS), `/de/` und `/en/`
  vollständig, keine Drittanbieter-Requests, Feature-Vergleichstabelle deckungsgleich mit §4.

## 10. Rechtliche Leitplanke

MiCA-/Self-Custody-Aussagen sind ein Positionierungs-*Entwurf* und in Docs/Website als
juristisch ungeprüft zu kennzeichnen. Keine Renditeversprechen, keine Anlageberatung,
keine Sicherheitsgarantie („nicht auditiert" bis ein Audit vorliegt).
