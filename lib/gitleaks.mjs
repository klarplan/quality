/**
 * gitleaks in fester Version, für `quality gate --secrets`.
 *
 * Ein Werkzeug, das Geheimnisse sucht, läuft nicht ungeprüft aus dem Netz.
 * Darum stehen Version und Prüfsummen hier im Paket und nicht je Projekt.
 * Vorher führten resplan, rankscan und rankscan-website je eine eigene Kopie
 * dieser Logik in scripts/gate.sh.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const GITLEAKS_VERSION = '8.30.1'

/**
 * Die Prüfsummen stammen aus gitleaks_8.30.1_checksums.txt des Releases
 * (gelesen am 14.11.2026). linux_arm64 braucht der ddev-Container auf dem
 * Mac mini.
 */
export const GITLEAKS_CHECKSUMS = Object.freeze({
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
})

/**
 * Der Plattformname im Dateinamen des Releases.
 *
 * @param {string} platform  wie process.platform
 * @param {string} arch  wie process.arch
 * @returns {string | null}  null für eine Plattform ohne Prüfsumme
 */
export function gitleaksPlatform(platform, arch) {
  const os = { darwin: 'darwin', linux: 'linux' }[platform]
  const cpu = { arm64: 'arm64', x64: 'x64' }[arch]
  return os && cpu ? `${os}_${cpu}` : null
}

/**
 * Der Cache-Ordner. Eine leere Variable zählt als nicht gesetzt, wie in der
 * XDG-Spezifikation.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string}
 */
export function gitleaksCacheDir(env, home) {
  const base = env.XDG_CACHE_HOME || join(home, '.cache')
  return join(base, 'standout-quality', `gitleaks-${GITLEAKS_VERSION}`)
}

/**
 * Lädt eine URL in eine Datei. Folgt der Weiterleitung von GitHub auf den
 * Speicherort des Assets.
 *
 * @param {string} url
 * @param {string} file
 * @returns {Promise<void>}
 */
async function fetchToFile(url, file) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download von ${url} scheiterte: HTTP ${response.status}.`)
  writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

/** @param {string} file */
function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Liefert den Pfad einer geprüften gitleaks-Datei. Liegt sie im Cache, lädt
 * die Funktion nichts. Sonst lädt sie das Archiv, prüft die Prüfsumme und
 * entpackt es. Bei jedem Fehler bleibt nichts im Cache liegen.
 *
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {string} [opts.platform]
 * @param {string} [opts.arch]
 * @param {Readonly<Record<string, string>>} [opts.checksums]
 * @param {(url: string, file: string) => Promise<void>} [opts.download]
 * @returns {Promise<string>}
 */
export async function ensureGitleaks({
  cacheDir,
  platform = process.platform,
  arch = process.arch,
  checksums = GITLEAKS_CHECKSUMS,
  download = fetchToFile,
}) {
  const binary = join(cacheDir, 'gitleaks')
  if (isExecutable(binary)) return binary

  const name = gitleaksPlatform(platform, arch)
  const expected = name ? checksums[name] : undefined
  if (!name || !expected) {
    throw new Error(`Keine gitleaks-Prüfsumme für ${platform}-${arch}.`)
  }

  const url =
    `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/` +
    `gitleaks_${GITLEAKS_VERSION}_${name}.tar.gz`
  mkdirSync(cacheDir, { recursive: true })
  // Jeder Lauf lädt und entpackt in einen eigenen Ordner. Erst der Rename legt
  // die Datei an ihren Platz, und er ist atomar. Ein abgebrochener Lauf lässt
  // so nie eine halbe Datei am Zielpfad liegen, und parallele Läufe stören
  // sich nicht.
  const work = mkdtempSync(join(cacheDir, 'tmp-'))
  try {
    const archive = join(work, 'gitleaks.tar.gz')
    try {
      await download(url, archive)
    } catch (err) {
      // fetch meldet nur «fetch failed». Die eigentliche Ursache steht in cause.
      const e = /** @type {Error & { cause?: unknown }} */ (err)
      const cause = e.cause instanceof Error ? ` (${e.cause.message})` : ''
      throw new Error(`Download von ${url} scheiterte: ${e.message}${cause}`)
    }
    const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (actual !== expected) {
      throw new Error(
        `Prüfsumme von ${url} stimmt nicht.\n  erwartet: ${expected}\n  erhalten: ${actual}`,
      )
    }
    execFileSync('tar', ['-xzf', archive, '-C', work, 'gitleaks'], { stdio: 'ignore' })
    renameSync(join(work, 'gitleaks'), binary)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return binary
}
