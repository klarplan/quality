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
 * falsches "ddev" mit Mutagen, dessen Sync hängt.
 *
 * @param {import('node:test').TestContext} t
 */
function haengenderSync(t) {
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
  describe)
    printf '{"raw":{"status":"running","approot":"%s","mutagen_enabled":true}}\\n' "$(pwd -P)" ;;
  mutagen) exec sleep 60 ;;
  exec)
    case "$*" in
      *" -- ls "*)
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

test('post-edit: hängt der Mutagen-Sync, meldet der Hook das vor seinem Zeitlimit', (t) => {
  const { dir, path } = haengenderSync(t)

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
