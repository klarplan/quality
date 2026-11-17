// Prüft den PHP-Abschnitt von runner/provision.sh. Der Test schneidet den
// Abschnitt aus provision.sh aus und führt ihn mit bash aus. Ersatzbefehle
// für apt-get, add-apt-repository und update-alternatives schreiben ihre
// Argumente in eine Datei. Die calcup-CI verlinkt /usr/bin/php8.5.
// provision.sh muss PHP 8.5 deshalb installieren.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const PROVISION = new URL('../runner/provision.sh', import.meta.url)
const START = 'echo "==> PHP '
const EXTENSIONS = [
  'cli',
  'pgsql',
  'redis',
  'intl',
  'mbstring',
  'bcmath',
  'zip',
  'gd',
  'xml',
  'curl',
  'sqlite3',
]

/** Schneidet den PHP-Abschnitt bis zum nächsten «echo "» aus. */
function section() {
  const text = readFileSync(PROVISION, 'utf8')
  const start = text.indexOf(START)
  assert.notEqual(start, -1, 'provision.sh hat keinen PHP-Abschnitt')
  const rest = text.slice(text.indexOf('\n', start) + 1)
  return {
    heading: text.slice(start, text.indexOf('\n', start)),
    body: rest.slice(0, rest.indexOf('\necho "') + 1),
  }
}

/** @type {string[]} */
const tempDirs = []
after(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** @type {string[] | undefined} */
let cached

/**
 * Führt den Abschnitt einmal aus und gibt die protokollierten Aufrufe zurück.
 * Jeder weitere Aufruf liefert dasselbe Ergebnis aus dem Zwischenspeicher.
 */
function run() {
  if (cached) return cached
  const dir = mkdtempSync(join(tmpdir(), 'runner-php-'))
  tempDirs.push(dir)
  const bin = join(dir, 'bin')
  const log = join(dir, 'calls.log')
  mkdirSync(bin)
  for (const cmd of ['apt-get', 'add-apt-repository', 'update-alternatives']) {
    writeFileSync(join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >>'${log}'\n`)
    chmodSync(join(bin, cmd), 0o755)
  }
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', section().body], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  cached = readFileSync(log, 'utf8').trim().split('\n')
  return cached
}

/**
 * Liefert die Pakete aller «apt-get install»-Aufrufe.
 * @param {string[]} calls
 * @returns {string[]}
 */
function installed(calls) {
  return calls
    .filter((c) => c.startsWith('apt-get install'))
    .flatMap((c) => c.split(' '))
    .filter((w) => w.startsWith('php'))
}

for (const v of ['8.3', '8.4', '8.5']) {
  test(`provision.sh installiert PHP ${v} mit allen Extensions`, () => {
    const pkgs = installed(run())
    for (const ext of EXTENSIONS) assert.ok(pkgs.includes(`php${v}-${ext}`), `php${v}-${ext} fehlt`)
  })
}

test('provision.sh lässt den Standard-php auf 8.4', () => {
  const calls = run().filter((c) => c.startsWith('update-alternatives'))
  assert.deepEqual(calls, ['update-alternatives --set php /usr/bin/php8.4'])
})

test('die Überschrift des PHP-Abschnitts nennt 8.5', () => {
  assert.match(section().heading, /8\.5/)
})
