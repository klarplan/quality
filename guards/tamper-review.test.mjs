/**
 * Funde aus dem Code-Review des Audits vom 14.11.2026.
 *
 * Jeder Test war vor der Korrektur rot. Die Gegenproben am Ende sichern, dass
 * gewöhnlicher Testcode keinen Fund erzeugt.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runTamper } from './tamper-git.mjs'
import { analyseDiff, parseDiff } from './tamper.mjs'

delete process.env.GITHUB_ACTOR
delete process.env.GITHUB_EVENT_PATH
delete process.env.GITHUB_TOKEN

/**
 * Funde einer Umbenennung als [Regel, Pfad].
 *
 * @param {string} from
 * @param {string} to
 * @param {Parameters<typeof analyseDiff>[1]} [options]
 */
function renameFindings(from, to, options) {
  const files = parseDiff(
    [
      `diff --git a/${from} b/${to}`,
      'similarity index 100%',
      `rename from ${from}`,
      `rename to ${to}`,
    ].join('\n'),
  )
  return analyseDiff(files, options).map((f) => [f.rule, f.path])
}

/**
 * Regeln, die eine hinzugefügte Zeile in einer Testdatei auslöst.
 *
 * @param {string} path
 * @param {string} line
 */
function rulesFor(path, line) {
  const file = { path, deleted: false, added: [{ line: 1, text: line }], removed: [] }
  return analyseDiff([file]).map((f) => f.rule)
}

// ── Umbenennung ────────────────────────────────────────────────────────────

for (const [from, to] of [
  ['tests/FooTest.php', 'tests/FooTest.php.off'],
  ['tests/unit/a.test.mjs', 'tests/unit/a.test.mjs.off'],
  ['tests/test_a.py', 'tests/a_aus.py'],
  ['src/b.test.mjs', 'vendor/b.txt'],
  ['src/b.test.mjs', 'third_party/b.test.mjs'],
]) {
  test(`Umbenennung ${from} → ${to} meldet test.deleted`, () => {
    assert.deepEqual(renameFindings(/** @type {string} */ (from), /** @type {string} */ (to)), [
      ['test.deleted', from],
    ])
  })
}

test('Umbenennung in einen ignorierten Pfad meldet test.deleted', () => {
  assert.deepEqual(renameFindings('src/b.test.mjs', 'alt/b.txt', { ignorePaths: ['alt/'] }), [
    ['test.deleted', 'src/b.test.mjs'],
  ])
})

test('Umbenennung innerhalb eines ignorierten Pfads meldet nicht', () => {
  assert.deepEqual(renameFindings('alt/b.test.mjs', 'alt/b.txt', { ignorePaths: ['alt/'] }), [])
})

test('eine Hilfsdatei im Testordner darf im Testordner umbenannt werden', () => {
  assert.deepEqual(renameFindings('tests/helpers/db.php', 'tests/helpers/database.php'), [])
})

for (const from of ['phpstan.neon', 'eslint.config.mjs', '.eslintrc.json', 'vitest.config.ts']) {
  test(`eine wegumbenannte Gate-Konfiguration ${from} meldet protected.changed`, () => {
    assert.deepEqual(renameFindings(from, `${from}.bak`), [['protected.changed', from]])
  })
}

test('echter Diff: eine umbenannte Testdatei mit Umlaut im Namen macht den Check rot', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-review-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  try {
    git('init', '--quiet')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'src', 'ä.test.mjs'),
      "import { test } from 'node:test'\ntest('x', () => {})\n",
    )
    git('add', '.')
    git('commit', '--quiet', '-m', 'vorher')
    git('mv', 'src/ä.test.mjs', 'src/ä.txt')
    git('commit', '--quiet', '-m', 'umbenannt')
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Stillgelegte Tests: bisher tote oder fehlende Muster ───────────────────

for (const [path, line] of [
  ['tests/ATest.php', '     * @doesNotPerformAssertions'],
  ['tests/ATest.php', '     * @group skip'],
  ['tests/ATest.php', '    #[DoesNotPerformAssertions]'],
  ['tests/test_a.py', '    @unittest.skipIf(True, "x")'],
  ['tests/test_a.py', '    @unittest.skipUnless(False, "x")'],
  ['tests/test_a.py', '        self.skipTest("x")'],
  ['src/a.test.ts', "it.concurrent.skip('rechnet', () => {"],
  ['e2e/a.spec.ts', "test.fixme('rechnet', async () => {"],
  ['tests/Feature/ATest.php', "it('rechnet', function () {})->skip();"],
]) {
  test(`stillgelegter Test: ${String(line).trim()} meldet test.skipped`, () => {
    assert.deepEqual(rulesFor(/** @type {string} */ (path), /** @type {string} */ (line)), [
      'test.skipped',
    ])
  })
}

// ── Gegenproben: gewöhnlicher Testcode ─────────────────────────────────────

for (const [path, line] of [
  ['tests/Feature/ATest.php', '$users = User::query()->skip(1)->take(2)->get();'],
  ['tests/Feature/ATest.php', '$users = User::query()->skip($offset)->get();'],
  ['lib/a.test.mjs', `it('reads "x"', async () => { await run('a', { skip: 2 }) })`],
  ['lib/a.test.mjs', "suite('paging', { skip: 0, take: 5 })"],
  ['lib/a.test.mjs', "test('rechnet', { skip: false }, () => {"],
]) {
  test(`gewöhnlicher Testcode meldet nicht: ${line}`, () => {
    assert.deepEqual(rulesFor(/** @type {string} */ (path), /** @type {string} */ (line)), [])
  })
}

// ── phpunit.xml: Umgebungswerte sind keine Abschwächung ────────────────────
// Probelauf vom 14.11.2026 über rund 180 Merges von rankscan: drei Commits
// wären neu rot geworden. Jeder fügte nur eine <env>-Zeile hinzu.

/**
 * @param {string[]} added
 * @param {string[]} [removed]
 */
function phpunitRules(added, removed = []) {
  const file = {
    path: 'phpunit.xml',
    deleted: false,
    added: added.map((text, index) => ({ line: index + 1, text })),
    removed: removed.map((text) => ({ text })),
  }
  return analyseDiff([file]).map((f) => f.rule)
}

test('phpunit.xml: ein neuer Umgebungswert mit Kommentar meldet nicht', () => {
  assert.deepEqual(
    phpunitRules([
      '        <!-- Gemini scan model empty: der Test prüft den Default im Code. -->',
      '        <env name="GEMINI_DEFAULT_MODEL" value="" force="true"/>',
      '        <server name="APP_ENV" value="testing"/>',
      '        <ini name="memory_limit" value="1G"/>',
    ]),
    [],
  )
})

test('phpunit.xml: ein geänderter Umgebungswert meldet nicht', () => {
  assert.deepEqual(
    phpunitRules(
      ['        <env name="AI_MODE_ENABLED" value="true"/>'],
      ['        <env name="AI_MODE_ENABLED" value="false"/>'],
    ),
    [],
  )
})

test('phpunit.xml: eine entfernte Testsuite meldet weiter', () => {
  assert.deepEqual(phpunitRules([], ['            <directory>tests/Feature</directory>']), [
    'protected.changed',
  ])
})

test('phpunit.xml: ein Umgebungswert neben einem neuen exclude meldet weiter', () => {
  assert.deepEqual(
    phpunitRules([
      '        <env name="X" value="1"/>',
      '            <exclude>tests/Feature/Slow</exclude>',
    ]),
    ['protected.changed'],
  )
})

test('phpunit.xml: ein Attribut am Wurzelelement meldet weiter', () => {
  assert.deepEqual(
    phpunitRules(['         failOnWarning="false"'], ['         failOnWarning="true"']),
    ['protected.changed'],
  )
})
