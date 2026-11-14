# Audit des Gates, 14.11.2026

Stand: quality v0.2.31, Branch `task/optimierung`.

## Die zwei Fragen

**Ist das Gate für unsere Projekte zweckmässig?** Ja, als Mindestschranke. Es
läuft in 16 Repositories mit sechs Stacks aus je einer `quality.yml`. Es blockiert
bei Unklarheit statt durchzulassen. Der Tamper-Check passt zur Arbeit mit
Agenten.

**Stellt es hohe Code-Qualität sicher?** Nein. Es stellt sicher, dass Code
formatiert ist, die Typprüfung besteht und die vorhandenen Tests grün sind. Es
prüft nicht, ob ein Projekt überhaupt lintet, testet oder genug testet. Fehlt
eine Prüfung, meldet das Gate grün.

## Wie ich geprüft habe

- Ich habe README, Runner, Stack-Adapter, Tamper-Check und Hooks gelesen.
- Ich habe 48 konstruierte Diffs durch `analyseDiff` geschickt.
- Ich habe das Gate auf drei Wegwerf-Projekten laufen lassen.
- Ich habe `quality.yml`, Board-Gate, Pins, Pflicht-Checks und die letzten
  CI-Läufe von zehn Repositories gelesen.

Nicht geprüft: Ich habe kein Gate eines Konsumenten ausgeführt. Die Zahlen zu
Tests und Baselines sind gezählte Dateien und Zeilen, keine Messung. Von den
acht Connector-Repositories habe ich bei zweien den Branch-Schutz abgefragt.

## Befunde

### 1. Eine fehlende Prüfung ist grün (hoch)

Ein Schritt ohne Werkzeug, ohne Konfiguration oder ohne Tests endet als
«übersprungen» mit Exit 0. Belegt mit zwei Wegwerf-Projekten unter
`level: strict`:

- node-ts mit einem Typfehler, ohne Werkzeuge: fünf Schritte übersprungen,
  «0 Prüfungen bestanden», Exit 0.
- php mit einem Syntaxfehler, ohne pint, phpstan und Tests: drei Schritte
  übersprungen, «0 Prüfungen bestanden», Exit 0.

Die Sicherung `uninstalledStep` fängt nur den Fall «gar nichts installiert».
Sie fängt nicht den Fall «dieses Werkzeug nutzt das Projekt nicht».

Die Folge in den Projekten: calcup, rankscan/website, die mcp-servers und das
Connector-Frontend haben kein `lint`-Skript. Ob dort trotzdem oxlint oder
eslint läuft, habe ich nicht gemessen. Fehlt beides, hat der JS-Code dort
keinen Linter, und das Gate sagt es nur in einer grauen Zeile.

Dieselbe Regel trifft Tests: ein Projekt ohne Tests besteht `quality full`.

### 2. Der Tamper-Check schützt nicht alle Stellen, die das Gate steuern (hoch)

Diese Änderungen meldet der Check nicht:

| Änderung                                             | Wirkung                                             |
| ---------------------------------------------------- | --------------------------------------------------- |
| `package.json`: `"lint": "true"`, `"test": "exit 0"` | Das Gate ruft genau diese Skripte auf.              |
| `tsconfig.json`: `"strict": false`, neues `exclude`  | Die Typprüfung wird weicher oder kleiner.           |
| `phpstan.dist.neon`                                  | Der Stack liest die Datei, die Schutzliste nicht.   |
| `ruff.toml`, `mypy.ini`, `pyproject.toml`            | Die ganze Python-Konfiguration ist ungeschützt.     |
| `.eslintrc.json`, `.oxlintrc.jsonc`                  | Nur `eslint.config.*` und `.oxlintrc.json` zählen.  |
| `vitest.config.*`, `phpunit.xml`, `pytest.ini`       | Tests lassen sich über die Konfiguration abwählen.  |
| `composer.json`: Skripte                             | Betrifft Projekte mit `test_command` über composer. |

Der PreToolUse-Hook nutzt dieselbe Liste. Ein Agent darf diese Dateien also
auch direkt bearbeiten.

### 3. Der Tamper-Check übersieht gängige Wege, Tests stillzulegen (mittel)

Nicht gemeldet werden:

- `xit(`, `xdescribe(`, `it.skipIf(…)`, `it.todo`, `describe.todo`, `test.fails`
- node:test: `{ skip: true }` und `t.skip()`. Das betrifft quality selbst.
- Pest: `->todo()`. Python: `pytest.importorskip`.
- Eine Testdatei, die jemand umbenennt, zum Beispiel in `a.test.mjs.off`. git
  meldet das als Umbenennung, nicht als Löschung. Belegt mit einem echten
  Commit: «keine Umgehungsmuster im Diff».
- Suppressions in `.mts`, `.cts` und `.svelte`.

Nicht behebbar per Muster ist der Tausch einer Assertion gegen
`expect(true).toBe(true)`. Das fände nur eine Coverage- oder Mutationsmessung.

### 4. Ein Trailer entschuldigt alle Funde des Bereichs (mittel)

`Quality-Exception:` gilt für jeden Fund in `base..HEAD`, nicht für eine Regel.
Jede Lockfile-Änderung braucht heute einen Trailer. Derselbe Commit-Bereich
darf dann auch einen Test löschen oder eine Suppression setzen. Die Funde
bleiben sichtbar, aber gelb statt rot.

### 5. Was das Gate nicht misst (hoch für die Frage nach Qualität)

- **Testabdeckung.** Es gibt keine Schwelle und keine Regel «neuer Code hat
  Tests». Der Code enthält dazu nichts.
- **Ratchet.** Die README sagt, das PHPStan-Level steige per Ratchet. Im Code
  gibt es keinen. Elf von zwölf PHP-Komponenten stehen auf Level 5.
- **Linter-Regeln.** PHP hat keinen Linter. Im JS-Stack gehört er dem Projekt,
  und das Gate prüft nicht, ob er existiert.
- **Abhängigkeiten und Secrets.** `npm audit`, `composer audit` und gitleaks
  laufen nur in `quality audit`, nie in einer Stufe.
- **Komplexität, toter Code, Duplikate.** Kein Werkzeug dafür.

Ob diese Punkte ins Gate gehören, ist eine Entscheidung und kein Fehler. Heute
beantwortet das Gate die Frage «ist etwas kaputt», nicht «ist es gut».

### 6. Das Board-Gate ist je Projekt handgebaut (mittel)

Im Register stehen sieben verschiedene Gate-Befehle. Vier Projekte führen ein
eigenes `scripts/gate.sh`. Das von resplan hat 150 Zeilen und lädt gitleaks
selbst samt Checksumme. Die Unterschiede:

- adboard, agent-desk und die Connectors rufen `quality task --base` auf. Der
  Build fehlt dort, die CI baut.
- resplan und rankscan ergänzen gitleaks selbst, weil das Paket es nicht
  anbietet (Befund 5).
- calcup hat kein Board-Gate. Ein roter Stand landet auf `main`, erst die CI
  meldet ihn.
- 27 weitere Repositories im Register haben kein Board-Gate. Das sind vor allem
  Kundenprojekte. Ob sie eine `quality.yml` führen, habe ich nicht geprüft.

Die Versionen laufen auseinander: adboard, agent-desk und calcup stehen auf
v0.2.25, die Connectors auf v0.2.30 oder v0.2.31. Der Schutz von
`scripts/gate.sh` von heute wirkt nur, wo v0.2.31 installiert ist.

### 7. Die CI setzt das Gate nicht überall durch (mittel)

- Pflicht-Check `quality`: quality, adboard, calcup, resplan, rankscan,
  rankscanpage, rankscanmautic.
- Kein Pflicht-Check: mcp-servers. Kein Branch-Schutz: ga4-connector und
  looker-gads-connector. Die übrigen sechs Connectors habe ich nicht abgefragt.
- agent-desk hat keinen Workflow. Dort prüft nur das Board-Gate.
- rankscan: `main` ist seit acht Läufen rot. Der Job `audit` meldet eine Lücke
  in einem PHP-Paket. Der Job ist kein Pflicht-Check, `deploy-check` lässt also
  durch. Dauerrot auf `main` entwertet das Signal.

## Was gut ist

- Unklare Lagen blockieren: fehlende Basis, kein Merge-Base, leeres `--base`.
- Die Bot-Ausnahme hängt an der GitHub-Signatur, nicht am Autor.
- Baselines dürfen schrumpfen, aber nicht wachsen.
- `deploy-check` und das Release-Skript hängen am grünen `main`.
- Die Grenzen stehen offen in der README.

## Empfehlung

Reihenfolge nach Wirkung je Aufwand:

1. **Erwartete Schritte deklarieren (Befund 1).** `quality.yml` nennt je
   Komponente, welche Schritte Pflicht sind. Ein übersprungener Pflichtschritt
   ist rot. «0 Prüfungen» ist immer rot. Das ist der grösste Hebel, kostet aber
   in jedem Konsumenten eine Zeile und einen Versionssprung.
2. **Schutzliste und Test-Muster ergänzen (Befunde 2 und 3).** Kleine,
   testbare Änderung in `guards/tamper.mjs`. `package.json` braucht eine
   Feldprüfung auf `scripts`, sonst meldet jede neue Abhängigkeit.
3. **Trailer an eine Regel binden (Befund 4).** Zum Beispiel
   `Quality-Exception(dependency.changed): …`. Der Trailer ohne Regel bleibt
   eine Übergangszeit gültig.
4. **`quality gate` als Kommando (Befund 6).** Ein Aufruf für das Board: Stufe,
   Tamper mit Basis, optional gitleaks. Die vier `gate.sh` schrumpfen dann auf
   wenige Zeilen.
5. **Abdeckung und Ratchet (Befund 5).** Erst entscheiden, ob das Gate das
   leisten soll. Der Trade-off: mehr Aussage über Qualität gegen längere Läufe
   und mehr rote Gates in gewachsenen Projekten.

Befund 7 ist Einstellungsarbeit in GitHub und in rankscan, kein Code in diesem
Repository.
