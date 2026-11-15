# quality.yml schärfen ohne Trailer

Stand: 15.11.2026. Freigegeben von René (Weg C).

## Anlass

Im Task «looker-linkedin-connector» gab René dreimal das OK für
`required: [fmt, types, test]` in `quality.yml`. Der Agent kam trotzdem nicht
durch. Drei Sperren griffen:

1. Der Hook `hooks/protect-paths.mjs` lehnt jeden Edit an `quality.yml` ab.
2. Der Tamper-Check meldet jede Änderung an `quality.yml` als
   `protected.changed`. Nur ein `Quality-Exception:`-Trailer gibt sie frei.
3. Den Trailer setzt nur ein Mensch. Der Klassifikator von Claude Code
   blockierte den Commit mit selbst gesetztem Trailer.

## Ziel

Ein Agent soll das Gate schärfen können, ohne dass René einen Schritt selbst
ausführt. Eine Selbstfreigabe bleibt unmöglich: Lockern braucht weiter den
Trailer eines Menschen.

## Wege

- **A: Freigabe im Board.** Das Board schreibt eine Freigabe, die Hook und
  Tamper-Check anerkennen. Verworfen: Der Agent kann `cc` selbst aufrufen.
  Ein Kanal nur für Menschen fehlt, und der Umbau läge im agent-desk-Repo.
- **B: Hook warnt nur.** Spart den Edit-Schritt, nicht den Commit mit Trailer.
  Verworfen: Der Commit war der Engpass.
- **C: Schärfen ist kein Fund.** Gewählt. Hook und Tamper-Check vergleichen
  den alten mit dem neuen Stand über dieselbe Funktion. Ohne Fund braucht es
  keinen Trailer, also greift Sperre 3 nicht.

## Warum der Hook hier die Richtung kennt

Bei Baselines kennt der Hook keine Richtung. Dort gibt es `quality prune`, und
ein Hand-Edit kann nicht zusichern, die richtigen Einträge zu entfernen. Für
`quality.yml` gibt es kein solches Werkzeug. Beim Schärfen ist zudem jede
Wahl sicher: Schlimmstenfalls wird das Gate rot, und das sieht man.

## Regeln

`configLoosenings(before, after)` in `guards/tamper.mjs` liefert die Liste der
Lockerungen. Eine leere Liste heisst: schärft nur oder ändert nichts. Beide
Fassungen laufen durch `parseYaml` und `validateConfig`. So zählt der
effektive Wert, etwa das Standard-`phpstan_level` je Level.

| Feld                           | Schärfen (kein Fund)                                      | Sonst Lockerung                       |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------- |
| `version`                      | gleich                                                    | anders                                |
| `level`                        | gleich oder `standard` → `strict`                         | `strict` → `standard`                 |
| `baseline`                     | gleich oder `true` → `false`                              | `false` → `true`                      |
| `configs`                      | Einträge entfernt                                         | Eintrag hinzugefügt                   |
| `tamper.ignore`                | Teilmenge des alten                                       | neuer Pfad                            |
| Komponente (Schlüssel `path`)  | hinzugefügt, ohne `test_command` und unbekannte Schlüssel | entfernt, oder neu mit `test_command` |
| `stack`, `php`, `test_command` | gleich                                                    | geändert                              |
| `required`                     | Obermenge des alten                                       | Schritt entfernt                      |
| `phpstan_level` (effektiv)     | gleich oder höher                                         | niedriger                             |
| unbekannte Schlüssel (roh)     | gleich                                                    | geändert                              |

Ist eine Fassung nicht lesbar oder ungültig, gilt das als Lockerung. Kommentare
und Formatierung ändern das Ergebnis nicht.

## Umsetzung

- `PROTECTED_PATHS`: `quality.yml` bekommt `tightenOnly: true`.
- `guards/tamper-git.mjs`: `markConfigTightening` liest beide Fassungen wie
  `markGateFields` und markiert die Datei mit `configOnlyTightens`.
- `analyseDiff` überspringt eine markierte Datei. Umbenennen und Löschen
  bleiben Fund.
- Der Hook rechnet bei `Edit` und `Write` den Zielinhalt aus. Ohne Lockerung
  lässt er durch. Sonst nennt er jede Lockerung einzeln.
- Skill `quality-workflow` und README nennen die Ausnahme.

## Offen

- Ob der Klassifikator einen Commit an `quality.yml` ohne Trailer passieren
  lässt, zeigt erst eine echte Konsumenten-Session.
- Konsumenten bekommen die Änderung mit dem nächsten Release.
