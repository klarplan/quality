/**
 * Apps-Script-Dateien (.gs) in Datei-Läufen.
 *
 * Der Anlass: looker-meta-connector prüft seinen Connector als node-ts-Komponente.
 * prettier liest .gs über einen Override, eslint über `files: ['**\/*.gs']`.
 * quality filterte geänderte .gs-Dateien vorher heraus. `quality fast` meldete
 * dann grün, ohne die Datei geprüft zu haben (gemessen am 15.11.2026, v0.2.32).
 *
 * Geprüft wird über den echten Prozess. prettier und eslint sind Attrappen.
 * Sie schreiben ihre Argumente in eine Logdatei und bestehen immer.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const QUALITY = join(dirname(fileURLToPath(import.meta.url)), 'quality')

/**
 * Ein Repo mit der Komponente connector (node-ts) und einer Datei Code.gs.
 *
 * @param {string[]} linters  Attrappen für den Linter, z. B. ['eslint']
 */
function projekt(linters) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-gs-')))
  const comp = join(dir, 'connector')
  const bin = join(comp, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const devDependencies = /** @type {Record<string, string>} */ ({})
  for (const tool of ['prettier', ...linters]) {
    const script = join(bin, tool)
    writeFileSync(script, `#!/bin/sh\necho "${tool} $*" >> "${join(dir, 'aufrufe.log')}"\nexit 0\n`)
    chmodSync(script, 0o755)
    // Die Version neben dem Binary: eslint ab 9 nutzt die Flat Config.
    mkdirSync(join(comp, 'node_modules', tool), { recursive: true })
    writeFileSync(
      join(comp, 'node_modules', tool, 'package.json'),
      JSON.stringify({ name: tool, version: tool === 'eslint' ? '10.14.0' : '1.87.0' }),
    )
    devDependencies[tool] = '*'
  }
  writeFileSync(join(comp, 'package.json'), JSON.stringify({ devDependencies }))
  writeFileSync(join(comp, 'Code.gs'), 'function getAuthType() {}\n')
  writeFileSync(
    join(dir, 'quality.yml'),
    [
      'version: 1',
      'level: standard',
      'components:',
      '  - path: connector',
      '    stack: node-ts',
      '    required: [fmt, lint]',
      '',
    ].join('\n'),
  )
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\naufrufe.log\n')
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

/** @param {string} dir */
function aufrufe(dir) {
  try {
    return readFileSync(join(dir, 'aufrufe.log'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

/**
 * @param {string[]} linters
 * @param {(dir: string) => void} body
 */
function mit(linters, body) {
  const dir = projekt(linters)
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('quality fast: eine geänderte .gs-Datei geht an prettier und eslint', () => {
  mit(['eslint'], (dir) => {
    writeFileSync(join(dir, 'connector', 'Code.gs'), 'function getAuthType() { var x = 1 }\n')
    const { output, code } = quality(dir, ['fast'])
    assert.equal(code, 0, output)
    const log = aufrufe(dir)
    assert.ok(
      log.some((l) => l.startsWith('prettier ') && l.endsWith(' Code.gs')),
      `prettier ohne Code.gs: ${log.join(' | ')}\n${output}`,
    )
    assert.ok(
      log.some((l) => l.startsWith('eslint ') && l.endsWith(' Code.gs')),
      `eslint ohne Code.gs: ${log.join(' | ')}\n${output}`,
    )
  })
})

test('oxlint liest keine .gs: liegt eslint daneben, prüft eslint die Datei', () => {
  // oxlint 1.87 hat keine Option für weitere Endungen. Mit
  // --no-error-on-unmatched-pattern endet es bei Code.gs ohne Ausgabe mit 0.
  mit(['oxlint', 'eslint'], (dir) => {
    writeFileSync(join(dir, 'connector', 'Code.gs'), 'function getAuthType() { var x = 1 }\n')
    const { output, code } = quality(dir, ['fast'])
    assert.equal(code, 0, output)
    const log = aufrufe(dir)
    assert.ok(
      log.some((l) => l.startsWith('eslint ') && l.endsWith(' Code.gs')),
      `eslint ohne Code.gs: ${log.join(' | ')}\n${output}`,
    )
    assert.ok(!log.some((l) => l.startsWith('oxlint ')), `oxlint aufgerufen: ${log.join(' | ')}`)
  })
})

test('nur oxlint vorhanden: eine .gs-Datei macht den lint-Schritt rot', () => {
  mit(['oxlint'], (dir) => {
    writeFileSync(join(dir, 'connector', 'Code.gs'), 'function getAuthType() { var x = 1 }\n')
    const { output, code } = quality(dir, ['fast'])
    assert.equal(code, 1, output)
    assert.match(output, /oxlint liest keine \.gs-Dateien/)
    assert.ok(!aufrufe(dir).some((l) => l.startsWith('oxlint ')))
  })
})
