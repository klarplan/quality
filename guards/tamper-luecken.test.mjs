/**
 * Lücken aus dem Audit vom 14.11.2026 (docs/audit-gate-2026-11-14.md).
 *
 * Jeder Test hier war vor der Änderung rot: der Tamper-Check meldete die
 * Umgehung nicht. Die Gegenproben sichern, dass gewöhnliche Arbeit keinen
 * Fund erzeugt — eine neue Abhängigkeit, ein neues Skript, ein Versionssprung.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { runTamper } from './tamper-git.mjs'
import * as tamper from './tamper.mjs'

const { analyseDiff, parseDiff, PROTECTED_PATHS, SOURCE_FILE } = tamper

delete process.env.GITHUB_ACTOR
delete process.env.GITHUB_EVENT_PATH
delete process.env.GITHUB_TOKEN

/**
 * Regeln, die eine geänderte Datei auslöst.
 *
 * @param {string} path
 * @param {string[]} [added]
 * @param {string[]} [removed]
 */
function rulesFor(path, added = ['x'], removed = []) {
  const file = {
    path,
    deleted: false,
    added: added.map((text, index) => ({ line: index + 1, text })),
    removed: removed.map((text) => ({ text })),
  }
  return analyseDiff([file]).map((finding) => finding.rule)
}

/**
 * Ein Repository mit zwei Commits: `before` und `after` je als Dateiliste.
 *
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 */
function twoCommits(before, after) {
  const root = mkdtempSync(join(tmpdir(), 'quality-luecken-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  const write = (/** @type {Record<string, string>} */ files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  write(before)
  git('add', '.')
  git('commit', '--quiet', '-m', 'vorher')
  write(after)
  git('add', '.')
  git('commit', '--quiet', '-m', 'nachher')
  return { root, git }
}

/**
 * Exit-Code des Tamper-Checks über den zweiten Commit.
 *
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 */
function tamperExit(before, after) {
  const { root } = twoCommits(before, after)
  try {
    return runTamper({ root, base: 'HEAD~1', quiet: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const json = (/** @type {unknown} */ value) => JSON.stringify(value, null, 2) + '\n'

// ── Schutzliste ────────────────────────────────────────────────────────────

for (const path of [
  'phpstan.dist.neon',
  'backend/phpstan.dist.neon',
  'ruff.toml',
  '.ruff.toml',
  'mypy.ini',
  '.mypy.ini',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  'frontend/.eslintrc.yml',
  '.oxlintrc.jsonc',
  'tsconfig.json',
  'frontend/tsconfig.app.json',
  'vitest.config.ts',
  'vitest.config.mjs',
  'phpunit.xml',
  'phpunit.xml.dist',
  'pytest.ini',
]) {
  test(`Schutzliste: eine Änderung an ${path} meldet protected.changed`, () => {
    assert.deepEqual(rulesFor(path), ['protected.changed'])
  })
}

test('Schutzliste: gewöhnliche Dateien mit ähnlichem Namen bleiben frei', () => {
  for (const path of ['src/tsconfig.ts', 'docs/phpunit.xml.md', 'src/vitest.config.test.ts']) {
    assert.ok(!rulesFor(path).includes('protected.changed'), path)
  }
})

test('Schutzliste: Test-Runner und tsconfig sperrt der Hook nicht', () => {
  const blocked = (/** @type {string} */ path) =>
    PROTECTED_PATHS.some((entry) => entry.pattern.test(path) && !entry.reportOnly)
  for (const path of [
    'tsconfig.json',
    'tsconfig.app.json',
    'vitest.config.ts',
    'phpunit.xml',
    'pytest.ini',
  ]) {
    assert.equal(blocked(path), false, `${path} darf der Hook nicht sperren`)
  }
  for (const path of [
    'phpstan.dist.neon',
    'ruff.toml',
    'mypy.ini',
    '.eslintrc.json',
    '.oxlintrc.jsonc',
  ]) {
    assert.equal(blocked(path), true, `${path} muss der Hook sperren`)
  }
})

// ── Manifeste: Feldprüfung ─────────────────────────────────────────────────

const PKG = { name: 'x', version: '1.0.0', scripts: { lint: 'eslint .', test: 'vitest run' } }

test('package.json: ein abgeschwächtes lint-Skript meldet', () => {
  const after = { ...PKG, scripts: { ...PKG.scripts, lint: 'true' } }
  assert.deepEqual(tamper.manifestGateChanges('package.json', json(PKG), json(after)), [
    'scripts.lint',
  ])
})

test('package.json: ein entferntes test-Skript meldet', () => {
  const after = { ...PKG, scripts: { lint: 'eslint .' } }
  assert.deepEqual(tamper.manifestGateChanges('package.json', json(PKG), json(after)), [
    'scripts.test',
  ])
})

test('package.json: eine geänderte Linter-Konfiguration im Manifest meldet', () => {
  const before = { ...PKG, eslintConfig: { rules: { 'no-unused-vars': 'error' } } }
  const after = { ...PKG, eslintConfig: { rules: { 'no-unused-vars': 'off' } } }
  assert.deepEqual(tamper.manifestGateChanges('package.json', json(before), json(after)), [
    'eslintConfig',
  ])
})

test('package.json: neue Abhängigkeit, Versionssprung und neues Skript melden nicht', () => {
  const after = {
    ...PKG,
    version: '1.1.0',
    scripts: { ...PKG.scripts, dev: 'vite' },
    dependencies: { react: '^19.0.0' },
    devDependencies: { vitest: '^3.0.0' },
  }
  assert.deepEqual(tamper.manifestGateChanges('package.json', json(PKG), json(after)), [])
})

test('package.json: eine neu angelegte oder unlesbare Fassung meldet nicht', () => {
  assert.deepEqual(tamper.manifestGateChanges('package.json', null, json(PKG)), [])
  assert.deepEqual(tamper.manifestGateChanges('package.json', '{kaputt', json(PKG)), [])
})

const COMPOSER = {
  name: 'x/y',
  require: { php: '^8.4' },
  scripts: { test: 'phpunit', 'post-autoload-dump': ['@php artisan package:discover'] },
}

test('composer.json: ein abgeschwächtes test-Skript meldet', () => {
  const after = { ...COMPOSER, scripts: { ...COMPOSER.scripts, test: 'true' } }
  assert.deepEqual(
    tamper.manifestGateChanges('backend/composer.json', json(COMPOSER), json(after)),
    ['scripts.test'],
  )
})

test('composer.json: neue Anforderung und Versionssprung melden nicht', () => {
  const after = {
    ...COMPOSER,
    version: '2.0.0',
    require: { php: '^8.4', 'laravel/framework': '^12.0' },
    'require-dev': { 'phpunit/phpunit': '^12.0' },
  }
  assert.deepEqual(tamper.manifestGateChanges('composer.json', json(COMPOSER), json(after)), [])
})

const PYPROJECT = `[project]
name = "x"
version = "1.0.0"
dependencies = ["httpx"]

[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I"]

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
`

test('pyproject.toml: eine abgeschaltete ruff-Regel meldet', () => {
  const after = PYPROJECT.replace('select = ["E", "F", "I"]', 'select = ["E"]')
  assert.deepEqual(tamper.manifestGateChanges('pyproject.toml', PYPROJECT, after), [
    'tool.ruff.lint',
  ])
})

test('pyproject.toml: ein neuer mypy-Override meldet', () => {
  const after = PYPROJECT + '\n[[tool.mypy.overrides]]\nmodule = "app.*"\nignore_errors = true\n'
  assert.deepEqual(tamper.manifestGateChanges('pyproject.toml', PYPROJECT, after), [
    'tool.mypy.overrides',
  ])
})

test('pyproject.toml: eingeschränkte Testpfade melden', () => {
  const after = PYPROJECT.replace('testpaths = ["tests"]', 'testpaths = ["tests/unit"]')
  assert.deepEqual(tamper.manifestGateChanges('pyproject.toml', PYPROJECT, after), [
    'tool.pytest.ini_options',
  ])
})

test('pyproject.toml: neue Abhängigkeit, Versionssprung und Kommentar melden nicht', () => {
  const after = PYPROJECT.replace('version = "1.0.0"', 'version = "1.1.0"')
    .replace('dependencies = ["httpx"]', 'dependencies = ["httpx", "boto3"]')
    .replace('[tool.mypy]', '# Typen\n[tool.mypy]')
  assert.deepEqual(tamper.manifestGateChanges('pyproject.toml', PYPROJECT, after), [])
})

test('pyproject.toml: eine Listenzeile mit eckiger Klammer beendet den Abschnitt nicht', () => {
  const before =
    '[tool.ruff.lint]\nextend-per-file-ignores = [\n  ["tests"],\n]\nselect = ["E", "F"]\n'
  const after = before.replace('select = ["E", "F"]', 'select = []')
  assert.deepEqual(tamper.manifestGateChanges('pyproject.toml', before, after), ['tool.ruff.lint'])
})

test('pyproject.toml: ein Abschnittskopf mit Anführungszeichen beginnt einen neuen Abschnitt', () => {
  const before =
    '[tool.mypy]\nstrict = true\n\n[tool.poetry.group."dev".dependencies]\npytest = "^8"\n'
  const after = before.replace('pytest = "^8"', 'pytest = "^9"')
  assert.deepEqual(tamper.manifestGateChanges('pyproject.toml', before, after), [])
})

test('analyseDiff: ein geändertes Skript meldet gate.script-changed', () => {
  const file = {
    path: 'package.json',
    deleted: false,
    added: [{ line: 5, text: '    "lint": "true",' }],
    removed: [{ text: '    "lint": "eslint .",' }],
    gateFields: ['scripts.lint'],
  }
  const findings = analyseDiff([file])
  assert.deepEqual(
    findings.map((f) => f.rule),
    ['gate.script-changed'],
  )
  assert.match(findings[0]?.label ?? '', /scripts\.lint/)
})

test('analyseDiff: geänderte Werkzeug-Konfiguration im Manifest meldet protected.changed', () => {
  const file = {
    path: 'package.json',
    deleted: false,
    added: [{ line: 5, text: '    "no-unused-vars": "off"' }],
    removed: [],
    gateFields: ['eslintConfig'],
  }
  assert.deepEqual(
    analyseDiff([file]).map((f) => f.rule),
    ['protected.changed'],
  )
})

test('analyseDiff: Skript und Konfiguration zugleich melden beide Regeln', () => {
  const file = {
    path: 'package.json',
    deleted: false,
    added: [],
    removed: [],
    gateFields: ['scripts.test', 'jest'],
  }
  assert.deepEqual(
    analyseDiff([file])
      .map((f) => f.rule)
      .sort(),
    ['gate.script-changed', 'protected.changed'],
  )
})

test('ein abgeschwächtes Skript blockiert auch lokal, Werkzeug-Konfiguration nicht', () => {
  assert.equal(tamper.SOFT_LOCALLY.has('gate.script-changed'), false)
  assert.equal(tamper.SOFT_LOCALLY.has('protected.changed'), true)
})

for (const key of ['jest', 'mocha', 'c8', 'nyc']) {
  test(`package.json: geänderte ${key}-Konfiguration im Manifest meldet`, () => {
    const after = { ...PKG, [key]: { exclude: ['**'] } }
    assert.deepEqual(tamper.manifestGateChanges('package.json', json(PKG), json(after)), [key])
  })
}

for (const name of ['pretest', 'prelint', 'prebuild']) {
  test(`package.json: ein neues ${name}-Skript meldet`, () => {
    const before = { ...PKG, scripts: { ...PKG.scripts, build: 'vite build' } }
    const after = { ...before, scripts: { ...before.scripts, [name]: 'rm -rf tests' } }
    assert.deepEqual(tamper.manifestGateChanges('package.json', json(before), json(after)), [
      `scripts.${name}`,
    ])
  })
}

test('package.json: ein neues Skript mit pre im Namen, aber ohne Ziel, meldet nicht', () => {
  const after = { ...PKG, scripts: { ...PKG.scripts, preview: 'vite preview', prepare: 'husky' } }
  assert.deepEqual(tamper.manifestGateChanges('package.json', json(PKG), json(after)), [])
})

test('composer.json: ein neues pre-Skript meldet nicht', () => {
  // composer kennt pre- und post-Skripte nur für eigene Kommandos, nicht für
  // selbst benannte Skripte.
  const after = { ...COMPOSER, scripts: { ...COMPOSER.scripts, pretest: 'true' } }
  assert.deepEqual(tamper.manifestGateChanges('composer.json', json(COMPOSER), json(after)), [])
})

test('echter Stand: ein uncommittet abgeschwächtes lint-Skript blockiert lokal', () => {
  const { root } = twoCommits({ 'package.json': json(PKG) }, { 'README.md': 'x\n' })
  try {
    writeFileSync(
      join(root, 'package.json'),
      json({ ...PKG, scripts: { ...PKG.scripts, lint: 'true' } }),
    )
    assert.equal(runTamper({ root, quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Stand: eine uncommittete ruff-Änderung in pyproject.toml bleibt lokal ein Hinweis', () => {
  const { root } = twoCommits({ 'pyproject.toml': PYPROJECT }, { 'README.md': 'x\n' })
  try {
    writeFileSync(join(root, 'pyproject.toml'), PYPROJECT.replace('"E", "F", "I"', '"E"'))
    assert.equal(runTamper({ root, quiet: true }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: package.json mit abgeschwächtem lint-Skript macht den Check rot', () => {
  const after = { ...PKG, scripts: { ...PKG.scripts, lint: 'true' } }
  assert.equal(tamperExit({ 'package.json': json(PKG) }, { 'package.json': json(after) }), 1)
})

test('echter Diff: package.json mit neuer Abhängigkeit bleibt grün', () => {
  const after = { ...PKG, version: '1.0.1', dependencies: { react: '^19.0.0' } }
  assert.equal(tamperExit({ 'package.json': json(PKG) }, { 'package.json': json(after) }), 0)
})

test('echter Diff: composer.json mit neuer Anforderung bleibt grün', () => {
  const after = { ...COMPOSER, require: { php: '^8.4', 'laravel/framework': '^12.0' } }
  assert.equal(tamperExit({ 'composer.json': json(COMPOSER) }, { 'composer.json': json(after) }), 0)
})

test('echter Diff: pyproject.toml mit neuer Abhängigkeit bleibt grün, mit ruff-Änderung rot', () => {
  const dependency = PYPROJECT.replace('["httpx"]', '["httpx", "boto3"]')
  assert.equal(tamperExit({ 'pyproject.toml': PYPROJECT }, { 'pyproject.toml': dependency }), 0)
  const weaker = PYPROJECT.replace('select = ["E", "F", "I"]', 'select = []')
  assert.equal(tamperExit({ 'pyproject.toml': PYPROJECT }, { 'pyproject.toml': weaker }), 1)
})

// ── Stillgelegte Tests ─────────────────────────────────────────────────────

for (const [path, line] of [
  ['src/a.test.ts', "xit('rechnet', () => {"],
  ['src/a.test.ts', "xdescribe('Rechner', () => {"],
  ['src/a.test.ts', "xtest('rechnet', () => {"],
  ['src/a.test.ts', "it.skipIf(true)('rechnet', () => {"],
  ['src/a.test.ts', "it.todo('rechnet')"],
  ['src/a.test.ts', "describe.todo('Rechner')"],
  ['src/a.test.ts', "test.fails('rechnet', () => {"],
  ['lib/a.test.mjs', "test('rechnet', { skip: true }, () => {"],
  ['lib/a.test.mjs', "test('rechnet', { todo: 'später' }, () => {"],
  ['lib/a.test.mjs', '  t.skip()'],
  ['lib/a.test.mjs', "  t.todo('später')"],
  ['tests/Feature/ATest.php', "it('rechnet', function () {})->todo();"],
  ['tests/Feature/ATest.php', "it('rechnet', function () {})->skip('später');"],
  ['tests/test_a.py', 'boto3 = pytest.importorskip("boto3")'],
]) {
  test(`stillgelegter Test: ${line} meldet test.skipped`, () => {
    assert.deepEqual(rulesFor(/** @type {string} */ (path), [/** @type {string} */ (line)]), [
      'test.skipped',
    ])
  })
}

test('stillgelegter Test: gewöhnliche Testzeilen melden nicht', () => {
  for (const line of [
    "it('exit(0) beendet', () => {",
    "test('rechnet', () => {",
    "const step = { name: 'tsc', skip: 'Werkzeug fehlt' }",
    "it('liest die Option { skip: true }', () => {",
    "test('rechnet', { skip: false }, () => {",
    "assert.equal(result.skip, 'kein build-Skript')",
    'const todo = list.todo()',
    "await exit('x')",
  ]) {
    assert.deepEqual(rulesFor('lib/a.test.mjs', [line]), [], line)
  }
})

// ── Umbenannte Testdatei ───────────────────────────────────────────────────

test('eine aus dem Testmuster umbenannte Testdatei meldet test.deleted', () => {
  const files = parseDiff(
    [
      'diff --git a/t/a.test.mjs b/t/a.test.mjs.off',
      'similarity index 100%',
      'rename from t/a.test.mjs',
      'rename to t/a.test.mjs.off',
    ].join('\n'),
  )
  const findings = analyseDiff(files)
  assert.deepEqual(
    findings.map((f) => [f.rule, f.path]),
    [['test.deleted', 't/a.test.mjs']],
  )
})

test('eine Testdatei, die Testdatei bleibt, meldet beim Umbenennen nicht', () => {
  const files = parseDiff(
    [
      'diff --git a/t/a.test.mjs b/t/unit/b.test.mjs',
      'similarity index 100%',
      'rename from t/a.test.mjs',
      'rename to t/unit/b.test.mjs',
    ].join('\n'),
  )
  assert.deepEqual(analyseDiff(files), [])
})

test('echter Diff: eine umbenannte Testdatei macht den Check rot', () => {
  const body = "import { test } from 'node:test'\ntest('x', () => {})\n"
  const { root, git } = twoCommits({ 't/a.test.mjs': body }, { 'README.md': 'x\n' })
  try {
    git('mv', 't/a.test.mjs', 't/a.test.mjs.off')
    git('commit', '--quiet', '-m', 'umbenannt')
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Suppressions in weiteren Quelldateien ──────────────────────────────────

for (const path of ['src/a.mts', 'src/a.cts', 'src/A.svelte']) {
  test(`Suppression in ${path} meldet`, () => {
    assert.ok(SOURCE_FILE.test(path), `${path} sollte als Quellcode gelten`)
    assert.deepEqual(rulesFor(path, ['// @ts-ignore']), ['suppression.typescript'])
  })
}
