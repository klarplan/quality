import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  checkoutTempDir,
  healStaleCache,
  phpstanEnv,
  reflectionCacheDir,
  stalePath,
} from './phpstan-cache.mjs'

// Die Meldungen stammen aus adboard, 12.11.2026, PHPStan 2.3.4. Der Worktree
// war gelöscht, der gemeinsame Cache in $TMPDIR/phpstan verwies noch darauf.
const GONE = '/nirgends/adboard-worktrees/geloescht/backend/vendor/phpstan/phpstan/phpstan.phar'
const STUB = `phar://${GONE}/vendor/ondrejmirtes/better-reflection/src/SourceLocator/SourceStubber/../../../../../jetbrains/phpstorm-stubs/standard/standard_10.stub`

/** PHPStans JSON: die Meldung steht in `errors`. */
const json = `{"totals":{"errors":1,"file_errors":0},"files":{},"errors":[${JSON.stringify(
  `Internal error: "${STUB}" is not a file while analysing file /p/app/A.php`,
)}]}`

/** PHPStans Tabelle: der Pfad ist auf 75 Zeichen umbrochen. */
function table() {
  const text = `"${STUB}" is not a file while analysing file /p/app/A.php`
  const lines = ['     Internal error:']
  for (let i = 0; i < text.length; i += 73) lines.push(`     ${text.slice(i, i + 73)}  `)
  return [' -- ---', '     Error', ' -- ---', ...lines, ' -- ---'].join('\n')
}

/** Kurzformat von laravel/pao: dieselbe Meldung, JSON-maskiert. */
const pao = `{"tool":"phpstan","result":"failed","errors":1,"general_errors":[${JSON.stringify(
  `Internal error: "${STUB}" is not a file while analysing file /p/app/A.php`,
)}]}`

test('stalePath erkennt den verwaisten Pfad im JSON-Bericht', () => {
  assert.equal(stalePath(json), GONE)
})

test('stalePath erkennt den verwaisten Pfad in der umbrochenen Tabelle', () => {
  assert.equal(stalePath(table()), GONE)
})

test('stalePath erkennt den verwaisten Pfad im Kurzformat von laravel/pao', () => {
  assert.equal(stalePath(pao), GONE)
})

test('stalePath übergeht die Meldung, wenn die Datei noch existiert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-stale-'))
  try {
    const phar = join(dir, 'phpstan.phar')
    writeFileSync(phar, '')
    const output = `Internal error: "phar://${phar}/x.stub" is not a file while analysing file /p/A.php`
    assert.equal(stalePath(output), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stalePath übergeht gewöhnliche Befunde', () => {
  assert.equal(stalePath('Line 3: Function f() should return int but returns string.'), null)
})

test('healStaleCache löscht den Reflection-Cache bei verwaistem Pfad', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-cache-'))
  try {
    const cache = join(dir, 'PHPStan')
    mkdirSync(join(cache, '61', 'ad'), { recursive: true })
    writeFileSync(join(cache, '61', 'ad', 'x.dat'), 'alt')
    assert.equal(healStaleCache(json, { dir: cache }), true)
    assert.equal(existsSync(cache), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('healStaleCache lässt den Cache bei anderen Fehlern stehen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-cache-'))
  try {
    const cache = join(dir, 'PHPStan')
    mkdirSync(cache)
    assert.equal(
      healStaleCache('Internal error: Allowed memory size exhausted', { dir: cache }),
      false,
    )
    assert.equal(existsSync(cache), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/*
 * Mini, 15.11.2026: Alle Checkouts teilten sich $TMPDIR/phpstan. PHPStan
 * 2.3.5 speichert bei Enums wie RoundingMode absolute Stub-Pfade in den
 * Phar des Checkouts, der den Eintrag schrieb. Nach dem Löschen eines
 * tiktok-Worktrees brach PHPStan in msads ab. Löschte quality den Cache,
 * brach zusätzlich ein gleichzeitiger PHPStan-Lauf ab.
 */

test('checkoutTempDir trennt zwei Checkouts und bleibt je Checkout gleich', () => {
  const base = mkdtempSync(join(tmpdir(), 'quality-base-'))
  const a = mkdtempSync(join(tmpdir(), 'quality-a-'))
  const b = mkdtempSync(join(tmpdir(), 'quality-b-'))
  try {
    const first = checkoutTempDir(a, { base })
    assert.notEqual(first, checkoutTempDir(b, { base }))
    assert.equal(first, checkoutTempDir(a, { base }))
    assert.equal(dirname(first), base)
    assert.match(basename(first), /^phpstan-[0-9a-f]{12}$/)
  } finally {
    for (const d of [base, a, b]) rmSync(d, { recursive: true, force: true })
  }
})

test('phpstanEnv legt den Ordner des Checkouts an und setzt TMPDIR darauf', () => {
  const base = mkdtempSync(join(tmpdir(), 'quality-base-'))
  const a = mkdtempSync(join(tmpdir(), 'quality-a-'))
  try {
    const env = phpstanEnv(a, { base })
    const own = checkoutTempDir(a, { base })
    assert.equal(env.TMPDIR, `${own}/`)
    assert.equal(existsSync(own), true)
  } finally {
    for (const d of [base, a]) rmSync(d, { recursive: true, force: true })
  }
})

test('phpstanEnv entfernt den Cache eines gelöschten Checkouts und lässt lebende stehen', () => {
  const base = mkdtempSync(join(tmpdir(), 'quality-base-'))
  const alive = mkdtempSync(join(tmpdir(), 'quality-alive-'))
  const gone = mkdtempSync(join(tmpdir(), 'quality-gone-'))
  const current = mkdtempSync(join(tmpdir(), 'quality-current-'))
  try {
    phpstanEnv(alive, { base })
    phpstanEnv(gone, { base })
    const aliveCache = checkoutTempDir(alive, { base })
    const goneCache = checkoutTempDir(gone, { base })
    rmSync(gone, { recursive: true, force: true })
    // Ein Ordner ohne Herkunftsdatei gehört nicht quality. Er bleibt stehen.
    const foreign = join(base, 'phpstan-fremd')
    mkdirSync(foreign)

    phpstanEnv(current, { base })

    assert.equal(existsSync(goneCache), false)
    assert.equal(existsSync(aliveCache), true)
    assert.equal(existsSync(foreign), true)
  } finally {
    for (const d of [base, alive, gone, current]) rmSync(d, { recursive: true, force: true })
  }
})

test('healStaleCache meldet false statt zu werfen, wenn das Löschen scheitert', () => {
  // rmSync wirft ENOTEMPTY, wenn ein anderer PHPStan-Lauf gleichzeitig schreibt.
  const dir = mkdtempSync(join(tmpdir(), 'quality-cache-'))
  try {
    const cache = join(dir, 'PHPStan')
    mkdirSync(cache)
    const remove = () => {
      throw Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
    }
    assert.equal(healStaleCache(json, { dir: cache, remove }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reflectionCacheDir liegt im übergebenen Temp-Ordner', () => {
  assert.equal(reflectionCacheDir('/t/phpstan-abc/'), '/t/phpstan-abc/phpstan/cache/PHPStan')
})

test('phpstanEnv lässt den Cache stehen, wenn der Checkout nur nicht lesbar ist', () => {
  // existsSync meldet auch bei EACCES false. Nur ENOENT heisst «gelöscht».
  const base = mkdtempSync(join(tmpdir(), 'quality-base-'))
  const locked = mkdtempSync(join(tmpdir(), 'quality-locked-'))
  const inner = join(locked, 'checkout')
  mkdirSync(inner)
  const current = mkdtempSync(join(tmpdir(), 'quality-current-'))
  try {
    phpstanEnv(inner, { base })
    const cache = checkoutTempDir(inner, { base })
    chmodSync(locked, 0o000)
    phpstanEnv(current, { base })
    chmodSync(locked, 0o755)
    assert.equal(existsSync(cache), true)
  } finally {
    chmodSync(locked, 0o755)
    for (const d of [base, locked, current]) rmSync(d, { recursive: true, force: true })
  }
})

test('phpstanEnv gibt eine leere Umgebung zurück, wenn der Temp-Ordner nicht beschreibbar ist', () => {
  // Ein voller oder schreibgeschützter Temp darf nur PHPStan treffen, nicht den ganzen Lauf.
  const dir = mkdtempSync(join(tmpdir(), 'quality-file-'))
  const a = mkdtempSync(join(tmpdir(), 'quality-a-'))
  try {
    const base = join(dir, 'keine-ordner')
    writeFileSync(base, '')
    assert.deepEqual(phpstanEnv(a, { base }), {})
  } finally {
    for (const d of [dir, a]) rmSync(d, { recursive: true, force: true })
  }
})
