import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, KNOWN_STACKS, STACK_VERBS, validateConfig } from './config.mjs'

const base = { version: 1, components: [{ path: '.', stack: 'laravel' }] }

test('ohne configs-Block ist die Einbindungsprüfung überall aktiv', () => {
  const config = validateConfig({ ...base }, 'quality.yml')
  assert.deepEqual(config.configs, {})
})

test('configs: prettier: own wird übernommen', () => {
  const config = validateConfig({ ...base, configs: { prettier: 'own' } }, 'quality.yml')
  assert.deepEqual(config.configs, { prettier: 'own' })
})

test('ein unbekannter Schlüssel im configs-Block ist ein Fehler', () => {
  // Ein Tippfehler würde sonst still nichts abschalten — und der Hinweis, den
  // jemand loswerden wollte, bliebe stehen.
  assert.throws(
    () => validateConfig({ ...base, configs: { prettierrc: 'own' } }, 'quality.yml'),
    (error) => error instanceof ConfigError && /prettierrc/.test(error.message),
  )
})

test('ein unbekannter Wert im configs-Block ist ein Fehler', () => {
  assert.throws(
    () => validateConfig({ ...base, configs: { prettier: 'nein' } }, 'quality.yml'),
    (error) => error instanceof ConfigError && /own/.test(error.message),
  )
})

test('python ist ein bekannter Stack', () => {
  assert.ok(KNOWN_STACKS.includes('python'))
})

/* ── required: Pflichtschritte je Komponente ─────────────────────────── */

const mitRequired = (/** @type {string} */ stack, /** @type {unknown} */ required) =>
  validateConfig({ version: 1, components: [{ path: '.', stack, required }] }, 'quality.yml')

test('ohne required ist die Liste leer', () => {
  const config = validateConfig({ ...base }, 'quality.yml')
  assert.deepEqual(config.components[0]?.required, [])
})

test('required wird übernommen', () => {
  const config = mitRequired('react-ts', ['fmt', 'lint', 'types', 'test', 'build'])
  assert.deepEqual(config.components[0]?.required, ['fmt', 'lint', 'types', 'test', 'build'])
})

test('required muss eine Liste sein', () => {
  assert.throws(
    () => mitRequired('react-ts', 'lint'),
    (error) => error instanceof ConfigError && /required muss eine Liste/.test(error.message),
  )
})

test('ein unbekannter Schritt in required ist ein Fehler', () => {
  // Ein Tippfehler würde sonst still nichts verlangen.
  assert.throws(
    () => mitRequired('react-ts', ['tests']),
    (error) => error instanceof ConfigError && /"tests"/.test(error.message),
  )
})

test('ein Schritt, den der Stack nicht hat, ist in required ein Fehler', () => {
  // laravel hat keinen Linter und keinen Build. Ein lint in required wäre eine
  // Zusage, die das Gate nie prüfen kann.
  assert.throws(
    () => mitRequired('laravel', ['fmt', 'lint']),
    (error) => error instanceof ConfigError && /laravel.*lint/.test(error.message),
  )
  assert.throws(
    () => mitRequired('python', ['build']),
    (error) => error instanceof ConfigError && /python.*build/.test(error.message),
  )
})

test('STACK_VERBS deckt sich mit den Stack-Adaptern', async () => {
  // Ein Verb, das in STACK_VERBS fehlt, liefert beim Adapter keinen Schritt.
  // Wer einem Stack einen Schritt gibt, muss ihn auch hier eintragen.
  for (const stack of KNOWN_STACKS) {
    const adapter = (await import(`../stacks/${stack}.mjs`)).default
    /** @type {import('./types.mjs').Verb[]} */
    const verbs = ['fmt', 'lint', 'types', 'test', 'build']
    for (const verb of verbs) {
      if (STACK_VERBS[stack]?.includes(verb)) continue
      assert.equal(adapter[verb]?.({}) ?? null, null, `${stack}.${verb} liefert einen Schritt`)
    }
  }
})

test('ohne exclude-Block ist nichts ausgenommen', () => {
  assert.deepEqual(validateConfig({ ...base }, 'quality.yml').exclude, [])
})

test('exclude übernimmt Pfad und Grund, der Pfad wird normiert', () => {
  const config = validateConfig(
    { ...base, exclude: [{ path: './ads-cockpit/browsershot/', reason: 'Nur Manifest' }] },
    'quality.yml',
  )
  assert.deepEqual(config.exclude, [{ path: 'ads-cockpit/browsershot', reason: 'Nur Manifest' }])
})

/** @type {Array<[string, unknown, RegExp]>} */
const invalidExcludes = [
  ['keine Liste', { path: 'a', reason: 'x' }, /exclude muss eine Liste/],
  ['Eintrag ohne Grund', [{ path: 'a' }], /exclude\[0\]\.reason fehlt/],
  ['Eintrag mit leerem Grund', [{ path: 'a', reason: '  ' }], /exclude\[0\]\.reason fehlt/],
  ['Eintrag ohne Pfad', [{ reason: 'x' }], /exclude\[0\]\.path fehlt/],
  ['Pfad auf die Wurzel', [{ path: './', reason: 'x' }], /exclude\[0\]\.path fehlt/],
  ['absoluter Pfad', [{ path: '/tmp/a', reason: 'x' }], /relativ zur Repo-Wurzel/],
  ['Eintrag ist keine Map', ['a'], /exclude\[0\] muss eine Map/],
]
for (const [name, exclude, message] of invalidExcludes) {
  test(`exclude: ${name} ist ein Fehler`, () => {
    assert.throws(
      () => validateConfig({ ...base, exclude }, 'quality.yml'),
      (error) => error instanceof ConfigError && message.test(error.message),
    )
  })
}

test('exclude: derselbe Pfad wie eine Komponente ist ein Fehler', () => {
  assert.throws(
    () =>
      validateConfig(
        {
          version: 1,
          components: [{ path: 'backend', stack: 'laravel' }],
          exclude: [{ path: 'backend', reason: 'x' }],
        },
        'quality.yml',
      ),
    (error) => error instanceof ConfigError && /backend.*components/.test(error.message),
  )
})

test('exclude: eine Komponente unterhalb des Pfads ist ein Fehler', () => {
  assert.throws(
    () =>
      validateConfig(
        {
          version: 1,
          components: [{ path: 'apps/web', stack: 'react-ts' }],
          exclude: [{ path: 'apps', reason: 'x' }],
        },
        'quality.yml',
      ),
    (error) => error instanceof ConfigError && /apps\/web/.test(error.message),
  )
})

test('exclude: ein Geschwisterordner mit gleichem Präfix ist kein Fehler', () => {
  const config = validateConfig(
    {
      version: 1,
      components: [{ path: 'apps-web', stack: 'react-ts' }],
      exclude: [{ path: 'apps', reason: 'x' }],
    },
    'quality.yml',
  )
  assert.equal(config.exclude.length, 1)
})

/* ── deploy: Ersatzliste der Pflicht-Checks für deploy-check ─────────── */

test('ohne deploy-Block gibt es keine Ersatzliste', () => {
  assert.deepEqual(validateConfig({ ...base }, 'quality.yml').deploy, { requiredChecks: [] })
})

test('deploy.required_checks wird übernommen', () => {
  const config = validateConfig(
    { ...base, deploy: { required_checks: ['quality', 'audit'] } },
    'quality.yml',
  )
  assert.deepEqual(config.deploy, { requiredChecks: ['quality', 'audit'] })
})

test('eine ungültige deploy-Form ist ein Fehler', () => {
  for (const deploy of [
    ['quality'],
    { required_checks: 'quality' },
    { required_checks: [] },
    { required_checks: ['quality', ''] },
    { required_checks: ['quality', 'quality'] },
    { required_checks: [1] },
    { checks: ['quality'] },
  ]) {
    assert.throws(
      () => validateConfig({ ...base, deploy }, 'quality.yml'),
      (error) => error instanceof ConfigError && /deploy/.test(error.message),
      JSON.stringify(deploy),
    )
  }
})
