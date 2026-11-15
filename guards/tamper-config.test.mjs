/**
 * Eine Änderung an quality.yml, die das Gate nur schärft, ist kein Fund.
 *
 * Anlass: Task «looker-linkedin-connector» vom 14./15.11.2026. René gab das OK
 * für `required: [fmt, types, test]`, der Agent kam an Hook und Tamper-Check
 * trotzdem nicht vorbei. Spec: docs/superpowers/specs/2026-11-15-quality-yml-schaerfen-design.md
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runTamper } from './tamper-git.mjs'
import { configLoosenings } from './tamper.mjs'

delete process.env.GITHUB_ACTOR
delete process.env.GITHUB_EVENT_PATH
delete process.env.GITHUB_TOKEN

const BASE = `version: 1
level: standard
baseline: true
configs:
  prettier: own
tamper:
  ignore:
    - examples/
components:
  - { path: '.', stack: laravel, php: '8.3', phpstan_level: 5, required: [fmt] }
`

/**
 * Ersetzt genau eine Stelle in BASE. Scheitert laut, wenn die Stelle fehlt:
 * sonst prüfte der Test unbemerkt die unveränderte Fassung.
 *
 * @param {string} from
 * @param {string} to
 */
function variant(from, to) {
  assert.ok(BASE.includes(from), `Stelle fehlt in BASE: ${from}`)
  return BASE.replace(from, to)
}

test('unveränderte Fassung lockert nichts', () => {
  assert.deepEqual(configLoosenings(BASE, BASE), [])
})

test('Kommentar und Formatierung lockern nichts', () => {
  const after = `# Kommentar\n${variant('level: standard', 'level:   standard   # bleibt')}`
  assert.deepEqual(configLoosenings(BASE, after), [])
})

test('Fall Looker: required ergänzen schärft', () => {
  const after = variant('required: [fmt]', 'required: [fmt, types, test]')
  assert.deepEqual(configLoosenings(BASE, after), [])
})

test('required ergänzen bei einer Komponente ohne required schärft', () => {
  const before = variant(', required: [fmt] }', ' }')
  const after = variant('required: [fmt]', 'required: [fmt, types, test]')
  assert.deepEqual(configLoosenings(before, after), [])
})

test('einen Schritt aus required entfernen lockert', () => {
  const before = variant('required: [fmt]', 'required: [fmt, test]')
  const result = configLoosenings(before, BASE)
  assert.equal(result.length, 1)
  assert.match(result.join('\n'), /required: test entfernt/)
})

test('phpstan_level erhöhen schärft, senken lockert', () => {
  const higher = variant('phpstan_level: 5', 'phpstan_level: 7')
  assert.deepEqual(configLoosenings(BASE, higher), [])
  assert.match(configLoosenings(higher, BASE).join('\n'), /phpstan_level/)
})

test('der effektive phpstan_level zählt, nicht der geschriebene', () => {
  // strict setzt ohne Angabe Level 8. Das Feld zu streichen senkt dann nichts.
  const before = variant('level: standard', 'level: strict').replace(
    'phpstan_level: 5',
    'phpstan_level: 8',
  )
  const after = before.replace(', phpstan_level: 8', '')
  assert.deepEqual(configLoosenings(before, after), [])
  // Unter standard ist der Standard 5. Level 7 zu streichen senkt.
  const seven = variant('phpstan_level: 5', 'phpstan_level: 7')
  assert.match(
    configLoosenings(seven, seven.replace(', phpstan_level: 7', '')).join('\n'),
    /phpstan_level/,
  )
})

test('level standard → strict schärft, strict → standard lockert', () => {
  const strict = variant('level: standard', 'level: strict')
  assert.deepEqual(configLoosenings(BASE, strict), [])
  assert.match(configLoosenings(strict, BASE).join('\n'), /level/)
})

test('baseline true → false schärft, false → true lockert', () => {
  const off = variant('baseline: true', 'baseline: false')
  assert.deepEqual(configLoosenings(BASE, off), [])
  assert.match(configLoosenings(off, BASE).join('\n'), /baseline/)
})

test('configs-Eintrag entfernen schärft, hinzufügen lockert', () => {
  const without = variant('configs:\n  prettier: own\n', '')
  assert.deepEqual(configLoosenings(BASE, without), [])
  assert.match(configLoosenings(without, BASE).join('\n'), /configs\.prettier/)
})

test('tamper.ignore kürzen schärft, erweitern lockert', () => {
  const shorter = variant('tamper:\n  ignore:\n    - examples/\n', '')
  assert.deepEqual(configLoosenings(BASE, shorter), [])
  const longer = variant('    - examples/\n', '    - examples/\n    - src/\n')
  assert.match(configLoosenings(BASE, longer).join('\n'), /tamper\.ignore.*src\//)
})

test('Komponente hinzufügen schärft, entfernen lockert', () => {
  const two = `${BASE}  - { path: frontend, stack: react-ts }\n`
  assert.deepEqual(configLoosenings(BASE, two), [])
  assert.match(configLoosenings(two, BASE).join('\n'), /frontend/)
})

test('Review 1: eine neue Komponente mit test_command lockert', () => {
  const two = `${BASE}  - { path: app, stack: laravel, test_command: 'true' }\n`
  assert.match(configLoosenings(BASE, two).join('\n'), /components\[app\]\.test_command/)
})

test('Review 1: eine neue Komponente mit unbekanntem Schlüssel lockert', () => {
  const two = `${BASE}  - { path: app, stack: laravel, skip_tests: true }\n`
  assert.match(configLoosenings(BASE, two).join('\n'), /components\[app\]\.skip_tests/)
})

test('Review 3: tamper als Skalar lockert, fail closed', () => {
  const before = variant('tamper:\n  ignore:\n    - examples/\n', '')
  assert.match(configLoosenings(before, `${before}tamper: off\n`).join('\n'), /tamper/)
})

test('Review 5: ohne alten Stand nennt die Meldung die neue Datei, keine Lockerung', () => {
  assert.match(configLoosenings(null, BASE).join('\n'), /neu angelegt/)
})

/** @type {[string, string, string][]} */
const CHANGED_FIELDS = [
  ['stack', 'stack: laravel', 'stack: php'],
  ['php', "php: '8.3'", "php: '8.2'"],
]
for (const [field, from, to] of CHANGED_FIELDS) {
  test(`${field} ändern lockert`, () => {
    assert.match(configLoosenings(BASE, variant(from, to)).join('\n'), new RegExp(field))
  })
}

test('test_command ändern lockert', () => {
  const after = variant(' }', ", test_command: 'true' }")
  assert.match(configLoosenings(BASE, after).join('\n'), /test_command/)
})

test('version ändern lockert', () => {
  // version 2 ist ungültig. Das zählt als Lockerung, egal aus welchem Grund.
  assert.notDeepEqual(configLoosenings(BASE, variant('version: 1', 'version: 2')), [])
})

test('ein unbekannter Schlüssel lockert, fail closed', () => {
  assert.match(configLoosenings(BASE, `${BASE}future_gate: off\n`).join('\n'), /future_gate/)
  const inComponent = variant(' }', ', skip_tests: true }')
  assert.match(configLoosenings(BASE, inComponent).join('\n'), /skip_tests/)
})

test('ungültige Konfiguration lockert', () => {
  assert.notDeepEqual(configLoosenings(BASE, 'components: []\n'), [])
  assert.notDeepEqual(configLoosenings('components: []\n', BASE), [])
})

test('fehlende Fassung lockert', () => {
  assert.notDeepEqual(configLoosenings(null, BASE), [])
  assert.notDeepEqual(configLoosenings(BASE, null), [])
})

test('mehrere Lockerungen werden einzeln genannt', () => {
  const loose = variant('required: [fmt]', 'required: []').replace(
    'phpstan_level: 5',
    'phpstan_level: 3',
  )
  assert.equal(configLoosenings(BASE, loose).length, 2)
})

/**
 * Ein Repository mit zwei Commits: der erste legt `before` als quality.yml an,
 * der zweite ersetzt sie durch `after`. `message` ist die Nachricht des zweiten.
 *
 * @param {string} before
 * @param {string} after
 * @param {string} [message]
 * @param {string[]} [ignorePaths] wie bin/quality.mjs sie aus der geprüften quality.yml liest
 */
function exitFor(before, after, message = 'nachher', ignorePaths = []) {
  const root = mkdtempSync(join(tmpdir(), 'quality-config-'))
  try {
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '--quiet')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(root, 'quality.yml'), before)
    git('add', '.')
    git('commit', '--quiet', '-m', 'vorher')
    writeFileSync(join(root, 'quality.yml'), after)
    git('add', '.')
    git('commit', '--quiet', '-m', message)
    return runTamper({ root, base: 'HEAD~1', quiet: true, ignorePaths })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const TIGHTER = variant('required: [fmt]', 'required: [fmt, types, test]')

test('echter Diff: quality.yml schärfen ohne Trailer ist grün', () => {
  assert.equal(exitFor(BASE, TIGHTER), 0)
})

test('echter Diff: quality.yml lockern ohne Trailer blockiert', () => {
  assert.equal(exitFor(TIGHTER, BASE), 1)
})

test('echter Diff: quality.yml lockern mit Trailer eines Menschen ist grün', () => {
  assert.equal(
    exitFor(TIGHTER, BASE, 'nachher\n\nQuality-Exception(protected.changed): Ticket #1'),
    0,
  )
})

test('Review 2: quality.yml, die sich selbst in tamper.ignore einträgt, bleibt ein Fund', () => {
  const self = TIGHTER.replace('    - examples/\n', '    - examples/\n    - quality.yml\n')
  assert.equal(exitFor(TIGHTER, self, 'nachher', ['examples/', 'quality.yml']), 1)
})

// Fall calcup vom 15.11.2026: zwei Komponenten mit path ".", erst laravel,
// dann node-ts. Die Zuordnung nur über path verglich die alte node-ts-
// Komponente mit der neuen laravel-Komponente.
const SAME_PATH = `version: 1
level: standard
components:
  - { path: '.', stack: laravel, php: '8.4.19', required: [fmt, types, test] }
  - { path: '.', stack: node-ts, required: [fmt, test, build] }
`

test('Fall calcup: required ergänzen an der zweiten Komponente mit gleichem path schärft', () => {
  const after = SAME_PATH.replace(
    'required: [fmt, test, build]',
    'required: [fmt, lint, test, build]',
  )
  assert.notEqual(after, SAME_PATH)
  assert.deepEqual(configLoosenings(SAME_PATH, after), [])
})

test('Fall calcup: level strict bei zwei Komponenten mit gleichem path schärft', () => {
  const after = SAME_PATH.replace('level: standard', 'level: strict')
  assert.deepEqual(configLoosenings(SAME_PATH, after), [])
})

test('Fall calcup: required kürzen an der zweiten Komponente bleibt ein Fund', () => {
  const after = SAME_PATH.replace('required: [fmt, test, build]', 'required: [fmt, test]')
  const result = configLoosenings(SAME_PATH, after)
  assert.equal(result.length, 1)
  assert.match(result.join('\n'), /node-ts.*required: build entfernt/)
})

test('Fall calcup: die Reihenfolge der Komponenten tauschen lockert nichts', () => {
  const lines = SAME_PATH.trimEnd().split('\n')
  const swapped = [...lines.slice(0, -2), ...lines.slice(-2).reverse()].join('\n')
  assert.notEqual(swapped, SAME_PATH.trimEnd())
  assert.deepEqual(configLoosenings(SAME_PATH, `${swapped}\n`), [])
})

test('Fall calcup: die zweite Komponente mit gleichem path entfernen lockert', () => {
  const after = SAME_PATH.replace(/ {2}- \{ path: '\.', stack: node-ts.*\n/, '')
  assert.match(configLoosenings(SAME_PATH, after).join('\n'), /node-ts.*Komponente entfernt/)
})

test('gleicher path und gleicher stack doppelt ist mehrdeutig, fail closed', () => {
  const twice = `${BASE}  - { path: '.', stack: laravel, required: [fmt, test] }\n`
  assert.match(configLoosenings(twice, twice).join('\n'), /mehrdeutig/)
  assert.match(configLoosenings(BASE, twice).join('\n'), /mehrdeutig/)
})

test('Review: mehrdeutige Komponenten melden keine erfundene Entfernung', () => {
  const twice = `${BASE}  - { path: '.', stack: laravel, required: [fmt, test] }\n`
  const result = configLoosenings(twice, twice.replace('level: standard', 'level: strict'))
  assert.match(result.join('\n'), /mehrdeutig/)
  assert.doesNotMatch(result.join('\n'), /entfernt/)
  // Erst nachher doppelt: die alte Komponente ist nicht entfernt.
  const added = configLoosenings(BASE, twice).join('\n')
  assert.match(added, /mehrdeutig/)
  assert.doesNotMatch(added, /entfernt/)
})

test('Review: Stack-Wechsel bei geteiltem path nennt den Wechsel', () => {
  const after = SAME_PATH.replace('stack: node-ts', 'stack: react-ts')
  assert.match(configLoosenings(SAME_PATH, after).join('\n'), /stack: node-ts → react-ts/)
})

test('exclude: einen Pfad hinzufügen lockert, entfernen schärft', () => {
  // Wie configs: own stellt ein Ausschluss einen Hinweis des Audits dauerhaft
  // ab. Darum braucht er den Trailer eines Menschen (René, 15.11.2026).
  const one = `${BASE}exclude:\n  - { path: tools/x, reason: Nur Manifest }\n`
  assert.match(configLoosenings(BASE, one).join('\n'), /exclude: neuer Pfad tools\/x/)
  assert.deepEqual(configLoosenings(one, BASE), [])
})

test('exclude: den Grund ändern lockert nicht', () => {
  const before = `${BASE}exclude:\n  - { path: tools/x, reason: Nur Manifest }\n`
  const after = `${BASE}exclude:\n  - { path: tools/x, reason: 'Nur Manifest, kein Code' }\n`
  assert.deepEqual(configLoosenings(before, after), [])
})

test('exclude: derselbe Pfad anders geschrieben lockert nicht', () => {
  const before = `${BASE}exclude:\n  - { path: tools/x, reason: a }\n`
  const after = `${BASE}exclude:\n  - { path: ./tools/x/, reason: a }\n`
  assert.deepEqual(configLoosenings(before, after), [])
})

// Befund 15.11.2026: der Tamper-Check verglich den path einer Komponente als
// rohe Zeichenkette. Gleich gilt, was der Runner gleich behandelt:
// filesForComponent in lib/files.mjs.
const APP = `version: 1
level: standard
components:
  - { path: app, stack: laravel, required: [fmt] }
`

test('components: path mit / am Ende lockert nicht', () => {
  assert.deepEqual(configLoosenings(APP, APP.replace('path: app', 'path: app/')), [])
  assert.deepEqual(configLoosenings(APP.replace('path: app', 'path: app/'), APP), [])
})

test('components: die Meldung zeigt den path wie in quality.yml', () => {
  const after = APP.replace('path: app', 'path: app/').replace('[fmt]', '[]')
  assert.match(configLoosenings(APP, after).join('\n'), /components\[app\]\.required: fmt entfernt/)
})

test('components: anderer path bleibt ein Fund', () => {
  assert.match(
    configLoosenings(APP, APP.replace('path: app', 'path: web')).join('\n'),
    /components\[app\]: Komponente entfernt/,
  )
})

// git nennt die Dateien ohne "./". componentBase fällt "./" darum weg, und
// der Runner findet für "./app" dieselben Dateien wie für "app". Der
// Umschrieb lockert also nicht.
test('components: ./app statt app lockert nicht', () => {
  assert.deepEqual(configLoosenings(APP, APP.replace('path: app', 'path: ./app')), [])
  assert.deepEqual(configLoosenings(APP.replace('path: app', 'path: ./app'), APP), [])
})

test('components: ./ statt . lockert nicht', () => {
  assert.deepEqual(configLoosenings(BASE, variant("path: '.'", "path: './'")), [])
})

test('components: zwei Schreibweisen desselben path sind mehrdeutig, fail closed', () => {
  const two = `${APP}  - { path: app/, stack: laravel, required: [fmt] }\n`
  assert.match(configLoosenings(two, two).join('\n'), /mehrdeutig/)
})
