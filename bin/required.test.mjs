/**
 * Pflichtschritte: eine fehlende Prüfung ist rot.
 *
 * Der Anlass: Audit vom 14.11.2026, Befund 1. Ein Schritt ohne Werkzeug endete
 * als «übersprungen» mit Exit 0. Ein Projekt ohne jedes Werkzeug meldete
 * «0 Prüfungen bestanden» und war grün.
 *
 * Geprüft wird über den echten Prozess: erst das Zusammenspiel von
 * quality.yml, Stufe, --only und Stack-Adapter entscheidet, ob ein Skip rot ist.
 * Das Formatierwerkzeug ist eine Attrappe, die immer besteht. Einen Linter gibt
 * es im Projekt nicht, der lint-Schritt wird also übersprungen.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const QUALITY = join(dirname(fileURLToPath(import.meta.url)), 'quality')

/**
 * Baut ein react-ts-Projekt mit einer prettier-Attrappe und ohne Linter.
 *
 * @param {object} [args]
 * @param {string} [args.required]  Zeile `required: …` der Komponente, leer heisst ohne
 * @param {boolean} [args.prettier]  liegt die prettier-Attrappe bereit?
 */
function projekt({ required = '', prettier = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-required-')))
  if (prettier) {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'node_modules', '.bin', 'prettier'), 0o755)
  }
  const yml = [
    'version: 1',
    'level: standard',
    'components:',
    '  - path: "."',
    '    stack: react-ts',
    ...(required ? [`    required: ${required}`] : []),
  ].join('\n')
  writeFileSync(join(dir, 'quality.yml'), `${yml}\n`)
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '-A'],
    ['commit', '-qm', 'Basis'],
  ]) {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  return dir
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function quality(dir, args) {
  try {
    const output = execFileSync(process.execPath, [QUALITY, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    })
    return { output, code: 0 }
  } catch (thrown) {
    const err = /** @type {{ stdout?: string, stderr?: string, status?: number | null }} */ (thrown)
    return { output: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 }
  }
}

/**
 * @param {Parameters<typeof projekt>[0]} setup
 * @param {(dir: string) => void} body
 */
function mit(setup, body) {
  const dir = projekt(setup)
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('ohne required bleibt ein übersprungener Schritt grün', () => {
  mit({}, (dir) => {
    const { output, code } = quality(dir, ['task', '--only', 'fmt,lint'])
    assert.equal(code, 0, output)
    assert.match(output, /1 Prüfung bestanden/)
  })
})

test('ein übersprungener Pflichtschritt ist rot und nennt den Grund', () => {
  mit({ required: '[fmt, lint]' }, (dir) => {
    const { output, code } = quality(dir, ['task', '--only', 'fmt,lint'])
    assert.equal(code, 1, output)
    assert.match(
      output,
      /✗ lint — Pflichtschritt übersprungen: kein lint-Skript, oxlint oder eslint gefunden/,
    )
    assert.match(output, /1 von 2 Prüfungen fehlgeschlagen: lint$/m)
  })
})

test('--only wertet required nur für die ausgeführten Schritte', () => {
  mit({ required: '[fmt, lint]' }, (dir) => {
    const { output, code } = quality(dir, ['task', '--only', 'fmt'])
    assert.equal(code, 0, output)
  })
})

test('ein Datei-Lauf ohne passende Datei bleibt grün, auch mit required', () => {
  mit({ required: '[fmt, lint]' }, (dir) => {
    writeFileSync(join(dir, 'notiz.txt'), 'x\n')
    const { output, code } = quality(dir, ['fix', '--check', '--files', 'notiz.txt'])
    assert.equal(code, 0, output)
  })
})

test('0 Prüfungen bestanden ist rot, auch ohne required', () => {
  mit({ prettier: false }, (dir) => {
    const { output, code } = quality(dir, ['task', '--only', 'fmt,lint'])
    assert.equal(code, 1, output)
    assert.match(output, /Keine Prüfung ist gelaufen/)
  })
})

test('required mit einem Schritt, den der Stack nicht kennt, ist ein Konfigurationsfehler', () => {
  mit({ required: '[fmt, linting]' }, (dir) => {
    const { output, code } = quality(dir, ['task', '--only', 'fmt'])
    assert.equal(code, 2, output)
    assert.match(output, /required.*linting/)
  })
})
