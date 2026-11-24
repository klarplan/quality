# deploy-check ohne Rulesets-API: Pflicht-Checks aus dem Repo

Stand 24.11.2026. Task «deploy-check ohne Rulesets-API: Pflicht-Checks aus dem Repo lesen».

## Anlass

Die Organisation `standout-ch` läuft im GitHub-Plan «free». René stuft nicht hoch.
Private Repos haben in diesem Plan weder Branch Protection noch Rulesets.

- `repos/<slug>/rules/branches/main` antwortet mit HTTP 403 «Upgrade to GitHub Pro or make this repository public to enable this feature».
- `branches/main.protection.enabled` ist `false` bei resplan, adboard, mcp-stack, connector-stack und calcup.
- `deploy-check` endete darum immer mit «keine Aussage möglich». Jedes Deploy dieser Repos blieb blockiert.

## Ziel

`deploy-check` macht ohne Branch-Schutz-API eine verlässliche Aussage. Das Gate wird dabei nicht weicher.

Nicht Ziel: Branch-Schutz auf `main` herstellen, die Organisation hochstufen.

## Entscheid

Das Projekt führt eine Ersatzliste in `quality.yml`:

```yaml
deploy:
  required_checks: [quality, audit]
```

Die Regeln:

1. Liefert die API Pflicht-Checks, gelten nur diese. Die Ersatzliste zählt dann nicht. _(Call des Workers)_
2. Liefert die API keine, gilt die Ersatzliste. Die Rulesets-Antwort 403 mit «Upgrade to GitHub Pro» zählt als «keine Rulesets». Jede andere Störung bleibt «keine Aussage möglich». _(Call des Workers)_
3. Die Liste kommt aus der `quality.yml` des Ziel-Commits (`git show <sha>:quality.yml`), nie aus dem Arbeitsbaum.
4. `quality` zählt immer mit, auch wenn die Liste ihn nicht nennt. _(Variante C, Entscheid René)_
5. Jeder Eintrag ist an die App GitHub Actions (ID 15368) gebunden. Ein Commit-Status gleichen Namens zählt nicht. _(Call des Workers)_
6. Fehlt die Liste, ist sie leer oder ungültig, endet `deploy-check` mit Exit 2.
7. Der Tamper-Check meldet jeden gestrichenen Eintrag als Lockerung (`protected.changed`). Ein neuer Eintrag schärft und ist kein Fund.

## Warum der Boden `quality`

Der Tamper-Check läuft im CI-Job `quality`. Ein Commit könnte `quality` aus der eigenen Liste streichen.
Der Job würde rot, aber `deploy-check` würde nicht mehr auf ihn warten. Mit dem Boden bleibt `quality` Pflicht.
Streicht ein Commit einen anderen Check, wird `quality` rot, ausser der Commit trägt einen Trailer.
Alle CI-Vorlagen unter `examples/` nennen den Job `quality`. Ein Repo mit anderem Jobnamen blockiert, sichtbar und sicher.

## Verworfene Varianten

- **A – nur Tamper-Regel:** Die Liste gilt, wie sie im Commit steht. Ein Commit, der nur `quality` streicht, wäre grün. Die Lücke bliebe offen.
- **B – Liste wächst nur:** Vereinigung aller Fassungen aus der Git-Historie, Streichen nur mit Trailer. Am strengsten, aber deutlich mehr Code, und ein flacher Clone hätte keine Historie. Das Vertrauensniveau ist dasselbe wie bei C, denn auch dort lockert ein Trailer.

## Umsetzung

- `lib/config.mjs`: `validateDeploy` prüft den Block. `validateConfig` und `deploy-check` nutzen dieselbe Prüfung.
- `lib/deploy-check.mjs`: `fallbackChecks`, Erkennung des 403 «Upgrade to GitHub Pro», Quelle in der Ausgabe.
- `guards/tamper.mjs`: `deploy` ist ein bekannter Schlüssel, `configLoosenings` meldet gestrichene Einträge.
- README, `quality.example.yml`.

## Offen

- Die betroffenen Projekte stellen nach einem Release um. Zuerst per grep feststellen, welche `deploy-check` nutzen.
