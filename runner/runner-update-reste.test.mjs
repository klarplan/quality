// Prüft den Cron /etc/cron.daily/runner-update-reste, den provision.sh anlegt.
// Der Test liest das Heredoc aus provision.sh und führt es mit sh gegen eine
// nachgebaute Ordnerstruktur in einem Temp-Ordner aus.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

const PROVISION = new URL('./provision.sh', import.meta.url)
const MARKER = "cat >/etc/cron.daily/runner-update-reste <<'EOF'\n"

/** Liest den Inhalt des Heredocs aus provision.sh. */
function script() {
  const text = readFileSync(PROVISION, 'utf8')
  const start = text.indexOf(MARKER)
  assert.notEqual(start, -1, 'provision.sh legt /etc/cron.daily/runner-update-reste nicht an')
  const body = text.slice(start + MARKER.length)
  return body.slice(0, body.indexOf('\nEOF\n') + 1)
}

/** @type {string[]} */
const tempDirs = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function root() {
  const d = mkdtempSync(join(tmpdir(), 'runner-update-reste-'))
  tempDirs.push(d)
  return d
}

/**
 * Setzt die mtime eines Pfads und aller Einträge darunter zurück.
 * Vorgabe: zwei Stunden, also über der Grenze von 60 Minuten.
 * @param {string} path
 * @param {number} [minutes]
 */
function age(path, minutes = 120) {
  const t = new Date(Date.now() - minutes * 60 * 1000)
  if (statSync(path).isDirectory()) {
    for (const e of readdirSync(path)) age(join(path, e), minutes)
  }
  utimesSync(path, t, t)
}

/**
 * Baut einen Runner-Ordner nach: bin.<v> und externals.<v> je Version, die
 * Links bin und externals auf die aktive Version, optional _work/_update.
 * @param {string} base
 * @param {{ versions: string[], active: string, update?: boolean, absolute?: boolean, fresh?: string[] }} opts
 */
function runner(base, { versions, active, update = false, absolute = false, fresh = [] }) {
  const dir = join(base, 'repo', '1')
  mkdirSync(dir, { recursive: true })
  for (const v of versions) {
    for (const kind of ['bin', 'externals']) {
      mkdirSync(join(dir, `${kind}.${v}`))
      writeFileSync(join(dir, `${kind}.${v}`, 'x'), '')
    }
  }
  if (update) {
    mkdirSync(join(dir, '_work', '_update'), { recursive: true })
    writeFileSync(join(dir, '_work', '_update', 'x'), '')
  }
  for (const v of versions) {
    // Frisch heisst 30 Minuten alt: knapp unter der Grenze, nicht null.
    const minutes = fresh.includes(v) ? 30 : 120
    age(join(dir, `bin.${v}`), minutes)
    age(join(dir, `externals.${v}`), minutes)
  }
  if (update) age(join(dir, '_work', '_update'))
  for (const kind of ['bin', 'externals']) {
    const target = absolute ? join(dir, `${kind}.${active}`) : `${kind}.${active}`
    symlinkSync(target, join(dir, kind))
  }
  return dir
}

/** Muster, das nur auf den Kindprozess dieses Tests passt. */
const PATTERN = `[r]unner-update-reste-test-worker-${process.pid}`

/**
 * Führt das Skript aus und gibt die Logzeilen zurück.
 * @param {string} base
 */
function run(base) {
  const r = spawnSync('sh', ['-c', script()], {
    env: { ...process.env, RUNNER_ROOT: base, RUNNER_WORKER_PATTERN: PATTERN, RUNNER_LOG: 'echo' },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `Exit ${r.status}: ${r.stderr}`)
  assert.equal(r.stderr, '')
  return r.stdout
}

function entries(/** @type {string} */ dir) {
  return readdirSync(dir).sort()
}

test('entfernt alte Versionen und lässt die aktive stehen', () => {
  const base = root()
  const dir = runner(base, { versions: ['2.338.0', '2.338.2'], active: '2.338.2' })
  const out = run(base)
  assert.deepEqual(entries(dir), ['bin', 'bin.2.338.2', 'externals', 'externals.2.338.2'])
  assert.match(out, /bin\.2\.338\.0/)
  assert.match(out, /externals\.2\.338\.0/)
})

test('lässt eine frische neue Version stehen', () => {
  const base = root()
  const dir = runner(base, {
    versions: ['2.338.2', '2.339.0'],
    active: '2.338.2',
    fresh: ['2.339.0'],
  })
  run(base)
  assert.deepEqual(entries(dir), [
    'bin',
    'bin.2.338.2',
    'bin.2.339.0',
    'externals',
    'externals.2.338.2',
    'externals.2.339.0',
  ])
})

test('entfernt _update nach abgeschlossenem Update', () => {
  const base = root()
  const dir = runner(base, { versions: ['2.338.0', '2.338.2'], active: '2.338.2', update: true })
  const out = run(base)
  assert.equal(existsSync(join(dir, '_work', '_update')), false)
  assert.equal(existsSync(join(dir, '_work')), true)
  assert.match(out, /_update/)
})

test('lässt _update stehen, solange ein Job läuft', async () => {
  const base = root()
  const dir = runner(base, { versions: ['2.338.2'], active: '2.338.2', update: true })
  const worker = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)', PATTERN.replace('[r]', 'r')],
    { stdio: 'ignore' },
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    run(base)
    assert.equal(existsSync(join(dir, '_work', '_update')), true)
  } finally {
    worker.kill()
  }
})

test('lässt _update stehen, wenn bin nicht auf die neueste Version zeigt', () => {
  const base = root()
  const dir = runner(base, {
    versions: ['2.338.2', '2.339.0'],
    active: '2.338.2',
    update: true,
    fresh: ['2.339.0'],
  })
  run(base)
  assert.equal(existsSync(join(dir, '_work', '_update')), true)
})

test('lässt frisch geänderte _update stehen', () => {
  const base = root()
  const dir = runner(base, { versions: ['2.338.2'], active: '2.338.2', update: true })
  writeFileSync(join(dir, '_work', '_update', 'neu'), '')
  age(join(dir, '_work', '_update'), 30)
  run(base)
  assert.equal(existsSync(join(dir, '_work', '_update')), true)
})

test('vergleicht Versionen numerisch', () => {
  const base = root()
  // 2.4.10 ist frisch und bleibt stehen. Als Text sortiert wäre sie die
  // neueste Version, und _update bliebe fälschlich liegen.
  const dir = runner(base, {
    versions: ['2.4.10', '2.338.0'],
    active: '2.338.0',
    update: true,
    fresh: ['2.4.10'],
  })
  run(base)
  assert.equal(existsSync(join(dir, '_work', '_update')), false)
  assert.equal(existsSync(join(dir, 'bin.2.4.10')), true)
})

test('nimmt absolute Link-Ziele', () => {
  const base = root()
  const dir = runner(base, {
    versions: ['2.338.0', '2.338.2'],
    active: '2.338.2',
    absolute: true,
    update: true,
  })
  run(base)
  assert.deepEqual(entries(dir), ['_work', 'bin', 'bin.2.338.2', 'externals', 'externals.2.338.2'])
})

test('lässt Ordner ohne Link bin unberührt', () => {
  const base = root()
  const dir = join(base, 'resplan', '1')
  mkdirSync(join(dir, 'bin.2.338.0'), { recursive: true })
  mkdirSync(join(dir, '_work', '_update'), { recursive: true })
  age(dir)
  const out = run(base)
  assert.deepEqual(entries(dir), ['_work', 'bin.2.338.0'])
  assert.equal(existsSync(join(dir, '_work', '_update')), true)
  assert.equal(out, '')
})

test('läuft ohne Runner ohne Fehler', () => {
  assert.equal(run(root()), '')
})

test('läuft ohne RUNNER_ROOT-Ordner ohne Fehler', () => {
  assert.equal(run(join(root(), 'fehlt')), '')
})

test('lässt Runner ohne Link externals unberührt', () => {
  const base = root()
  const dir = runner(base, { versions: ['2.338.0', '2.338.2'], active: '2.338.2', update: true })
  rmSync(join(dir, 'externals'))
  run(base)
  assert.deepEqual(entries(dir), [
    '_work',
    'bin',
    'bin.2.338.0',
    'bin.2.338.2',
    'externals.2.338.0',
    'externals.2.338.2',
  ])
  assert.equal(existsSync(join(dir, '_work', '_update')), true)
})
