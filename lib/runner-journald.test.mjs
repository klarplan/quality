// Prüft den journald-Abschnitt von runner/provision.sh. Der Test schneidet
// den Abschnitt aus provision.sh aus und führt ihn mit bash aus. Den Pfad
// /etc/systemd/journald.conf.d biegt er auf einen Temp-Ordner um. Ein
// Ersatz für systemctl schreibt seine Argumente in eine Datei.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

const PROVISION = new URL('../runner/provision.sh', import.meta.url)
const START = 'echo "==> journald: Grenze 500M"\n'
const CONF_DIR = '/etc/systemd/journald.conf.d'

/** Schneidet den journald-Abschnitt bis zum nächsten «echo "» aus. */
function section() {
  const text = readFileSync(PROVISION, 'utf8')
  const start = text.indexOf(START)
  assert.notEqual(start, -1, 'provision.sh hat keinen journald-Abschnitt')
  const rest = text.slice(start + START.length)
  return rest.slice(0, rest.indexOf('\necho "') + 1)
}

/** @type {string[]} */
const tempDirs = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-journald-'))
  tempDirs.push(dir)
  const bin = join(dir, 'bin')
  const conf = join(dir, 'journald.conf.d')
  const calls = join(dir, 'systemctl.log')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >>'${calls}'\n`)
  chmodSync(join(bin, 'systemctl'), 0o755)
  const body = section().replaceAll(CONF_DIR, conf)
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', body], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return { conf, calls }
}

test('provision.sh schreibt 50-groesse.conf mit SystemMaxUse=500M', () => {
  const { conf } = run()
  assert.equal(
    readFileSync(join(conf, '50-groesse.conf'), 'utf8'),
    '[Journal]\nSystemMaxUse=500M\n',
  )
})

test('provision.sh startet journald nach dem Schreiben neu', () => {
  const { calls } = run()
  assert.equal(readFileSync(calls, 'utf8'), 'restart systemd-journald\n')
})
