import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** @import { Kind } from './types.mjs' */

/** @typedef {'npm' | 'pnpm' | 'yarn'} PackageManager */

/**
 * Werkzeuge finden und richtig aufrufen.
 *
 * Der zweite Teil ist nicht selbstverständlich: npm und pnpm reichen
 * Argumente an ein Skript unterschiedlich weiter, und wer das rät, misst
 * still das Falsche. Die Regeln stehen deshalb in reinen Funktionen mit
 * Tests, nicht verstreut in den Stack-Adaptern.
 */

/**
 * Findet ein Werkzeug in der Reihenfolge Komponente → Repo-Wurzel → PATH.
 * Gibt null zurück, wenn nichts gefunden wurde; der Aufrufer entscheidet, ob
 * das ein Fehler ist oder der Schritt einfach entfällt.
 *
 * @param {string} name
 * @param {{ dir?: string | null | undefined, root?: string | null | undefined, kind: Kind }} where
 * @returns {string | null}
 */
export function findBinary(name, { dir, root, kind }) {
  const relative = LOCAL_BIN[kind]?.(name) ?? join('node_modules', '.bin', name)
  for (const base of [dir, root]) {
    if (!base) continue
    const candidate = join(base, relative)
    if (existsSync(candidate)) return candidate
  }
  // Nur Python: ruff und mypy werden regelmässig global installiert (pipx,
  // Homebrew), und ein Projekt-venv ist dort keine Pflicht. Bei PHP und JS
  // bleibt es beim Projektpfad — ein global installiertes Pint hätte eine
  // andere Version als die, gegen die das Projekt aufgelöst hat.
  if (kind === 'py' && hasOnPath(name)) return name
  return null
}

/**
 * Umgebung für jeden PHPStan-Lauf, dessen JSON quality selbst liest.
 *
 * laravel/pao erkennt Coding-Agenten an Variablen wie CLAUDECODE oder
 * AI_AGENT. Dann ersetzt es PHPStans JSON durch eine Kurzfassung, auch bei
 * `--error-format=json`. Dort ist `errors` eine Zahl, und die Fundstellen
 * sind nach 30 gekappt. PAO_DISABLE=1 schaltet das Paket ab. PHPStan selbst
 * lässt das JSON in Agent-Umgebungen unverändert (geprüft mit 2.3.4).
 *
 * Das Gate (`quality fast`/`task`) braucht das nicht: es wertet nur den
 * Exit-Code aus, und den lässt laravel/pao stehen.
 */
export const PHPSTAN_JSON_ENV = Object.freeze({ PAO_DISABLE: '1' })

/**
 * Wo ein Stack seine Werkzeuge lokal installiert.
 *
 * @type {Record<Kind, (name: string) => string>}
 */
const LOCAL_BIN = {
  php: (name) => join('vendor', 'bin', name),
  js: (name) => join('node_modules', '.bin', name),
  py: (name) => join('.venv', 'bin', name),
}

/**
 * Meldung, die sagt, was fehlt und wie man es behebt.
 *
 * @param {string} name
 * @param {Kind} kind
 * @returns {string}
 */
export function missingToolHint(name, kind) {
  const pkg = PACKAGE_FOR[name] ?? name
  const how =
    kind === 'php'
      ? `composer require --dev ${pkg}`
      : kind === 'py'
        ? `pip install ${pkg}`
        : `npm install -D ${pkg}`
  return `Werkzeug "${name}" nicht gefunden. Installieren mit:  ${how}`
}

/** @type {Record<string, string>} */
const PACKAGE_FOR = {
  pint: 'laravel/pint',
  phpstan: 'phpstan/phpstan larastan/larastan',
  prettier: 'prettier',
  oxlint: 'oxlint',
  tsc: 'typescript',
  vitest: 'vitest',
  ruff: 'ruff',
  mypy: 'mypy',
  pytest: 'pytest',
}

/* ── PHP in ddev ──────────────────────────────────────────────────────── */

/** Dort mountet ddev das Projekt im web-Container. */
const DDEV_APPROOT = '/var/www/html'

/**
 * Wie ein PHP-Werkzeug aus vendor/bin oder ein PHP-Befehl wie "php artisan
 * test" aufgerufen wird: im ddev-Container oder auf dem Host.
 *
 * vendor/bin/pint beginnt mit "#!/usr/bin/env php". Fehlt PHP auf dem Host,
 * endet der Aufruf mit "env: php: No such file or directory" und exit 127.
 * Projekte wie rankscan verbieten PHP auf dem Host; dort läuft PHP nur in
 * ddev, mit der Version aus .ddev/config.yaml.
 *
 * Die Reihenfolge:
 * 1. ddev-Projekt und ddev läuft: Aufruf im Container.
 * 2. Sonst PHP auf dem Host: Aufruf auf dem Host wie bisher. So läuft CI,
 *    wo .ddev/config.yaml im Repo liegt, ddev aber fehlt.
 * 3. Sonst: ein Schritt, der klar sagt, was fehlt.
 *
 * "ddev exec" startet ein gestopptes Projekt von selbst. Ein Hook nach jedem
 * Edit darf das nicht auslösen. Deshalb fragt der Adapter vorher den Status ab.
 *
 * @param {string} tool absoluter Pfad aus findBinary oder ein Befehlsname
 *   wie "php", den der Container selbst im PATH findet
 * @param {string[]} args
 * @param {string} dir Arbeitsverzeichnis der Komponente
 * @returns {{ cmd: string, args: string[] }}
 */
export function phpCommand(tool, args, dir) {
  const ddevRoot = findDdevRoot(dir)
  const ddev = ddevRoot ? ddevStatus(ddevRoot) : null
  if (ddevRoot && ddev?.running) return ddevExec(tool, args, dir, ddevRoot, ddev.mutagen)
  if (!ddevRoot || onHostPath('php')) return { cmd: tool, args }
  return failingCommand(
    `PHP fehlt auf dem Host, und ddev läuft nicht für diesen Checkout (${ddevRoot}).\n` +
      ddevStartHint(ddevRoot),
  )
}

/**
 * Wie ein JS-Werkzeug aus node_modules/.bin oder ein Befehl wie "npm run
 * build" aufgerufen wird: im ddev-Container oder auf dem Host.
 *
 * rankscan installiert node_modules im ddev-Container. Dort liegen nur die
 * Linux-Bindings nativer Pakete wie rolldown, Tailwind-Oxide und
 * lightningcss. Auf dem Mac endete Vitest darum mit "Cannot find native
 * binding". Solches node_modules läuft nur dort, wo es installiert wurde.
 *
 rankscan-website geht weiter: node_modules liegt dort nur in einem Volume
 * des Containers. Auf dem Host fehlt der Ordner ganz.
 *
 * Die Reihenfolge:
 * 1. node_modules passt zum Host: Aufruf auf dem Host wie bisher. ddev wird
 *    dafür nicht befragt.
 * 2. node_modules stammt von einer anderen Plattform oder fehlt auf dem Host,
 *    und ddev läuft: Aufruf im Container.
 * 3. node_modules fehlt auf dem Host, ddev läuft nicht: Aufruf auf dem Host.
 *    Ein Projekt ohne Abhängigkeiten braucht kein node_modules. Fehlen
 *    deklarierte Abhängigkeiten, meldet das der Stack-Adapter vorher.
 * 4. Sonst: ein Schritt, der klar sagt, was fehlt.
 *
 * @param {string} tool absoluter Pfad aus findBinary oder ein Befehlsname
 *   wie "npm", den der Container selbst im PATH findet
 * @param {string[]} args
 * @param {string} dir Arbeitsverzeichnis der Komponente
 * @param {string | null | undefined} root Repo-Wurzel
 * @returns {{ cmd: string, args: string[] }}
 */
export function jsCommand(tool, args, dir, root) {
  const platform = nodeModulesPlatform(dir, root)
  const absent = !platform && !hostInstalled(dir, root)
  if (!platform && !absent) return { cmd: tool, args }
  const ddevRoot = findDdevRoot(dir)
  const ddev = ddevRoot ? ddevStatus(ddevRoot) : null
  if (ddevRoot && ddev?.running) return ddevExec(tool, args, dir, ddevRoot, ddev.mutagen)
  if (!platform) return { cmd: tool, args }
  const fix = ddevRoot
    ? ddevStartHint(ddevRoot)
    : `Installiere node_modules auf diesem Rechner neu.\n`
  return failingCommand(
    `node_modules stammt von ${platform}, dieser Rechner ist ${process.platform}.\n` +
      `Native Pakete wie rolldown laufen hier nicht. ${fix}`,
  )
}

/**
 * Der Aufruf im web-Container von ddev.
 *
 * Nutzt ddev Mutagen, trägt der Schritt die Wurzel des ddev-Projekts in
 * `mutagen`. runStep synct dann vor und nach dem Aufruf, siehe
 * lib/mutagen.mjs.
 *
 * @param {string} tool absoluter Pfad oder Befehlsname
 * @param {string[]} args
 * @param {string} dir Arbeitsverzeichnis der Komponente
 * @param {string} ddevRoot
 * @param {boolean} mutagen
 * @returns {{ cmd: string, args: string[], mutagen?: string }}
 */
function ddevExec(tool, args, dir, ddevRoot, mutagen) {
  const command = isAbsolute(tool) ? relative(dir, tool).split(sep).join(posix.sep) : tool
  // dir liegt immer unter ddevRoot: findDdevRoot sucht von dir aus aufwärts.
  const inside = containerPath(ddevRoot, dir) ?? DDEV_APPROOT
  // --raw: ohne bash im Container, sonst zerfallen Dateinamen mit Leerzeichen.
  const call = ['exec', '--raw', '--dir', inside, '--', command, ...args]
  return mutagen ? { cmd: 'ddev', args: call, mutagen: ddevRoot } : { cmd: 'ddev', args: call }
}

/**
 * Der Pfad eines Host-Ordners im web-Container — oder null, wenn der Ordner
 * nicht unter dem Projekt liegt.
 *
 * @param {string} ddevRoot
 * @param {string} hostDir
 * @returns {string | null}
 */
function containerPath(ddevRoot, hostDir) {
  const inside = relative(ddevRoot, hostDir)
  if (inside.startsWith('..') || isAbsolute(inside)) return null
  return inside ? posix.join(DDEV_APPROOT, ...inside.split(sep)) : DDEV_APPROOT
}

/**
 * Sind die Abhängigkeiten auf dem Host installiert?
 *
 * Installiert heisst: mindestens eine deklarierte Abhängigkeit liegt in
 * node_modules der Komponente oder der Repo-Wurzel. Ein Ordner node_modules
 * allein genügt nicht. In der Wurzel liegen sonst oft nur deren eigene
 * Werkzeuge, etwa husky, und das Skript der Komponente endet mit exit 127.
 * Yarn Plug'n'Play legt nie node_modules an; dort zählt .pnp.cjs. Ein
 * package.json ohne Abhängigkeiten braucht kein node_modules.
 *
 * @param {string} dir
 * @param {string | null | undefined} root
 * @returns {boolean}
 */
export function hostInstalled(dir, root) {
  const deps = declaredDependencies(dir)
  if (deps.length === 0) return true
  return [dir, root].some(
    (base) =>
      base &&
      (existsSync(join(base, '.pnp.cjs')) ||
        deps.some((dep) => existsSync(join(base, 'node_modules', dep)))),
  )
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function declaredDependencies(dir) {
  const manifest = readJson(join(dir, 'package.json'))
  return Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })
}

/**
 * node_modules im ddev-Container, für Projekte, die es nur dort installieren.
 *
 * @typedef {object} ContainerModules
 * @property {boolean} installed mindestens eine deklarierte Abhängigkeit liegt dort
 * @property {(name: string) => string | null} bin der Host-Pfad, unter dem
 *   ddevExec das Binary im Container aufruft, oder null, wenn es fehlt
 * @property {(name: string) => string | null} version die Version des Pakets
 *   im Container, oder null, wenn sie sich nicht lesen lässt
 */

/** @type {Map<string, ContainerModules | null>} */
const containerCache = new Map()

/**
 * Fragt den laufenden Container, was in node_modules liegt — oder null, wenn
 * kein eigenes ddev-Projekt läuft.
 *
 * Ein einziger "ls"-Aufruf deckt Komponente und Repo-Wurzel ab. Fehlt ein
 * Ordner, endet ls mit exit 2, listet aber die übrigen. Das Ergebnis gilt für
 * den ganzen Lauf: fmt, lint und types fragen sonst je einmal.
 *
 * @param {string} dir
 * @param {string | null | undefined} root
 * @returns {ContainerModules | null}
 */
export function containerNodeModules(dir, root) {
  const ddevRoot = findDdevRoot(dir)
  if (!ddevRoot || !ddevStatus(ddevRoot).running) return null
  const key = `${dir}\0${root ?? ''}`
  if (containerCache.has(key)) return containerCache.get(key) ?? null

  /** @type {Array<{ host: string, modules: string, bin: string }>} */
  const bases = []
  for (const host of new Set([dir, root])) {
    const inside = host ? containerPath(ddevRoot, host) : null
    if (!host || inside === null) continue
    const modules = posix.join(inside, 'node_modules')
    bases.push({ host, modules, bin: posix.join(modules, '.bin') })
  }
  const workdir = containerPath(ddevRoot, dir) ?? DDEV_APPROOT
  const paths = bases.flatMap((b) => [b.modules, b.bin])
  const listing = parseLs(
    ddevOutput(ddevRoot, ['exec', '--raw', '--dir', workdir, '--', 'ls', '-1A', ...paths]),
  )
  // Ein Paket wie @eslint/js liegt im Ordner @eslint.
  const deps = declaredDependencies(dir).map((dep) => dep.split('/')[0] ?? dep)
  /** @type {Map<string, string | null>} */
  const versions = new Map()
  const result = {
    installed: bases.some((b) => deps.some((dep) => listing.get(b.modules)?.has(dep))),
    /** @param {string} name */
    bin(name) {
      const base = bases.find((b) => listing.get(b.bin)?.has(name))
      return base ? join(base.host, 'node_modules', '.bin', name) : null
    },
    /**
     * Liest package.json im Container. Auf dem Host fehlt die Datei, und
     * eine Option, die von der Version abhängt, fiele sonst weg. Es zählt
     * das node_modules, aus dem auch bin() das Binary nimmt.
     *
     * @param {string} name
     */
    version(name) {
      if (versions.has(name)) return versions.get(name) ?? null
      const base = bases.find((b) => listing.get(b.bin)?.has(name))
      const file = base ? posix.join(base.modules, name, 'package.json') : null
      const text = file
        ? ddevOutput(ddevRoot, ['exec', '--raw', '--dir', workdir, '--', 'cat', file])
        : ''
      // Ein pre-exec-Hook schreibt mitunter eine Zeile vor das JSON.
      const found = /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null
      versions.set(name, found)
      return found
    },
  }
  containerCache.set(key, result)
  return result
}

/**
 * Zerlegt die Ausgabe von "ls -1A a b" in Ordner und Einträge. Zeilen vor der
 * ersten Überschrift, etwa die Warnung eines pre-exec-Hooks, fallen weg.
 *
 * @param {string} text
 * @returns {Map<string, Set<string>>}
 */
function parseLs(text) {
  /** @type {Map<string, Set<string>>} */
  const result = new Map()
  /** @type {Set<string> | null} */
  let current = null
  for (const line of text.split('\n')) {
    const header = /^(\/.*):$/.exec(line)
    if (header?.[1]) {
      current = new Set()
      result.set(header[1], current)
    } else if (line && current) {
      current.add(line)
    }
  }
  return result
}

/**
 * stdout eines ddev-Aufrufs, auch wenn er mit einem Fehlercode endet. Fehlt
 * ddev, ist die Ausgabe leer.
 *
 * @param {string} ddevRoot
 * @param {string[]} args
 * @returns {string}
 */
function ddevOutput(ddevRoot, args) {
  try {
    return execFileSync('ddev', args, {
      cwd: ddevRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
  } catch (error) {
    return String(/** @type {{ stdout?: unknown }} */ (error).stdout ?? '')
  }
}

/**
 * Die fremde Plattform, für die node_modules installiert wurde — oder null,
 * wenn es zum Host passt oder sich nichts sagen lässt.
 *
 * npm schreibt nach jeder Installation node_modules/.package-lock.json. Die
 * Datei listet nur Pakete, die tatsächlich installiert wurden, samt ihren
 * Feldern os und cpu. Ein optionales Binding für eine andere Plattform
 * überspringt npm und listet es nicht. Steht dort ein Paket, das auf diesem
 * Host nicht installierbar wäre, stammt node_modules von einer anderen
 * Plattform. Die Regel kennt kein Paket beim Namen.
 *
 * Geprüft wird das node_modules, das findBinary zuerst findet: Komponente vor
 * Repo-Wurzel.
 *
 * @param {string} dir
 * @param {string | null | undefined} root
 * @returns {string | null}
 */
export function nodeModulesPlatform(dir, root) {
  for (const base of [dir, root]) {
    if (!base || !existsSync(join(base, 'node_modules'))) continue
    const packages = readJson(join(base, 'node_modules', '.package-lock.json'))?.packages ?? {}
    for (const meta of Object.values(packages)) {
      if (!allows(meta?.os, process.platform)) return String(meta.os.join(', '))
      if (!allows(meta?.cpu, process.arch)) return String(meta.cpu.join(', '))
    }
    return null
  }
  return null
}

/**
 * Lässt eine Liste wie os oder cpu aus package.json diesen Wert zu? Regeln
 * wie bei npm: "!x" schliesst x aus, positive Einträge sind eine Positivliste.
 *
 * @param {unknown} list
 * @param {string} value
 * @returns {boolean}
 */
function allows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true
  if (list.includes(`!${value}`)) return false
  const positive = list.filter((entry) => !String(entry).startsWith('!'))
  return positive.length === 0 || positive.includes(value)
}

/**
 * Sucht .ddev/config.yaml ab einem Verzeichnis aufwärts.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
export function findDdevRoot(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, '.ddev', 'config.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * @typedef {object} DdevStatus
 * @property {boolean} running das Projekt dieses Checkouts läuft
 * @property {boolean} mutagen
 * @property {string | null} foreign approot eines anderen Checkouts, wenn ddev
 *   läuft, aber dorthin zeigt
 */

/** @type {Map<string, DdevStatus>} */
const runningCache = new Map()

/**
 * Was zu tun ist, wenn das ddev-Projekt dieses Checkouts nicht läuft.
 *
 * Läuft ddev schon, zeigt approot aber auf einen anderen Checkout, hilft
 * «ddev start» nicht. Das passiert in einem Worktree vor dem Bootstrap:
 * .ddev/config.yaml trägt dann noch den Namen des Haupt-Checkouts.
 *
 * @param {string} ddevRoot
 * @returns {string}
 */
export function ddevStartHint(ddevRoot) {
  const { foreign } = ddevStatus(ddevRoot)
  if (!foreign) return `Starte das Projekt mit:  ddev start\n`
  return (
    `ddev läuft, aber für einen anderen Checkout (approot ${foreign}).\n` +
    `Gib diesem Checkout in .ddev/config.yaml einen eigenen Projektnamen ` +
    `und starte ihn dann mit ddev start.\n`
  )
}

/**
 * Läuft das ddev-Projekt dieses Checkouts? Fehlt ddev oder scheitert die
 * Abfrage, gilt es als nicht laufend. Das Ergebnis gilt für den ganzen Lauf.
 *
 * "ddev describe -j" schreibt JSON-Zeilen. Davor stehen mitunter andere
 * Zeilen, in rankscan-website die Warnung eines pre-exec-Hooks. Gelesen wird
 * darum die letzte Zeile mit dem Feld raw.
 *
 * approot muss dieser Checkout sein. In einem Worktree vor dem Bootstrap
 * trägt .ddev/config.yaml noch den Namen des Haupt-Checkouts. ddev exec
 * prüfte dann dessen Code statt des eigenen.
 *
 * Nutzt das Projekt Mutagen? `mutagen_enabled` steht in derselben Ausgabe
 * unter raw. ddev setzt es bei `performance_mode: mutagen` (geprüft mit
 * rankscan-website). Siehe lib/mutagen.mjs.
 *
 * @param {string} ddevRoot
 * @returns {DdevStatus}
 */
function ddevStatus(ddevRoot) {
  let status = runningCache.get(ddevRoot)
  if (status === undefined) {
    const raw = ddevOutput(ddevRoot, ['describe', '-j'])
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line)?.raw
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .at(-1)
    const up = raw?.status === 'running'
    const own = up && samePath(raw?.approot, ddevRoot)
    status = {
      running: own,
      mutagen: raw?.mutagen_enabled === true,
      foreign: up && !own && typeof raw?.approot === 'string' ? raw.approot : null,
    }
    runningCache.set(ddevRoot, status)
  }
  return status
}

/**
 * @param {unknown} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (typeof a !== 'string' || !a) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * Liegt eine Datei dieses Namens im PATH? Bewusst ohne Aufruf und ohne
 * Merken: "env php" sucht genauso, und der Status kann sich zwischen zwei
 * Läufen ändern.
 *
 * @param {string} name
 * @returns {boolean}
 */
function onHostPath(name) {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry && existsSync(join(entry, name)))
}

/**
 * Ein Aufruf, der nur eine Meldung ausgibt und mit exit 1 endet. So trägt der
 * Schritt die Meldung, ohne dass Runner und Audit einen neuen Schritttyp
 * kennen müssen.
 *
 * `unavailable` sagt dem Audit: dieser Schritt prüft nichts, er meldet nur,
 * was der Umgebung fehlt. Der Audit macht ihn darum nicht zur Pflicht.
 *
 * @param {string} message
 * @returns {{ cmd: string, args: string[], unavailable: true }}
 */
export function failingCommand(message) {
  return {
    cmd: process.execPath,
    args: ['-e', 'process.stderr.write(process.argv[1]); process.exit(1)', message],
    unavailable: true,
  }
}

/* ── Paketmanager ─────────────────────────────────────────────────────── */

/** @type {PackageManager[]} */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn']

/** Lockfiles, an denen sich ein JS-Projekt erkennen lässt. */
export const JS_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]

/**
 * Welcher Paketmanager ein JS-Projekt treibt.
 *
 * Das Feld `packageManager` im package.json entscheidet zuerst: Corepack
 * liest genau dieses Feld, und es nennt die Absicht statt eines Nebenprodukts.
 * Erst danach zählt das Lockfile. Liegen zwei Lockfiles nebeneinander, gewinnt
 * npm — ein Zustand, den niemand absichtlich herstellt; wichtiger als die Wahl
 * ist, dass sie feststeht und nicht von der Verzeichnisreihenfolge abhängt.
 *
 * Gibt null zurück, wenn nichts entschied. Das ist eine andere Aussage als
 * "npm", und jeder Aufrufer setzt seinen eigenen Standard.
 *
 * @param {{declared?: string|null, lockfiles?: string[]}} facts
 * @returns {PackageManager | null}
 */
export function packageManagerFrom({ declared = null, lockfiles = [] } = {}) {
  const name = String(declared ?? '')
    .split('@')[0]
    ?.trim()
  const named = PACKAGE_MANAGERS.find((pm) => pm === name)
  if (named) return named

  const present = new Set(lockfiles)
  if (present.has('package-lock.json') || present.has('npm-shrinkwrap.json')) return 'npm'
  if (present.has('pnpm-lock.yaml')) return 'pnpm'
  if (present.has('yarn.lock')) return 'yarn'
  return null
}

/**
 * @param {string} file
 * @returns {any} ungeprüftes JSON; die Aufrufer greifen nur optional darauf zu
 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Sammelt die Fakten von der Platte, Komponente vor Repo-Wurzel — dieselbe
 * Reihenfolge wie findBinary. Der Rückfall auf die Wurzel ist Pflicht: in
 * einem pnpm-Monorepo liegt das Lockfile nur dort, und ohne ihn fiele jede
 * Unterkomponente auf npm zurück.
 *
 * @param {string | null | undefined} dir
 * @param {string | null | undefined} root
 * @returns {PackageManager | null}
 */
export function packageManagerFor(dir, root) {
  for (const base of [dir, root]) {
    if (!base) continue
    const declared = readJson(join(base, 'package.json'))?.packageManager ?? null
    const lockfiles = JS_LOCKFILES.filter((f) => existsSync(join(base, f)))
    const pm = packageManagerFrom({ declared, lockfiles })
    if (pm) return pm
  }
  return null
}

/** @type {Map<string, boolean>} */
const onPath = new Map()

/**
 * Liegt das Werkzeug im PATH? Einmal je Prozess geprüft, dann gemerkt.
 *
 * Nötig, weil lib/run.mjs mit `shell: false` startet: ein fehlendes `pnpm`
 * bricht den Schritt mit Exit 127 ab, statt auf npm auszuweichen. Auf Renés
 * Rechner fehlen pnpm, yarn und corepack — der Rückfall ist kein Randfall.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function hasOnPath(name) {
  let found = onPath.get(name)
  if (found === undefined) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore' })
      found = true
    } catch {
      found = false
    }
    onPath.set(name, found)
  }
  return found
}

/**
 * Der Aufruf eines Projekt-Skripts, samt Weitergabe zusätzlicher Argumente.
 *
 * Gemessen am 20.08.2026 mit npm 11.12.1 und pnpm 9.12:
 *   npm  run --silent lint --version     → npm meldet SEINE Version (11.12.1)
 *   npm  run --silent lint -- --version  → eslint meldet seine (v9.39.4)
 *   pnpm run --silent lint --version     → eslint meldet seine (v9.39.4)
 *   pnpm run --silent lint -- --version  → eslint bekommt "--" als Trenner
 *
 * npm braucht das `--` also zwingend, pnpm darf es auf keinen Fall bekommen.
 * Ohne diese Unterscheidung schluckt npm die Schärfe-Option stillschweigend.
 *
 * @param {PackageManager | string | null} pm unbekannte Werte fallen auf npm zurück
 * @param {string} script
 * @param {string[]} [args]
 * @returns {{ cmd: string, args: string[] }}
 */
export function scriptCommand(pm, script, args = []) {
  if (pm === 'pnpm') return { cmd: 'pnpm', args: ['run', '--silent', script, ...args] }
  // yarn ist ungetestet — kein Standout-Projekt nutzt es. `--silent` bleibt
  // weg, weil yarn berry die Option nicht kennt.
  if (pm === 'yarn') return { cmd: 'yarn', args: ['run', script, ...args] }
  const forward = args.length > 0 ? ['--', ...args] : []
  return { cmd: 'npm', args: ['run', '--silent', script, ...forward] }
}

/* ── Linter-Schärfe ───────────────────────────────────────────────────── */

/**
 * Die Option, mit der ein Linter Warnungen als Fehler wertet. Eine Tabelle,
 * damit der direkte Aufruf und der Aufruf über das lint-Skript dieselbe
 * Wahrheit benutzen.
 */
/** @type {Record<'eslint' | 'oxlint', string>} */
export const LINT_STRICT_FLAG = { eslint: '--max-warnings=0', oxlint: '--deny-warnings' }

/**
 * Welche Option ein fremdes lint-Skript scharf stellt — oder null, wenn sich
 * das nicht sicher sagen lässt.
 *
 * Verkettete Skripte bleiben unangetastet: ein weitergereichtes Argument
 * landet nur beim LETZTEN Befehl der Kette. Halb scharf ist schlechter als
 * offen nicht scharf, weil es dasselbe grüne Häkchen erzeugt.
 *
 * @param {unknown} script
 * @returns {string[] | null}
 */
export function lintStrictArgs(script) {
  const text = String(script ?? '')
  if (/&&|\|\||[;|]/.test(text)) return null
  if (/(^|[\s/])oxlint(\s|$)/.test(text)) return [LINT_STRICT_FLAG.oxlint]
  // "next lint" reicht eslint-Optionen durch, enthält aber nicht "eslint".
  if (/(^|[\s/])eslint(\s|$)/.test(text) || /(^|[\s/])next\s+lint(\s|$)/.test(text)) {
    return [LINT_STRICT_FLAG.eslint]
  }
  return null
}
