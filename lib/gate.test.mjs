/**
 * Die Bausteine von `quality gate`: Basis, Merge-Zustand, Secret-Schritte.
 * Die Repositories sind Wegwerf-Repos in einem Temp-Ordner.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GateError, assertGateReady, resolveBase, secretScanSteps } from './gate.mjs'

const git = (/** @type {string[]} */ args, /** @type {string} */ cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** Repo mit main und einem Branch task, der eine eigene Datei ändert. */
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-gate-lib-')))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'a.txt'), 'basis\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'Basis'], dir)
  const base = git(['rev-parse', 'HEAD'], dir)
  git(['checkout', '-q', '-b', 'task'], dir)
  writeFileSync(join(dir, 'a.txt'), 'task\n')
  git(['commit', '-qam', 'Task'], dir)
  return { dir, base }
}

/** Wie repo(), dazu ein Merge von task in main, der noch nicht committet ist. */
function offenerMerge() {
  const { dir, base } = repo()
  git(['checkout', '-q', 'main'], dir)
  writeFileSync(join(dir, 'b.txt'), 'main\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'Main'], dir)
  git(['merge', '-q', '--no-ff', '--no-commit', 'task'], dir)
  return { dir, base }
}

test('resolveBase: --base vor CC_INTEGRATION_BASE vor origin/main', () => {
  assert.equal(resolveBase('x', { CC_INTEGRATION_BASE: 'y' }), 'x')
  assert.equal(resolveBase(null, { CC_INTEGRATION_BASE: 'y' }), 'y')
  assert.equal(resolveBase(null, {}), 'origin/main')
})

test('resolveBase: leeres CC_INTEGRATION_BASE gilt als nicht gesetzt', () => {
  assert.equal(resolveBase(null, { CC_INTEGRATION_BASE: '  ' }), 'origin/main')
})

test('assertGateReady: sauberer Branch mit gültiger Basis geht durch', () => {
  const { dir, base } = repo()
  assert.doesNotThrow(() => assertGateReady(dir, base))
})

test('assertGateReady: offener Merge bricht ab', () => {
  const { dir, base } = offenerMerge()
  assert.throws(
    () => assertGateReady(dir, base),
    (err) => err instanceof GateError && /Committe den Merge/.test(err.message),
  )
})

test('assertGateReady: unbekannte Basis bricht ab', () => {
  const { dir } = repo()
  assert.throws(
    () => assertGateReady(dir, 'gibtsnicht'),
    (err) => err instanceof GateError && /gibtsnicht/.test(err.message),
  )
})

test('assertGateReady: Null-SHA bricht ab', () => {
  const { dir } = repo()
  assert.throws(() => assertGateReady(dir, '0000000'), GateError)
})

test('secretScanSteps: ohne Merge-Commit nur der Commit-Scan', () => {
  const { dir, base } = repo()
  const steps = secretScanSteps({ root: dir, base, binary: '/bin/gl' })
  assert.equal(steps.length, 1)
  assert.equal(steps[0]?.name, 'gitleaks: Commits')
  assert.equal(steps[0]?.cmd, '/bin/gl')
  assert.ok(steps[0]?.args?.includes(`--log-opts=--no-textconv --no-ext-diff HEAD --not ${base}`))
  assert.ok(steps[0]?.args?.includes('--redact'))
})

test('secretScanSteps: Merge-Commit bekommt zweiten Scan', () => {
  const { dir, base } = offenerMerge()
  git(['commit', '-qm', 'Merge'], dir)
  const steps = secretScanSteps({ root: dir, base, binary: '/bin/gl' })
  assert.deepEqual(
    steps.map((s) => s.name),
    ['gitleaks: Commits', 'gitleaks: Merge-Commit'],
  )
  assert.equal(steps[1]?.cmd, 'bash')
  assert.equal(steps[1]?.args?.[2], '/bin/gl')
})

test('secretScanSteps: .gitleaks.toml nur, wenn vorhanden', () => {
  const { dir, base } = repo()
  assert.ok(!secretScanSteps({ root: dir, base, binary: 'gl' })[0]?.args?.includes('--config'))
  writeFileSync(join(dir, '.gitleaks.toml'), '')
  const args = secretScanSteps({ root: dir, base, binary: 'gl' })[0]?.args ?? []
  assert.ok(args.includes('--config'))
  assert.equal(args[args.indexOf('--config') + 1], '.gitleaks.toml')
})
