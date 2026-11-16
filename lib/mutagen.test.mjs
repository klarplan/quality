/**
 * Mutagen-Sync rund um Schritte im ddev-Container.
 *
 * Mit Mutagen spiegelt ddev das Projekt asynchron zwischen Host und
 * Container. Ohne Sync prüft der Container einen alten Stand, und was
 * prettier --write im Container schreibt, sieht der Host erst später.
 * Gemessen in rankscan-website am 16.11.2026.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runStep, runSteps } from './run.mjs'

/** @import { Step } from './types.mjs' */

/**
 * Ersetzt den PATH durch einen Ordner mit einem falschen "ddev". Das Skript
 * schreibt jeden Aufruf in ein Protokoll. "ddev mutagen sync" scheitert,
 * wenn die Datei fail-sync im Ordner liegt.
 *
 * @param {import('node:test').TestContext} t
 */
function fakeDdev(t) {
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-mutagen-'))
  const log = join(bin, 'calls.log')
  const fail = join(bin, 'fail-sync')
  writeFileSync(
    join(bin, 'ddev'),
    `#!/bin/sh
echo "$1 $2" >> "${log}"
case "$1" in
  mutagen)
    if [ -f "${fail}" ]; then echo "Mutagen: problems: transitioning" >&2; exit 1; fi ;;
  exec) echo "im Container" ;;
esac
`,
  )
  chmodSync(join(bin, 'ddev'), 0o755)
  writeFileSync(join(bin, 'host'), '#!/bin/sh\necho "host" >> "' + log + '"\n')
  chmodSync(join(bin, 'host'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  t.after(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  })
  return {
    root: bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    failSync: () => writeFileSync(fail, ''),
  }
}

/**
 * Ein Schritt im Container, wie ddevExec ihn baut.
 *
 * @param {string} root
 * @param {Partial<Step>} [extra]
 * @returns {Step}
 */
const container = (root, extra = {}) => ({
  name: 'prettier (.)',
  cmd: 'ddev',
  args: ['exec', '--raw', '--', 'prettier'],
  cwd: root,
  mutagen: root,
  ...extra,
})

/** @param {Partial<Step>} [extra] */
const host = (extra = {}) => ({ name: 'host', cmd: 'host', args: [], ...extra })

test('mutagen: vor einem Schritt im Container läuft ein Sync', async (t) => {
  const ddev = fakeDdev(t)

  const result = await runStep(container(ddev.root), { quiet: true })

  assert.equal(result.code, 0, result.output)
  assert.deepEqual(ddev.calls(), ['mutagen sync', 'exec --raw'])
})

test('mutagen: nach einem schreibenden Schritt sieht der Host das Ergebnis', async (t) => {
  const ddev = fakeDdev(t)

  await runStep(container(ddev.root, { writes: true }), { quiet: true })

  assert.deepEqual(ddev.calls(), ['mutagen sync', 'exec --raw', 'mutagen sync'])
})

test('mutagen: ohne Mutagen ruft der Runner keinen Sync auf', async (t) => {
  const ddev = fakeDdev(t)

  await runStep(container(ddev.root, { mutagen: undefined, writes: true }), { quiet: true })

  assert.deepEqual(ddev.calls(), ['exec --raw'])
})

test('mutagen: lesende Schritte nacheinander brauchen nur einen Sync', async (t) => {
  // Zeitbudget: der Post-Edit-Hook hat 8 s, ein Sync dauert rund 0,6 s.
  const ddev = fakeDdev(t)

  await runSteps([container(ddev.root), container(ddev.root), container(ddev.root)], {
    quiet: true,
  })

  assert.deepEqual(ddev.calls(), ['mutagen sync', 'exec --raw', 'exec --raw', 'exec --raw'])
})

test('mutagen: nach einem schreibenden Schritt auf dem Host synct der nächste neu', async (t) => {
  const ddev = fakeDdev(t)

  await runSteps(
    [
      container(ddev.root),
      host(),
      container(ddev.root),
      host({ writes: true }),
      container(ddev.root),
    ],
    { quiet: true },
  )

  assert.deepEqual(ddev.calls(), [
    'mutagen sync',
    'exec --raw',
    'host',
    'exec --raw',
    'host',
    'mutagen sync',
    'exec --raw',
  ])
})

test('mutagen: scheitert der Sync davor, läuft der Schritt nicht und ist rot', async (t) => {
  // Sonst meldet die Prüfung grün oder rot für einen Stand, den es auf dem
  // Host so nicht gibt.
  const ddev = fakeDdev(t)
  ddev.failSync()

  const result = await runStep(container(ddev.root), { quiet: true })

  assert.equal(result.code, 1)
  assert.deepEqual(ddev.calls(), ['mutagen sync'])
  assert.match(result.output, /Mutagen-Sync vor dem Schritt ist gescheitert/)
  assert.match(result.output, /problems: transitioning/)
  assert.match(result.output, /ddev mutagen reset/)
})

test('mutagen: scheitert der Sync danach, ist der schreibende Schritt rot', async (t) => {
  const ddev = fakeDdev(t)
  /** @type {Step} */
  const step = {
    name: 'prettier (.)',
    cmd: 'sh',
    args: ['-c', `touch "${join(ddev.root, 'fail-sync')}"; echo geschrieben`],
    mutagen: ddev.root,
    writes: true,
  }

  const result = await runStep(step, { quiet: true })

  assert.equal(result.code, 1)
  assert.match(result.output, /geschrieben/)
  assert.match(result.output, /Mutagen-Sync nach dem Schritt ist gescheitert/)
})
