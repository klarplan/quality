# Ausschluss im Audit: Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `exclude:` in `quality.yml` nimmt erkannte Ordner aus `quality audit`
und `quality init`.

**Architecture:** `validateConfig` liest `exclude` als `{ path, reason }[]`.
`runAudit` filtert `detectComponents` gegen diese Liste und gibt die
ausgeschlossenen Einträge im Bericht zurück. `configLoosenings` meldet neue
Pfade.

**Tech Stack:** Node ESM, `node:test`, JSDoc-Typen.

**Spec:** `docs/superpowers/specs/2026-11-15-audit-exclude-design.md`

## Global Constraints

- `path` und `reason` sind Pflicht. Ein leerer Grund ist ein `ConfigError`.
- Ein Pfad gilt für den Ordner und alles darunter.
- Das Gate ändert sich nicht.

## Review Focus

- Pfad mit `./` am Anfang oder `/` am Ende: gilt wie der normierte Pfad.
- Alle erkannten Komponenten ausgeschlossen: Der Bericht nennt die
  Ausnahmen statt nur «Keine Komponente erkannt».
- Pfad, den das Audit gar nicht erkennt: kein Fehler, der Bericht nennt ihn.
- `exclude` als Map statt Liste: `ConfigError`.
- Komponente unterhalb eines ausgeschlossenen Pfads: `ConfigError`.

---

### Task 1: `exclude` in `validateConfig`

**Files:** `lib/config.mjs`, `lib/types.mjs`, Test `lib/config.test.mjs`

**Produces:** `ValidConfig.exclude: Array<{ path: string, reason: string }>`,
Pfade ohne `./` am Anfang und ohne `/` am Ende.

Tests: fehlt → `[]`; gültiger Eintrag wird übernommen und normiert; ohne
`reason`, mit leerem `reason`, ohne `path`, absoluter Pfad, keine Liste,
Pfad gleich einer Komponente, Komponente unterhalb → `ConfigError`.

### Task 2: Audit filtert und berichtet

**Files:** `lib/audit-run.mjs`, `lib/audit-report.mjs`, Tests
`lib/audit-run.test.mjs`, `lib/audit-report.test.mjs`

**Produces:** `AuditReport.excluded: Array<{ path, reason }>`.

Tests: Workspace-Repo mit `quality.yml`, das `servers/gsc-mcp` ausschliesst →
`report.components` leer, `report.excluded` enthält den Eintrag. Bericht
rendert `## Ausgenommen` mit Pfad und Grund, auch wenn keine Komponente
übrig bleibt.

### Task 3: Tamper-Check

**Files:** `guards/tamper.mjs`, Test `guards/tamper-config.test.mjs`

Tests: neuer Pfad → Fund `exclude: neuer Pfad <p>`; entfernter Pfad und
geänderter Grund → kein Fund. `exclude` steht in `CONFIG_KEYS`.

### Task 4: Doku

**Files:** `README.md` (Abschnitt neben `configs:`, Zeile in der
Tamper-Tabelle), `quality.example.yml`, `skills/quality-workflow/SKILL.md`.
