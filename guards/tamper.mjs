/**
 * Tamper-Check: erkennt im Diff die Handgriffe, mit denen sich ein Gate
 * umgehen lässt, statt es zu erfüllen.
 *
 * Das ist der Teil des Frameworks, der speziell für agentische Entwicklung
 * existiert. Lokale Hooks kann ein Agent umgehen; dieser Check läuft in CI
 * über den fertigen Diff und ist damit die Wahrheit über Mergefähigkeit.
 *
 * Grundsatz: Keine Regel verbietet etwas endgültig. Jeder Treffer lässt sich
 * mit dem Commit-Trailer "Quality-Exception: <grund>" durchwinken — den setzt
 * ein Mensch. Der legitime Fall bleibt möglich, aber sichtbar und bewusst.
 */

import { isDeepStrictEqual } from 'node:util'
import { LEVELS, validateConfig } from '../lib/config.mjs'
import { parseToml } from '../lib/toml.mjs'
import { parseYaml } from '../lib/yaml.mjs'

/**
 * Eine hinzugefügte Zeile im Diff, mit ihrer Nummer im Zielzustand.
 *
 * @typedef {object} AddedLine
 * @property {number} line
 * @property {string} text
 */

/**
 * Eine entfernte Zeile im Diff. Sie hat keine Nummer: die alte zeigte auf
 * einen Zustand, den es nicht mehr gibt.
 *
 * @typedef {object} RemovedLine
 * @property {string} text
 */

/**
 * Eine Datei aus dem Diff, wie parseDiff sie liefert.
 * `removed` fehlt bei Dateien, die nur als hinzugefügt gelten (untracked).
 * `ownVersionOnly` setzt tamper-git.mjs bei einem Lockfile, dessen beide
 * Fassungen nur einen Versionssprung des eigenen Pakets abbilden: bei
 * package-lock.json die Version, bei composer.lock den content-hash.
 *
 * @typedef {object} DiffFile
 * @property {string} path
 * @property {AddedLine[]} added
 * @property {RemovedLine[] | undefined} [removed]
 * @property {boolean} deleted
 * @property {boolean | undefined} [ownVersionOnly]
 * @property {string | undefined} [renamedFrom] alter Pfad bei einer Umbenennung
 * @property {string[] | undefined} [gateFields] geänderte Gate-Felder eines
 *   Manifests, gesetzt von tamper-git.mjs über `manifestGateChanges`
 * @property {boolean | undefined} [configOnlyTightens] quality.yml wird nur
 *   geschärft, gesetzt von tamper-git.mjs über `configLoosenings`
 */

/**
 * Ein Treffer des Tamper-Checks.
 *
 * @typedef {object} Finding
 * @property {string} rule
 * @property {string} path
 * @property {number | undefined} [line]
 * @property {string} label
 * @property {string} detail
 */

/**
 * Regeln, die lokal nur berichtet und erst in CI bindend werden.
 *
 * Beides beschreibt Arbeit, die typischerweise vom Menschen kommt: die
 * Gate-Konfiguration anlegen oder ein Paket hinzufügen. Lokal gibt es noch
 * keinen Commit und damit keinen Trailer, mit dem man das durchwinken könnte —
 * ein Projekt käme sonst gar nicht erst durch sein eigenes Onboarding.
 */
export const SOFT_LOCALLY = new Set([
  'protected.changed',
  'dependency.changed',
  'ignore.extended',
  'allowlist.extended',
])

/**
 * Ignore-Dateien von Formatierer und Linter. Eine hinzugefügte Zeile darin nimmt
 * Code aus der Prüfung — dieselbe Wirkung wie eine Suppression, nur eine Ebene
 * höher und ohne Fundstelle im Code selbst.
 *
 * Bewusst NICHT in PROTECTED_PATHS: diese Liste ist gleichzeitig die Blockliste
 * des PreToolUse-Hooks. Eine Positivliste wie die von rankscan/application
 * (`/*` plus `!/resources`) wird legitim erweitert, um Dateien AUFzunehmen; ein
 * Hook, der das blockt, hält die Arbeit auf, ohne etwas zu schützen.
 */
const IGNORE_FILE = /(^|\/)\.(prettier|eslint)ignore$/

/**
 * Konfiguration des Secret-Scanners: .gitleaks.toml und gitleaks.toml.
 * Eine Allowlist darin nimmt Code aus der Prüfung — dieselbe Wirkung wie eine
 * Zeile in .prettierignore, nur bei dem Werkzeug, das Geheimnisse sucht.
 *
 * Aus demselben Grund wie IGNORE_FILE nicht in PROTECTED_PATHS: die Datei wird
 * legitim erweitert — eine eigene [[rules]]-Sektion, ein minVersion-Bump, ein
 * Pfad für einen Upstream-Drop. Ein Hook, der das blockt, hält die Arbeit auf,
 * ohne etwas zu schützen; die Umgehung meldet ohnehin `allowlist.extended`.
 * Die Baseline hinter --baseline-path steht dort sehr wohl: sie ist ein
 * Verzeichnis akzeptierter Funde, wie phpstan-baseline.neon.
 */
const GITLEAKS_FILE = /(^|\/)\.?gitleaks\.toml$/

/** Abschnittskopf: [allowlist], [[allowlists]], [[rules]], [rules.allowlist]. */
const TOML_SECTION = /^\[\[?\s*([^\]\s]+)\s*\]\]?/

/** Schlüssel, die es nur in einer Allowlist gibt. Sie weiten die Ausnahme. */
const ALLOW_KEY = /^(regexes|paths|stopwords|commits|regexTarget)\b/

/** Eintrag einer mehrzeiligen Liste: '''…''' oder "…". */
const LIST_ENTRY = /^('''|"|')/

/** Dateien, in denen Test-Muster überhaupt geprüft werden. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\//i
// Die Modul-Endungen .mjs/.cjs gehören zwingend dazu: node --test nutzt sie,
// und ohne sie bliebe ein stillgelegter Test in einer .test.mjs unbemerkt.
export const TEST_NAME = /\.(test|spec)\.[mc]?[jt]sx?$|Test\.php$|_test\.py$|test_.*\.py$/i

export const isTestFile = (/** @type {string} */ path) =>
  TEST_FILE.test(path) || TEST_NAME.test(path)

/**
 * Läuft eine Testdatei nach der Umbenennung nicht mehr als Test?
 *
 * Trug der alte Name das Testmuster (`a.test.mjs`, `FooTest.php`), muss der neue
 * es auch tragen: `tests/FooTest.php.off` liegt weiter im Testordner, aber kein
 * Test-Runner findet die Datei. Galt die Datei nur über ihren Ordner als Test,
 * genügt es, dass sie in einem Testordner bleibt.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function renamedOutOfTests(from, to) {
  if (!isTestFile(from)) return false
  if (TEST_NAME.test(from)) return !TEST_NAME.test(to)
  return !TEST_FILE.test(to)
}

/** Quellcode, in dem Suppressions gesucht werden — nicht in Sperr-/Buildartefakten. */
export const SOURCE_FILE = /\.(php|[cm]?[jt]sx?|vue|svelte|py)$/i

/**
 * Dateien, die das Gate selbst definieren. Dieselbe Liste dient dem
 * PreToolUse-Hook als Blockliste — es soll nicht zwei Wahrheiten darüber
 * geben, was geschützt ist.
 *
 * `reportOnly` nimmt einen Eintrag aus der Blockliste des Hooks. Der
 * Tamper-Check meldet die Änderung weiterhin. Das gilt für tsconfig und die
 * Konfiguration der Test-Runner: ein Agent ändert sie regelmässig legitim,
 * etwa für einen neuen Pfad-Alias oder eine Setup-Datei. Ein Hook, der das
 * sperrt, hält die Arbeit auf. Gesperrt bleiben reine Linter-, Typchecker-
 * und Formatter-Konfigurationen.
 *
 * `harmless` beschreibt Zeilen, die das Gate nicht verschieben. Besteht die
 * Änderung nur aus solchen Zeilen, ist sie kein Fund.
 *
 * `tightenOnly` markiert quality.yml: eine Änderung, die das Gate nur schärft,
 * ist kein Fund, im Tamper-Check wie im Hook. Siehe `configLoosenings`.
 *
 * @type {{ pattern: RegExp, label: string, shrinkOnly?: boolean, tightenOnly?: boolean, botMayChange?: boolean, reportOnly?: boolean, harmless?: RegExp }[]}
 */
export const PROTECTED_PATHS = [
  // Der CI-Workflow steht zuerst: eine Datei wie .github/workflows/quality.yml
  // ist ein Workflow und keine Quality-Konfiguration, auch wenn sie so heisst.
  // `botMayChange`: Dependabot hebt hier Action-Versionen an. Siehe `analyseDiff`.
  { pattern: /^\.github\/workflows\//, label: 'CI-Workflow', botMayChange: true },
  // `shrinkOnly` markiert die Baselines: nur bei ihnen hat eine Änderung eine
  // erwünschte Richtung. Siehe `baselineOnlyShrinks`.
  { pattern: /(^|\/)phpstan-baseline\.neon$/, label: 'PHPStan-Baseline', shrinkOnly: true },
  { pattern: /(^|\/)\.?gitleaks[-.]baseline\.json$/, label: 'gitleaks-Baseline', shrinkOnly: true },
  { pattern: /(^|\/)eslint-suppressions\.json$/, label: 'ESLint-Suppressions', shrinkOnly: true },
  { pattern: /^quality\.ya?ml$/, label: 'Quality-Konfiguration', tightenOnly: true },
  // phpstan.dist.neon liest der Stack genauso wie phpstan.neon(.dist).
  { pattern: /(^|\/)phpstan(\.dist)?\.neon(\.dist)?$/, label: 'PHPStan-Konfiguration' },
  { pattern: /(^|\/)pint\.json$/, label: 'Pint-Konfiguration' },
  { pattern: /(^|\/)\.prettierrc/, label: 'Prettier-Konfiguration' },
  // [cm]? deckt .mjs/.cjs/.mts/.cts mit ab. Ohne das war die Linter- und
  // Formatiererkonfiguration in genau den Projekten ungeschützt, die sie am
  // ehesten so benennen: wer kein "type": "module" im package.json hat, MUSS
  // .mjs verwenden, sonst lädt die Konfiguration gar nicht. Gefunden am
  // 16.08.2026 in rankscan/website, wo beide Dateien .mjs heissen.
  { pattern: /(^|\/)prettier\.config\.[cm]?[jt]s$/, label: 'Prettier-Konfiguration' },
  { pattern: /(^|\/)eslint\.config\.[cm]?[jt]s$/, label: 'ESLint-Konfiguration' },
  // Die alte eslint-Konfiguration: .eslintrc ohne Endung und mit jeder Endung.
  { pattern: /(^|\/)\.eslintrc(\.(c?js|mjs|json|ya?ml))?$/, label: 'ESLint-Konfiguration' },
  { pattern: /(^|\/)\.oxlintrc\.jsonc?$/, label: 'oxlint-Konfiguration' },
  { pattern: /(^|\/)\.?ruff\.toml$/, label: 'ruff-Konfiguration' },
  { pattern: /(^|\/)\.?mypy\.ini$/, label: 'mypy-Konfiguration' },
  {
    pattern: /(^|\/)tsconfig(\.[\w-]+)?\.json$/,
    label: 'TypeScript-Konfiguration',
    reportOnly: true,
  },
  {
    pattern: /(^|\/)vitest\.config\.[cm]?[jt]s$/,
    label: 'vitest-Konfiguration',
    reportOnly: true,
  },
  {
    pattern: /(^|\/)phpunit(\.dist)?\.xml(\.dist)?$/,
    label: 'PHPUnit-Konfiguration',
    reportOnly: true,
    // Umgebungswerte für den Testlauf: <env>, <server>, <ini>, <const> und
    // Kommentare. Sie wählen keinen Test ab. In rankscan kam so eine Zeile in
    // drei von rund 180 Merges dazu (Probelauf vom 14.11.2026).
    harmless: /^\s*(<(env|server|ini|const)\s[^<>]*\/>|<!--.*-->)\s*$/,
  },
  { pattern: /(^|\/)pytest\.ini$/, label: 'pytest-Konfiguration', reportOnly: true },
  // pytest, mypy und flake8 lesen auch diese Dateien. Sie tragen daneben
  // Paket- und tox-Einstellungen, die sich legitim ändern: darum nur gemeldet.
  { pattern: /(^|\/)setup\.cfg$/, label: 'Python-Konfiguration (setup.cfg)', reportOnly: true },
  { pattern: /(^|\/)tox\.ini$/, label: 'Python-Konfiguration (tox.ini)', reportOnly: true },
  { pattern: /(^|\/)\.flake8$/, label: 'flake8-Konfiguration', reportOnly: true },
  { pattern: /(^|\/)\.claude\/settings\.json$/, label: 'Claude-Hook-Konfiguration' },
  // Das Board-Gate (`gate = "bash scripts/gate.sh"` in ~/.cc/projects.toml)
  // läuft vor dem Push. Ein Branch darf das Skript nicht abschwächen, das ihn
  // gleich danach prüft. Nur die Repo-Wurzel: dort ruft das Board es auf.
  { pattern: /^scripts\/gate\.sh$/, label: 'Gate-Skript' },
]

const LOCKFILES = /(^|\/)(composer\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/

/**
 * Das einzige Lockfile, das die Version des eigenen Pakets trägt.
 *
 * Gemessen am 12.10.2026: composer.lock, pnpm-lock.yaml und yarn.lock führen
 * sie nicht.
 */
export const NPM_LOCKFILE = /(^|\/)package-lock\.json$/

/**
 * composer.lock ändert bei einem Versionssprung nur den content-hash. Der
 * ändert sich aber auch bei einer neuen Anforderung. Belegen lässt sich der
 * Sprung deshalb nur zusammen mit composer.json, siehe composerLockOnlyRehashes.
 */
export const COMPOSER_LOCKFILE = /(^|\/)composer\.lock$/

/**
 * Felder in composer.json, die bestimmen, welche Pakete installiert werden.
 * `config.platform` gehört dazu und wird separat verglichen.
 */
const COMPOSER_DEPENDENCY_KEYS = [
  'require',
  'require-dev',
  'conflict',
  'replace',
  'provide',
  'minimum-stability',
  'prefer-stable',
  'repositories',
]

/**
 * Unterscheiden sich zwei Fassungen eines package-lock.json nur in der
 * Version des eigenen Pakets?
 *
 * Verglichen wird das geparste JSON, nicht die Diff-Zeilen. Die Version steht
 * an zwei Stellen: oben und unter `packages[""]`. Das Format v1 kennt nur die
 * obere. Beide fallen vor dem Vergleich weg, alles andere muss gleich sein.
 *
 * Im Zweifel `false`: fehlt eine Fassung oder ist sie kein JSON-Objekt, gilt
 * die Änderung als echte Abhängigkeitsänderung.
 *
 * @param {string | null} before
 * @param {string | null} after
 * @returns {boolean}
 */
export function lockfileOnlyBumpsOwnVersion(before, after) {
  if (before === null || after === null) return false

  const withoutOwnVersion = (/** @type {string} */ text) => {
    const lock = JSON.parse(text)
    if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return null
    delete lock.version
    const root = lock.packages?.['']
    if (root && typeof root === 'object') delete root.version
    return lock
  }

  try {
    const a = withoutOwnVersion(before)
    const b = withoutOwnVersion(after)
    if (a === null || b === null) return false
    return isDeepStrictEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Ändert sich composer.lock nur im content-hash, ohne dass sich eine
 * Abhängigkeit ändert?
 *
 * Das trifft auf `composer update --lock` nach einem Versionssprung in
 * composer.json zu. Zwei Bedingungen müssen gelten:
 * - composer.lock ist bis auf `content-hash` gleich. Kein Paket ändert sich.
 * - composer.json ist in allen Abhängigkeitsfeldern gleich. Sonst steckt die
 *   Änderung in einer neuen Anforderung, die das Lockfile noch nicht abbildet.
 *
 * Im Zweifel `false`: fehlt eine Fassung oder ist sie kein JSON-Objekt, gilt
 * die Änderung als echte Abhängigkeitsänderung.
 *
 * @param {{ lockBefore: string | null, lockAfter: string | null, manifestBefore: string | null, manifestAfter: string | null }} versions
 * @returns {boolean}
 */
export function composerLockOnlyRehashes({ lockBefore, lockAfter, manifestBefore, manifestAfter }) {
  const parse = (/** @type {string | null} */ text) => {
    if (text === null) return null
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  }

  try {
    const [lockA, lockB, jsonA, jsonB] = [lockBefore, lockAfter, manifestBefore, manifestAfter].map(
      parse,
    )
    if (lockA === null || lockB === null || jsonA === null || jsonB === null) return false

    delete lockA['content-hash']
    delete lockB['content-hash']
    if (!isDeepStrictEqual(lockA, lockB)) return false

    for (const key of COMPOSER_DEPENDENCY_KEYS) {
      if (!isDeepStrictEqual(jsonA[key], jsonB[key])) return false
    }
    return isDeepStrictEqual(jsonA.config?.platform, jsonB.config?.platform)
  } catch {
    return false
  }
}

/**
 * Manifeste, die neben Abhängigkeiten auch das Gate steuern. Als ganze Datei
 * lassen sie sich nicht schützen: jede neue Abhängigkeit wäre ein Fund.
 * Geprüft werden deshalb nur die Felder, die das Gate liest.
 */
export const GATE_MANIFEST = /(^|\/)(package\.json|composer\.json|pyproject\.toml)$/

/** Felder in package.json, die Formatierer, Linter und Test-Runner als Konfiguration lesen. */
const PACKAGE_CONFIG_KEYS = [
  'prettier',
  'eslintConfig',
  'eslintIgnore',
  'jest',
  'mocha',
  'c8',
  'nyc',
]

/** Abschnitte in pyproject.toml, die ruff, mypy und pytest lesen. */
const PYPROJECT_GATE_SECTION = /^tool\.(ruff|mypy|pytest)(\.|$)/

/** Werkzeuge unter [tool], deren Konfiguration das Gate verschieben kann. */
const PYPROJECT_GATE_TOOLS = ['ruff', 'mypy', 'pytest']

/**
 * Rückfall, wenn der TOML-Leser eine Fassung nicht versteht: die Abschnitte
 * einer TOML-Datei als Text je Abschnittsname.
 *
 * Kein TOML-Parser: verglichen wird nur, ob sich der Text eines Abschnitts
 * ändert. Gepunktete Schlüssel wie `ruff.lint.ignore` unter [tool] sieht der
 * Vergleich nicht. Leerzeilen und Kommentarzeilen zählen nicht. Mehrere Abschnitte mit
 * demselben Namen ([[tool.mypy.overrides]]) hängen aneinander.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function tomlSections(text) {
  /** @type {Map<string, string>} */
  const sections = new Map()
  let name = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    // Strenger als TOML_SECTION: der Name beginnt mit einem Schlüsselzeichen, und
    // nach der Klammer folgt nichts. Spätere Teile dürfen in Anführungszeichen
    // stehen, etwa [tool.poetry.group."dev".dependencies]. Eine Listenzeile wie `["tests"],` ist
    // sonst ein Abschnittskopf, und der Rest des Abschnitts fiele aus dem Vergleich.
    const header = line.match(/^\[\[?\s*([\w-][\w.\-"' ]*?)\s*\]\]?\s*(#.*)?$/)
    if (header) {
      // Die Gruppe ist im Muster Pflicht: passt es, ist sie gesetzt.
      name = /** @type {string} */ (header[1])
      sections.set(name, `${sections.get(name) ?? ''}${line}\n`)
      continue
    }
    sections.set(name, `${sections.get(name) ?? ''}${line}\n`)
  }
  return sections
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isTomlTable(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Ist der Wert eine Tabelle oder eine Liste von Tabellen ([[…]])?
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isTomlTableLike(v) {
  return isTomlTable(v) || (Array.isArray(v) && v.length > 0 && v.every(isTomlTable))
}

/**
 * Die Tabellen, in denen sich zwei gelesene TOML-Teilbäume unterscheiden.
 *
 * Sind beide Werte Tabellen, geht der Vergleich hinein. Sonst zählt die
 * tiefste Tabelle: bei einem einfachen Wert die umgebende Tabelle, bei einer
 * Tabelle oder Tabellenliste ihr eigener Pfad. So heissen die Funde wie die
 * Abschnittsköpfe, etwa `tool.ruff.lint` oder `tool.mypy.overrides`.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} path
 * @param {string} parent
 * @param {Set<string>} out
 */
function tomlTreeChanges(a, b, path, parent, out) {
  if (isDeepStrictEqual(a, b)) return
  if (isTomlTable(a) && isTomlTable(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      tomlTreeChanges(a[key], b[key], `${path}.${key}`, path, out)
    }
    return
  }
  out.add(isTomlTableLike(a) || isTomlTableLike(b) ? path : parent)
}

/**
 * Gate-Abschnitte einer pyproject.toml, die sich ändern. Versteht der
 * TOML-Leser eine Fassung nicht, greift der Textvergleich. Ein Fehler des
 * Lesers verschluckt so keinen Fund.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
function pyprojectGateChanges(before, after) {
  /** @type {Record<string, unknown>} */
  let a
  /** @type {Record<string, unknown>} */
  let b
  try {
    a = parseToml(before)
    b = parseToml(after)
  } catch {
    const ta = tomlSections(before)
    const tb = tomlSections(after)
    return [...new Set([...ta.keys(), ...tb.keys()])]
      .filter((name) => PYPROJECT_GATE_SECTION.test(name))
      .filter((name) => ta.get(name) !== tb.get(name))
      .sort()
  }
  const toolA = isTomlTable(a.tool) ? a.tool : {}
  const toolB = isTomlTable(b.tool) ? b.tool : {}
  /** @type {Set<string>} */
  const out = new Set()
  for (const name of PYPROJECT_GATE_TOOLS) {
    tomlTreeChanges(toolA[name], toolB[name], `tool.${name}`, 'tool', out)
  }
  // Steht `tool.mypy = 1` in beiden Fassungen als einfacher Wert, heisst der
  // Fund `tool`. Das Werkzeug liest den Wert ohnehin nicht als Konfiguration.
  return [...out].sort()
}

/**
 * Welche Gate-Felder eines Manifests unterscheiden sich zwischen zwei Fassungen?
 *
 * - package.json und composer.json: ein bestehendes Skript, das sich ändert
 *   oder verschwindet. Das Gate ruft `lint`, `test` und `build` auf, und diese
 *   rufen oft weitere Skripte. Ein NEUES Skript ist kein Fund: es schwächt
 *   keinen bestehenden Aufruf. Die Ausnahme ist bei package.json ein neues
 *   `pre<name>` zu einem vorhandenen Skript. Bei package.json dazu die
 *   Konfiguration von prettier, eslint und den Test-Runnern im Manifest.
 * - pyproject.toml: die Teilbäume tool.ruff, tool.mypy und tool.pytest, in
 *   jeder TOML-Schreibweise. Siehe `pyprojectGateChanges`.
 *
 * Abhängigkeiten und die Version zählen nicht. Dafür gibt es die Lockfile-Regel.
 *
 * Im Zweifel leer: fehlt die alte Fassung, ist die Datei neu. Ist eine Fassung
 * nicht lesbar, scheitert schon das Werkzeug, das sie liest.
 *
 * @param {string} path
 * @param {string | null} before
 * @param {string | null} after
 * @returns {string[]}
 */
export function manifestGateChanges(path, before, after) {
  if (before === null || after === null) return []

  if (path.endsWith('.toml')) return pyprojectGateChanges(before, after)

  /** @type {Record<string, any>} */
  let a
  /** @type {Record<string, any>} */
  let b
  try {
    a = JSON.parse(before)
    b = JSON.parse(after)
  } catch {
    return []
  }
  /**
   * @param {unknown} v
   * @returns {v is Record<string, unknown>}
   */
  const isObject = (v) => v !== null && typeof v === 'object'
  if (!isObject(a) || !isObject(b)) return []

  /** @type {string[]} */
  const changed = []
  /** @type {Record<string, unknown>} */
  const scriptsA = isObject(a.scripts) ? a.scripts : {}
  /** @type {Record<string, unknown>} */
  const scriptsB = isObject(b.scripts) ? b.scripts : {}
  for (const name of Object.keys(scriptsA)) {
    if (!isDeepStrictEqual(scriptsA[name], scriptsB[name])) changed.push(`scripts.${name}`)
  }
  if (path.endsWith('package.json')) {
    // npm führt `pre<name>` vor `<name>` aus. Ein neues pretest läuft also im
    // Gate mit, ohne dass sich das test-Skript ändert.
    for (const name of Object.keys(scriptsB)) {
      const target = name.startsWith('pre') ? name.slice(3) : ''
      if (!(name in scriptsA) && target && target in scriptsB) changed.push(`scripts.${name}`)
    }
    for (const key of PACKAGE_CONFIG_KEYS) {
      if (!isDeepStrictEqual(a[key], b[key])) changed.push(key)
    }
  }
  return changed
}

/**
 * Fremdcode. Wird nie bewertet — auch dann nicht, wenn ein Projekt seine
 * Abhängigkeiten mitcommittet, wie es bei gewachsenen CMS-Projekten
 * regelmässig vorkommt. Ein `@ts-ignore` in einem fremden Paket ist keine
 * Umgehung durch den Entwickler, sondern die Arbeit von jemand anderem.
 */
export const VENDOR_PATH = /(^|\/)(vendor|node_modules|bower_components|\.venv|venv|third_party)\//

/**
 * Wege, einen Test stillzulegen. Je Zeile eine Alternative, damit jede für
 * sich lesbar bleibt. Keine gemeinsame Wortgrenze davor: vor `->`, `@` und `#`
 * liegt keine, und zwei Alternativen griffen deshalb bis zum 14.11.2026 nie.
 */
const SKIPPED_TEST = new RegExp(
  [
    // Pest: })->skip(), ->skip('Grund'), ->todo(). Eine Zahl oder Variable als
    // Argument ist der Query-Builder: ->skip(10)->take(5).
    String.raw`->(skip|todo)\((?![\d$])`,
    // PHPUnit
    String.raw`\bmarkTestSkipped\b`,
    String.raw`@doesNotPerformAssertions\b`,
    String.raw`#\[DoesNotPerformAssertions\]`,
    String.raw`@group\s+skip\b`,
    // vitest, jest, playwright: it.skip, it.skipIf, it.concurrent.skip, test.fixme
    String.raw`\b(it|test|describe|context)(\.\w+)*\.(skip|skipIf|todo|fails|fixme)\b`,
    String.raw`\bx(it|test|describe)\s*\(`,
    // node:test: test('x', { skip: true }, …). Die Optionen stehen direkt nach
    // dem Titel, und der Titel endet am ersten passenden Anführungszeichen. Ein
    // nacktes `skip:` zählt nicht: so heisst auch ein gewöhnliches Feld.
    // `skip: false` und `skip: 0` legen nichts still.
    String.raw`\b(it|test|describe|suite)\s*\(\s*(?<quote>['"\`])(?:(?!\k<quote>).)*\k<quote>\s*,\s*\{[^}]*\b(skip|todo)\s*:(?!\s*(false|0)\b)`,
    String.raw`\bt\.(skip|todo)\s*\(`,
    // pytest und unittest
    String.raw`@(pytest\.mark\.(skip|skipif|xfail)|unittest\.skip(If|Unless)?)\b`,
    String.raw`\bpytest\.(skip|importorskip)\s*\(`,
    String.raw`\bself\.skipTest\s*\(`,
  ].join('|'),
)

/**
 * Muster in hinzugefügten Zeilen.
 * `scope: 'test'` beschränkt die Prüfung auf Testdateien — "skip" oder "only"
 * in Produktivcode ist gewöhnlicher Code und kein Umgehungsversuch.
 */
export const LINE_RULES = [
  {
    id: 'suppression.phpstan',
    // eslint-disable-next-line -- Muster, nicht Anwendung
    pattern: /@phpstan-ignore(-next-line|-line)?\b/,
    label: 'PHPStan-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.psalm',
    pattern: /@psalm-suppress\b/,
    label: 'Psalm-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.typescript',
    pattern: /@ts-(ignore|expect-error|nocheck)\b/,
    label: 'TypeScript-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.eslint',
    pattern: /\beslint-disable(-next-line|-line)?\b/,
    label: 'ESLint-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.oxlint',
    pattern: /\boxlint-disable(-next-line|-line)?\b/,
    label: 'oxlint-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.phpcs',
    pattern: /\bphpcs:(ignore|disable)\b/,
    label: 'PHPCS-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.python',
    // `# type: ignore` (mypy), `# noqa` (ruff/flake8) und die Datei-weiten
    // Varianten. Beide sind der Normalfall, mit dem in Python ein Befund
    // stillgelegt wird — das Gegenstueck zu @ts-ignore und eslint-disable.
    pattern:
      /#\s*(type:\s*ignore|noqa|mypy:\s*(ignore-errors|disable)|ruff:\s*noqa|pyright:\s*ignore)\b/,
    label: 'Python-Suppression',
    scope: 'source',
  },
  {
    id: 'test.skipped',
    pattern: SKIPPED_TEST,
    label: 'übersprungener Test',
    scope: 'test',
  },
  {
    id: 'test.focused',
    // .only lässt die restliche Suite still verstummen — im Merge fast immer ein Versehen.
    pattern: /\b(it|test|describe|context)\.only\b|\bfit\(|\bfdescribe\(/,
    label: 'auf einen Fall verengter Testlauf (.only)',
    scope: 'test',
  },
  {
    id: 'test.incomplete',
    pattern: /\bmarkTestIncomplete\(/,
    label: 'als unvollständig markierter Test',
    scope: 'test',
  },
]

/**
 * Muster in ENTFERNTEN Zeilen.
 *
 * Anders bewertet als hinzugefügte: eine einzelne entfernte Zeile sagt nichts —
 * Testcode wird ständig umformuliert. Gezählt wird deshalb netto je Datei, und
 * gemeldet nur, wenn mehr passende Zeilen verschwinden als dazukommen.
 */
export const REMOVED_LINE_RULES = [
  {
    id: 'test.assertions-removed',
    // $this->assertSame( · self::assertTrue( · assert.equal( · expect(x)
    // Dazu Pythons nacktes Statement `assert x == 1`: es hat weder Klammer
    // noch Punkt und fiel deshalb durch jedes der Muster darueber.
    pattern:
      /\bassert\w*\s*[.(]|->\s*assert\w*\s*\(|::\s*assert\w*\s*\(|\bexpect\s*\(|^\s*assert\s+\S/,
    label: 'netto entfernte Assertions',
    scope: 'test',
  },
]

/**
 * Zerlegt einen unified diff in {path, added: [{line, text}], removed, deleted, renamed}.
 * Bewusst genügsam: es zählt, welche Zeilen hinzugekommen sind und welche
 * Dateien verschwunden sind.
 *
 * @param {string} diffText
 * @returns {DiffFile[]}
 */
export function parseDiff(diffText) {
  /** @type {{ path: string | null, added: AddedLine[], removed: RemovedLine[], deleted: boolean, renamedFrom?: string }[]} */
  const files = []
  /** @type {(typeof files)[number] | null} */
  let current = null
  let newLineNo = 0

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // "diff --git a/pfad b/pfad" — der b-Pfad ist der Zielzustand.
      const match = raw.match(/ b\/(.*)$/)
      // Die Gruppe `(.*)` passt immer mit, auch leer. Sie ist also gesetzt.
      current = {
        path: match ? /** @type {string} */ (match[1]) : null,
        added: [],
        removed: [],
        deleted: false,
      }
      files.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith('deleted file mode')) {
      current.deleted = true
      continue
    }
    // git meldet eine Umbenennung nicht als Löschung. Der alte Pfad steht nur
    // hier: die Zeile "diff --git" ist bei Pfaden mit Leerzeichen mehrdeutig.
    if (raw.startsWith('rename from ')) {
      current.renamedFrom = raw.slice('rename from '.length)
      continue
    }
    if (raw.startsWith('rename to ')) {
      current.path = raw.slice('rename to '.length)
      continue
    }
    if (raw.startsWith('+++ ')) {
      // Bei gelöschten Dateien steht hier /dev/null; den a-Pfad haben wir schon.
      const path = raw.slice(4).trim()
      if (path !== '/dev/null' && path.startsWith('b/')) current.path = path.slice(2)
      continue
    }
    if (raw.startsWith('--- ')) {
      const path = raw.slice(4).trim()
      if (current.deleted && path.startsWith('a/')) current.path = path.slice(2)
      continue
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      // Die Gruppe ist im Muster nicht optional: passt es, ist sie gesetzt.
      newLineNo = match ? Number.parseInt(/** @type {string} */ (match[1]), 10) : 0
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.added.push({ line: newLineNo, text: raw.slice(1) })
      newLineNo++
      continue
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      // Verschiebt die neue Nummerierung nicht, deshalb keine Zeilennummer: die
      // alte zeigte auf einen Zustand, den es nicht mehr gibt.
      current.removed.push({ text: raw.slice(1) })
      continue
    }
    if (raw.startsWith(' ') || raw === '') newLineNo++
  }

  // Der Filter entfernt Einträge ohne Pfad. Übrig bleiben nur DiffFile-Formen.
  return /** @type {DiffFile[]} */ (files.filter((f) => f.path))
}

/**
 * Weitet diese Zeile einer gitleaks-Konfiguration die Ausnahme?
 *
 * `section` ist der Abschnitt, in dem die Zeile steht: 'allow' für eine
 * Allowlist, 'other' für [[rules]] und [extend], null wenn er unbekannt ist.
 * `arrayKey` ist der Schlüssel einer offenen mehrzeiligen Liste.
 *
 * @param {string} entry
 * @param {'allow' | 'other' | null} section
 * @param {string | null} arrayKey
 * @returns {boolean}
 */
function widensGitleaks(entry, section, arrayKey) {
  // Der Standard-Regelsatz abgeschaltet: die grösstmögliche Ausnahme, und sie
  // steht in [extend], nicht in der Allowlist.
  if (/^useDefault\s*=\s*false\b/.test(entry)) return true
  // Eine Beschreibung begründet eine Ausnahme, sie weitet sie nicht.
  if (/^description\s*=/.test(entry)) return false
  // Zwei Schlüssel GRENZEN eine Ausnahme ein: targetRules bindet sie an eine
  // benannte Regel, condition = "AND" verlangt alle Kriterien zugleich.
  if (/^targetRules\s*=/.test(entry)) return false
  if (/^condition\s*=\s*["']AND["']/i.test(entry)) return false
  // "OR" weitet dagegen: dann genügt jedes Kriterium für sich. Der Schlüssel
  // kommt nur in einer Allowlist vor, deshalb zählt er ohne Abschnitt.
  if (/^condition\s*=\s*["']OR["']/i.test(entry)) return true
  // Eine hinzugefügte [[rules]]-Sektion VERSCHÄRFT die Prüfung. Sie darf keinen
  // Treffer erzeugen, sonst meldet die Regel das Gegenteil von dem, was passiert.
  if (section === 'other') return false
  if (section === 'allow') return true

  // Abschnitt unbekannt — dann entscheidet der Schlüssel.
  if (ALLOW_KEY.test(entry)) return true
  if (LIST_ENTRY.test(entry)) return arrayKey === null || ALLOW_KEY.test(arrayKey)
  return false
}

/**
 * Sucht in einer gitleaks-Konfiguration die hinzugefügten Zeilen, die eine
 * Ausnahme weiten.
 *
 * Anders als eine .prettierignore ist die Datei strukturiert: dieselbe Zeile
 * bedeutet in [allowlist] das Gegenteil von dem, was sie in [[rules]] bedeutet.
 * Der Abschnitt wird deshalb über die hinzugefügten Zeilen mitgeführt.
 *
 * Die Grenze offen benannt: der Diff kommt mit --unified=0, es gibt keine
 * Kontextzeilen. Wird ein Eintrag mitten in eine bestehende `keywords`-Liste
 * eingefügt, fehlt jeder Hinweis auf den Abschnitt — die Zeile meldet dann,
 * obwohl sie verschärft. Der Fall ist selten; die umgekehrte Voreinstellung
 * wäre der teurere Fehler, weil sie eine weggedrückte Fundstelle verschweigt.
 *
 * @param {DiffFile} file
 * @returns {Finding[]}
 */
function scanGitleaksConfig(file) {
  /** @type {Finding[]} */
  const findings = []
  /** @type {'allow' | 'other' | null} */
  let section = null
  /** @type {string | null} */
  let arrayKey = null

  for (const { line, text } of file.added) {
    const entry = text.trim()
    if (entry === '' || entry.startsWith('#')) continue

    const header = entry.match(TOML_SECTION)
    if (header) {
      // Der letzte Namensteil zählt: [rules.allowlist] ist eine Allowlist.
      // Die Gruppe ist im Muster Pflicht, und split liefert nie ein leeres Array.
      const name = /** @type {string} */ (/** @type {string} */ (header[1]).split('.').pop())
      section = /^allowlists?$/i.test(name) ? 'allow' : 'other'
      arrayKey = null
      continue
    }

    // Klammern einer mehrzeiligen Liste tragen selbst keinen Wert.
    const opens = entry.match(/^([A-Za-z_][\w-]*)\s*=\s*\[$/)
    if (opens) {
      // Die Gruppe ist im Muster Pflicht: passt es, ist sie gesetzt.
      arrayKey = /** @type {string} */ (opens[1])
      continue
    }
    if (/^[\]}],?$/.test(entry)) {
      arrayKey = null
      continue
    }

    if (!widensGitleaks(entry, section, arrayKey)) continue

    findings.push({
      rule: 'allowlist.extended',
      path: file.path,
      line,
      label: 'erweiterte Secret-Ausnahme',
      detail: entry.slice(0, 120),
    })
  }

  return findings
}

/**
 * Zeile eines Zählers — im Neon-Format `count: 3`, im JSON-Format `"count": 3,`.
 */
const COUNT_LINE = /^[ \t]*"?count"?[ \t]*:[ \t]*(\d+),?[ \t]*$/

/**
 * Inhaltliche Form einer Diff-Zeile für den Mengenvergleich.
 *
 * Das Komma am Zeilenende fällt weg: entfernt man das letzte Element eines
 * JSON-Arrays, verliert das vorherige sein Komma. Diese Zeile ist inhaltlich
 * dieselbe und darf nicht als neue zählen.
 */
const shape = (/** @type {string} */ text) => text.replace(/,[ \t]*$/, '')

/**
 * Entfernt diese Baseline-Änderung nur, oder nimmt sie etwas auf?
 *
 * Der Grund für die Unterscheidung: Eine Baseline-Zeile HINZUFÜGEN schwächt
 * das Gate, eine LÖSCHEN stärkt es. Über der Baseline-Einbindung steht in den
 * Projekten die Regel «sie schrumpft, sie wächst nicht» — genau diese
 * erwünschte Richtung kostete bis v0.2.7 einen menschlichen Eingriff, weil
 * beides gleich behandelt wurde.
 *
 * Zwei Bedingungen, beide nötig:
 *
 *   1. Jede hinzugefügte Zeile steht wörtlich auch unter den entfernten, und
 *      nicht häufiger. Damit kann kein Eintrag dazukommen: ein Baseline-Eintrag
 *      trägt immer seine eigene `message:`-Zeile, und die wäre neuer Text.
 *   2. Die Summe der hinzugefügten Zähler übersteigt die der entfernten nicht.
 *
 * Zähler sind von Bedingung 1 ausgenommen, weil ein gesenkter Zähler
 * zwangsläufig eine Zeile mit neuem Text ist. Bedingung 2 tritt an ihre Stelle.
 *
 * Leerzeilen zählen nicht mit: sie tragen keinen Inhalt, und bei `--unified=0`
 * wandern sie mit jedem entfernten Block.
 *
 * Die Grenze offen benannt: der Vergleich ist wörtlich. Wird eine Baseline
 * umformatiert — Tabs zu Leerzeichen, andere Anführungszeichen — gilt jede
 * Zeile als neu, und die Regel meldet. Das ist Absicht: eine Umformatierung ist
 * kein Schrumpfen, und `quality prune` erzeugt sie nicht.
 *
 * @param {DiffFile} file
 * @returns {boolean}
 */
export function baselineOnlyShrinks(file) {
  const content = (/** @type {RemovedLine[] | undefined} */ lines) =>
    (lines ?? []).map((entry) => entry.text).filter((text) => text.trim() !== '')
  const added = content(file.added)
  const removed = content(file.removed)

  const sumCounts = (/** @type {string[]} */ lines) =>
    lines.reduce((total, text) => {
      const hit = COUNT_LINE.exec(text)
      // Die Gruppe ist im Muster nicht optional: passt es, ist sie gesetzt.
      return hit ? total + Number.parseInt(/** @type {string} */ (hit[1]), 10) : total
    }, 0)
  if (sumCounts(added) > sumCounts(removed)) return false

  // Mehrmengen-Vergleich, nicht Mengen-Vergleich: eine Zeile, die doppelt so
  // oft hinzukommt wie sie verschwindet, vervielfacht einen Eintrag.
  const pool = new Map()
  for (const text of removed) {
    if (COUNT_LINE.test(text)) continue
    const key = shape(text)
    pool.set(key, (pool.get(key) ?? 0) + 1)
  }
  for (const text of added) {
    if (COUNT_LINE.test(text)) continue
    const key = shape(text)
    const left = pool.get(key) ?? 0
    if (left === 0) return false
    pool.set(key, left - 1)
  }

  return true
}

/** Schlüssel, die validateConfig liest. Alle anderen vergleicht der Check roh. */
const CONFIG_KEYS = ['version', 'level', 'baseline', 'components', 'configs', 'tamper']
const TAMPER_KEYS = ['ignore']
const COMPONENT_KEYS = ['path', 'stack', 'php', 'phpstan_level', 'required', 'test_command']

/**
 * Die Werte unter Schlüsseln, die das Werkzeug nicht kennt.
 *
 * @param {unknown} value
 * @param {string[]} known
 * @returns {Record<string, unknown>}
 */
function unknownKeys(value, known) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)))
}

/**
 * Vergleicht die unbekannten Schlüssel zweier Maps. Jede Abweichung ist eine
 * Lockerung: eine spätere quality-Version könnte den Schlüssel lesen.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @param {string[]} known
 * @param {string} where
 * @returns {string[]}
 */
function unknownKeyChanges(before, after, known, where) {
  const a = unknownKeys(before, known)
  const b = unknownKeys(after, known)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !isDeepStrictEqual(a[key], b[key]))
    .map((key) => `${where}${key}: unbekannter Schlüssel geändert`)
}

/**
 * Was eine Änderung an quality.yml lockert. Eine leere Liste heisst: die
 * Änderung schärft das Gate nur oder ändert es gar nicht.
 *
 * Bei Baselines kennt der Hook keine Richtung, weil `quality prune` dort den
 * richtigen Weg bietet. Für quality.yml gibt es kein solches Werkzeug. Beim
 * Schärfen ist jede Wahl sicher: schlimmstenfalls wird das Gate rot, und das
 * ist sichtbar. Darum gilt Schärfen hier nicht als Fund.
 *
 * Beide Fassungen laufen durch validateConfig. So zählt der effektive Wert,
 * etwa das Standard-phpstan_level je Level. Kann eine Fassung nicht gelesen
 * werden, gilt das als Lockerung. Die Regeln stehen in
 * docs/superpowers/specs/2026-11-15-quality-yml-schaerfen-design.md.
 *
 * @param {string | null} before
 * @param {string | null} after
 * @returns {string[]}
 */
export function configLoosenings(before, after) {
  // Ohne alten Stand gibt es keine Richtung. Eine neu angelegte Datei
  // entscheidet der Mensch, wie bisher.
  if (before === null) return ['quality.yml: neu angelegt, kein alter Stand zum Vergleich']
  if (after === null) return ['quality.yml: entfernt']

  /** @param {string} text @param {string} side */
  const read = (text, side) => {
    try {
      const raw = parseYaml(text)
      return { raw, config: validateConfig(raw, 'quality.yml') }
    } catch (error) {
      return { error: `quality.yml ${side} nicht lesbar: ${/** @type {Error} */ (error).message}` }
    }
  }
  const a = read(before, 'vorher')
  const b = read(after, 'nachher')
  if (a.error || b.error) return [a.error, b.error].filter((text) => text !== undefined)
  const old = /** @type {import('../lib/types.mjs').ValidConfig} */ (a.config)
  const now = /** @type {import('../lib/types.mjs').ValidConfig} */ (b.config)
  /** @type {any} */
  const rawOld = a.raw
  /** @type {any} */
  const rawNow = b.raw

  /** @type {string[]} */
  const found = []
  // `version` braucht keinen eigenen Vergleich: validateConfig kennt nur 1
  // und wirft sonst, und das zählt oben als «nicht lesbar».
  if (LEVELS.indexOf(now.level) < LEVELS.indexOf(old.level)) {
    found.push(`level: ${old.level} → ${now.level}`)
  }
  if (!old.baseline && now.baseline) found.push('baseline: false → true')
  for (const key of Object.keys(now.configs)) {
    if (!(key in old.configs)) found.push(`configs.${key}: neu`)
  }
  for (const path of now.tamperIgnore) {
    if (!old.tamperIgnore.includes(path)) found.push(`tamper.ignore: neuer Pfad ${path}`)
  }

  found.push(...unknownKeyChanges(rawOld, rawNow, CONFIG_KEYS, ''))
  // Ist `tamper` keine Map, sieht unknownKeyChanges nichts. Dann zählt jede
  // Abweichung, fail closed.
  const isMap = (/** @type {unknown} */ value) =>
    value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
  if (!(isMap(rawOld.tamper) && isMap(rawNow.tamper))) {
    if (!isDeepStrictEqual(rawOld.tamper, rawNow.tamper)) found.push('tamper: keine Map, geändert')
  } else {
    found.push(...unknownKeyChanges(rawOld.tamper, rawNow.tamper, TAMPER_KEYS, 'tamper.'))
  }

  const { pairs, ambiguous, skipped } = pairComponents(old.components, now.components)
  found.push(...ambiguous)
  for (const [index, component] of old.components.entries()) {
    if (skipped.old.has(index)) continue
    const label = componentLabel(component, old.components)
    const nowIndex = pairs.get(index) ?? -1
    const next = now.components[nowIndex]
    if (!next) {
      found.push(`${label}: Komponente entfernt`)
      continue
    }
    for (const field of /** @type {const} */ (['stack', 'php', 'testCommand'])) {
      if (component[field] !== next[field]) {
        const name = field === 'testCommand' ? 'test_command' : field
        found.push(`${label}.${name}: ${component[field]} → ${next[field]}`)
      }
    }
    const dropped = component.required.filter((verb) => !next.required.includes(verb))
    if (dropped.length > 0) found.push(`${label}.required: ${dropped.join(', ')} entfernt`)
    if (next.phpstanLevel < component.phpstanLevel) {
      found.push(`${label}.phpstan_level: ${component.phpstanLevel} → ${next.phpstanLevel}`)
    }
    found.push(
      ...unknownKeyChanges(
        rawOld.components[index],
        rawNow.components[nowIndex],
        COMPONENT_KEYS,
        `${label}.`,
      ),
    )
  }

  // Eine neue Komponente prüft mehr. Sie darf aber keinen eigenen Testbefehl
  // und keine unbekannten Schlüssel mitbringen: beides wäre bei einer
  // bestehenden Komponente eine Lockerung (Review vom 15.11.2026).
  const taken = new Set(pairs.values())
  for (const [index, component] of now.components.entries()) {
    if (taken.has(index) || skipped.now.has(index)) continue
    const label = componentLabel(component, now.components)
    if (component.testCommand !== null) {
      found.push(`${label}.test_command: neue Komponente mit eigenem Testbefehl`)
    }
    found.push(...unknownKeyChanges({}, rawNow.components[index], COMPONENT_KEYS, `${label}.`))
  }
  return found
}

/**
 * Name einer Komponente in einer Meldung. Teilt sie ihren path mit einer
 * anderen Komponente, nennt der Name auch den stack.
 *
 * @param {{ path: string, stack: string }} component
 * @param {{ path: string, stack: string }[]} all
 * @returns {string}
 */
function componentLabel(component, all) {
  const shared = all.filter(({ path }) => path === component.path).length > 1
  return shared
    ? `components[${component.path}, ${component.stack}]`
    : `components[${component.path}]`
}

/**
 * Ordnet jeder alten Komponente ihr Gegenstück in der neuen Fassung zu.
 *
 * Der Schlüssel ist (path, stack). Ein path allein reicht nicht: calcup hat
 * zwei Komponenten mit path "." (Befund 15.11.2026). Bleibt auf einem path
 * danach genau eine alte und genau eine neue Komponente ohne Gegenstück,
 * bilden diese beiden ein Paar. So meldet der Vergleich einen Stack-Wechsel
 * als Stack-Wechsel.
 *
 * Kommt (path, stack) in einer Fassung mehrfach vor, bekommt keine Komponente
 * mit diesem Schlüssel ein Gegenstück, vorher wie nachher. Eine mehrdeutige
 * Zuordnung ist ein Fund, fail closed. `skipped` nennt die Indizes dieser Komponenten, damit der Vergleich
 * für sie keine weiteren Funde erfindet.
 *
 * @param {{ path: string, stack: string }[]} old
 * @param {{ path: string, stack: string }[]} now
 * @returns {{ pairs: Map<number, number>, ambiguous: string[], skipped: { old: Set<number>, now: Set<number> } }}
 */
function pairComponents(old, now) {
  /**
   * @param {{ path: string, stack: string }[]} list
   * @param {(component: { path: string, stack: string }) => string} keyOf
   * @returns {Map<string, number[]>}
   */
  const group = (list, keyOf) => {
    /** @type {Map<string, number[]>} */
    const groups = new Map()
    for (const [index, component] of list.entries()) {
      const key = keyOf(component)
      groups.set(key, [...(groups.get(key) ?? []), index])
    }
    return groups
  }
  /** @param {{ path: string, stack: string }} component */
  const byKey = (component) => JSON.stringify([component.path, component.stack])
  const oldGroups = group(old, byKey)
  const nowGroups = group(now, byKey)

  /** @type {string[]} */
  const ambiguous = []
  const skipped = { old: new Set(), now: new Set() }
  for (const [side, list, groups] of /** @type {const} */ ([
    ['vorher', old, oldGroups],
    ['nachher', now, nowGroups],
  ])) {
    for (const [key, indices] of groups) {
      const first = list[indices[0] ?? -1]
      if (indices.length < 2 || !first) continue
      // Der Schlüssel fällt auf beiden Seiten aus der Zuordnung.
      for (const index of oldGroups.get(key) ?? []) skipped.old.add(index)
      for (const index of nowGroups.get(key) ?? []) skipped.now.add(index)
      ambiguous.push(
        `${componentLabel(first, list)}: ${indices.length}-mal ${side}, Zuordnung mehrdeutig`,
      )
    }
  }

  /** @type {Map<number, number>} */
  const pairs = new Map()
  for (const [key, [index, ...more]] of oldGroups) {
    const [match, ...others] = nowGroups.get(key) ?? []
    if (index === undefined || match === undefined) continue
    if (more.length === 0 && others.length === 0) pairs.set(index, match)
  }

  // Was übrig bleibt und nicht mehrdeutig ist, paart der path allein.
  const taken = new Set(pairs.values())
  /** @param {{ path: string, stack: string }} component */
  const byPath = (component) => component.path
  const oldLeft = group(old, byPath)
  const nowLeft = group(now, byPath)
  for (const [path, indices] of oldLeft) {
    const [index, ...more] = indices.filter((i) => !pairs.has(i) && !skipped.old.has(i))
    const [match, ...others] = (nowLeft.get(path) ?? []).filter(
      (i) => !taken.has(i) && !skipped.now.has(i),
    )
    if (index === undefined || match === undefined) continue
    if (more.length === 0 && others.length === 0) pairs.set(index, match)
  }
  return { pairs, ambiguous, skipped }
}

/**
 * Besteht die Änderung nur aus Zeilen, die auf `harmless` passen?
 * Leerzeilen zählen nicht. Eine Änderung ohne Zeilen ist nicht harmlos: dann
 * hat sich etwas anderes geändert, etwa der Dateimodus.
 *
 * @param {DiffFile} file
 * @param {RegExp} harmless
 * @returns {boolean}
 */
function onlyHarmlessLines(file, harmless) {
  const lines = [...file.added, ...(file.removed ?? [])]
    .map((entry) => entry.text)
    .filter((text) => text.trim() !== '')
  return lines.length > 0 && lines.every((text) => harmless.test(text))
}

/**
 * Bewertet einen geparsten Diff.
 *
 * `botAuthor` unterdrückt zwei Regeln: die Lockfile-Regel — ein Renovate-Lauf
 * ändert Lockfiles per Definition und würde sonst jedes Mal rot — und seit
 * v0.1.8 `protected.changed`, aber nur für die CI-Workflows (`botMayChange`).
 * Baselines und Gate-Konfiguration meldet die Regel auch bei einem Bot. Ein Bot
 * hebt Versionen an; eine wachsende Baseline ist kein Versionsbump.
 *
 * Die Workflows, weil Dependabot Action-Versionen in `.github/workflows/**`
 * anhebt, und das ist ein geschützter Pfad. Ohne die Ausnahme ist JEDER
 * Actions-PR rot, auch ein reiner Patch-Bump: Dauerröte auf einem Gate, das
 * genau davon lebt, dass Rot etwas bedeutet.
 *
 * Die Abwägung dahinter: wer einem Bot die Lockdatei glaubt, muss ihm die
 * Versionsreferenz erst recht glauben. Eine Lockdatei kann beliebigen Code
 * nachziehen — sie ist die grössere Angriffsfläche, nicht die kleinere. Die
 * Ausnahme hier nicht zu machen, während sie dort gilt, wäre inkonsequent.
 *
 * Getragen wird das von `isBotAuthor` (guards/tamper-git.mjs): dort müssen
 * ALLE Autoren des Diffs Bots sein. Ein einziger menschlicher Commit im
 * selben PR schaltet beide Regeln wieder scharf — es lässt sich also nichts
 * in einem Bot-PR mitschmuggeln. Ein Merge-Commit ohne eigene Änderung zählt
 * dabei nicht als Autor; einer mit eigener Änderung schon.
 *
 * @param {DiffFile[]} files
 * @param {{ botAuthor?: boolean, ignorePaths?: string[] }} [options]
 * @returns {Finding[]}
 */
export function analyseDiff(files, { botAuthor = false, ignorePaths = [] } = {}) {
  /** @type {Finding[]} */
  const findings = []
  // quality.yml führt die Liste `tamper.ignore` selbst. Trüge sie sich dort
  // ein, verschwände jede Lockerung aus der Prüfung (Review vom 15.11.2026).
  const selfIgnoring = (/** @type {string} */ path) =>
    PROTECTED_PATHS.some(({ pattern, tightenOnly }) => tightenOnly && pattern.test(path))
  const skipped = (/** @type {string} */ path) =>
    (!selfIgnoring(path) && ignorePaths.some((p) => path.startsWith(p))) || VENDOR_PATH.test(path)

  for (const file of files) {
    // Eine Umbenennung hat zwei Pfade. Der alte entscheidet, ob die Datei zu
    // prüfen war. Wandert sie in Fremdcode oder einen ignorierten Pfad, wäre sie
    // sonst mit dem `continue` unten aus der Prüfung verschwunden.
    const from = file.renamedFrom
    if (from && !skipped(from)) {
      if (renamedOutOfTests(from, file.path) || (isTestFile(from) && skipped(file.path))) {
        findings.push({
          rule: 'test.deleted',
          path: from,
          label: 'aus dem Testlauf umbenannte Testdatei',
          detail: `Heisst jetzt ${file.path} und läuft nicht mehr als Test.`,
        })
      }
      // Eine Gate-Konfiguration unter anderem Namen liest kein Werkzeug mehr.
      const was = PROTECTED_PATHS.find(({ pattern }) => pattern.test(from))
      if (was && !was.pattern.test(file.path) && !(botAuthor && was.botMayChange)) {
        findings.push({
          rule: 'protected.changed',
          label: `${was.label} umbenannt`,
          path: from,
          detail: `Heisst jetzt ${file.path}. Das Werkzeug liest die Datei nicht mehr.`,
        })
      }
    }

    if (skipped(file.path)) continue

    if (file.deleted) {
      if (isTestFile(file.path)) {
        findings.push({
          rule: 'test.deleted',
          path: file.path,
          label: 'gelöschte Testdatei',
          detail: 'Die Datei wurde entfernt.',
        })
      }
      continue
    }

    // Ein Skript ändern ist Agentenverhalten und blockiert auch lokal. Die
    // Werkzeug-Konfiguration im Manifest legt beim Onboarding ein Mensch an und
    // bleibt lokal ein Hinweis, wie jede andere Gate-Konfiguration.
    const scripts = (file.gateFields ?? []).filter((field) => field.startsWith('scripts.'))
    const config = (file.gateFields ?? []).filter((field) => !field.startsWith('scripts.'))
    if (scripts.length > 0) {
      findings.push({
        rule: 'gate.script-changed',
        label: `Skript geändert (${scripts.join(', ')})`,
        path: file.path,
        detail: 'Das Gate ruft lint, test und build auf, und diese rufen oft weitere Skripte.',
      })
    }
    if (config.length > 0) {
      findings.push({
        rule: 'protected.changed',
        label: `Werkzeug-Konfiguration geändert (${config.join(', ')})`,
        path: file.path,
        detail: 'Linter, Typprüfung oder Test-Runner lesen diese Felder.',
      })
    }

    for (const {
      pattern,
      label,
      shrinkOnly,
      tightenOnly,
      botMayChange,
      harmless,
    } of PROTECTED_PATHS) {
      if (pattern.test(file.path)) {
        if (botAuthor && botMayChange) break
        if (harmless && onlyHarmlessLines(file, harmless)) break
        // Nur Baselines haben eine erwünschte Richtung. Schrumpft die Datei,
        // ist das kein Verschieben des Gates, sondern das Gegenteil.
        if (shrinkOnly && baselineOnlyShrinks(file)) break
        // quality.yml hat ebenfalls eine Richtung: schärfen verschiebt das
        // Gate nicht, sondern zieht es an.
        if (tightenOnly && file.configOnlyTightens) break
        findings.push({
          rule: 'protected.changed',
          // Nachgestellt, damit die Meldung unabhängig vom Genus stimmt:
          // "CI-Workflow geändert", "PHPStan-Baseline geändert".
          label: `${label} geändert`,
          path: file.path,
          detail: 'Änderungen hieran verschieben das Gate selbst.',
        })
        break
      }
    }

    // Ein reiner Versionssprung ändert keine Abhängigkeit. Belegen lässt sich
    // das nur bei package-lock.json und composer.lock, siehe NPM_LOCKFILE und
    // COMPOSER_LOCKFILE.
    const ownVersionOnly =
      file.ownVersionOnly === true &&
      (NPM_LOCKFILE.test(file.path) || COMPOSER_LOCKFILE.test(file.path))
    if (LOCKFILES.test(file.path) && !botAuthor && !ownVersionOnly) {
      findings.push({
        rule: 'dependency.changed',
        path: file.path,
        label: 'geänderte Abhängigkeiten',
        detail: 'Neue oder aktualisierte Pakete gehören begründet.',
      })
    }

    if (IGNORE_FILE.test(file.path)) {
      for (const { line, text } of file.added) {
        const entry = text.trim()
        // Leerzeilen und Kommentare tragen nichts aus. Ein `!`-Eintrag nimmt
        // Code wieder AUF und ist das Gegenteil einer Umgehung.
        if (entry === '' || entry.startsWith('#') || entry.startsWith('!')) continue

        findings.push({
          rule: 'ignore.extended',
          path: file.path,
          line,
          label: 'erweiterte Prüf-Ausnahme',
          detail: entry.slice(0, 120),
        })
      }
    }

    if (GITLEAKS_FILE.test(file.path)) findings.push(...scanGitleaksConfig(file))

    const inTest = isTestFile(file.path)
    const inSource = SOURCE_FILE.test(file.path)
    for (const { line, text } of file.added) {
      for (const rule of LINE_RULES) {
        const applies = rule.scope === 'test' ? inTest : inSource
        if (!applies) continue
        if (rule.pattern.test(text)) {
          findings.push({
            rule: rule.id,
            path: file.path,
            line,
            label: rule.label,
            detail: text.trim().slice(0, 120),
          })
        }
      }
    }

    for (const rule of REMOVED_LINE_RULES) {
      if (rule.scope === 'test' ? !inTest : !inSource) continue

      const count = (/** @type {RemovedLine[]} */ lines) =>
        lines.filter((entry) => rule.pattern.test(entry.text)).length
      const gone = count(file.removed ?? [])
      const back = count(file.added)

      if (gone > back) {
        findings.push({
          rule: rule.id,
          path: file.path,
          label: rule.label,
          detail: `${gone} entfernt, ${back} hinzugefügt`,
        })
      }
    }
  }

  return findings
}

/**
 * Der Trailer, mit oder ohne Regel in Klammern:
 *   Quality-Exception: <Grund>
 *   Quality-Exception(dependency.changed, test.skipped): <Grund>
 */
const TRAILER_LINE = /^quality-exception\s*(?:\(([^)]*)\))?\s*:\s*(.*)$/i

/**
 * Eine Ausnahme aus einem Commit. `rules` ist null, wenn der Trailer keine
 * Regel nennt. Er gilt dann für jede Regel.
 *
 * @typedef {{ rules: string[] | null, reason: string }} Exception
 */

/**
 * Liest alle Ausnahme-Trailer aus den Commit-Nachrichten des geprüften Bereichs.
 *
 * Ein Trailer mit Regel entschuldigt nur Funde dieser Regel. Der Anlass: jede
 * Lockfile-Änderung braucht einen Trailer, und der entschuldigte bisher auch
 * eine Suppression oder einen gelöschten Test im selben Bereich.
 *
 * Ein Trailer ohne Grund zählt nicht. Eine leere Klammer zählt auch nicht: sie
 * nennt keine Regel und ist kein Trailer ohne Regel.
 *
 * @param {string[]} commitMessages
 * @returns {Exception[]}
 */
export function findExceptions(commitMessages) {
  /** @type {Exception[]} */
  const exceptions = []
  for (const message of commitMessages) {
    for (const line of message.split('\n')) {
      const hit = TRAILER_LINE.exec(line.trim())
      if (!hit) continue
      const reason = (hit[2] ?? '').trim()
      if (!reason) continue
      if (hit[1] === undefined) {
        exceptions.push({ rules: null, reason })
        continue
      }
      const rules = hit[1]
        .split(',')
        .map((rule) => rule.trim())
        .filter(Boolean)
      if (rules.length > 0) exceptions.push({ rules, reason })
    }
  }
  return exceptions
}

/**
 * Der Grund, der einen Fund dieser Regel entschuldigt — sonst null.
 *
 * Eine genannte Regel passt genau (`test.skipped`) oder als Familie vor dem
 * Punkt (`suppression` für `suppression.typescript`).
 *
 * @param {string} rule
 * @param {Exception[]} exceptions
 * @returns {string | null}
 */
export function exceptionFor(rule, exceptions) {
  const hit = exceptions.find(
    ({ rules }) =>
      rules === null || rules.some((name) => rule === name || rule.startsWith(`${name}.`)),
  )
  return hit ? hit.reason : null
}

/**
 * Der Grund des ersten Ausnahme-Trailers im geprüften Bereich, mit oder ohne
 * Regel. Für Aufrufer, die nur wissen wollen, ob der Bereich eine Ausnahme
 * trägt — etwa scripts/gate.sh von resplan.
 *
 * @param {string[]} commitMessages
 * @returns {string | null}
 */
export function findException(commitMessages) {
  return findExceptions(commitMessages)[0]?.reason ?? null
}
