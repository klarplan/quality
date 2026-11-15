import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseToml, TomlError } from './toml.mjs'

test('Skalare auf oberster Ebene', () => {
  assert.deepEqual(
    parseToml(
      'name = "x"\nliteral = \'C:\\pfad\'\nzahl = 100\nminus = -3\nkomma = 0.5\nja = true\nnein = false',
    ),
    { name: 'x', literal: 'C:\\pfad', zahl: 100, minus: -3, komma: 0.5, ja: true, nein: false },
  )
})

test('Escapes in Basic-Strings', () => {
  assert.deepEqual(parseToml('a = "x\\"y\\\\z\\n\\t"'), { a: 'x"y\\z\n\t' })
})

test('Kommentare und Leerzeilen zählen nicht, # im String bleibt', () => {
  assert.deepEqual(parseToml('# Kopf\n\na = "x # y" # Rest\n  # eingerückt\n'), { a: 'x # y' })
})

test('Tabellen und verschachtelte Tabellen', () => {
  assert.deepEqual(
    parseToml('[tool.ruff]\nline-length = 100\n\n[tool.ruff.lint]\nselect = ["E"]\n'),
    {
      tool: { ruff: { 'line-length': 100, lint: { select: ['E'] } } },
    },
  )
})

test('gepunktete Schlüssel unter einer Tabelle und auf oberster Ebene', () => {
  assert.deepEqual(parseToml('tool.mypy.strict = true\n[tool]\nruff.lint.ignore = ["ALL"]\n'), {
    tool: { mypy: { strict: true }, ruff: { lint: { ignore: ['ALL'] } } },
  })
})

test('gequotete Schlüssel in Tabellenköpfen und Zuweisungen', () => {
  assert.deepEqual(
    parseToml('[tool."ruff"]\n"line-length" = 80\n[tool.\'mypy\']\na.\'b c\' = 1\n'),
    {
      tool: { ruff: { 'line-length': 80 }, mypy: { a: { 'b c': 1 } } },
    },
  )
})

test('Leerzeichen um Punkte und in Tabellenköpfen', () => {
  assert.deepEqual(parseToml('[ tool . ruff ]\nlint . select = []\n'), {
    tool: { ruff: { lint: { select: [] } } },
  })
})

test('Tabellenlisten', () => {
  assert.deepEqual(
    parseToml(
      '[[tool.mypy.overrides]]\nmodule = "a"\n\n[[tool.mypy.overrides]]\nmodule = "b"\nignore_errors = true\n',
    ),
    { tool: { mypy: { overrides: [{ module: 'a' }, { module: 'b', ignore_errors: true }] } } },
  )
})

test('Untertabelle zu einem Eintrag einer Tabellenliste', () => {
  assert.deepEqual(parseToml('[[a]]\nx = 1\n[a.b]\ny = 2\n'), { a: [{ x: 1, b: { y: 2 } }] })
})

test('mehrzeilige Liste mit Kommentaren, Schlusskomma und verschachtelten Listen', () => {
  const text = 'ignore = [\n  "E501", # zu lang\n  ["tests"],\n  "F401",\n]\nnach = 1\n'
  assert.deepEqual(parseToml(text), { ignore: ['E501', ['tests'], 'F401'], nach: 1 })
})

test('Inline-Tabellen, auch verschachtelt und in Listen', () => {
  assert.deepEqual(parseToml('a = { x = 1, y.z = "q" }\nb = [{ n = 1 }, { n = 2 }]\nc = {}\n'), {
    a: { x: 1, y: { z: 'q' } },
    b: [{ n: 1 }, { n: 2 }],
    c: {},
  })
})

test('Unterstrich in Zahlen', () => {
  assert.deepEqual(parseToml('a = 1_000'), { a: 1000 })
})

/** @type {[string, string][]} */
const INVALID = [
  ['Datum', 'a = 2026-11-15'],
  ['mehrzeiliger String', 'a = """\nx\n"""'],
  ['mehrzeiliger Literal-String', "a = '''x'''"],
  ['Wert ohne Anführungszeichen', 'a = hallo'],
  ['doppelter Schlüssel', 'a = 1\na = 2'],
  ['Tabelle zweimal', '[a]\nx = 1\n[a]\ny = 2'],
  ['Schlüssel überschreibt Tabelle', '[a.b]\nx = 1\n[a]\nb = 2'],
  ['gepunkteter Schlüssel in Inline-Tabelle erweitern', 'a = { x = 1 }\n[a]\ny = 2'],
  ['offene Liste', 'a = [1, 2'],
  ['offener String', 'a = "x'],
  ['unbekanntes Escape', 'a = "\\q"'],
  ['Zeile ohne Gleichheitszeichen', 'a'],
  ['Rest nach dem Wert', 'a = 1 2'],
  ['inf', 'a = inf'],
  ['Hex-Zahl', 'a = 0x10'],
]

for (const [name, text] of INVALID) {
  test(`wirft TomlError: ${name}`, () => {
    assert.throws(() => parseToml(text), TomlError)
  })
}

test('Fehlermeldung nennt die Zeile', () => {
  assert.throws(() => parseToml('a = 1\nb = hallo'), /Zeile 2/)
})
