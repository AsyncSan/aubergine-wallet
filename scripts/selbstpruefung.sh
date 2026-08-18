#!/usr/bin/env bash
#
# Stufe-0-Selbstprüfung: die drei Prüfungen vom 18.08.2026, dauerhaft gemacht.
#
# Der Lauf vom 18.08. war einmalig und von Hand. Damit war jeder Befund ab dem
# nächsten `npm install` wieder unbelegt. Dieses Skript hält die drei Prüfungen
# zusammen, die den Aufwand getragen haben, und macht sie zu einem Gate statt zu
# einem Bericht:
#
#   1. addons-linter gegen den gebauten Firefox-Baum   -> 0 Fehler, sonst Abbruch
#   2. npm audit --omit=dev                            -> 0 Meldungen, sonst Abbruch
#   3. Gegenprobe im Artefakt                          -> keine der bekannten
#      verwundbaren Ketten darf in den ausgelieferten Bundles auftauchen
#   4. SBOM (CycloneDX 1.6), Laufzeit und vollständig  -> CRA-Pflichtstück
#
# WARUM PUNKT 2 UND 3 GETRENNT SIND. `npm audit` meldet den ganzen Baum, also
# auch reine Bauzeit-Abhängigkeiten (am 18.08.: 7 Meldungen, 0 davon im
# Artefakt). `--omit=dev` beantwortet die Frage "steckt es in einer
# Laufzeit-Abhängigkeit", Punkt 3 die härtere Frage "steckt es in den Bytes, die
# der Nutzer installiert". Die zweite ist die, mit der man vor einem Store oder
# einem B2B-Kunden geradesteht, und sie ist die einzige, die auch dann noch
# stimmt, wenn ein Bundler eine Abhängigkeit stillschweigend mitzieht.
#
# Aufruf:  npm run pruefen        (aus src/extension-v13)
# Ausgabe: audit-stufe0/ im Repo-Wurzelverzeichnis, JSON zum Nachlesen.
#
# Läuft bewusst OHNE WXT_SOROSWAP_API_KEY: geprüft wird das Artefakt, das
# eingereicht wird. Der Schlüssel darf da nicht drin sein.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
OUT="${STUFE0_OUT:-../../audit-stufe0}"
mkdir -p "$OUT"
FAILED=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '   \033[31mFEHLER\033[0m %s\n' "$1"; FAILED=1; }

# ------------------------------------------------------------------ 1 Linter
step "1/4  addons-linter gegen den Firefox-Bau"
if ! npm run build:firefox >/dev/null 2>&1; then
  bad "build:firefox schlägt fehl"
else
  npx --yes addons-linter .output/firefox-mv3 --output json > "$OUT/addons-linter.json" 2>/dev/null
  ERRORS=$(node -p "JSON.parse(require('fs').readFileSync('$OUT/addons-linter.json','utf8')).summary.errors" 2>/dev/null || echo "?")
  WARNINGS=$(node -p "JSON.parse(require('fs').readFileSync('$OUT/addons-linter.json','utf8')).summary.warnings" 2>/dev/null || echo "?")
  if [ "$ERRORS" = "0" ]; then ok "0 Fehler, $WARNINGS Warnungen"
  else bad "$ERRORS Fehler (siehe $OUT/addons-linter.json)"; fi
fi

# ------------------------------------------------------------------- 2 audit
step "2/4  npm audit"
npm audit --json > "$OUT/npm-audit.json" 2>/dev/null
TOTAL=$(node -p "Object.keys(JSON.parse(require('fs').readFileSync('$OUT/npm-audit.json','utf8')).vulnerabilities||{}).length" 2>/dev/null || echo "?")
PROD=$(npm audit --omit=dev --json 2>/dev/null | node -p "Object.keys(JSON.parse(require('fs').readFileSync(0,'utf8')).vulnerabilities||{}).length" 2>/dev/null || echo "?")
if [ "$PROD" = "0" ]; then ok "0 Meldungen in Laufzeit-Abhängigkeiten ($TOTAL im gesamten Baum, also Bauzeit)"
else bad "$PROD Meldungen in Laufzeit-Abhängigkeiten"; fi

# -------------------------------------------------- 3 Gegenprobe im Artefakt
# Die Ketten, die npm audit am 18.08.2026 gemeldet hat, plus ihre inneren
# Signaturen. Ein Treffer heißt nicht automatisch "verwundbar", aber er heißt:
# die Annahme "nicht im Artefakt" gilt nicht mehr und muss neu geprüft werden.
step "3/4  Gegenprobe: verwundbare Ketten in den gebauten Bundles"
SIGNATURES="elliptic browserify-sign create-ecdh crypto-browserify secp256k1 brorand hmac-drbg"
if ! npm run build:chrome >/dev/null 2>&1; then
  bad "build:chrome schlägt fehl"
else
  HITS=""
  for sig in $SIGNATURES; do
    if grep -rlF "$sig" .output/chrome-mv3 .output/firefox-mv3 --include='*.js' >/dev/null 2>&1; then
      HITS="$HITS $sig"
    fi
  done
  if [ -z "$HITS" ]; then ok "keine der bekannten Ketten im Artefakt"
  else bad "im Artefakt gefunden:$HITS — die Aussage »das ausgelieferte Wallet enthält keine der gemeldeten Schwachstellen« stimmt nicht mehr"; fi
fi

# --------------------------------------------------------------------- 4 SBOM
step "4/4  SBOM (CycloneDX 1.6)"
if npx --yes @cyclonedx/cyclonedx-npm --omit dev --spec-version 1.6 --output-file "$OUT/sbom-runtime.cdx.json" >/dev/null 2>&1 &&
   npx --yes @cyclonedx/cyclonedx-npm --spec-version 1.6 --output-file "$OUT/sbom-full.cdx.json" >/dev/null 2>&1; then
  RT=$(node -p "(JSON.parse(require('fs').readFileSync('$OUT/sbom-runtime.cdx.json','utf8')).components||[]).length")
  ALL=$(node -p "(JSON.parse(require('fs').readFileSync('$OUT/sbom-full.cdx.json','utf8')).components||[]).length")
  ok "$RT Laufzeit-, $ALL Gesamtkomponenten -> $OUT/"
else
  bad "SBOM-Erzeugung fehlgeschlagen"
fi

printf '\n'
if [ "$FAILED" = "0" ]; then printf '\033[32mStufe 0: alles grün.\033[0m\n'; else printf '\033[31mStufe 0: mindestens eine Prüfung ist rot.\033[0m\n'; fi
exit "$FAILED"
