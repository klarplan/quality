/**
 * `quality gate` über den echten Prozess.
 *
 * Zwei Attrappen ersetzen die Werkzeuge. prettier nennt jede Datei mit dem
 * Wort UNFORMATTED unformatiert. gitleaks liegt im Cache, wo ensureGitleaks
 * es sucht. So lädt kein Test etwas aus dem Netz. Die Attrappe schreibt jeden
 * Aufruf in aufrufe.log und meldet einen Fund, wenn der gescannte Inhalt das
 * Wort SECRET enthält. Im Modus git liest sie `git log -p` wie das echte
 * gitleaks. Darum sieht sie den Diff eines Merge-Commits nicht.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const QUALITY = join(dirname(fileURLToPath(import.meta.url)), 'quality')

const FAKE_PRETTIER = `#!/bin/sh
for f in $(git ls-files); do
  if grep -q UNFORMATTED "$f"; then echo "[warn] $f"; bad=1; fi
done
exit \${bad:-0}
`

const FAKE_GITLEAKS = `#!/bin/sh
echo "$*" >> "$XDG_CACHE_HOME/aufrufe.log"
case "$1" in
  git)
    for a in "$@"; do case "$a" in --log-opts=*) opts="\${a#--log-opts=}" ;; esac; done
    inhalt=$(git log -p $opts) ;;
  stdin) inhalt=$(cat) ;;
esac
case "$inhalt" in *SECRET*) echo "leak gefunden"; exit 1 ;; esac
exit 0
`

const git = (/** @type {string[]} */ args, /** @type {string} */ cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/**
 * Repo mit Basis auf main und einem Branch task mit eigener Arbeit.
 *
 * @param {{ inhalt?: string }} [opts]  Inhalt der Datei, die der Branch ändert
 */
function lage({ inhalt = 'export const a = 2\n' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-gate-')))
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'quality-gate-cache-')))
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), FAKE_PRETTIER)
  chmodSync(join(dir, 'node_modules', '.bin', 'prettier'), 0o755)
  const gl = join(cache, 'standout-quality', 'gitleaks-8.30.1')
  mkdirSync(gl, { recursive: true })
  writeFileSync(join(gl, 'gitleaks'), FAKE_GITLEAKS)
  chmodSync(join(gl, 'gitleaks'), 0o755)

  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  writeFileSync(
    join(dir, 'quality.yml'),
    'version: 1\nlevel: standard\nbaseline: false\ncomponents:\n  - { path: ".", stack: react-ts }\n',
  )
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'Basis'], dir)
  const base = git(['rev-parse', 'HEAD'], dir)
  git(['checkout', '-q', '-b', 'task'], dir)
  writeFileSync(join(dir, 'a.ts'), inhalt)
  git(['commit', '-qam', 'Arbeit'], dir)
  return { dir, cache, base }
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function quality(dir, args, env) {
  // Ein CC_INTEGRATION_BASE aus der Umgebung des Testlaufs darf nicht mitlaufen.
  /** @type {NodeJS.ProcessEnv} */
  const fullEnv = { ...process.env, NO_COLOR: '1' }
  delete fullEnv.CC_INTEGRATION_BASE
  Object.assign(fullEnv, env)
  try {
    const output = execFileSync(process.execPath, [QUALITY, 'gate', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: fullEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { output, code: 0 }
  } catch (thrown) {
    const err = /** @type {{ stdout?: string, stderr?: string, status?: number | null }} */ (thrown)
    return { output: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 }
  }
}

const aufrufe = (/** @type {string} */ cache) => join(cache, 'aufrufe.log')

test('gate: offener Merge → Exit 2 mit Hinweis', () => {
  const { dir, cache, base } = lage()
  git(['checkout', '-q', 'main'], dir)
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'Main'], dir)
  git(['merge', '-q', '--no-ff', '--no-commit', 'task'], dir)
  const { output, code } = quality(dir, ['--base', base], { XDG_CACHE_HOME: cache })
  assert.equal(code, 2)
  assert.match(output, /Committe den Merge/)
})

test('gate: unbekannte Basis → Exit 2', () => {
  const { dir, cache } = lage()
  const { output, code } = quality(dir, ['--base', 'gibtsnicht'], { XDG_CACHE_HOME: cache })
  assert.equal(code, 2)
  assert.match(output, /gibtsnicht/)
})

test('gate: ohne Basis-Angabe und ohne origin/main → Exit 2', () => {
  const { dir, cache } = lage()
  const { output, code } = quality(dir, [], { XDG_CACHE_HOME: cache })
  assert.equal(code, 2)
  assert.match(output, /origin\/main/)
})

test('gate: Null-SHA in CC_INTEGRATION_BASE → Exit 2', () => {
  const { dir, cache } = lage()
  const { code } = quality(dir, [], { XDG_CACHE_HOME: cache, CC_INTEGRATION_BASE: '0000000' })
  assert.equal(code, 2)
})

test('gate: CC_INTEGRATION_BASE wird zur Basis', () => {
  const { dir, cache, base } = lage()
  const { output, code } = quality(dir, [], { XDG_CACHE_HOME: cache, CC_INTEGRATION_BASE: base })
  assert.equal(code, 0, output)
  assert.match(output, new RegExp(`Basis: ${base}`))
})

test('gate: ohne --secrets ruft es gitleaks nicht', () => {
  const { dir, cache, base } = lage()
  const { code } = quality(dir, ['--base', base], { XDG_CACHE_HOME: cache })
  assert.equal(code, 0)
  assert.equal(existsSync(aufrufe(cache)), false)
})

test('gate --secrets: sauberer Branch → Exit 0, «Gate grün»', () => {
  const { dir, cache, base } = lage()
  const { output, code } = quality(dir, ['--base', base, '--secrets'], { XDG_CACHE_HOME: cache })
  assert.equal(code, 0, output)
  assert.match(output, /Gate grün/)
  assert.match(readFileSync(aufrufe(cache), 'utf8'), new RegExp(`--log-opts=HEAD --not ${base}`))
})

test('gate --secrets: Secret im Branch → Exit 1, Secret-Scan rot', () => {
  const { dir, cache, base } = lage({ inhalt: 'export const a = "SECRET"\n' })
  const { output, code } = quality(dir, ['--base', base, '--secrets'], { XDG_CACHE_HOME: cache })
  assert.equal(code, 1)
  assert.match(output, /Gate rot/)
  assert.match(output, /Secret-Scan/)
})

test('gate --secrets: Secret nur in der Konfliktlösung des Merge-Commits → Exit 1', () => {
  const { dir, cache } = lage()
  git(['checkout', '-q', 'main'], dir)
  writeFileSync(join(dir, 'a.ts'), 'export const a = 3\n')
  git(['commit', '-qam', 'Main'], dir)
  const base = git(['rev-parse', 'HEAD'], dir)
  try {
    git(['merge', '-q', '--no-ff', 'task'], dir)
  } catch {
    // Konflikt erwartet: beide Seiten ändern a.ts.
  }
  writeFileSync(join(dir, 'a.ts'), 'export const a = "SECRET"\n')
  git(['add', 'a.ts'], dir)
  git(['commit', '-qm', 'Merge task'], dir)
  const { output, code } = quality(dir, ['--base', base, '--secrets'], { XDG_CACHE_HOME: cache })
  assert.equal(code, 1, output)
  assert.match(output, /gitleaks: Merge-Commit/)
  assert.match(readFileSync(aufrufe(cache), 'utf8'), /^stdin /m)
})

test('gate --secrets: Branch ohne neue Commits → Exit 0', () => {
  const { dir, cache } = lage()
  const head = git(['rev-parse', 'HEAD'], dir)
  const { output, code } = quality(dir, ['--base', head, '--secrets'], { XDG_CACHE_HOME: cache })
  assert.equal(code, 0, output)
})

test('gate --secrets: rote Stufe, Secret-Scan läuft trotzdem', () => {
  const { dir, cache, base } = lage({ inhalt: 'export const a = "SECRET" // UNFORMATTED\n' })
  const { output, code } = quality(dir, ['--base', base, '--secrets'], { XDG_CACHE_HOME: cache })
  assert.equal(code, 1)
  assert.ok(existsSync(aufrufe(cache)))
  assert.match(output, /- quality task/)
  assert.match(output, /- Secret-Scan/)
})

test('gate --secrets: gitleaks nicht ladbar → roter Teil, Stufe lief', () => {
  const { dir, base } = lage()
  // Eine Datei statt eines Ordners: ensureGitleaks kann den Cache nicht anlegen
  // und scheitert, bevor es etwas aus dem Netz lädt.
  const blockiert = join(realpathSync(mkdtempSync(join(tmpdir(), 'quality-gate-x-'))), 'datei')
  writeFileSync(blockiert, '')
  const { output, code } = quality(dir, ['--base', base, '--secrets'], {
    XDG_CACHE_HOME: blockiert,
  })
  assert.equal(code, 1)
  assert.match(output, /quality task/)
  assert.match(output, /gitleaks laden/)
})

test('gate --build: läuft die Stufe full', () => {
  const { dir, cache, base } = lage()
  const { output } = quality(dir, ['--base', base, '--build'], { XDG_CACHE_HOME: cache })
  assert.match(output, /quality full/)
})
