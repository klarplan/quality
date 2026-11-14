# Design: `quality gate` für das Board-Gate

Stand: 14.11.2026, freigegeben von René. Anlass: Audit vom 14.11.2026,
Befunde 5 und 6 (Commit e20fe95, `docs/audit-gate-2026-11-14.md` auf
`task/optimierung`).

## Zweck

Das Board-Gate ist je Projekt handgebaut. Drei Projekte laden gitleaks selbst,
mit eigener Version, eigenen Prüfsummen und eigenem Cache. Das Kommando
`quality gate` hält die gemeinsame Logik im Paket. Ein Projekt-Gate besteht
danach aus der Installation seiner Abhängigkeiten und einem Aufruf.

## Ziele

- Ein Aufruf für das Board: Basis bestimmen, Stufe mit Tamper, optional Secret-Scan.
- gitleaks in fester Version mit Prüfsumme aus dem Paket, für vier Plattformen.
- Jeder Teil läuft, auch nach einem roten Teil. Exit 0 nur bei allem grün.

## Nicht-Ziele

- Keine Installation von Abhängigkeiten (`composer install`, `npm ci`, venv).
- Keine Projekt-Extras (Deploy-Skript-Tests, shellcheck, shfmt).
- Kein Handlauf mitten in einem offenen Merge.
- Kein Abgleich von lokalem `main` mit `origin/main`.
- Keine Umstellung der Konsumenten. Das sind eigene Tasks je Projekt.
- `quality audit` behält seinen gitleaks-Lauf über PATH.

## Anti-Ziele

- Das Gate darf bei Unklarheit nicht grün werden. Ungültige Basis, fehlende
  Prüfsumme, falsche Prüfsumme und «0 Commits gescannt» wegen falscher
  Referenz sind rot oder ein Abbruch.

## Randbedingungen

- `cc` committet den Merge vor dem Gate (agent-desk 31b06a3, `doc/betrieb.md`).
  `CC_INTEGRATION_BASE` ist der Commit-Hash von `main` vor dem Merge.
- rankscan und rankscan-website rufen quality im ddev-Container auf. Dort ist
  die Plattform Linux. Auf dem Mac mini ist das vermutlich arm64.
- Node ≥ 24, keine Laufzeit-Abhängigkeiten im Paket.

## Ansätze

1. **`quality gate` mit `--secrets` (gewählt).** Ein Kommando im Paket. Die
   Skripte schrumpfen auf Installation plus Aufruf. Kostet ein neues Modul für
   gitleaks.
2. **Nur `quality tamper --integration`.** Basis- und Trailer-Logik ins Paket,
   gitleaks bleibt in den Skripten. Kleiner, aber die Skripte laufen weiter
   auseinander. Verworfen: der Trailer im offenen Merge ist seit 31b06a3 nicht
   mehr nötig. Damit bliebe fast nichts für das Paket.
3. **Nur das Register vereinheitlichen.** Kein Code. Verworfen: gitleaks mit
   Prüfsumme lässt sich nicht sinnvoll in eine Register-Zeile schreiben.

## Verhalten

```
quality gate [--base <ref>] [--build] [--secrets] [--quiet]
```

1. **Basis:** `--base`, sonst `CC_INTEGRATION_BASE`, sonst `origin/main`.
   Löst sich die Basis nicht zu einem Commit auf → Exit 2.
2. **Offener Merge:** Gibt es `MERGE_HEAD` → Exit 2 mit dem Hinweis
   «Committe den Merge und starte das Gate erneut».
3. **Stufe:** `task --base <basis>`, mit `--build` `full --base <basis>`.
   Der Tamper-Check läuft in der Stufe mit. Der Stufenlauf ist derselbe Code
   wie bei `quality task`.
4. **Secret-Scan (`--secrets`):**
   - gitleaks 8.30.1. Prüfsummen für darwin_arm64, darwin_x64, linux_arm64,
     linux_x64 stehen im Paket. Andere Plattform → roter Teil mit Meldung.
   - Cache: `${XDG_CACHE_HOME:-$HOME/.cache}/standout-quality/gitleaks-<version>/gitleaks`.
     Fehlt die Datei: laden, Prüfsumme prüfen, entpacken. Falsche Prüfsumme →
     nichts bleibt liegen, roter Teil.
   - Scan 1: `gitleaks git --redact --verbose --log-opts="HEAD --not <basis>" .`
   - Scan 2, nur wenn HEAD ein Merge-Commit ist: `git show --cc --format= HEAD`
     an `gitleaks stdin --redact --verbose`. Grund: `git log -p` zeigt für einen
     Merge-Commit keinen Diff. Was beim Lösen von Konflikten dazukommt, steht
     in keinem Branch-Commit.
   - Beide Scans nehmen `--config .gitleaks.toml`, wenn die Datei im Repo liegt.
5. **Ergebnis:** Alle Teile laufen. Am Ende steht die Liste der roten Teile.
   Exit 0 nur, wenn alle Teile grün sind. Sonst der höchste Code der Teile
   (1 rot, 2 keine Aussage möglich).

## Entscheide von René (14.11.2026)

- gitleaks kommt ins Paket, als `--secrets` von `quality gate`. Kein eigenes
  Kommando `quality secrets`. rankscan-mautic behält seinen gitleaks-Teil.
- Der Build ist Opt-in mit `--build`. Standard ist `task`.
- Abgleich lokal/origin und Trailer im offenen Merge entfallen.

## Offen, nicht Teil dieses Tasks

- Bekommt calcup ein Board-Gate? Gehört in den Folgetask der Umstellung.

## Dem Umsetzer überlassen

- Modulschnitt (`lib/gate.mjs`, `lib/gitleaks.mjs`), Namen der Optionen im Code.
- Wie der Stufenlauf aus `main` in eine wiederverwendbare Funktion wandert.
- Test-Nähte: Download und Prozessaufrufe injizierbar, damit die Tests ohne Netz laufen.
