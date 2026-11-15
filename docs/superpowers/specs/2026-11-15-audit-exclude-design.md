# Ausschluss für Komponenten im Audit

Stand: 15.11.2026. Freigegeben von René (Ansatz 1, Trailer-Regel).

## Anlass

`quality audit` (v0.2.32) schlug in adboard die Komponente
`ads-cockpit/browsershot` mit Stack `node-ts` vor. Der Ordner enthält nur
`package.json` und `package-lock.json` für das Prod-Image, keinen Code. René
hat entschieden: Die Komponente kommt nicht ins Gate. Das Audit schlug sie
trotzdem bei jedem Lauf erneut vor, weil es keinen Ausschluss gab.

## Ziel

Ein Projekt nimmt einen erkannten Ordner bewusst aus dem Audit. Der Grund
steht in `quality.yml`. Der Hinweis verschwindet dauerhaft, analog zu
`configs: own`.

Nicht-Ziel: Das Gate ändert sich nicht. Es prüft weiter nur `components:`.

## Ansätze

1. **Block `exclude:` auf oberster Ebene** mit `{ path, reason }`. Gewählt.
   Er ist getrennt von `components:` und klar lesbar.
2. **Eintrag in `components:` mit `exclude:` statt `stack`.** Verworfen.
   Gate-Komponenten und Nicht-Komponenten wären vermischt. Validierung, Gate
   und Tamper-Check bräuchten Sonderfälle.
3. **Glob-Liste wie `tamper.ignore`, ohne Grund.** Verworfen. Der Grund soll
   in der Datei stehen.

## Design

```yaml
exclude:
  - path: ads-cockpit/browsershot
    reason: Nur Manifest für das Prod-Image, kein Code.
```

- `path` und `reason` sind Pflicht. Ein leerer Grund ist ein Fehler.
- `path` ist relativ zur Repo-Wurzel. Er gilt für den Ordner und alles
  darunter, zum Beispiel für Workspaces in diesem Ordner.
- Derselbe Pfad in `components:` und in `exclude:` ist ein Fehler. Eine
  Komponente unterhalb eines ausgeschlossenen Pfads ist ebenfalls ein Fehler.
- `quality audit` misst ausgeschlossene Ordner nicht und schlägt sie nicht
  vor. Der Bericht nennt sie mit Grund in einem eigenen Abschnitt.
- `quality init` übernimmt den Vorschlag des Audits und schlägt sie darum
  auch nicht vor.

## Tamper-Check

Ein neuer Pfad in `exclude:` zählt als Lockerung und braucht einen
`Quality-Exception:`-Trailer. Das entspricht `configs.<key>: neu`: Beide
stellen einen Hinweis dauerhaft ab. Ein entfernter Ausschluss schärft und ist
kein Fund. Eine geänderte Begründung ist kein Fund.
