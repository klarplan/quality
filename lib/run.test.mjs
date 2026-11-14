/**
 * Wie die Zusammenfassung einen weichen Schritt wertet.
 *
 * Ein weicher Schritt ist ein Hinweis, keine Prüfung: er darf das Gate nicht
 * färben und nicht in der Summe auftauchen. Der fmt-Schritt in `task` und
 * `full` erzeugt mit `--base` genau so einen — er meldet Formatierung
 * ausserhalb des Diffs, für die dieser Zweig nicht einsteht.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runStep, summarize } from './run.mjs'

/** @import { StepResult } from './types.mjs' */

/**
 * Fängt auf, was summarize schreibt, und gibt Text und Rückgabewert zurück.
 *
 * @param {Array<Omit<StepResult, 'output'>>} results
 */
function lauf(results) {
  const original = process.stdout.write
  let text = ''
  process.stdout.write = (chunk) => {
    text += chunk
    return true
  }
  try {
    const code = summarize(results, { label: 'quality task' })
    return { text, code }
  } finally {
    process.stdout.write = original
  }
}

const hart = (code = 0) => ({ name: 'prettier (prüfend) (.)', code })
const weich = (code = 0, extra = {}) => ({
  name: 'prettier — ganze Fläche',
  code,
  soft: true,
  ...extra,
})

test('Ein weicher Fund färbt das Gate nicht', () => {
  const { text, code } = lauf([hart(0), weich(1, { note: 'blockiert nicht' })])

  assert.equal(code, 0)
  assert.match(text, /prettier — ganze Fläche/)
  assert.doesNotMatch(text, /fehlgeschlagen/)
})

test('Ein weicher Schritt zählt nicht als Prüfung', () => {
  const { text } = lauf([hart(0), weich(1)])

  assert.match(text, /1 Prüfung bestanden/)
})

test('Ein weicher Schritt ohne Fund bekommt keine Zeile', () => {
  const { text, code } = lauf([hart(0), weich(0)])

  assert.equal(code, 0)
  assert.doesNotMatch(text, /ganze Fläche/)
})

test('Ein übersprungener weicher Schritt wiederholt den harten nicht', () => {
  // Fehlt das Werkzeug, sagt das schon der harte Lauf. Zweimal dieselbe
  // Zeile ist keine zweite Auskunft.
  const uebersprungen = {
    name: 'prettier',
    code: 0,
    skipped: true,
    reason: 'Werkzeug nicht gefunden',
  }
  const { text } = lauf([
    uebersprungen,
    { ...uebersprungen, name: 'prettier — ganze Fläche', soft: true },
  ])

  assert.doesNotMatch(text, /ganze Fläche/)
  assert.match(text, /Werkzeug nicht gefunden/)
})

test('Ein harter Fehler bleibt ein Fehler', () => {
  const { text, code } = lauf([hart(1), weich(1)])

  assert.equal(code, 1)
  assert.match(text, /1 von 1 Prüfungen fehlgeschlagen/)
})

/* ── Pflichtschritte und «0 Prüfungen» ───────────────────────────────── */

const pflicht = { name: 'lint (.)', code: 1, skipped: true, required: true, reason: 'kein Linter' }

test('runStep: ein übersprungener Pflichtschritt endet mit Code 1', async () => {
  const result = await runStep({ name: 'lint (.)', skip: 'kein Linter', required: true })

  assert.equal(result.code, 1)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'kein Linter')
})

test('runStep: ein Pflichtschritt ohne Arbeit bleibt grün', async () => {
  // Ein Datei-Lauf nur mit ignorierten Dateien hat nichts zu prüfen. Das ist
  // keine fehlende Prüfung.
  const result = await runStep({
    name: 'prettier',
    skip: 'nur Dateien, die prettier ignoriert',
    nothingToDo: true,
    required: true,
  })

  assert.equal(result.code, 0)
})

test('Ein übersprungener Pflichtschritt ist rot und nennt den Grund', () => {
  const { text, code } = lauf([hart(0), pflicht])

  assert.equal(code, 1)
  assert.match(text, /✗ lint \(\.\) — Pflichtschritt übersprungen: kein Linter/)
  assert.match(text, /1 von 2 Prüfungen fehlgeschlagen: lint \(\.\)/)
})

test('Sind alle Schritte übersprungen, ist das Gate rot', () => {
  const { text, code } = lauf([
    { name: 'prettier', code: 0, skipped: true, reason: 'Werkzeug nicht gefunden' },
    { name: 'lint', code: 0, skipped: true, reason: 'kein Linter' },
  ])

  assert.equal(code, 1)
  assert.match(text, /Keine Prüfung ist gelaufen\. Übersprungen: prettier, lint/)
  assert.doesNotMatch(text, /bestanden/)
})

test('Ohne Arbeit übersprungene Schritte machen das Gate nicht rot', () => {
  const { code } = lauf([
    {
      name: 'prettier',
      code: 0,
      skipped: true,
      nothingToDo: true,
      reason: 'nur ignorierte Dateien',
    },
  ])

  assert.equal(code, 0)
})

test('Nur weiche Schritte machen das Gate nicht rot', () => {
  const { code } = lauf([weich(0)])

  assert.equal(code, 0)
})
