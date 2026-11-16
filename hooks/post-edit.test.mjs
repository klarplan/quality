/**
 * Der Post-Edit-Hook in einem ddev-Projekt mit Mutagen.
 *
 * Der Hook hat 8 s für `quality fix`, danach lässt er still durch. Ein
 * hängender Mutagen-Sync darf dieses Budget nicht aufbrauchen. Sonst sieht
 * der Agent den Hinweis auf `ddev mutagen reset` nie, und die Datei bleibt
 * unformatiert. Befund aus dem Review vom 16.11.2026.
 *
 * Geprüft wird über den echten Prozess mit einem falschen "ddev". Dessen
 * Sync hängt 60 s.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'post-edit.mjs')

/**
 * Ein react-ts-Projekt, dessen node_modules nur im Container liegt, und ein
 * falsches "ddev" mit Mutagen. Der Aufruf `haengt` hängt 60 s.
 *
 * @param {import('node:test').TestContext} t
 * @param {'mutagen' | 'describe' | 'ls'} haengt
 */
function projekt(t, haengt) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-post-edit-')))
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-ddev-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  writeFileSync(
    join(dir, 'quality.yml'),
    'version: 1\nlevel: standard\nbaseline: false\ncomponents:\n  - { path: ".", stack: react-ts }\n',
  )
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'app', devDependencies: { prettier: '^3.0.0', oxlint: '^1.0.0' } }),
  )
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1\n')
  mkdirSync(join(dir, '.ddev'))
  writeFileSync(join(dir, '.ddev', 'config.yaml'), 'name: demo\n')
  writeFileSync(
    join(bin, 'ddev'),
    `#!/bin/sh
case "$1" in
  ${haengt}) exec sleep 60 ;;
esac
case "$1" in
  describe)
    printf '{"raw":{"status":"running","approot":"%s","mutagen_enabled":true}}\\n' "$(pwd -P)" ;;
  exec)
    case "$*" in
      *" -- ls "*)
        ${haengt === 'ls' ? 'exec sleep 60' : ':'}
        echo "/var/www/html/node_modules:"
        echo "oxlint"
        echo "prettier"
        echo ""
        echo "/var/www/html/node_modules/.bin:"
        echo "oxlint"
        echo "prettier" ;;
    esac ;;
esac
`,
  )
  chmodSync(join(bin, 'ddev'), 0o755)
  return { dir, path: `${bin}:${process.env.PATH}` }
}

/**
 * Startet den Hook für app.ts und misst die Dauer.
 *
 * @param {{ dir: string, path: string }} where
 */
function hook({ dir, path }) {
  const start = Date.now()
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, 'app.ts') } }),
    encoding: 'utf8',
    env: { ...process.env, PATH: path },
    timeout: 30_000,
  })
  return { ...run, seconds: (Date.now() - start) / 1000 }
}

for (const haengt of /** @type {const} */ (['describe', 'ls'])) {
  test(`post-edit: hängt ddev bei "${haengt}", meldet der Hook «ddev antwortet nicht»`, (t) => {
    // Review vom 16.11.2026: describe und ls hatten je 10 s. Der Hook liess
    // nach 8 s still durch. Ein Timeout ist auch kein gestopptes ddev und
    // kein fehlendes node_modules.
    const run = hook(projekt(t, haengt))

    assert.equal(run.status, 2, `exit ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, /ddev antwortet nicht/)
    assert.doesNotMatch(run.stderr, /ddev start/)
    assert.doesNotMatch(run.stderr, /node_modules fehlt/)
    assert.ok(run.seconds < 8, `Hook brauchte ${run.seconds} s`)
  })
}

test('post-edit: hängt der Mutagen-Sync, meldet der Hook das vor seinem Zeitlimit', (t) => {
  const { dir, path } = projekt(t, 'mutagen')

  const start = Date.now()
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, 'app.ts') } }),
    encoding: 'utf8',
    env: { ...process.env, PATH: path },
    timeout: 30_000,
  })
  const seconds = (Date.now() - start) / 1000

  assert.equal(run.status, 2, `exit ${run.status}\n${run.stderr}`)
  assert.match(run.stderr, /Mutagen-Sync vor dem Schritt ist gescheitert/)
  assert.match(run.stderr, /ddev mutagen reset/)
  // Der Harness bricht den Hook nach 15 s ab.
  assert.ok(seconds < 12, `Hook brauchte ${seconds} s`)
})
