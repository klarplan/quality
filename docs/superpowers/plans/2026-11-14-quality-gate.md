# quality gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Kommando `quality gate [--base <ref>] [--build] [--secrets]` für das Board-Gate.

**Architecture:** `lib/gitleaks.mjs` hält Pin, Prüfsummen, Laden und Cache von
gitleaks. `lib/gate.mjs` bestimmt die Basis, prüft den Merge-Zustand und baut
die Secret-Scan-Schritte als normale `Step`-Objekte. `bin/quality.mjs` zieht den
Stufenlauf aus `main` in eine Funktion `runStage` und ruft sie aus
`runGateCommand` auf. Die Secret-Schritte laufen über `runSteps`/`summarize`
aus `lib/run.mjs`.

**Tech Stack:** Node ≥ 24, ESM (`.mjs`), JSDoc-Typen mit tsc, `node:test`. Keine Laufzeit-Abhängigkeit.

**Spec:** `docs/superpowers/specs/2026-11-14-quality-gate-design.md`

## Global Constraints

- gitleaks-Version `8.30.1`. Prüfsummen (aus `gitleaks_8.30.1_checksums.txt`, gelesen 14.11.2026):
  - `darwin_arm64`: `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`
  - `darwin_x64`: `dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709`
  - `linux_arm64`: `e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080`
  - `linux_x64`: `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`
- Download-URL: `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_<plattform>.tar.gz`
- Cache: `${XDG_CACHE_HOME:-$HOME/.cache}/standout-quality/gitleaks-8.30.1/gitleaks`
- Basis: `--base`, sonst `CC_INTEGRATION_BASE`, sonst `origin/main`.
- Exit-Codes: 0 alles grün, 1 rot, 2 keine Aussage möglich (Basis ungültig, offener Merge, Konfigurationsfehler).
- Jeder Teil läuft auch nach einem roten Teil.
- Texte, Kommentare und Commit-Messages auf Deutsch, ein Gedanke pro Satz, Aktiv.
- Kein Versionssprung, kein Push.

## Review Focus

1. Offline oder GitHub nicht erreichbar beim ersten `--secrets`-Lauf: roter Teil mit klarer Meldung, die Stufe läuft trotzdem, Exit ≠ 0. → Test in Task 4.
2. Branch ohne neue Commits (Basis = HEAD): gitleaks scannt 0 Commits, Gate grün. → Test in Task 4.
3. Repo ohne `.gitleaks.toml`: Scan läuft ohne `--config`. → Test in Task 3.
4. Basis als Null-SHA (`0000000`) aus der Umgebung: Exit 2, nicht grün durch übersprungenen Tamper. → Test in Task 4.
5. Abgebrochener Download (Datei halb geschrieben): kein Rest im Cache, nächster Lauf lädt neu. → Test in Task 2.

---

### Task 1: Optionen `gate`, `--build`, `--secrets`

**Files:**

- Modify: `lib/args.mjs` (COMMANDS, Options, parseArgs)
- Test: `lib/args.test.mjs`

**Interfaces:**

- Produces: `COMMANDS` enthält `'gate'`. `Options.build: boolean` (Default `false`), `Options.secretScan: boolean` (Default `false`).
  `options.secrets` bleibt unverändert (gehört zu `audit --no-secrets`).

- [ ] **Step 1: Failing tests schreiben**

```js
test('parseArgs: gate kennt --build und --secrets', () => {
  const o = parseArgs(['gate', '--build', '--secrets', '--base', 'abc123'])
  assert.equal(o.stage, 'gate')
  assert.equal(o.build, true)
  assert.equal(o.secretScan, true)
  assert.equal(o.base, 'abc123')
})
test('parseArgs: gate ohne Schalter baut nicht und scannt nicht', () => {
  const o = parseArgs(['gate'])
  assert.equal(o.build, false)
  assert.equal(o.secretScan, false)
})
test('parseArgs: --build und --secrets gibt es nur für gate', () => {
  assert.throws(() => parseArgs(['task', '--build']), /--build gibt es nur für gate/)
  assert.throws(() => parseArgs(['task', '--secrets']), /--secrets gibt es nur für gate/)
})
test('COMMANDS enthält gate', () => assert.ok(COMMANDS.includes('gate')))
```

- [ ] **Step 2:** `node --test lib/args.test.mjs` → FAIL.
- [ ] **Step 3:** In `lib/args.mjs` umsetzen. Prüfung nach der Schleife, im Stil der bestehenden `--wait`-Prüfung.
- [ ] **Step 4:** `node --test lib/args.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(args): Optionen für quality gate`.

### Task 2: `lib/gitleaks.mjs` — Pin, Prüfsumme, Cache

**Files:**

- Create: `lib/gitleaks.mjs`, `lib/gitleaks.test.mjs`

**Interfaces:**

- Produces:
  - `GITLEAKS_VERSION = '8.30.1'`
  - `GITLEAKS_CHECKSUMS: Readonly<Record<string, string>>` (vier Einträge aus Global Constraints)
  - `gitleaksPlatform(platform: string, arch: string): string | null` — `('darwin','arm64')→'darwin_arm64'`, `('darwin','x64')→'darwin_x64'`, `('linux','arm64')→'linux_arm64'`, `('linux','x64')→'linux_x64'`, sonst `null`.
  - `gitleaksCacheDir(env: NodeJS.ProcessEnv, home: string): string`
  - `ensureGitleaks(opts: { cacheDir: string, platform?: string, arch?: string, checksums?: Record<string,string>, download?: (url: string, file: string) => Promise<void> }): Promise<string>` — gibt den Pfad der ausführbaren Datei zurück. Wirft `Error` mit verständlicher Meldung bei unbekannter Plattform, falscher Prüfsumme oder Download-Fehler.
  - Default-`download`: `fetch` mit Redirect, Body in die Datei schreiben.

Ablauf `ensureGitleaks`: Liegt `<cacheDir>/gitleaks` ausführbar vor → zurückgeben, nichts laden. Sonst nach `<cacheDir>/gitleaks.tar.gz.part` laden, SHA-256 mit `node:crypto` prüfen, mit `tar -xzf <archiv> -C <cacheDir> gitleaks` entpacken, Archiv löschen. Bei jedem Fehler `.part` und Archiv löschen.

- [ ] **Step 1: Failing tests schreiben.** Die Tests bauen ein echtes `.tar.gz` mit einer Attrappe `gitleaks` (`tar -czf`) und berechnen dessen Prüfsumme selbst. `download` kopiert dieses Archiv.

```js
test('gitleaksPlatform: vier Plattformen, sonst null', ...)        // inkl. ('win32','x64') → null
test('gitleaksCacheDir: XDG_CACHE_HOME vor HOME', ...)              // '/x/standout-quality/gitleaks-8.30.1' bzw. '/h/.cache/standout-quality/gitleaks-8.30.1'
test('ensureGitleaks: lädt, prüft und entpackt', ...)               // Pfad endet auf /gitleaks, Datei ausführbar, kein .tar.gz übrig
test('ensureGitleaks: liegt die Datei schon da, lädt es nicht', ...) // download-Attrappe wirft, wenn aufgerufen
test('ensureGitleaks: falsche Prüfsumme lässt nichts liegen', ...)  // rejects /Prüfsumme/, readdirSync(cacheDir) ohne gitleaks und ohne .part
test('ensureGitleaks: abgebrochener Download lässt nichts liegen', ...) // download schreibt halbe Datei und wirft; danach Cache leer; zweiter Lauf mit gutem download liefert Pfad
test('ensureGitleaks: unbekannte Plattform nennt Plattform', ...)   // rejects /win32-x64/
test('GITLEAKS_CHECKSUMS: die vier Prüfsummen aus dem Release', ...) // deepEqual mit den Werten aus Global Constraints
```

- [ ] **Step 2:** `node --test lib/gitleaks.test.mjs` → FAIL.
- [ ] **Step 3:** `lib/gitleaks.mjs` umsetzen.
- [ ] **Step 4:** `node --test lib/gitleaks.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(gitleaks): gepinnte Version mit Prüfsumme und Cache`.

### Task 3: `lib/gate.mjs` — Basis, Merge-Zustand, Secret-Schritte

**Files:**

- Create: `lib/gate.mjs`, `lib/gate.test.mjs`

**Interfaces:**

- Consumes: `gitIn` aus `lib/git.mjs`, `Step` aus `lib/types.mjs`.
- Produces:
  - `resolveBase(option: string | null, env: NodeJS.ProcessEnv): string` — `option ?? env.CC_INTEGRATION_BASE?.trim() || 'origin/main'`. Leeres `CC_INTEGRATION_BASE` zählt als nicht gesetzt.
  - `GateError extends Error` — Fehler mit Exit 2.
  - `assertGateReady(root: string, base: string): void` — wirft `GateError`, wenn `MERGE_HEAD` existiert (Text enthält «Committe den Merge und starte das Gate erneut») oder `base` sich nicht zu einem Commit auflöst (Text enthält die Referenz). Null-SHA löst sich nicht auf und fällt damit hier heraus.
  - `secretScanSteps(opts: { root: string, base: string, binary: string }): Step[]`
    - Schritt 1, Name `gitleaks: Commits`: `cmd: binary`, `args: ['git', '--redact', '--verbose', ...config, '--log-opts=HEAD --not <base>', '.']`, `cwd: root`.
    - Schritt 2 nur, wenn `HEAD^2` existiert, Name `gitleaks: Merge-Commit`: `cmd: 'bash'`, `args: ['-c', 'set -o pipefail; git show --cc --format= HEAD | "$0" stdin --redact --verbose "$@"', binary, ...config]`.
    - `config` = `['--config', '.gitleaks.toml']`, wenn die Datei im Root liegt, sonst `[]`.

- [ ] **Step 1: Failing tests schreiben.** Wegwerf-Repos per `git init` in `mkdtempSync`, wie in `bin/quality.test.mjs`.

```js
test('resolveBase: --base vor CC_INTEGRATION_BASE vor origin/main', ...)
test('resolveBase: leeres CC_INTEGRATION_BASE gilt als nicht gesetzt', ...) // → 'origin/main'
test('assertGateReady: offener Merge bricht ab', ...)       // merge --no-commit mit zwei Branches; throws GateError /Committe den Merge/
test('assertGateReady: unbekannte Basis bricht ab', ...)    // throws GateError /gibtsnicht/
test('assertGateReady: Null-SHA bricht ab', ...)            // base '0000000' → throws GateError
test('secretScanSteps: ohne Merge-Commit nur der Commit-Scan', ...)  // length 1, args enthält '--log-opts=HEAD --not <base>'
test('secretScanSteps: Merge-Commit bekommt zweiten Scan', ...)      // length 2, names wie oben
test('secretScanSteps: .gitleaks.toml nur, wenn vorhanden', ...)     // mit Datei: args enthält '--config'; ohne: nicht
```

- [ ] **Step 2:** `node --test lib/gate.test.mjs` → FAIL.
- [ ] **Step 3:** `lib/gate.mjs` umsetzen.
- [ ] **Step 4:** `node --test lib/gate.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(gate): Basis, Merge-Zustand und Secret-Schritte`.

### Task 4: `runGateCommand` im CLI, Hilfe, README

**Files:**

- Modify: `bin/quality.mjs` (Stufenlauf aus `main` in `runStage(stageName, options)` ziehen; `runGateCommand`; `usage()`)
- Modify: `README.md` (Abschnitt «Board-Gate»: Aufruf, Basis-Regel, `--secrets`, Cache, Beispiel-Registerzeilen aus der Spec)
- Create: `bin/gate.test.mjs`

**Interfaces:**

- Consumes: Task 1 (`build`, `secretScan`), Task 2 (`ensureGitleaks`, `gitleaksCacheDir`, `GITLEAKS_VERSION`), Task 3 (`resolveBase`, `assertGateReady`, `GateError`, `secretScanSteps`).
- Produces: `runStage(stageName: 'task' | 'full' | …, options: Options): Promise<number>` — derselbe Code wie bisher in `main` ab `loadConfig`. `main` ruft ihn für die Stufen auf. Verhalten der bestehenden Stufen bleibt gleich.

Ablauf `runGateCommand(options)`:

1. `base = resolveBase(options.base, process.env)`; Zeile `Basis: <base>` ausgeben.
2. `assertGateReady(root, base)`; `GateError` → Meldung rot, Exit 2.
3. `stageCode = await runStage(options.build ? 'full' : 'task', { ...options, base })`.
4. Mit `secretScan`: `ensureGitleaks({ cacheDir: gitleaksCacheDir(process.env, homedir()) })`. Fehler → roter Teil «gitleaks laden: <Meldung>», Code 1. Sonst `runSteps(secretScanSteps(...))` und `summarize(..., { label: 'quality gate — Secret-Scan (gitleaks 8.30.1)' })`.
5. Schlusszeile: «Gate grün» oder «Gate rot:» plus Liste der roten Teile (`quality task`/`quality full`, `Secret-Scan`). Exit = höchster Code.

- [ ] **Step 1: Failing tests schreiben** in `bin/gate.test.mjs`. Fixture wie `lage()` in `bin/quality.test.mjs`: Repo mit `quality.yml` (react-ts), Attrappe `prettier`. Eine Attrappe `gitleaks` liegt unter `$XDG_CACHE_HOME/standout-quality/gitleaks-8.30.1/gitleaks`. Sie schreibt ihre Argumente und stdin in eine Protokolldatei und endet mit 1, wenn der gescannte Inhalt `SECRET` enthält (Modus `git`: `git log -p` über `--log-opts`; Modus `stdin`: stdin). Jeder Test setzt `XDG_CACHE_HOME` auf ein eigenes Temp-Verzeichnis.

```js
test('gate: offener Merge → Exit 2 mit Hinweis', ...)
test('gate: unbekannte Basis → Exit 2', ...)
test('gate: Null-SHA in CC_INTEGRATION_BASE → Exit 2', ...)
test('gate: CC_INTEGRATION_BASE wird zur Basis', ...)          // output enthält 'Basis: <hash>'
test('gate: ohne --secrets ruft es gitleaks nicht', ...)        // Protokolldatei existiert nicht
test('gate --secrets: Secret im Branch → Exit 1, Secret-Scan rot', ...)
test('gate --secrets: Secret nur in der Konfliktlösung des Merge-Commits → Exit 1', ...)
test('gate --secrets: sauberer Branch → Exit 0, «Gate grün»', ...)
test('gate --secrets: Branch ohne neue Commits → Exit 0', ...)
test('gate --secrets: rote Stufe, Secret-Scan läuft trotzdem', ...)  // UNFORMATTED in eigener Datei; Protokoll existiert; Exit 1; Schluss nennt beide roten Teile wenn beide rot
test('gate --secrets: gitleaks nicht ladbar → roter Teil, Stufe lief', ...) // XDG_CACHE_HOME auf Datei statt Ordner → ensureGitleaks scheitert ohne Netz; Exit 1; output enthält 'gitleaks laden'
test('gate --build: läuft die Stufe full', ...)                 // output enthält 'quality full'
```

- [ ] **Step 2:** `node --test bin/gate.test.mjs` → FAIL.
- [ ] **Step 3:** `runStage` herausziehen, `runGateCommand` und Hilfetext ergänzen, README-Abschnitt schreiben.
- [ ] **Step 4:** `npm test` → alle PASS (auch `bin/quality.test.mjs` unverändert grün).
- [ ] **Step 5:** `node bin/quality full` → grün.
- [ ] **Step 6:** Commit `feat: quality gate für das Board-Gate`.

### Task 5: Abnahme von Hand

- [ ] **Step 1:** `node bin/quality gate --base origin/main --secrets` in diesem Worktree. Erwartet: echtes gitleaks wird geladen (Prüfsumme ok), Exit 0.
- [ ] **Step 2:** Zweiter Lauf: lädt nicht neu (kein Download in der Ausgabe).
- [ ] **Step 3:** Ergebnis und offene Punkte an René melden: calcup-Gate, Folge-Tasks je Konsument (resplan, rankscan, rankscan-website, Connectors, adboard, agent-desk, mcp-servers, quality selbst).
