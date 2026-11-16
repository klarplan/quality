import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runStep as runnerStep } from '../lib/run.mjs'
import reactTs from './react-ts.mjs'

/** @import { StackContext } from '../lib/types.mjs' */

/**
 * Ein git-Repo mit lokalem prettier-Platzhalter. findBinary prüft nur, ob die
 * Datei existiert; ausgeführt wird sie in diesen Tests nie.
 *
 * @returns {string}
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-'))
  execFileSync('git', ['init', '-q', dir])
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), '')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
  writeFileSync(join(dir, 'app.ts'), 'export {}\n')
  return dir
}

/**
 * @param {string} dir
 * @param {Partial<StackContext>} [extra]
 * @returns {StackContext}
 */
function context(dir, extra = {}) {
  return /** @type {StackContext} */ ({
    dir,
    root: dir,
    component: { path: '.', stack: 'react-ts' },
    config: {},
    files: null,
    check: true,
    full: true,
    ...extra,
  })
}

/**
 * Füllt einen Ordner mit so vielen Dateien, dass die Ausgabe von git ls-files
 * über die Standardgrenze von 1 MB steigt: 5000 Namen à 240 Zeichen.
 *
 * @param {string} folder
 * @param {string} ext
 */
function fillFolder(folder, ext) {
  mkdirSync(folder, { recursive: true })
  for (let i = 0; i < 5000; i++) {
    writeFileSync(join(folder, `${String(i).padStart(5, '0')}${'x'.repeat(235)}${ext}`), '')
  }
}

/**
 * Legt ein Skript "git" in einen eigenen Ordner und stellt den Ordner im PATH
 * nach vorn. Das Skript ersetzt git für diesen Test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} script
 */
function fakeGit(t, script) {
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-git-'))
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nREAL_GIT=${real}\n${script}\n`)
  chmodSync(join(bin, 'git'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  t.after(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  })
}

/**
 * @param {StackContext} ctx
 * @returns {string[]}
 */
function fmtArgs(ctx) {
  const step = reactTs.fmt?.(ctx)
  assert.ok(step && 'args' in step && step.args, 'fmt liefert einen ausführbaren Schritt')
  return step.args
}

test('fmt: --write schreibt, --check nicht', (t) => {
  // Im ddev-Container mit Mutagen synct der Runner nach einem schreibenden Schritt.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(reactTs.fmt?.(context(dir, { check: false }))?.writes, true)
  assert.equal(reactTs.fmt?.(context(dir))?.writes, false)
})

test('fmt: eine Datei aus info/exclude fällt aus der Prüfung der ganzen Fläche', (t) => {
  // Das Board legt WORKER.md in jedem Worktree an und schliesst sie nur über
  // info/exclude aus. prettier liest diese Datei nicht.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.', '!WORKER.md'])
})

test('fmt: im verknüpften Worktree gilt info/exclude des gemeinsamen git-Verzeichnisses', (t) => {
  const main = repo()
  const worktree = `${main}-wt`
  t.after(() => {
    rmSync(main, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })
  execFileSync('git', ['-C', main, 'add', '.gitignore', 'app.ts'])
  execFileSync('git', [
    '-C',
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'init',
  ])
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', worktree])
  appendFileSync(join(main, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(worktree, 'WORKER.md'), '# Auftrag\n')
  mkdirSync(join(worktree, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(worktree, 'node_modules', '.bin', 'prettier'), '')

  assert.deepEqual(fmtArgs(context(worktree)), ['--check', '--ignore-unknown', '.', '!WORKER.md'])
})

test('fmt: Einzeldateien aus info/exclude fallen aus der Dateiliste', (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')

  assert.deepEqual(fmtArgs(context(dir, { files: ['app.ts', 'WORKER.md'] })), [
    '--check',
    '--ignore-unknown',
    'app.ts',
  ])
})

test('fmt: bleibt nach dem Filtern keine Datei übrig, entfällt der Schritt', (t) => {
  // Ein Edit an WORKER.md erreicht fmt, denn .md gehört zu den JS-Dateien.
  // prettier ohne Datei-Argument prüft nichts; ein "bestanden" wäre falsch.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')

  const step = reactTs.fmt?.(context(dir, { files: ['WORKER.md'] }))
  assert.ok(step && 'skip' in step && step.skip, 'fmt meldet den Schritt als entfallen')
  // Keine Datei für prettier ist keine fehlende Prüfung, auch nicht als Pflicht.
  assert.equal(step?.nothingToDo, true)
})

test('fmt: Glob-Zeichen im Dateinamen werden für die Negation maskiert', (t) => {
  // prettier liest jedes Argument als Glob. Unmaskiert träfe "!notiz[1].md"
  // die Datei "notiz1.md" und liesse "notiz[1].md" in der Prüfung.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'notiz*\n')
  writeFileSync(join(dir, 'notiz[1].md'), '# Notiz\n')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.', '!notiz\\[1\\].md'])
})

test('fmt: ausserhalb eines git-Repos bleiben die Argumente unverändert', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), '')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.'])
})

test('fmt: ein grosser Ordner aus info/exclude erscheint als ein Muster', (t) => {
  // In resplan schliesst info/exclude /node_modules aus. git listete jede
  // Datei einzeln, über 1 MB Ausgabe. execFileSync brach mit ENOBUFS ab, und
  // WORKER.md landete still wieder in der Prüfung. Je Datei ein Argument
  // sprengte zudem ARG_MAX.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '/cache\nWORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')
  fillFolder(join(dir, 'cache'), '.ts')

  assert.deepEqual(fmtArgs(context(dir)), [
    '--check',
    '--ignore-unknown',
    '.',
    '!WORKER.md',
    '!cache/**',
  ])
})

test('fmt: Einzeldateien in einem Ordner aus info/exclude fallen aus der Dateiliste', (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '/cache\n')
  mkdirSync(join(dir, 'cache'))
  writeFileSync(join(dir, 'cache', 'x.ts'), '')

  assert.deepEqual(fmtArgs(context(dir, { files: ['app.ts', 'cache/x.ts'] })), [
    '--check',
    '--ignore-unknown',
    'app.ts',
  ])
})

test('fmt: scheitert der git-Abgleich, meldet der Schritt einen Hinweis', (t) => {
  // Ein stiller Rückfall auf eine leere Liste nimmt die ausgeschlossenen
  // Dateien wieder in die Prüfung. Der rote Lauf braucht dann eine Erklärung.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // git lehnt ein Verzeichnis als exclude-Datei ab.
  rmSync(join(dir, '.git', 'info', 'exclude'))
  mkdirSync(join(dir, '.git', 'info', 'exclude'))

  const step = reactTs.fmt?.(context(dir))
  assert.ok(
    step && 'note' in step && step.note?.includes('info/exclude'),
    'fmt meldet einen Hinweis',
  )
  assert.deepEqual(step.args, ['--check', '--ignore-unknown', '.'])
})

test('fmt: ein Ordner voller Dateien aus einem Dateimuster erscheint als ein Muster', (t) => {
  // Trifft ein Dateimuster jede Datei eines ungetrackten Ordners, listet git
  // den Ordner und dazu jede Datei einzeln. Die Ausgabe übersteigt 1 MB, und
  // die Einzeldateien sind neben "!logs/**" überflüssig.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '*.log\n')
  fillFolder(join(dir, 'logs'), '.log')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.', '!logs/**'])
})

test('fmt: scheitert git schon beim Finden des git-Verzeichnisses, meldet der Schritt einen Hinweis', (t) => {
  // Ein git vor 2.31 kennt --path-format nicht. Still blieb das nur richtig,
  // solange das Verzeichnis kein Repo ist.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  fakeGit(t, "echo 'error: unknown option' >&2; exit 129")

  const step = reactTs.fmt?.(context(dir))
  assert.ok(
    step && 'note' in step && step.note?.includes('unknown option'),
    'fmt meldet einen Hinweis',
  )
})

test('fmt: der Hinweis übernimmt nur die erste Zeile der git-Meldung', (t) => {
  // Die Zusammenfassung zeigt je Schritt eine Zeile.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  fakeGit(
    t,
    'if [ "$1" = rev-parse ]; then exec "$REAL_GIT" "$@"; fi\n' +
      "printf 'fatal: eins\\nhint: zwei\\n' >&2; exit 128",
  )

  const step = reactTs.fmt?.(context(dir))
  assert.ok(step && 'note' in step && step.note, 'fmt meldet einen Hinweis')
  assert.equal(step.note, '.git/info/exclude nicht ausgewertet (fatal: eins)')
})

/**
 * Ein Projekt mit package.json und Abhängigkeiten, aber ohne node_modules —
 * so wie ein Worktree nach "worktree-setup.sh --no-node".
 *
 * @param {Record<string, unknown>} [pkg] Felder, die das package.json ergänzen
 * @returns {string}
 */
function uninstalled(pkg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-no-modules-'))
  const manifest = {
    name: 'app',
    private: true,
    scripts: { lint: 'eslint src', test: 'vitest', build: 'vite build' },
    devDependencies: { eslint: '^9.0.0', typescript: '^5.0.0', vitest: '^3.0.0' },
    ...pkg,
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  return dir
}

/**
 * Führt einen Schritt aus und gibt Exit-Code und Fehlerausgabe zurück.
 *
 * @param {import('../lib/types.mjs').Step | undefined} step
 * @returns {{ code: number | null, stderr: string }}
 */
function runStep(step) {
  assert.ok(step && !step.skip && step.cmd, 'der Schritt ist ausführbar, nicht übersprungen')
  const run = spawnSync(step.cmd, step.args ?? [], { cwd: step.cwd, encoding: 'utf8' })
  return { code: run.status, stderr: run.stderr }
}

for (const verb of /** @type {const} */ (['fmt', 'lint', 'types', 'test', 'build'])) {
  test(`${verb}: ohne node_modules scheitert der Schritt mit einem Hinweis auf npm ci`, (t) => {
    // Über ein npm-Skript endete der Schritt mit exit 127 und
    // "sh: eslint: command not found". prettier und tsc fielen still weg.
    const dir = uninstalled()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const { code, stderr } = runStep(reactTs[verb]?.(context(dir)))
    assert.equal(code, 1)
    assert.match(stderr, /node_modules fehlt/)
    assert.match(stderr, /npm ci/)
  })
}

test('lint: ohne node_modules nennt der Hinweis den Paketmanager des Projekts', (t) => {
  const dir = uninstalled({ packageManager: 'pnpm@9.12.0' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const { stderr } = runStep(reactTs.lint?.(context(dir)))
  assert.match(stderr, /pnpm install/)
})

test('lint: node_modules in der Repo-Wurzel genügt einer Unterkomponente', (t) => {
  // In einem Monorepo mit Workspaces liegt node_modules oft nur in der Wurzel.
  const root = uninstalled()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules', 'eslint'), { recursive: true })
  const dir = join(root, 'web')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint src' }, devDependencies: { eslint: '^9.0.0' } }),
  )

  const step = reactTs.lint?.(context(dir, { root }))
  assert.ok(step && step.cmd === 'npm', 'das lint-Skript läuft wie bisher')
})

test('types: mit node_modules, aber ohne typescript, entfällt tsc weiterhin', (t) => {
  // Fehlt nur ein Werkzeug, nutzt das Projekt es nicht. Das bleibt ein Skip.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'node_modules', 'eslint'), { recursive: true })

  assert.ok(reactTs.types?.(context(dir))?.skip)
})

test('types: ein package.json ohne Abhängigkeiten braucht kein node_modules', (t) => {
  const dir = uninstalled({ devDependencies: undefined })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.ok(reactTs.types?.(context(dir))?.skip)
})

test('test: ein eigener Testbefehl läuft auch ohne node_modules unverändert', (t) => {
  // Der Befehl aus quality.yml gehört dem Projekt; er braucht vielleicht gar keine Pakete.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const component = /** @type {StackContext['component']} */ ({
    path: '.',
    stack: 'react-ts',
    testCommand: 'node --test',
  })
  const step = reactTs.test?.(context(dir, { component }))
  assert.ok(step && step.cmd === 'node', 'der eigene Testbefehl bleibt')
})

test('lint: ohne Lockfile nennt der Hinweis npm install statt npm ci', (t) => {
  // npm ci bricht ohne package-lock.json ab. Der Hinweis selbst schlüge fehl.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(join(dir, 'package-lock.json'))

  const { stderr } = runStep(reactTs.lint?.(context(dir)))
  assert.match(stderr, /npm install/)
  assert.doesNotMatch(stderr, /npm ci/)
})

test('lint: node_modules der Wurzel ohne die Pakete der Komponente zählt nicht', (t) => {
  // Die Wurzel hat nur ihre eigenen Werkzeuge installiert, etwa husky.
  // Das lint-Skript der Komponente endete sonst wieder mit exit 127.
  const root = uninstalled()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules', 'husky'), { recursive: true })
  const dir = join(root, 'web')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'oxlint src' }, devDependencies: { oxlint: '^1.0.0' } }),
  )

  const { code, stderr } = runStep(reactTs.lint?.(context(dir, { root })))
  assert.equal(code, 1)
  assert.match(stderr, /node_modules fehlt/)
})

test("lint: ein Projekt mit Yarn Plug'n'Play gilt ohne node_modules als installiert", (t) => {
  // Mit nodeLinker: pnp legt yarn nie node_modules an, sondern .pnp.cjs.
  const dir = uninstalled({ packageManager: 'yarn@4.5.0' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '.pnp.cjs'), '')

  const step = reactTs.lint?.(context(dir))
  assert.ok(step && step.cmd !== process.execPath, 'das lint-Skript läuft wie bisher')
})

/* ── node_modules aus dem ddev-Container ──────────────────────────────── */

/*
 * In rankscan installiert worktree-setup.sh node_modules im ddev-Container.
 * Dort liegen nur die Linux-Bindings von rolldown, Tailwind und lightningcss.
 * Vitest und der vite-Build scheiterten auf dem Mac mit "Cannot find native
 * binding". Die Tests nehmen als fremde Plattform immer eine andere als die
 * des Hosts, damit sie auf macOS und im Linux-CI dasselbe prüfen.
 */

/** Eine Plattform, die nicht die des Hosts ist. */
const FOREIGN = process.platform === 'linux' ? 'darwin' : 'linux'

/**
 * Ein installiertes JS-Projekt mit ddev. node_modules/.package-lock.json
 * nennt ein natives Paket für die gewünschte Plattform, so wie npm die Datei
 * nach der Installation schreibt.
 *
 * @param {{ platform: string, scripts?: Record<string, string> }} options
 * @returns {string}
 */
function ddevProject({ platform, scripts = { build: 'vite build' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-ddev-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'app', scripts, devDependencies: { vitest: '^4.0.0' } }),
  )
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  const bin = join(dir, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'vitest'))
  for (const tool of ['prettier', 'tsc', 'vitest', 'oxlint']) writeFileSync(join(bin, tool), '')
  // cpu folgt dem Host: sonst gälte das Binding im x64-CI auch für die
  // Host-Plattform als fremd.
  const binding = `node_modules/@rolldown/binding-${platform}-${process.arch}`
  writeFileSync(
    join(dir, 'node_modules', '.package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/vitest': { version: '4.1.12' },
        [binding]: { version: '1.0.0', os: [platform], cpu: [process.arch], optional: true },
      },
    }),
  )
  mkdirSync(join(dir, '.ddev'))
  writeFileSync(join(dir, '.ddev', 'config.yaml'), 'name: demo\n')
  return dir
}

/**
 * Ersetzt den PATH durch einen Ordner mit einem falschen "ddev". Das Skript
 * schreibt jeden Aufruf in ein Protokoll und meldet den gewünschten Status
 * im Format von "ddev describe -j". approot ist ohne Vorgabe das
 * Arbeitsverzeichnis des Aufrufs, wie bei einem eigenen ddev-Projekt.
 *
 * Optional:
 * - approot: ein fremder Pfad, wie beim Projekt des Haupt-Checkouts.
 * - warn: eine Zeile vor dem JSON, wie sie ein pre-exec-Hook ausgibt.
 * - listing: die Ausgabe von "ls" im Container.
 * - mutagen: ddev meldet mutagen_enabled, wie rankscan-website.
 * - versions: Paketversionen für "cat node_modules/<paket>/package.json".
 *   Ein Paket ohne Eintrag fehlt, cat endet dann mit exit 1.
 * - kept: die Antwort von "node -e" im Container, wie eslintrcKeeps sie
 *   erwartet: die Dateien, die eslint nicht ignoriert.
 * - hang: dieser Aufruf antwortet nie, wie ddev bei hängendem Docker.
 *   Ohne sleep: der PATH enthält nur Builtins.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} status
 * @param {{ approot?: string, warn?: string, listing?: string, mutagen?: boolean, versions?: Record<string, string>, kept?: string[], hang?: 'describe' | 'ls' }} [options]
 * @returns {{ calls: () => string[] }}
 */
function fakeDdev(
  t,
  status,
  { approot, warn, listing, mutagen = false, versions = {}, kept, hang } = {},
) {
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-ddev-'))
  const log = join(bin, 'calls.log')
  // Ohne cat: der PATH enthält nur dieses Verzeichnis, also nur Builtins.
  const listingFile = join(bin, 'listing.txt')
  if (listing !== undefined) writeFileSync(listingFile, listing)
  const root = approot ?? '$(pwd -P)'
  writeFileSync(
    join(bin, 'ddev'),
    `#!/bin/sh
echo "$*" >> "${log}"
${hang === 'describe' ? 'case "$1" in describe) while :; do :; done ;; esac' : ''}
${hang === 'ls' ? 'case "$*" in *" -- ls "*) while :; do :; done ;; esac' : ''}
case "$1" in
  describe)
    ${warn ? `echo "${warn}"` : ':'}
    printf '{"level":"info","msg":"","raw":{"status":"${status}","approot":"%s","mutagen_enabled":${mutagen}}}\\n' "${root}" ;;
  mutagen) ;;
  exec)
    case "$*" in
      *" -- ls "*) if [ -f "${listingFile}" ]; then while IFS= read -r l; do echo "$l"; done < "${listingFile}"; else exit 2; fi ;;
      *" -- cat "*)
        eval "file=\\\${$#}"
        pkg="\${file%/package.json}"
        case "\${pkg##*/}" in
${Object.entries(versions)
  .map(
    ([name, version]) => `          ${name}) echo '{"name":"${name}","version":"${version}"}' ;;`,
  )
  .join('\n')}
          *) exit 1 ;;
        esac ;;
      *" -- node -e "*) ${kept ? `echo '${JSON.stringify(kept)}'` : 'exit 2'} ;;
    esac ;;
esac
`,
  )
  chmodSync(join(bin, 'ddev'), 0o755)
  const path = process.env.PATH
  process.env.PATH = bin
  t.after(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  })
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
  }
}

/** Der Anfang jedes Aufrufs im Container. */
const IN_CONTAINER = ['exec', '--raw', '--dir', '/var/www/html', '--']

test('vitest: node_modules aus dem Container und ddev läuft — vitest läuft im Container', (t) => {
  fakeDdev(t, 'running')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.test?.(context(dir))
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'node_modules/.bin/vitest', 'run'])
})

test('vitest: node_modules für den Host — vitest läuft auf dem Host, ddev bleibt unbefragt', (t) => {
  // So läuft CI und jedes Projekt, das auf dem Host installiert.
  const host = fakeDdev(t, 'running')
  const dir = ddevProject({ platform: process.platform })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.test?.(context(dir))
  assert.equal(step?.cmd, join(dir, 'node_modules', '.bin', 'vitest'))
  assert.deepEqual(host.calls(), [])
})

test('vitest: node_modules aus dem Container, ddev gestoppt — der Schritt nennt ddev start', (t) => {
  fakeDdev(t, 'stopped')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const { code, stderr } = runStep(reactTs.test?.(context(dir)))
  assert.equal(code, 1)
  assert.match(stderr, new RegExp(`node_modules stammt von ${FOREIGN}`))
  assert.match(stderr, /ddev start/)
})

test('build: das npm-Skript läuft im Container', (t) => {
  fakeDdev(t, 'running')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.build?.(context(dir))
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'npm', 'run', '--silent', 'build'])
})

test('tests: test_command läuft im Container', (t) => {
  fakeDdev(t, 'running')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = context(dir)
  ctx.component.testCommand = 'npx vitest run --project unit'
  const step = reactTs.test?.(ctx)
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'npx', 'vitest', 'run', '--project', 'unit'])
})

for (const [verb, tool, rest] of /** @type {const} */ ([
  ['fmt', 'prettier', ['--check', '--ignore-unknown', 'app.ts']],
  ['lint', 'oxlint', ['app.ts']],
  ['types', 'tsc', ['--noEmit']],
])) {
  test(`${verb}: ${tool} läuft im Container`, (t) => {
    // oxlint ist selbst ein natives Paket. Eine Regel für alle Schritte ist
    // sicherer als eine Liste der Werkzeuge, die gerade native Teile haben.
    fakeDdev(t, 'running')
    const dir = ddevProject({ platform: FOREIGN })
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const step = reactTs[verb]?.(context(dir, { files: ['app.ts'] }))
    assert.equal(step?.cmd, 'ddev')
    assert.deepEqual(step?.args, [...IN_CONTAINER, `node_modules/.bin/${tool}`, ...rest])
  })
}

/**
 * Ein Projekt mit genau einem Linter in node_modules, in der genannten
 * Version. Ausgeführt wird der Linter hier nie.
 *
 * @param {import('node:test').TestContext} t
 * @param {'oxlint' | 'eslint'} tool
 * @param {string} version
 * @param {string[]} [configs] Konfigurationsdateien, die angelegt werden
 * @returns {string}
 */
function withLinter(t, tool, version, configs = []) {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { [tool]: version } }))
  writeFileSync(join(dir, 'node_modules', '.bin', tool), '')
  mkdirSync(join(dir, 'node_modules', tool))
  writeFileSync(join(dir, 'node_modules', tool, 'package.json'), JSON.stringify({ version }))
  for (const file of configs) writeFileSync(join(dir, file), '')
  return dir
}

/**
 * @param {string} dir
 * @param {string[] | null} files
 * @returns {string[] | undefined}
 */
const lintArgs = (dir, files) => reactTs.lint?.(context(dir, { files }))?.args

// Hintergrund: Kommentar an LINT_FILE_RUN in react-ts.mjs.
test('lint: oxlint ab 1.60 bricht im Datei-Lauf ohne übrige Datei nicht ab', (t) => {
  const dir = withLinter(t, 'oxlint', '1.60.0')
  assert.deepEqual(lintArgs(dir, ['legacy/alt.ts']), [
    '--no-error-on-unmatched-pattern',
    'legacy/alt.ts',
  ])
})

test('lint: oxlint vor 1.60 kennt die Option nicht und bekommt sie nicht', (t) => {
  const dir = withLinter(t, 'oxlint', '1.59.0')
  assert.deepEqual(lintArgs(dir, ['legacy/alt.ts']), ['legacy/alt.ts'])
})

test('lint: oxlint im vollen Lauf bleibt ohne die Option', (t) => {
  const dir = withLinter(t, 'oxlint', '1.60.0')
  assert.deepEqual(lintArgs(dir, null), [])
})

test('lint: eslint 9 meldet im Datei-Lauf ignorierte Dateien nicht als Warnung', (t) => {
  const dir = withLinter(t, 'eslint', '9.39.5', ['eslint.config.mjs'])
  assert.deepEqual(lintArgs(dir, ['legacy/alt.ts']), ['--no-warn-ignored', 'legacy/alt.ts'])
})

test('lint: eslint 9 im vollen Lauf bleibt ohne --no-warn-ignored', (t) => {
  const dir = withLinter(t, 'eslint', '9.39.5', ['eslint.config.mjs'])
  assert.deepEqual(lintArgs(dir, null), ['.'])
})

test('lint: eslint 9 mit ESLINT_USE_FLAT_CONFIG=false bekommt kein --no-warn-ignored', (t) => {
  const before = process.env.ESLINT_USE_FLAT_CONFIG
  process.env.ESLINT_USE_FLAT_CONFIG = 'false'
  t.after(() => {
    if (before === undefined) delete process.env.ESLINT_USE_FLAT_CONFIG
    else process.env.ESLINT_USE_FLAT_CONFIG = before
  })
  const dir = withLinter(t, 'eslint', '9.39.5', ['.eslintrc.json'])
  assert.deepEqual(lintArgs(dir, ['app.ts']), ['app.ts'])
})

test('lint: eslint 8 mit .eslintrc bekommt kein --no-warn-ignored', (t) => {
  const dir = withLinter(t, 'eslint', '8.57.1', ['.eslintrc.json'])
  assert.deepEqual(lintArgs(dir, ['app.ts']), ['app.ts'])
})

test('lint: eslint 8.57 mit eslint.config.mjs bekommt --no-warn-ignored', (t) => {
  const dir = withLinter(t, 'eslint', '8.57.1', ['eslint.config.mjs'])
  assert.deepEqual(lintArgs(dir, ['app.ts']), ['--no-warn-ignored', 'app.ts'])
})

/**
 * Ersetzt das eslint-Paket durch eine API, die alles unter legacy/ ignoriert.
 * So prüft der Test die Verdrahtung ohne echtes eslint.
 *
 * @param {string} dir
 */
function fakeEslintApi(dir) {
  const pkg = join(dir, 'node_modules', 'eslint')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '8.57.1', main: 'index.js' }))
  writeFileSync(
    join(pkg, 'index.js'),
    'exports.ESLint = class { async isPathIgnored(f) { return f.startsWith("legacy/") } }\n',
  )
}

test('lint: eslint mit .eslintrc bekommt im Datei-Lauf nur Dateien, die es nicht ignoriert', (t) => {
  const dir = withLinter(t, 'eslint', '8.57.1', ['.eslintrc.json'])
  fakeEslintApi(dir)
  assert.deepEqual(lintArgs(dir, ['legacy/alt.ts', 'app.ts']), ['app.ts'])
})

test('lint: ignoriert eslint mit .eslintrc alle Dateien, entfällt der Schritt', (t) => {
  const dir = withLinter(t, 'eslint', '8.57.1', ['.eslintrc.json'])
  fakeEslintApi(dir)
  const step = reactTs.lint?.(context(dir, { files: ['legacy/alt.ts'] }))
  assert.equal(step?.cmd, undefined)
  assert.ok(step?.skip)
  assert.equal(step?.nothingToDo, true)
})

/* ── node_modules nur im ddev-Container ───────────────────────────────── */

/*
 * rankscan-website legt node_modules nur im Container an, in einem eigenen
 * Volume (.ddev/docker-compose.node-modules.yaml). Auf dem Host fehlt der
 * Ordner ganz. Der Hook meldete darum "node_modules fehlt" und blieb nach drei
 * Versuchen rot, obwohl "ddev exec vendor/bin/quality fast" grün war.
 */

/** Die Ausgabe von "ls -1A" im Container: Pakete und Binaries. */
const CONTAINER_LISTING = `/var/www/html/node_modules:
.bin
eslint
prettier
vitest

/var/www/html/node_modules/.bin:
eslint
prettier
vitest
`

/**
 * Ein ddev-Projekt ohne node_modules auf dem Host.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} [extraDeps]
 * @param {string} [eslintConfig]
 * @returns {string}
 */
function containerOnly(t, extraDeps = {}, eslintConfig = 'eslint.config.mjs') {
  const dir = uninstalled({
    devDependencies: { eslint: '^9.0.0', prettier: '^3.0.0', vitest: '^3.0.0', ...extraDeps },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.ddev'))
  writeFileSync(join(dir, '.ddev', 'config.yaml'), 'name: demo\n')
  // Ohne Vorgabe wie rankscan-website: eslint mit Flat Config.
  writeFileSync(join(dir, eslintConfig), '')
  return dir
}

for (const [verb, rest] of /** @type {const} */ ([
  ['fmt', ['node_modules/.bin/prettier', '--check', '--ignore-unknown', 'app.js']],
  ['lint', ['node_modules/.bin/eslint', '--no-warn-ignored', 'app.js']],
  ['test', ['node_modules/.bin/vitest', 'related', '--run', 'app.js']],
])) {
  test(`${verb}: node_modules nur im Container und ddev läuft — der Schritt läuft im Container`, (t) => {
    fakeDdev(t, 'running', { listing: CONTAINER_LISTING, versions: { eslint: '9.39.5' } })
    const dir = containerOnly(t)

    const step = reactTs[verb]?.(context(dir, { files: ['app.js'] }))
    assert.equal(step?.cmd, 'ddev')
    assert.deepEqual(step?.args, [...IN_CONTAINER, ...rest])
  })
}

test('lint: oxlint ab 1.60 nur im Container — der Datei-Lauf behält --no-error-on-unmatched-pattern', (t) => {
  // Review-Befund vom 16.11.2026: die Version kam vom Host und war dort
  // unbekannt. Ohne die Option macht jede ignorierte Datei den Hook rot.
  fakeDdev(t, 'running', {
    listing: '/var/www/html/node_modules:\noxlint\n\n/var/www/html/node_modules/.bin:\noxlint\n',
    versions: { oxlint: '1.60.0' },
  })
  const dir = containerOnly(t, { oxlint: '^1.60.0' })

  const step = reactTs.lint?.(context(dir, { files: ['app.js'] }))
  assert.deepEqual(step?.args, [
    ...IN_CONTAINER,
    'node_modules/.bin/oxlint',
    '--no-error-on-unmatched-pattern',
    'app.js',
  ])
})

test('lint: eslint mit .eslintrc nur im Container — der Filter fragt eslint im Container', (t) => {
  // Review-Befund vom 16.11.2026: der Filter lief mit Host-node gegen ein
  // eslint, das auf dem Host fehlt, und gab alle Dateien ungefiltert zurück.
  const host = fakeDdev(t, 'running', {
    listing: CONTAINER_LISTING,
    versions: { eslint: '8.57.1' },
    kept: ['app.js'],
  })
  const dir = containerOnly(t, {}, '.eslintrc.json')

  const step = reactTs.lint?.(context(dir, { files: ['legacy/alt.js', 'app.js'] }))
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'node_modules/.bin/eslint', 'app.js'])
  // Das Skript ist mehrzeilig. Im Protokoll steht der Aufruf darum über
  // mehrere Zeilen.
  const log = host.calls().join('\n')
  assert.match(log, /exec --raw --dir \/var\/www\/html -- node -e /)
  assert.match(log, /\s+node_modules\/eslint\/package\.json legacy\/alt\.js app\.js$/m)
})

test('lint: eslint vor 8.57 nur im Container mit eslint.config.mjs — kein --no-warn-ignored', (t) => {
  // Review-Befund vom 16.11.2026: bei unbekannter Version entschied die
  // Datei eslint.config.*. eslint vor 8.57 bricht an der Option ab.
  fakeDdev(t, 'running', { listing: CONTAINER_LISTING, versions: { eslint: '8.56.0' } })
  const dir = containerOnly(t)

  const step = reactTs.lint?.(context(dir, { files: ['app.js'] }))
  assert.ok(!step?.args?.includes('--no-warn-ignored'), String(step?.args))
})

test('lint: eslint-Version unbekannt — kein --no-warn-ignored, wie das JSDoc sagt', (t) => {
  fakeDdev(t, 'running', { listing: CONTAINER_LISTING })
  const dir = containerOnly(t)

  const step = reactTs.lint?.(context(dir, { files: ['app.js'] }))
  assert.equal(step?.cmd, 'ddev')
  assert.ok(!step?.args?.includes('--no-warn-ignored'), String(step?.args))
})

test('fmt: ddev mit Mutagen — prettier --write synct vor und nach dem Lauf', async (t) => {
  // rankscan-website, 16.11.2026: ohne Sync zeigte git diff die Datei nach
  // quality fix weiter unformatiert.
  const host = fakeDdev(t, 'running', { listing: CONTAINER_LISTING, mutagen: true })
  const dir = containerOnly(t)

  const step = reactTs.fmt?.(context(dir, { files: ['app.js'], check: false }))
  assert.ok(step)
  assert.equal(step.mutagen, dir)
  assert.equal(step.writes, true)

  const result = await runnerStep(step, { quiet: true })
  assert.equal(result.code, 0, result.output)
  const order = host
    .calls()
    .filter((c) => !c.startsWith('describe') && !c.includes(' -- ls '))
    .map((c) => (c.startsWith('exec') ? c.split(' -- ')[1]?.split(' ')[0] : c))
  assert.deepEqual(order, ['mutagen sync', 'node_modules/.bin/prettier', 'mutagen sync'])
})

for (const [label, make] of /** @type {const} */ ([
  ['build-Skript', (/** @type {StackContext} */ ctx) => reactTs.build?.(ctx)],
  ['lint-Skript', (/** @type {StackContext} */ ctx) => reactTs.lint?.(ctx)],
  [
    'test_command',
    (/** @type {StackContext} */ ctx) => {
      ctx.component.testCommand = 'npx vitest run'
      return reactTs.test?.(ctx)
    },
  ],
])) {
  test(`${label}: ddev mit Mutagen — nach dem Lauf synct der Runner`, async (t) => {
    // Review-Befund vom 16.11.2026: ein Skript des Projekts kann schreiben,
    // etwa "eslint --fix". Ohne Sync danach sah der Host die Änderung nicht.
    const host = fakeDdev(t, 'running', { listing: CONTAINER_LISTING, mutagen: true })
    const dir = containerOnly(t)

    const step = make(context(dir, { check: false }))
    assert.ok(step && !step.skip, String(step?.skip))
    assert.equal(step.writes, true)

    await runnerStep(step, { quiet: true })
    const syncs = host.calls().filter((c) => c === 'mutagen sync')
    assert.equal(syncs.length, 2)
  })
}

test('build: ein Skript auf dem Host trägt writes — der nächste Container-Schritt synct neu', (t) => {
  // Review-Befund 6 vom 16.11.2026: nur Host-Schritte mit writes machen den
  // gemerkten Sync alt. Ein Skript des Projekts kann immer schreiben.
  const dir = ddevProject({ platform: process.platform })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.build?.(context(dir))
  assert.notEqual(step?.cmd, 'ddev')
  assert.equal(step?.writes, true)
})

test('fmt: ddev ohne Mutagen — kein Sync', (t) => {
  fakeDdev(t, 'running', { listing: CONTAINER_LISTING })
  const dir = containerOnly(t)

  const step = reactTs.fmt?.(context(dir, { files: ['app.js'], check: false }))
  assert.equal(step?.mutagen, undefined)
})

test('build: node_modules nur im Container — das npm-Skript läuft im Container', (t) => {
  fakeDdev(t, 'running', { listing: CONTAINER_LISTING })
  const dir = containerOnly(t)

  const step = reactTs.build?.(context(dir))
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'npm', 'run', '--silent', 'build'])
})

test('types: tsc fehlt im Container — der Schritt entfällt mit Hinweis, statt rot zu sein', (t) => {
  // rankscan-website hat kein TypeScript. Im Container meldet quality dort
  // "Werkzeug tsc nicht gefunden"; der Host muss dasselbe sagen.
  fakeDdev(t, 'running', { listing: CONTAINER_LISTING })
  const dir = containerOnly(t)

  const step = reactTs.types?.(context(dir))
  assert.match(String(step?.skip), /tsc/)
})

test('fmt: kein node_modules, ddev gestoppt — der Hinweis nennt ddev start', (t) => {
  fakeDdev(t, 'stopped')
  const dir = containerOnly(t)

  const { code, stderr } = runStep(reactTs.fmt?.(context(dir)))
  assert.equal(code, 1)
  assert.match(stderr, /node_modules fehlt/)
  assert.match(stderr, /ddev start/)
})

test('fmt: auch im Container kein node_modules — der Schritt meldet node_modules fehlt', (t) => {
  fakeDdev(t, 'running')
  const dir = containerOnly(t)

  const { code, stderr } = runStep(reactTs.fmt?.(context(dir)))
  assert.equal(code, 1)
  assert.match(stderr, /node_modules fehlt/)
})

test('fmt: ddev meldet das Projekt eines anderen Checkouts — kein Aufruf im Container', (t) => {
  // FALLE in rankscan-website: Vor worktree-setup.sh heisst das Projekt im
  // Worktree wie das des Haupt-Checkouts. ddev exec prüfte dann fremden Code.
  const host = fakeDdev(t, 'running', { approot: '/anderer/checkout', listing: CONTAINER_LISTING })
  const dir = containerOnly(t)

  const { code, stderr } = runStep(reactTs.fmt?.(context(dir)))
  assert.equal(code, 1)
  assert.match(stderr, /node_modules fehlt/)
  assert.ok(!host.calls().some((call) => call.startsWith('exec')), 'kein ddev exec')
})

test('fmt: ddev läuft für einen anderen Checkout — der Hinweis nennt den Grund statt ddev start', (t) => {
  // Review-Befund vom 16.11.2026: ddev läuft, approot zeigt nur auf einen
  // anderen Checkout. «ddev start» hilft dann nicht.
  fakeDdev(t, 'running', { approot: '/anderer/checkout', listing: CONTAINER_LISTING })
  const dir = containerOnly(t)

  const { code, stderr } = runStep(reactTs.fmt?.(context(dir)))
  assert.equal(code, 1)
  assert.match(stderr, /\/anderer\/checkout/)
  assert.doesNotMatch(stderr, /starte das Projekt mit:\s+ddev start/)
})

/**
 * Setzt das ddev-Budget wie der Post-Edit-Hook, nur kürzer.
 *
 * @param {import('node:test').TestContext} t
 */
function shortDdevBudget(t) {
  const before = process.env.QUALITY_DDEV_TIMEOUT_MS
  process.env.QUALITY_DDEV_TIMEOUT_MS = '300'
  t.after(() => {
    if (before === undefined) delete process.env.QUALITY_DDEV_TIMEOUT_MS
    else process.env.QUALITY_DDEV_TIMEOUT_MS = before
  })
}

for (const hang of /** @type {const} */ (['describe', 'ls'])) {
  test(`fmt: ddev hängt bei "${hang}" — der Schritt meldet «ddev antwortet nicht»`, (t) => {
    // Review vom 16.11.2026: ein Timeout galt als «ddev läuft nicht» oder
    // als «node_modules fehlt». Beides schickt zur falschen Abhilfe.
    shortDdevBudget(t)
    const host = fakeDdev(t, 'running', { listing: CONTAINER_LISTING, hang })
    const dir = containerOnly(t)

    const start = Date.now()
    const { code, stderr } = runStep(reactTs.fmt?.(context(dir, { files: ['app.js'] })))
    assert.ok(Date.now() - start < 5000)
    assert.equal(code, 1)
    assert.match(stderr, /ddev antwortet nicht/)
    assert.doesNotMatch(stderr, /ddev start/)
    assert.doesNotMatch(stderr, /node_modules fehlt/)
    // Nach dem ersten Timeout fragt quality ddev nicht noch einmal.
    const asked = host.calls().filter((c) => c.startsWith(hang === 'ls' ? 'exec' : 'describe'))
    assert.equal(asked.length, 1, asked.join('\n'))
  })
}

test('fmt: eine Warnzeile vor dem JSON von ddev describe stört die Erkennung nicht', (t) => {
  // Der pre-exec-Hook von rankscan-website schreibt vor das JSON eine Zeile.
  fakeDdev(t, 'running', {
    warn: 'Warnung - node_modules im Container veraltet.',
    listing: CONTAINER_LISTING,
  })
  const dir = containerOnly(t)

  const step = reactTs.fmt?.(context(dir, { files: ['app.js'] }))
  assert.equal(step?.cmd, 'ddev')
})
