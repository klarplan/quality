/**
 * Ordnet geänderte Dateien den Komponenten und den einzelnen Werkzeugen zu.
 *
 * Der Unterschied zwischen beidem ist nicht kosmetisch: Prettier formatiert
 * JSON, CSS und Markdown, ein Linter kennt nur Skriptdateien. Gibt man oxlint
 * eine package.json, meldet es "No files found to lint" und beendet mit 1 —
 * jede Änderung an einer Konfigurationsdatei hätte damit das Gate blockiert.
 */
import { relative } from 'node:path'
import { normalizeDir } from './config.mjs'

/** @import { Kind, Verb } from './types.mjs' */

const SCRIPTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Google Apps Script. prettier liest .gs über einen Override mit Parser babel,
 * eslint über `files: ['**\/*.gs']`. tsc liest keine .gs. Die Tests laden .gs
 * über fs, und vitest --related findet sie über den Import-Graphen nicht.
 * Deshalb gehört .gs nur zu all und lint. oxlint liest .gs nicht. Den Fall
 * regelt der lint-Schritt im Stack.
 */
export const APPS_SCRIPT = '.gs'

/** @type {Record<Kind, Partial<Record<Verb | 'all', string[]>>>} */
export const EXTENSIONS = {
  php: { all: ['.php'] },
  js: {
    all: [...SCRIPTS, APPS_SCRIPT, '.css', '.scss', '.json', '.md', '.yml', '.yaml'],
    lint: [...SCRIPTS, APPS_SCRIPT],
    types: SCRIPTS,
    test: SCRIPTS,
  },
  // .pyi gehoert dazu: ruff formatiert und prueft Stub-Dateien, mypy liest
  // sie als Typquelle. Ohne sie bliebe eine geaenderte Signatur ungeprueft.
  py: { all: ['.py', '.pyi'] },
}

/**
 * Präfix, mit dem der Runner die Dateien einer Komponente findet.
 *
 * Zwei Schreibweisen eines path sind gleich, wenn ihr Präfix gleich ist. Der
 * Tamper-Check vergleicht Komponenten darum über dieses Präfix. git nennt die
 * Dateien ohne `./`. Das Präfix fällt `./` am Anfang und `/` am Ende darum
 * weg. `app`, `app/` und `./app` ergeben `app/`. `.` und `./` ergeben `''`.
 *
 * @param {string} path
 * @returns {string}
 */
export function componentBase(path) {
  const dir = normalizeDir(path)
  return dir === '' ? '' : `${dir}/`
}

/**
 * Dateien dieser Komponente, relativ zu ihrem Verzeichnis.
 *
 * @param {{ path: string, kind: Kind }} component
 * @param {string[]} files
 * @param {string} root
 * @returns {string[]}
 */
export function filesForComponent(component, files, root) {
  const base = componentBase(component.path)
  const allowed = EXTENSIONS[component.kind]?.all ?? []
  return files
    .map((f) => (f.startsWith(root) ? relative(root, f) : f))
    .filter((f) => (base === '' ? true : f.startsWith(base)))
    .filter((f) => allowed.some((ext) => f.endsWith(ext)))
    .map((f) => (base === '' ? f : f.slice(base.length)))
}

/**
 * Schränkt die Dateiliste auf das ein, was dieses Werkzeug verarbeiten kann.
 *
 * @overload
 * @param {Kind} kind
 * @param {Verb} verb
 * @param {string[]} files
 * @returns {string[]}
 */
/**
 * @overload
 * @param {Kind} kind
 * @param {Verb} verb
 * @param {string[] | null} files
 * @returns {string[] | null}
 */
/**
 * @param {Kind} kind
 * @param {Verb} verb
 * @param {string[] | null} files
 * @returns {string[] | null}
 */
export function filesForVerb(kind, verb, files) {
  if (!files) return null
  const allowed = EXTENSIONS[kind]?.[verb]
  return allowed ? files.filter((f) => allowed.some((ext) => f.endsWith(ext))) : files
}
