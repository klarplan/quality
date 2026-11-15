# Update-Reste der Runner: Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein täglicher Cron entfernt die Reste der Runner-Selbstupdates,
ohne die aktive Version, einen Job oder ein laufendes Update zu stören.

**Architecture:** `provision.sh` schreibt `/etc/cron.daily/runner-update-reste`
als Heredoc. Ein Node-Test liest das Heredoc aus `provision.sh` und führt es
mit `sh` gegen eine nachgebaute Ordnerstruktur aus.

**Tech Stack:** POSIX-sh (dash auf der VM), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-15-runner-update-reste-design.md`

## Global Constraints

- Altersgrenze 60 Minuten für `bin.*`, `externals.*` und den Inhalt von `_work/_update`.
- Vorgaben: `RUNNER_ROOT=/opt/gh-runner`, `RUNNER_WORKER_PATTERN='[R]unner\.Worker'`,
  `RUNNER_LOG='logger -t runner-update-reste'`.
- Prozessprüfung mit `ps -eo args | grep -q "$RUNNER_WORKER_PATTERN"`, nicht mit `pgrep -f`.
- Das Skript läuft unter dash und unter macOS-sh (Test lokal): nur POSIX, `find -mmin`, `sort -V`.
- Keine neue Abhängigkeit.

## Review Focus

- Link `bin` mit absolutem Ziel (`/opt/gh-runner/x/1/bin.2.338.2`): der Vergleich nimmt den Basename.
- Runner-Ordner ohne Link `bin` (z. B. `setup-pnpm`, frischer Ordner): bleibt unberührt.
- Leerer Glob (keine Runner, kein `bin.*`): kein Fehler, Exit 0.
- `_work/_update` fehlt: kein Fehler.
- Version mit zweistelligem Teil (`2.4.10` gegen `2.338.0`): `sort -V` statt Textsortierung.

---

### Task 1: Cron für Update-Reste

**Files:**

- Create: `runner/runner-update-reste.test.mjs`
- Modify: `runner/provision.sh` (neuer Abschnitt nach dem Docker-Aufräum-Cron)
- Modify: `package.json` (Test-Glob um `'runner/*.test.mjs'`)

**Interfaces:**

- Produces: Datei `/etc/cron.daily/runner-update-reste`, Exit 0, eine Logzeile je Löschung.

- [ ] **Step 1: Test schreiben.** Hilfsfunktionen: `script()` liest das
      Heredoc zwischen `cat >/etc/cron.daily/runner-update-reste <<'EOF'` und `EOF`;
      `runner(root, name, {versions, active, update})` baut `bin.<v>`,
      `externals.<v>`, die Links und `_work/_update/x`; `age(path)` setzt
      mtime auf zwei Stunden zurück (rekursiv). Fälle:
  - `entfernt alte Versionen und lässt die aktive stehen`: 2.338.0 und 2.338.2, aktiv 2.338.2 → nur `bin.2.338.2`, `externals.2.338.2` bleiben.
  - `lässt eine frische neue Version stehen`: `bin.2.339.0` jünger als 60 min, aktiv 2.338.2 → bleibt.
  - `entfernt _update nach abgeschlossenem Update`.
  - `lässt _update stehen, solange ein Job läuft`: Kindprozess mit Argument = Muster-Treffer.
  - `lässt _update stehen, wenn bin nicht auf die neueste Version zeigt`.
  - `lässt frisch geänderte _update stehen`.
  - `vergleicht Versionen numerisch` (2.4.10 neben 2.338.0, aktiv 2.338.0).
  - `nimmt absolute Link-Ziele`.
  - `lässt Ordner ohne Link bin unberührt`.
  - `läuft ohne Runner ohne Fehler`.
- [ ] **Step 2:** `node --test runner/runner-update-reste.test.mjs` → FAIL (Heredoc fehlt).
- [ ] **Step 3:** Abschnitt in `provision.sh` schreiben, Glob in `package.json` ergänzen.
- [ ] **Step 4:** `node --test runner/runner-update-reste.test.mjs` → PASS; `npm test` → PASS.
- [ ] **Step 5:** Commit.

### Task 2: Doku

**Files:**

- Modify: `docs/self-hosted-runner.md` (Abschnitt «Grenzen und Betrieb», Wartungstabelle)

- [ ] **Step 1:** Wartungstabelle um `runner-update-reste` ergänzen; Absatz
      zu den Update-Resten (1,4 GB je Runner, Regeln des Crons, Rückweg);
      Regel für Vorher-Sicherungen nach `/root/archiv/<JJJJ-MM>-<thema>/`;
      Betriebslog-Eintrag 15.11.2026 mit den Zahlen aus dem Auftrag.
- [ ] **Step 2:** `npx prettier --check docs/self-hosted-runner.md` → sauber.
- [ ] **Step 3:** Commit.
