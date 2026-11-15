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
