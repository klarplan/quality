// Prüft den Codename-Abschnitt von runner/provision.sh. Der Test schneidet
// den Abschnitt aus provision.sh aus und führt ihn mit bash aus. Den Pfad
// /etc/os-release biegt er auf eine Temp-Datei um.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

const PROVISION = new URL('../runner/provision.sh', import.meta.url)
const START = 'echo "==> Ubuntu-Codename"\n'
const OS_RELEASE = '/etc/os-release'

/** Schneidet den Codename-Abschnitt bis zum nächsten «echo "» aus. */
function section() {
  const text = readFileSync(PROVISION, 'utf8')
  const start = text.indexOf(START)
  assert.notEqual(start, -1, 'provision.sh hat keinen Codename-Abschnitt')
  const rest = text.slice(start + START.length)
  return rest.slice(0, rest.indexOf('\necho "') + 1)
}

/** @type {string[]} */
const tempDirs = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Schreibt eine os-release-Datei mit der gegebenen Codename-Zeile und führt
 * den Abschnitt aus. Der Abschnitt gibt danach CODENAME aus.
 * @param {string} codenameLine Zeile für VERSION_CODENAME, leer = Zeile fehlt
 */
function run(codenameLine) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-codename-'))
  tempDirs.push(dir)
  const file = join(dir, 'os-release')
  const lines = [
    'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
    'NAME="Ubuntu"',
    'VERSION_ID="24.04"',
    codenameLine,
    'ID=ubuntu',
    'UBUNTU_CODENAME=noble',
  ].filter(Boolean)
  writeFileSync(file, `${lines.join('\n')}\n`)
  const body = `${section().replaceAll(OS_RELEASE, file)}echo "$CODENAME"\n`
  return spawnSync('bash', ['-euo', 'pipefail', '-c', body], { encoding: 'utf8' })
}

test('provision.sh liest den Codename ohne Anführungszeichen', () => {
  const r = run('VERSION_CODENAME=noble')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'noble\n')
})

test('provision.sh entfernt doppelte Anführungszeichen um den Codename', () => {
  const r = run('VERSION_CODENAME="noble"')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'noble\n')
})

test('provision.sh entfernt einfache Anführungszeichen um den Codename', () => {
  const r = run("VERSION_CODENAME='noble'")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'noble\n')
})

test('provision.sh bricht ab, wenn VERSION_CODENAME fehlt', () => {
  const r = run('')
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /VERSION_CODENAME/)
})

test('provision.sh bricht ab, wenn VERSION_CODENAME leer ist', () => {
  const r = run('VERSION_CODENAME=')
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /VERSION_CODENAME/)
})

test('provision.sh liest os-release nicht mehr per source', () => {
  const text = readFileSync(PROVISION, 'utf8')
  assert.equal(text.includes('. /etc/os-release'), false)
  assert.match(text, /download\.docker\.com\/linux\/ubuntu \$\{CODENAME\} stable/)
  assert.match(text, /apt\.postgresql\.org\/pub\/repos\/apt \$\{CODENAME\}-pgdg main/)
})
