/**
 * gitleaks in fester Version: Plattform, Cache, Prüfsumme.
 *
 * Die Tests laden nichts aus dem Netz. Sie bauen ein echtes Archiv mit einer
 * Attrappe und übergeben eine eigene Download-Funktion. Die Prüfsumme des
 * Archivs berechnen sie selbst. Geprüft wird also der Ablauf, nicht gitleaks.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  GITLEAKS_CHECKSUMS,
  GITLEAKS_VERSION,
  ensureGitleaks,
  gitleaksCacheDir,
  gitleaksPlatform,
} from './gitleaks.mjs'

/** Ein Archiv mit einer Attrappe namens gitleaks und seine Prüfsumme. */
function archiv() {
  const dir = mkdtempSync(join(tmpdir(), 'quality-gitleaks-src-'))
  writeFileSync(join(dir, 'gitleaks'), '#!/bin/sh\necho attrappe\n')
  chmodSync(join(dir, 'gitleaks'), 0o755)
  const file = join(dir, 'gitleaks.tar.gz')
  execFileSync('tar', ['-czf', file, '-C', dir, 'gitleaks'])
  const summe = createHash('sha256').update(readFileSync(file)).digest('hex')
  return { file, summe }
}

const cache = () => mkdtempSync(join(tmpdir(), 'quality-gitleaks-cache-'))

test('GITLEAKS_CHECKSUMS: die vier Prüfsummen aus dem Release', () => {
  assert.equal(GITLEAKS_VERSION, '8.30.1')
  assert.deepEqual(
    { ...GITLEAKS_CHECKSUMS },
    {
      darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
      darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
      linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
      linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    },
  )
})

test('gitleaksPlatform: vier Plattformen, sonst null', () => {
  assert.equal(gitleaksPlatform('darwin', 'arm64'), 'darwin_arm64')
  assert.equal(gitleaksPlatform('darwin', 'x64'), 'darwin_x64')
  assert.equal(gitleaksPlatform('linux', 'arm64'), 'linux_arm64')
  assert.equal(gitleaksPlatform('linux', 'x64'), 'linux_x64')
  assert.equal(gitleaksPlatform('win32', 'x64'), null)
})

test('gitleaksCacheDir: XDG_CACHE_HOME vor HOME', () => {
  assert.equal(
    gitleaksCacheDir({ XDG_CACHE_HOME: '/x' }, '/h'),
    '/x/standout-quality/gitleaks-8.30.1',
  )
  assert.equal(gitleaksCacheDir({}, '/h'), '/h/.cache/standout-quality/gitleaks-8.30.1')
  assert.equal(
    gitleaksCacheDir({ XDG_CACHE_HOME: '' }, '/h'),
    '/h/.cache/standout-quality/gitleaks-8.30.1',
  )
})

test('ensureGitleaks: lädt, prüft und entpackt', async () => {
  const { file, summe } = archiv()
  const dir = cache()
  const pfad = await ensureGitleaks({
    cacheDir: dir,
    platform: 'linux',
    arch: 'arm64',
    checksums: { linux_arm64: summe },
    download: async (url, ziel) => {
      assert.match(url, /v8\.30\.1\/gitleaks_8\.30\.1_linux_arm64\.tar\.gz$/)
      copyFileSync(file, ziel)
    },
  })
  assert.equal(pfad, join(dir, 'gitleaks'))
  accessSync(pfad, constants.X_OK)
  assert.deepEqual(readdirSync(dir), ['gitleaks'])
})

test('ensureGitleaks: liegt die Datei schon da, lädt es nicht', async () => {
  const dir = cache()
  writeFileSync(join(dir, 'gitleaks'), '#!/bin/sh\n')
  chmodSync(join(dir, 'gitleaks'), 0o755)
  const pfad = await ensureGitleaks({
    cacheDir: dir,
    platform: 'linux',
    arch: 'arm64',
    download: async () => {
      throw new Error('darf nicht laden')
    },
  })
  assert.equal(pfad, join(dir, 'gitleaks'))
})

test('ensureGitleaks: falsche Prüfsumme lässt nichts liegen', async () => {
  const { file } = archiv()
  const dir = cache()
  await assert.rejects(
    ensureGitleaks({
      cacheDir: dir,
      platform: 'linux',
      arch: 'arm64',
      checksums: { linux_arm64: '0'.repeat(64) },
      download: async (_url, ziel) => copyFileSync(file, ziel),
    }),
    /Prüfsumme/,
  )
  assert.deepEqual(readdirSync(dir), [])
})

test('ensureGitleaks: abgebrochener Download lässt nichts liegen', async () => {
  const { file, summe } = archiv()
  const dir = cache()
  const checksums = { linux_arm64: summe }
  await assert.rejects(
    ensureGitleaks({
      cacheDir: dir,
      platform: 'linux',
      arch: 'arm64',
      checksums,
      download: async (_url, ziel) => {
        writeFileSync(ziel, readFileSync(file).subarray(0, 10))
        throw new Error('Verbindung abgebrochen')
      },
    }),
    /Verbindung abgebrochen/,
  )
  assert.deepEqual(readdirSync(dir), [])
  const pfad = await ensureGitleaks({
    cacheDir: dir,
    platform: 'linux',
    arch: 'arm64',
    checksums,
    download: async (_url, ziel) => copyFileSync(file, ziel),
  })
  accessSync(pfad, constants.X_OK)
})

test('ensureGitleaks: unbekannte Plattform nennt Plattform', async () => {
  await assert.rejects(
    ensureGitleaks({ cacheDir: cache(), platform: 'win32', arch: 'x64' }),
    /win32-x64/,
  )
})
