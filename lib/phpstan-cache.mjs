import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Der PHPStan-Cache eines Checkouts.
 *
 * PHPStan legt seinen Cache in `sys_get_temp_dir()/phpstan` ab (siehe
 * configs/phpstan/base.neon, warum quality kein tmpDir setzt). Ohne Zutun
 * teilen sich alle Projekte und Worktrees auf einem Rechner diesen Cache.
 * Der Reflection-Cache darin speichert absolute Pfade in den Phar des
 * Checkouts, der den Eintrag schrieb. Sein Schlüssel enthält den Pfad nicht.
 * Bis 2.3.5 machte PHPStan etwa bei Enums wie RoundingMode nur den äusseren
 * Stub-Pfad relativ. Löschte das Board einen Worktree, brach PHPStan in
 * jedem anderen Checkout mit «Internal error: "<pfad>" is not a file» ab.
 * Gesehen in adboard am 12.11.2026 und auf dem mini am 15.11.2026.
 * PHPStan 2.3.6 behebt den Fehler (phpstan/phpstan#15607, BetterReflection
 * 6.75.0.6). Nachgestellt am 21.11.2026 mit 2.3.7: beide Läufe grün.
 *
 * Der eigene Cache je Checkout bleibt trotzdem (Entscheid René, 21.11.2026).
 * Er trennt parallele Läufe, und ein künftiger Fehler im Cache trifft nur
 * einen Checkout statt alle.
 *
 * Abhilfe: quality gibt jedem Checkout einen eigenen Temp-Ordner
 * `<System-Temp>/phpstan-<hash des Pfads>` und setzt TMPDIR für PHPStan
 * darauf. PHP liest TMPDIR in sys_get_temp_dir(). Der Cache bleibt damit
 * ausserhalb des Projekts und ist ab dem zweiten Lauf warm. Ein Checkout
 * liest nie Einträge eines anderen. Caches gelöschter Checkouts räumt
 * quality beim nächsten Lauf weg.
 *
 * Die Selbstheilung bleibt als Rückfallebene: Nennt PHPStan trotzdem einen
 * verwaisten Pfad, löscht quality den Reflection-Cache des eigenen Checkouts
 * und startet PHPStan einmal neu.
 */

/** Die Datei im Temp-Ordner, die den Checkout nennt. */
const ORIGIN = 'checkout'

/**
 * Die Meldung im JSON (`\"` im Kurzformat von laravel/pao) und in der Tabelle.
 * Die Tabelle bricht den Pfad um; der Aufrufer fügt die Zeilen vorher zusammen.
 */
const NOT_A_FILE = /Internal error:\s*\\?"([^"\\]+)\\?"\s*is not a file/

/** Hinweis für die Ausgabe, wenn quality den Cache gelöscht hat. */
export const STALE_CACHE_NOTE =
  'PHPStan-Cache verwies auf einen gelöschten Worktree. quality hat den Cache gelöscht und startet PHPStan neu.'

/**
 * Der Pfad aus der Meldung, wenn es ihn nicht mehr gibt. Sonst null.
 *
 * Bei einem Pfad in einem Phar zählt das Phar selbst: der Teil dahinter ist
 * kein Dateipfad.
 *
 * @param {string} output Ausgabe von PHPStan, stdout und stderr
 * @returns {string | null}
 */
export function stalePath(output) {
  const flat = output.replace(/[ \t]*\r?\n[ \t]*/g, '')
  const hit = NOT_A_FILE.exec(flat)
  if (!hit) return null
  const path = /** @type {string} */ (hit[1]).replace(/^phar:\/\//, '')
  const phar = path.indexOf('.phar/')
  const file = phar === -1 ? path : path.slice(0, phar + '.phar'.length)
  return existsSync(file) ? null : file
}

/**
 * Der Temp-Ordner eines Checkouts.
 *
 * Der Hash nimmt den aufgelösten Pfad. Ein Symlink auf denselben Checkout
 * ergibt so denselben Ordner.
 *
 * @param {string} dir Verzeichnis, in dem PHPStan läuft
 * @param {{ base?: string }} [options] System-Temp, Standard os.tmpdir()
 * @returns {string}
 */
export function checkoutTempDir(dir, { base = tmpdir() } = {}) {
  const hash = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 12)
  return join(base, `phpstan-${hash}`)
}

/**
 * Die Umgebung für einen PHPStan-Lauf in `dir`.
 *
 * Legt den Temp-Ordner des Checkouts an und räumt vorher die Ordner
 * gelöschter Checkouts weg. Scheitert das, etwa bei vollem oder
 * schreibgeschütztem Temp, ist die Umgebung leer. PHPStan nimmt dann den
 * gemeinsamen Cache wie vor dieser Änderung, und der übrige Lauf geht weiter.
 *
 * @param {string} dir
 * @param {{ base?: string }} [options]
 * @returns {{ TMPDIR?: string }}
 */
export function phpstanEnv(dir, { base = tmpdir() } = {}) {
  try {
    pruneOrphanCaches(base)
    const own = checkoutTempDir(dir, { base })
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, ORIGIN), `${realpathSync(dir)}\n`)
    return { TMPDIR: `${own}/` }
  } catch {
    return {}
  }
}

/**
 * True nur, wenn es den Pfad sicher nicht mehr gibt.
 *
 * existsSync meldet auch bei fehlenden Rechten false. Ein Cache darf aber
 * nur weg, wenn sein Checkout gelöscht ist.
 *
 * @param {string} path
 * @returns {boolean}
 */
function gone(path) {
  try {
    statSync(path)
    return false
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
  }
}

/**
 * Entfernt die Temp-Ordner, deren Checkout es nicht mehr gibt.
 *
 * Nur Ordner mit Herkunftsdatei gehören quality. Andere bleiben stehen.
 * Scheitert das Löschen, bleibt der Ordner bis zum nächsten Lauf liegen.
 *
 * @param {string} base
 */
function pruneOrphanCaches(base) {
  /** @type {string[]} */
  let names
  try {
    names = readdirSync(base)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith('phpstan-')) continue
    const folder = join(base, name)
    let origin
    try {
      origin = readFileSync(join(folder, ORIGIN), 'utf8').trim()
    } catch {
      continue
    }
    if (!origin || !gone(origin)) continue
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch {
      // Ein anderer Lauf räumt gleichzeitig. Der nächste Lauf versucht es neu.
    }
  }
}

/**
 * Der Reflection-Cache im Temp-Ordner, den PHPStan als sys_get_temp_dir() sieht.
 *
 * @param {string} [tempDir] TMPDIR des PHPStan-Laufs, Standard os.tmpdir()
 * @returns {string}
 */
export function reflectionCacheDir(tempDir = tmpdir()) {
  return join(tempDir, 'phpstan', 'cache', 'PHPStan')
}

/**
 * Löscht den Reflection-Cache, wenn die Ausgabe einen verwaisten Pfad nennt.
 *
 * Gibt true zurück, wenn gelöscht wurde. Dann lohnt sich ein neuer Lauf.
 * Scheitert das Löschen, etwa mit ENOTEMPTY bei einem gleichzeitigen Lauf im
 * selben Checkout, gibt die Funktion false zurück. Der Schritt bleibt dann
 * mit der Meldung von PHPStan rot, statt den ganzen Lauf abzubrechen.
 *
 * @param {string} output
 * @param {{ dir?: string, remove?: typeof rmSync }} [options]
 * @returns {boolean}
 */
export function healStaleCache(output, { dir = reflectionCacheDir(), remove = rmSync } = {}) {
  if (!stalePath(output) || !existsSync(dir)) return false
  try {
    remove(dir, { recursive: true, force: true })
  } catch {
    return false
  }
  return true
}
