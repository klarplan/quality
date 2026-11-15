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
  'setup.cfg',
  'tox.ini',
  '.flake8',
  'package.json',
  'composer.json',
  'pyproject.toml',
  'src/a.ts',
]) {
  test(`der Hook lässt ${path} durch`, () => {
    assert.equal(decision(path), 'allow')
  })
}

/**
 * Antwort des Hooks auf einen Aufruf an quality.yml mit echtem Inhalt.
 *
 * @param {string} content aktueller Inhalt von quality.yml
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput ohne file_path
 * @returns {{ decision: string, reason: string }}
 */
function configHook(content, toolName, toolInput) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quality-protect-')))
  try {
    writeFileSync(join(root, 'quality.yml'), content)
    const input = {
      cwd: root,
      tool_name: toolName,
      tool_input: { file_path: join(root, 'quality.yml'), ...toolInput },
    }
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    if (result.stdout.trim() === '') return { decision: 'allow', reason: '' }
    const output = JSON.parse(result.stdout).hookSpecificOutput
    return { decision: output.permissionDecision, reason: output.permissionDecisionReason }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const CONFIG = `version: 1
level: standard
components:
  - { path: '.', stack: laravel, required: [fmt] }
`

test('Fall Looker: der Hook lässt einen Edit durch, der required ergänzt', () => {
  const answer = configHook(CONFIG, 'Edit', {
    old_string: 'required: [fmt]',
    new_string: 'required: [fmt, types, test]',
  })
  assert.equal(answer.decision, 'allow')
})

test('der Hook sperrt einen Edit, der einen Schritt aus required entfernt', () => {
  const answer = configHook(CONFIG, 'Edit', {
    old_string: 'required: [fmt]',
    new_string: 'required: []',
  })
  assert.equal(answer.decision, 'deny')
  assert.match(answer.reason, /required: fmt entfernt/)
})

test('der Hook rechnet replace_all mit', () => {
  const two = `${CONFIG}  - { path: web, stack: laravel, required: [fmt] }\n`
  const all = configHook(two, 'Edit', {
    old_string: 'required: [fmt]',
    new_string: 'required: [fmt, test]',
    replace_all: true,
  })
  assert.equal(all.decision, 'allow')
  // Ohne replace_all ist old_string nicht eindeutig. Edit scheiterte ohnehin.
  const one = configHook(two, 'Edit', {
    old_string: 'required: [fmt]',
    new_string: 'required: [fmt, test]',
  })
  assert.equal(one.decision, 'deny')
})

test('der Hook sperrt einen Edit, dessen old_string fehlt', () => {
  const answer = configHook(CONFIG, 'Edit', { old_string: 'gibt es nicht', new_string: 'x' })
  assert.equal(answer.decision, 'deny')
})

test('der Hook lässt ein Write durch, das schärft, und sperrt eines, das lockert', () => {
  const strict = CONFIG.replace('level: standard', 'level: strict')
  assert.equal(configHook(CONFIG, 'Write', { content: strict }).decision, 'allow')
  const loose = configHook(strict, 'Write', { content: CONFIG })
  assert.equal(loose.decision, 'deny')
  assert.match(loose.reason, /level: strict → standard/)
})

test('der Hook sperrt ein Write mit ungültiger Konfiguration', () => {
  assert.equal(configHook(CONFIG, 'Write', { content: 'components: []\n' }).decision, 'deny')
})

test('Review 6: der Hook rechnet auch bei CRLF-Zeilenenden', () => {
  const crlf = CONFIG.replaceAll('\n', '\r\n')
  const answer = configHook(crlf, 'Edit', {
    old_string: "  - { path: '.', stack: laravel, required: [fmt] }\nfoo",
    new_string: 'x',
  })
  // old_string fehlt auch normalisiert: weiter gesperrt.
  assert.equal(answer.decision, 'deny')
  const tighter = configHook(crlf, 'Edit', {
    old_string: 'level: standard\ncomponents:',
    new_string: 'level: strict\ncomponents:',
  })
  assert.equal(tighter.decision, 'allow')
})
