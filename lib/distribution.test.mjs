import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Die Sandbox für den security-audit-Skill braucht nur der Audit-Host.
// Sie darf weder ins npm-Paket noch ins Composer-Archiv gelangen.

const root = new URL('..', import.meta.url)
const read = (/** @type {string} */ name) => readFileSync(new URL(name, root), 'utf8')

test('package.json: files nennt security-audit nicht', () => {
  const files = /** @type {string[]} */ (JSON.parse(read('package.json')).files)
  assert.equal(files.filter((f) => f.replace(/^\.?\//, '').startsWith('security-audit')).length, 0)
})

test('gitattributes: security-audit ist export-ignore', () => {
  assert.match(read('.gitattributes'), /^\/security-audit export-ignore$/m)
})

test('composer.json: archive.exclude enthält /security-audit', () => {
  assert.ok(JSON.parse(read('composer.json')).archive?.exclude?.includes('/security-audit'))
})

test('git archive: enthält security-audit nicht', (t) => {
  // Das Archiv geht über eine Datei an tar, nicht über stdin. bsdtar beendet
  // sich an der End-of-Archive-Marke. git archive füllt danach bis zur
  // Record-Grösse auf. Bei einer Pipe schreibt Node diese Bytes unter Last
  // erst nach dem Ende von tar, und execFileSync wirft EPIPE.
  const dir = mkdtempSync(join(tmpdir(), 'quality-distribution-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'archive.tar')
  execFileSync('git', ['archive', '--worktree-attributes', '-o', file, 'HEAD'], {
    cwd: fileURLToPath(root),
  })
  const list = execFileSync('tar', ['-tf', file], { maxBuffer: 64 * 1024 * 1024 }).toString()
  assert.equal(list.split('\n').filter((l) => l.startsWith('security-audit/')).length, 0)
})
