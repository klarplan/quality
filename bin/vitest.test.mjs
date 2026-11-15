/**
 * vitest im Datei-Lauf (`quality task --files …`).
 *
 * Der Anlass: quality rief `vitest run --related <dateien>` auf. Die Option
 * `--related` kennt vitest nicht. Der Aufruf endet mit
 * `CACError: Unknown option --related` und Exit 1. Gemessen am 15.11.2026
 * mit vitest 0.34.6, 1.6.1, 2.1.9, 3.2.7, 4.1.12 und 5.0.5. Für diesen Zweck
 * gibt es den Befehl `vitest related <dateien>`, mit `--run` ohne Watch-Modus.
 *
 * Geprüft wird über den echten Prozess. vitest ist eine Attrappe mit Version
 * 5.0.5. Sie lehnt `--related` ab wie das echte vitest und schreibt sonst
 * ihre Argumente in eine Logdatei.
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

/** Ein Repo mit der Komponente connector (node-ts) und einer Testdatei. */
function projekt() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-vitest-')))
  const comp = join(dir, 'connector')
  const bin = join(comp, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(comp, 'node_modules', 'vitest'), { recursive: true })
  writeFileSync(
    join(comp, 'node_modules', 'vitest', 'package.json'),
    JSON.stringify({ name: 'vitest', version: '5.0.5' }),
  )
  const script = join(bin, 'vitest')
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  if [ "$a" = "--related" ]; then',
      '    echo "CACError: Unknown option \\`--related\\`" >&2',
      '    exit 1',
      '  fi',
      'done',
      `echo "vitest $*" >> "${join(dir, 'aufrufe.log')}"`,
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(script, 0o755)
  writeFileSync(join(comp, 'package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }))
  mkdirSync(join(comp, 'test'))
  writeFileSync(join(comp, 'test', 'connector.test.mjs'), "import { test } from 'vitest'\n")
  writeFileSync(
    join(dir, 'quality.yml'),
    [
      'version: 1',
      'level: standard',
      'components:',
      '  - path: connector',
      '    stack: node-ts',
      '    required: [test]',
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

/** @param {(dir: string) => void} body */
function mit(body) {
  const dir = projekt()
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('quality task --files: vitest läuft als related --run mit den Dateien', () => {
  mit((dir) => {
    const { output, code } = quality(dir, [
      'task',
      '--only',
      'test',
      '--files',
      'connector/test/connector.test.mjs',
    ])
    assert.equal(code, 0, output)
    assert.deepEqual(aufrufe(dir), ['vitest related --run test/connector.test.mjs'], output)
  })
})

test('quality task ohne --files: vitest läuft als run über die ganze Komponente', () => {
  mit((dir) => {
    const { output, code } = quality(dir, ['task', '--only', 'test'])
    assert.equal(code, 0, output)
    assert.deepEqual(aufrufe(dir), ['vitest run'], output)
  })
})
