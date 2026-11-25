// Prüft die Auslese der quality-Version im Schritt «Tamper-Check» der
// CI-Vorlagen in examples/. Der Test führt den REF-Block der Vorlage
// unverändert mit bash aus, gegen ein Lockfile in einem Wegwerf-Repo.
// Die Composer-Fälle brauchen php im PATH, wie der Tamper-Schritt selbst.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples')
const HASH = '117883c095373dd8e53bdab0c729cbc88cc2132c'

/**
 * Liest LOCKFILE und den REF-Block aus dem Tamper-Schritt einer Vorlage.
 * @param {string} name Dateiname in examples/
 */
function tamperStep(name) {
  const lines = readFileSync(join(EXAMPLES, name), 'utf8').split('\n')
  const start = lines.findIndex((l) => l.includes('- name: Tamper-Check'))
  assert.notEqual(start, -1, `${name}: kein Schritt «Tamper-Check»`)
  const rest = lines.slice(start)
  const lockLine = rest.find((l) => /^\s*LOCKFILE:/.test(l))
  assert.ok(lockLine, `${name}: kein LOCKFILE im Tamper-Schritt`)
  const lockfile = lockLine.replace(/^\s*LOCKFILE:\s*/, '').trim()
  const from = rest.findIndex((l) => /^\s*REF=\$\(/.test(l))
  const to = rest.findIndex((l, i) => i >= from && /\|\| true\)\s*$/.test(l))
  assert.ok(from !== -1 && to !== -1, `${name}: kein REF-Block`)
  const lead = (/** @type {string} */ l) => l.length - l.trimStart().length
  const indent = lead(rest[from] ?? '')
  const block = rest
    .slice(from, to + 1)
    .map((l) => l.slice(Math.min(indent, lead(l))))
    .join('\n')
  return { lockfile, block }
}

/**
 * Committet ein Lockfile in ein Wegwerf-Repo und führt den REF-Block aus.
 * @param {string} name Dateiname in examples/
 * @param {string} content Inhalt des Lockfiles
 * @returns {string} der gefundene Hash, leer ohne Treffer
 */
function readRef(name, content) {
  const { lockfile, block } = tamperStep(name)
  const repo = mkdtempSync(join(tmpdir(), 'ci-vorlage-'))
  try {
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '--quiet')
    mkdirSync(dirname(join(repo, lockfile)), { recursive: true })
    writeFileSync(join(repo, lockfile), content)
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'lock')
    const script = `set -euo pipefail\n${block}\nprintf '%s' "$REF"\n`
    return execFileSync('bash', ['-c', script], {
      cwd: repo,
      env: { ...process.env, BASE: 'HEAD', LOCKFILE: lockfile },
      encoding: 'utf8',
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

/** composer.lock mit quality als Repository-Typ vcs: Hash auch in dist. */
const composerVcs = JSON.stringify(
  {
    packages: [],
    'packages-dev': [
      {
        name: 'standout/quality',
        version: 'v0.2.39',
        source: { type: 'git', url: 'https://github.com/klarplan/quality.git', reference: HASH },
        dist: {
          type: 'zip',
          url: `https://api.github.com/repos/klarplan/quality/zipball/${HASH}`,
          reference: HASH,
          shasum: '',
        },
      },
    ],
  },
  null,
  4,
)

/** composer.lock mit quality als Repository-Typ git: kein dist, URL ohne Hash. */
const composerGit = JSON.stringify(
  {
    packages: [],
    'packages-dev': [
      {
        name: 'standout/quality',
        version: 'v0.2.39',
        source: { type: 'git', url: 'https://github.com/klarplan/quality.git', reference: HASH },
      },
    ],
  },
  null,
  4,
)

const composerOhne = JSON.stringify(
  { packages: [{ name: 'acme/x', version: '1.0.0' }], 'packages-dev': [] },
  null,
  4,
)

for (const name of ['ci-split-static-tests.yml', 'ci-monorepo-php-js.yml']) {
  test(`${name}: liest den Hash bei Repository-Typ vcs`, () => {
    assert.equal(readRef(name, composerVcs), HASH)
  })

  test(`${name}: liest den Hash bei Repository-Typ git (nur source)`, () => {
    assert.equal(readRef(name, composerGit), HASH)
  })

  test(`${name}: ohne quality im Lockfile bleibt REF leer`, () => {
    assert.equal(readRef(name, composerOhne), '')
  })
}

test('ci-node.yml: liest den Hash aus der codeload-URL in pnpm-lock.yaml', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    'packages:',
    `  '@standout/quality@https://codeload.github.com/klarplan/quality/tar.gz/${HASH}':`,
    `    resolution: {tarball: https://codeload.github.com/klarplan/quality/tar.gz/${HASH}}`,
    '    version: 0.2.39',
    '',
  ].join('\n')
  assert.equal(readRef('ci-node.yml', lock), HASH)
})

test('ci-node.yml: ohne quality im Lockfile bleibt REF leer', () => {
  assert.equal(readRef('ci-node.yml', "lockfileVersion: '9.0'\npackages: {}\n"), '')
})
