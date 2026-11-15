#!/usr/bin/env node
/**
 * PreToolUse: verhindert, dass der Agent das Gate selbst umschreibt.
 *
 * Geschützt sind genau die Dateien, die definieren, was geprüft wird —
 * Baselines, Gate- und Linter-Konfiguration, CI-Workflows, Hook-Einstellungen.
 * Die Liste stammt aus derselben Quelle wie der Tamper-Check, damit es nicht
 * zwei Wahrheiten darüber gibt, was geschützt ist.
 *
 * Das ist die weiche Sicherung: Ein Agent könnte sie über die Shell umgehen.
 * Die harte Sicherung ist der Tamper-Check in CI. Diese hier existiert, damit
 * es gar nicht erst so weit kommt — und damit der Agent die Grenze erfährt,
 * bevor er Arbeit hineinsteckt.
 *
 * WARUM DIESER HOOK KEINE RICHTUNG KENNT
 *
 * Der Tamper-Check unterscheidet bei Baselines seit v0.2.7 die Richtung: eine
 * Änderung, die nur entfernt, ist dort kein Fund (guards/tamper.mjs,
 * `baselineOnlyShrinks`). Dieser Hook macht das bewusst NICHT mit, obwohl die
 * Information vorläge — `tool_input` trägt bei Edit `old_string`/`new_string`
 * und bei Write den ganzen `content`.
 *
 * Der Grund: Für das Schrumpfen gibt es ein Werkzeug, `quality prune`. Es
 * fragt den Analysator, WELCHE Einträge tot sind, und kann konstruktionsbedingt
 * nur entfernen. Ein Hand-Edit kann beides nicht zusichern: „entfernt nur"
 * heisst nicht „entfernt die richtigen". Ein richtungsabhängiger Hook wäre ein
 * zweiter, ungeprüfter Weg an derselben Datei — mehr Fläche, kein Gewinn.
 * Das Kommando deckt beide Alltagsfälle ab, das Entfernen und das Senken des
 * Zählers; ein Rest, den nur ein Hand-Edit löst, bleibt nicht übrig.
 *
 * Statt der Lockerung nennt die Ablehnung deshalb den vorgesehenen Weg.
 *
 * DIE AUSNAHME: quality.yml
 *
 * Bei quality.yml kennt der Hook die Richtung (`tightenOnly`). Für diese Datei
 * gibt es kein Werkzeug wie `quality prune`, und beim Schärfen ist jede Wahl
 * sicher: schlimmstenfalls wird das Gate rot, und das sieht man. Der Hook
 * rechnet den Inhalt nach dem Edit aus und fragt `configLoosenings`, dieselbe
 * Funktion wie der Tamper-Check. Anlass: Task «looker-linkedin-connector» vom
 * 14./15.11.2026, in dem René `required` freigab und den Edit doch selbst
 * ausführen musste.
 */
import { readFileSync } from 'node:fs'
import { PROTECTED_PATHS, configLoosenings } from '../guards/tamper.mjs'
import { findProjectRoot, readHookInput, relativeToRoot } from './lib/hook-io.mjs'

const input = await readHookInput()
const filePath = input?.tool_input?.file_path
if (!filePath) process.exit(0)

const root = findProjectRoot(input.cwd ?? process.cwd())
if (!root) process.exit(0)

const relativePath = relativeToRoot(filePath, root)
if (!relativePath) process.exit(0)

// `reportOnly` meldet nur der Tamper-Check: tsconfig und die Konfiguration der
// Test-Runner ändert ein Agent regelmässig legitim.
const hit = PROTECTED_PATHS.find(
  ({ pattern, reportOnly }) => !reportOnly && pattern.test(relativePath),
)
if (!hit) process.exit(0)

/**
 * Der Inhalt der Datei nach dem Aufruf, oder null, wenn er sich nicht sicher
 * ausrechnen lässt. Dann sperrt der Hook wie bei jeder anderen Datei.
 *
 * Edit gleicht old_string auch bei CRLF-Zeilenenden ab. Darum rechnet der Hook
 * mit LF. Für YAML ändert das nichts an der Bedeutung. Andere Normalisierungen
 * von Edit, etwa bei Anführungszeichen, bildet er nicht nach: dann sperrt er.
 *
 * @param {string | null} current der Inhalt vor dem Aufruf
 * @returns {string | null}
 */
function contentAfter(current) {
  const toolInput = input.tool_input
  if (input.tool_name === 'Write') {
    return typeof toolInput.content === 'string' ? toolInput.content : null
  }
  if (input.tool_name !== 'Edit' || current === null) return null
  const { old_string: rawFrom, new_string: rawTo, replace_all: all } = toolInput
  if (typeof rawFrom !== 'string' || typeof rawTo !== 'string' || rawFrom === '') return null
  const lf = (/** @type {string} */ text) => text.replaceAll('\r\n', '\n')
  const text = lf(current)
  const from = lf(rawFrom)
  const to = lf(rawTo)
  const count = text.split(from).length - 1
  // Wie Edit selbst: ohne replace_all muss old_string eindeutig sein.
  if (count === 0 || (count > 1 && all !== true)) return null
  return all === true ? text.split(from).join(to) : text.replace(from, () => to)
}

/** @type {string[]} */
let loosenings = []
if (hit.tightenOnly) {
  // Einmal lesen: vorher und nachher stammen so aus demselben Stand.
  let before = null
  try {
    before = readFileSync(filePath, 'utf8')
  } catch {
    before = null
  }
  const after = contentAfter(before)
  if (after !== null) {
    loosenings = configLoosenings(before === null ? null : before.replaceAll('\r\n', '\n'), after)
    if (loosenings.length === 0) process.exit(0)
  }
}

// Bei einer Baseline gibt es einen vorgesehenen Weg. Ihn hier zu nennen ist
// der Unterschied zwischen einer Sperre und einer Sackgasse: der Agent soll
// nicht den Menschen rufen, wo ein Kommando die Arbeit erledigt.
const tightenWay =
  `Schärfen darfst du: required ergänzen, phpstan_level erhöhen, level auf strict, ` +
  `baseline auf false, tamper.ignore kürzen, eine Komponente hinzufügen.\n` +
  (loosenings.length > 0
    ? `Diese Änderung schärft nicht nur:\n${loosenings.map((line) => `  - ${line}`).join('\n')}\n\n`
    : `Den Inhalt nach dieser Änderung konnte ich nicht sicher ausrechnen.\n\n`) +
  `Lockern entscheidet der Mensch. Beschreibe ihm, was du ändern möchtest und warum. ` +
  `Nutze keinen Umweg über die Shell.`

const wayOut = hit.tightenOnly
  ? tightenWay
  : hit.shrinkOnly
    ? `Willst du Einträge ENTFERNEN, für die es keinen Fehler mehr gibt, nimm das Werkzeug:\n` +
      `    quality prune            (mit --dry-run erst zeigen, was wegfällt)\n` +
      `Es entfernt genau die Einträge, die der Analysator als unerfüllt meldet, und ` +
      `senkt zu hohe Zähler. Wachsen kann es nicht. Dieser Lauf über die Shell ist ` +
      `kein Umweg um den Hook, sondern der vorgesehene Weg.\n\n` +
      `Für alles andere an dieser Datei — einen Eintrag HINZUFÜGEN, sie umformatieren — ` +
      `beschreibe dem Menschen, was du ändern möchtest und warum.`
    : `Wenn die Änderung wirklich nötig ist, beschreibe dem Menschen, was du ändern möchtest ` +
      `und warum — die Entscheidung darüber liegt bei ihm. Nutze keinen Umweg über die Shell.`

const status = hit.tightenOnly
  ? 'der Agent darf sie nur schärfen.'
  : 'wird nicht vom Agenten geändert.'
const reason = `${relativePath} ist geschützt (${hit.label}) und ${status}\n\n${wayOut}`

// permissionDecision ist der Weg, der die Begründung sauber an den Agenten
// weitergibt; Exit 2 täte es auch, wäre aber gröber.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
)
process.exit(0)
