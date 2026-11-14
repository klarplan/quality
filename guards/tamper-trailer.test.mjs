/**
 * Der Ausnahme-Trailer nennt die Regel, die er entschuldigt.
 *
 * Befund 4 aus dem Audit vom 14.11.2026: `Quality-Exception: <Grund>` galt für
 * jeden Fund des Bereichs. Ein Trailer für eine Lockfile-Änderung entschuldigte
 * damit auch eine Suppression im selben Bereich.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runTamper } from './tamper-git.mjs'
import * as tamper from './tamper.mjs'

delete process.env.GITHUB_ACTOR
delete process.env.GITHUB_EVENT_PATH
delete process.env.GITHUB_TOKEN

test('ein Trailer mit Regel gilt nur für diese Regel', () => {
  assert.deepEqual(
    tamper.findExceptions(['feat: x\n\nQuality-Exception(dependency.changed): neues Paket']),
    [{ rules: ['dependency.changed'], reason: 'neues Paket' }],
  )
})

test('ein Trailer nennt mehrere Regeln mit Komma', () => {
  assert.deepEqual(
    tamper.findExceptions(['Quality-Exception(dependency.changed, test.skipped): Ticket #1']),
    [{ rules: ['dependency.changed', 'test.skipped'], reason: 'Ticket #1' }],
  )
})

test('ein Trailer ohne Regel gilt weiter für alle Regeln', () => {
  assert.deepEqual(tamper.findExceptions(['Quality-Exception: Ticket #1']), [
    { rules: null, reason: 'Ticket #1' },
  ])
})

test('ein Trailer ohne Grund oder mit leerer Regelliste zählt nicht', () => {
  assert.deepEqual(tamper.findExceptions(['Quality-Exception(test.skipped):']), [])
  assert.deepEqual(tamper.findExceptions(['Quality-Exception(): Grund']), [])
  assert.deepEqual(tamper.findExceptions(['Quality-Exception:']), [])
})

test('exceptionFor: die Regel passt genau oder als Familie vor dem Punkt', () => {
  const exceptions = tamper.findExceptions([
    'Quality-Exception(suppression): Typen der Bibliothek fehlen',
    'Quality-Exception(test.skipped): Ticket #1',
  ])
  assert.equal(
    tamper.exceptionFor('suppression.typescript', exceptions),
    'Typen der Bibliothek fehlen',
  )
  assert.equal(tamper.exceptionFor('test.skipped', exceptions), 'Ticket #1')
  assert.equal(tamper.exceptionFor('test.deleted', exceptions), null)
  assert.equal(tamper.exceptionFor('dependency.changed', exceptions), null)
})

test('findException liefert weiter den ersten Grund, auch bei einem Trailer mit Regel', () => {
  // scripts/gate.sh von resplan ruft diese Funktion auf.
  assert.equal(tamper.findException(['Quality-Exception(test.skipped): Ticket #1']), 'Ticket #1')
  assert.equal(tamper.findException(['Quality-Exception: Ticket #2']), 'Ticket #2')
  assert.equal(tamper.findException(['kein Trailer']), null)
})

/**
 * Ein Repository, dessen zweiter Commit ein Lockfile ändert und eine
 * Suppression einfügt. `trailer` steht in der Nachricht des zweiten Commits.
 *
 * @param {string} trailer
 */
function lockfileAndSuppression(trailer) {
  const root = mkdtempSync(join(tmpdir(), 'quality-trailer-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'vorher')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n')
  writeFileSync(join(root, 'src', 'a.ts'), '// @ts-ignore\nexport const a = 1\n')
  git('add', '.')
  git('commit', '--quiet', '-m', `nachher\n\n${trailer}`)
  return root
}

/** @param {string} trailer */
function exitWith(trailer) {
  const root = lockfileAndSuppression(trailer)
  try {
    return runTamper({ root, base: 'HEAD~1', quiet: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('echter Diff: ein Trailer für das Lockfile entschuldigt die Suppression nicht', () => {
  assert.equal(exitWith('Quality-Exception(dependency.changed): neues Paket'), 1)
})

test('echter Diff: ein Trailer für beide Regeln macht den Check grün', () => {
  assert.equal(exitWith('Quality-Exception(dependency.changed, suppression): Ticket #1'), 0)
})

test('echter Diff: ein Trailer ohne Regel macht den Check weiter grün', () => {
  assert.equal(exitWith('Quality-Exception: Ticket #1'), 0)
})
