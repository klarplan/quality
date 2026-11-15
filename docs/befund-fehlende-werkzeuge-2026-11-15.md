# Befund: Schritte, die in drei Konsumenten nie laufen

Stand: 15.11.2026. Gemessen mit quality auf Commit 065558d (Version 0.2.33).

## Vorgehen

1. Ich habe je Repository die Schritte der Stufe `full` aufgebaut, ohne sie
   auszuführen. Das Skript folgt der Schleife über `config.components` in
   `bin/quality.mjs`.
2. Ich habe den letzten `main`-Lauf des Workflows «Quality» in jedem
   Repository gelesen (`gh run view --log`).
3. Ich habe `quality.yml`, `package.json` und die Dateitypen je Repository
   gelesen.
4. Ich habe oxlint 1.93.0 ohne Konfiguration über calcup und mcp-servers
   laufen lassen. Der Lauf hat keine Datei geändert.

Geprüfte Stände:

| Repository       | Commit `main` | CI-Lauf     |
| ---------------- | ------------- | ----------- |
| calcup           | 0650b2a       | 43686588454 |
| rankscan/website | 3c67a9f       | 43686356063 |
| mcp-servers      | 96421f9       | 43687895636 |

## Ergebnis je Zeile

| Repository       | Komponente              | Schritt | Lokal        | CI           | Ursache                                  |
| ---------------- | ----------------------- | ------- | ------------ | ------------ | ---------------------------------------- |
| calcup           | `.` (node-ts)           | lint    | übersprungen | übersprungen | Werkzeug fehlt: kein Linter eingerichtet |
| calcup           | `.` (node-ts)           | types   | übersprungen | übersprungen | Schritt passt nicht: kein TypeScript     |
| rankscan/website | `.` (node-ts)           | types   | übersprungen | übersprungen | Schritt passt nicht: kein TypeScript     |
| mcp-servers      | alle 9 unter `servers/` | lint    | übersprungen | übersprungen | Werkzeug fehlt: kein Linter eingerichtet |

Der Befund aus dem Task stimmt in allen Zeilen. Lokal und CI zeigen dieselben
Schritte als übersprungen.

Belege:

- calcup hat 0 TypeScript-Dateien und 67 JavaScript-Dateien. Es gibt keine
  `tsconfig.json` und kein `typescript` in den devDependencies.
- rankscan/website hat 0 TypeScript-Dateien und 121 JavaScript-Dateien. Es
  gibt keine `tsconfig.json`. ESLint ist eingerichtet und läuft.
- mcp-servers hat 712 TypeScript-Dateien. tsc läuft in allen 9 Servern. Kein
  Server hat ein `lint`-Skript, und weder oxlint noch eslint ist installiert.

Die Vermutung aus dem Task stimmt damit für calcup und rankscan/website: Beide
Komponenten sind reines JavaScript.

## Empfehlungen

### calcup

**lint: Werkzeug einrichten und in `required` aufnehmen.**

- Optionen: oxlint oder eslint. oxlint braucht keine Konfiguration und läuft
  in 24 ms über 58 Dateien. eslint ist flexibler, braucht aber eine
  `eslint.config.mjs`. Empfehlung: oxlint.
- Messung ohne Konfiguration: 41 Warnungen, 0 Fehler.
- Danach `lint` in `required` der node-ts-Komponente aufnehmen.
- `quality.yml` nennt `level: strict` als nächsten Schritt, sobald ein Linter
  da ist. Unter `strict` werden die 41 Warnungen zu Fehlern. Der Task muss sie
  also zuerst beheben oder bei `standard` bleiben.

**types: bewusst weglassen.** `quality.yml` begründet das schon: «Ohne types:
kein TypeScript». Eine Änderung ist nicht nötig.

### rankscan/website

**types: bewusst weglassen.** `quality.yml` begründet das schon: «types fällt
sauber weg — kein TypeScript». Eine Änderung ist nicht nötig.

Empfehlung: kein Board-Task für rankscan/website.

### mcp-servers

**lint: Werkzeug einrichten und in `required` aller 9 Komponenten aufnehmen.**

- Empfehlung: oxlint, aus denselben Gründen wie bei calcup.
- Messung ohne Konfiguration über `servers/`: rund 25 Warnungen, 0 Fehler.
  Die Zahl habe ich aus der Zeilenzahl der Ausgabe abgeleitet. Sie ist
  ungenau, weil die Zusammenfassungszeile im Lauf fehlte.
- Ort: oxlint in die devDependencies der Wurzel. `findBinary` sucht auch im
  `node_modules/.bin` der Wurzel. Der Image-Build (`npm ci -w servers/<repo>`)
  braucht oxlint nicht, weil im Image kein Lint läuft.
- Ungeprüft: ob ein `lint`-Skript je Server oder der Rückfall auf oxlint der
  bessere Weg ist. Das entscheidet der Umsetzungs-Task.
- Danach den Kommentar «lint fehlt bewusst» in `quality.yml` entfernen.

## Nebenbefunde

Diese Punkte liegen ausserhalb des Tasks. Ich habe nichts daran geändert.

1. rankscan/website, Komponente `.` (php): `test` wird übersprungen («weder
   artisan noch phpunit gefunden»). `quality.yml` begründet das: Das Projekt
   hat keine PHP-Tests.
2. calcup: Der letzte `main`-Lauf ist rot. Ursache ist der Job `audit`, nicht
   quality: `composer audit` meldet CVE-2026-118516 in `symfony/routing`.
   Die Schritte von `quality full` sind dort grün.
