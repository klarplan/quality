// Prüft den SSH-Abschnitt von runner/provision.sh. Der Test schneidet den
// Abschnitt aus provision.sh aus und führt ihn mit bash aus. Den Pfad
// /etc/ssh/sshd_config.d biegt er auf einen Temp-Ordner um. Ersatz-Skripte
// für sshd und systemctl schreiben ihre Argumente in eine Datei.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

const PROVISION = new URL('../runner/provision.sh', import.meta.url)
const START = 'echo "==> SSH nur mit Key"\n'
const CONF_DIR = '/etc/ssh/sshd_config.d'
const HARDENING = 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n'

/** Schneidet den SSH-Abschnitt bis zum nächsten «echo "» aus. */
function section() {
  const text = readFileSync(PROVISION, 'utf8')
  const start = text.indexOf(START)
  assert.notEqual(start, -1, 'provision.sh hat keinen SSH-Abschnitt')
  const rest = text.slice(start + START.length)
  return rest.slice(0, rest.indexOf('\necho "') + 1)
}

/** @type {string[]} */
const tempDirs = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Legt Temp-Ordner und Ersatz-Skripte an. sshdExit ist der Exit-Code von «sshd -t». */
function setup(sshdExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-sshd-'))
  tempDirs.push(dir)
  const bin = join(dir, 'bin')
  const conf = join(dir, 'sshd_config.d')
  const calls = join(dir, 'calls.log')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(join(bin, 'sshd'), `#!/bin/sh\necho "sshd $*" >>'${calls}'\nexit ${sshdExit}\n`)
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >>'${calls}'\n`)
  chmodSync(join(bin, 'sshd'), 0o755)
  chmodSync(join(bin, 'systemctl'), 0o755)
  return { bin, conf, calls }
}

/**
 * Führt den Abschnitt aus und gibt das Ergebnis von spawnSync zurück.
 * @param {{ bin: string, conf: string }} env
 */
function run({ bin, conf }) {
  const body = section().replaceAll(CONF_DIR, conf)
  return spawnSync('bash', ['-euo', 'pipefail', '-c', body], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
}

test('provision.sh schreibt 00-hardening.conf ohne Passwort-Login', () => {
  const env = setup()
  const r = run(env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(env.conf, '00-hardening.conf'), 'utf8'), HARDENING)
})

test('provision.sh prüft mit sshd -t und lädt sshd per reload neu', () => {
  const env = setup()
  const r = run(env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(env.calls, 'utf8'), 'sshd -t\nsystemctl reload ssh\n')
})

test('provision.sh läuft ein zweites Mal ohne Fehler und mit gleichem Inhalt', () => {
  const env = setup()
  assert.equal(run(env).status, 0)
  const r = run(env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(env.conf, '00-hardening.conf'), 'utf8'), HARDENING)
})

test('provision.sh entfernt die Datei und bricht ab, wenn sshd -t scheitert', () => {
  const env = setup(1)
  const r = run(env)
  assert.notEqual(r.status, 0)
  assert.equal(existsSync(join(env.conf, '00-hardening.conf')), false)
  assert.equal(readFileSync(env.calls, 'utf8'), 'sshd -t\n')
})
