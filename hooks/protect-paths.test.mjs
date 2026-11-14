/**
 * Welche Dateien der PreToolUse-Hook sperrt.
 *
 * Geprüft wird über den echten Prozess: der Hook liest JSON von stdin und
 * antwortet mit einer Entscheidung auf stdout. Ohne Ausgabe lässt er durch.
 *
 * Die Schutzliste des Tamper-Checks ist seit dem Audit vom 14.11.2026 breiter
 * als die Blockliste des Hooks. Test-Runner-Konfiguration und tsconfig meldet
 * nur der Tamper-Check: ein Agent ändert sie regelmässig legitim.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'protect-paths.mjs')

/**
 * Entscheidung des Hooks für einen Edit an `path`: 'deny' oder 'allow'.
 *
 * @param {string} path
 */
function decision(path) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quality-protect-')))
  try {
    writeFileSync(join(root, 'quality.yml'), 'version: 1\n')
    const input = { cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, path) } }
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    if (result.stdout.trim() === '') return 'allow'
    return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const path of [
  'phpstan.neon',
  'phpstan.dist.neon',
  'ruff.toml',
  'mypy.ini',
  '.eslintrc.json',
  '.oxlintrc.jsonc',
  'quality.yml',
]) {
  test(`der Hook sperrt ${path}`, () => {
    assert.equal(decision(path), 'deny')
  })
}

for (const path of [
  'tsconfig.json',
  'tsconfig.app.json',
  'vitest.config.ts',
  'phpunit.xml',
  'pytest.ini',
  'package.json',
  'composer.json',
  'pyproject.toml',
  'src/a.ts',
]) {
  test(`der Hook lässt ${path} durch`, () => {
    assert.equal(decision(path), 'allow')
  })
}
