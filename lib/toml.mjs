/**
 * Enger TOML-Leser für pyproject.toml.
 *
 * Bewusst kein vollständiges TOML: das Paket wird auch über Composer installiert,
 * wo kein node_modules danebenliegt. Eine Dependency wäre dort nicht verfügbar.
 * Unterstützt werden Tabellen, Tabellenlisten, gepunktete und gequotete
 * Schlüssel, Basic- und Literal-Strings, Dezimalzahlen, Wahrheitswerte, Listen
 * und Inline-Tabellen. Alles andere (Datum, mehrzeilige Strings, Hex-Zahlen,
 * inf/nan) wirft einen TomlError, statt still falsch gelesen zu werden.
 */

/** @typedef {string | number | boolean | TomlList | TomlTable} TomlValue */

/** @typedef {TomlValue[]} TomlList */

/** @typedef {{ [key: string]: TomlValue }} TomlTable */

class TomlError extends Error {
  /**
   * @param {string} message
   * @param {number} [lineNo]
   */
  constructor(message, lineNo) {
    super(lineNo ? `${message} (Zeile ${lineNo})` : message)
    this.name = 'TomlError'
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/
const NUMBER = /^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?/
const BOOLEAN = /^(true|false)/
const DELIMITER = /^([ \t\r\n,\]}#]|$)/

/** @type {Record<string, string>} */
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

/**
 * Setzt einen Schlüssel als eigene Eigenschaft. Ein Schlüssel `__proto__`
 * ändert so nicht den Prototyp.
 *
 * @param {TomlTable | TomlValue[]} target
 * @param {string | number} key
 * @param {TomlValue} value
 */
function define(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * @param {unknown} v
 * @returns {v is TomlTable}
 */
function isTable(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

class Parser {
  /** @param {string} text */
  constructor(text) {
    this.text = text
    this.pos = 0
    /** Mit [kopf] definierte Tabellen: ein zweiter Kopf ist ein Fehler. */
    this.headerTables = new WeakSet()
    /** Inline-Tabellen und statische Listen: später nicht erweiterbar. */
    this.frozen = new WeakSet()
    /** Listen aus [[kopf]]. */
    this.tableArrays = new WeakSet()
  }

  /**
   * @param {string} message
   * @returns {TomlError}
   */
  error(message) {
    const lineNo = this.text.slice(0, this.pos).split('\n').length
    return new TomlError(message, lineNo)
  }

  peek(n = 1) {
    return this.text.slice(this.pos, this.pos + n)
  }

  skipSpaces() {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++
  }

  skipComment() {
    if (this.peek() !== '#') return
    while (this.pos < this.text.length && this.peek() !== '\n') this.pos++
  }

  /** Leerraum, Zeilenenden und Kommentare, etwa zwischen Listeneinträgen. */
  skipBlank() {
    for (;;) {
      this.skipSpaces()
      this.skipComment()
      const c = this.peek()
      if (c === '\n' || c === '\r') this.pos++
      else return
    }
  }

  /** Nach Kopf oder Zuweisung darf bis zum Zeilenende nur ein Kommentar folgen. */
  endOfLine() {
    this.skipSpaces()
    this.skipComment()
    if (this.peek() === '\r') this.pos++
    if (this.pos >= this.text.length) return
    if (this.peek() !== '\n') throw this.error(`Unerwartetes Zeichen nach dem Wert: ${this.peek()}`)
    this.pos++
  }

  /** @returns {TomlTable} */
  parse() {
    /** @type {TomlTable} */
    const root = {}
    let current = root
    for (;;) {
      this.skipBlank()
      if (this.pos >= this.text.length) return root
      if (this.peek() === '[') current = this.header(root)
      else this.keyValue(current)
      this.endOfLine()
    }
  }

  /** @returns {string} */
  key() {
    const c = this.peek()
    if (c === '"') return this.basicString()
    if (c === "'") return this.literalString()
    const start = this.pos
    while (this.pos < this.text.length && BARE_KEY.test(this.peek())) this.pos++
    if (this.pos === start) throw this.error(`Schlüssel erwartet, gefunden: ${c || 'Dateiende'}`)
    return this.text.slice(start, this.pos)
  }

  /** @returns {string[]} */
  dottedKey() {
    const parts = [this.key()]
    for (;;) {
      this.skipSpaces()
      if (this.peek() !== '.') return parts
      this.pos++
      this.skipSpaces()
      parts.push(this.key())
    }
  }

  /**
   * Geht von `table` aus über `parts` zur Elterntabelle. Fehlende Tabellen
   * entstehen dabei, bei einer Tabellenliste zählt der letzte Eintrag.
   *
   * @param {TomlTable} table
   * @param {string[]} parts
   * @returns {TomlTable}
   */
  descend(table, parts) {
    let node = table
    for (const part of parts) {
      if (!Object.hasOwn(node, part)) define(node, part, {})
      let next = node[part]
      if (Array.isArray(next) && this.tableArrays.has(next)) next = next[next.length - 1]
      if (!isTable(next) || this.frozen.has(next)) {
        throw this.error(`Schlüssel ${part} ist schon ein Wert und keine Tabelle`)
      }
      node = next
    }
    return node
  }

  /**
   * @param {TomlTable} root
   * @returns {TomlTable}
   */
  header(root) {
    const isArray = this.peek(2) === '[['
    this.pos += isArray ? 2 : 1
    this.skipSpaces()
    const parts = this.dottedKey()
    this.skipSpaces()
    const close = isArray ? ']]' : ']'
    if (this.peek(close.length) !== close) throw this.error(`${close} erwartet`)
    this.pos += close.length

    const last = /** @type {string} */ (parts.pop())
    const parent = this.descend(root, parts)
    const existing = Object.hasOwn(parent, last) ? parent[last] : undefined

    if (isArray) {
      /** @type {TomlTable} */
      const entry = {}
      if (existing === undefined) {
        /** @type {TomlValue[]} */
        const list = []
        this.tableArrays.add(list)
        define(parent, last, list)
        list.push(entry)
      } else if (Array.isArray(existing) && this.tableArrays.has(existing)) {
        existing.push(entry)
      } else {
        throw this.error(`[[${last}]] ist schon anders definiert`)
      }
      return entry
    }

    if (existing === undefined) {
      /** @type {TomlTable} */
      const table = {}
      define(parent, last, table)
      this.headerTables.add(table)
      return table
    }
    if (isTable(existing) && !this.frozen.has(existing) && !this.headerTables.has(existing)) {
      this.headerTables.add(existing)
      return existing
    }
    throw this.error(`Tabelle [${last}] ist schon definiert`)
  }

  /** @param {TomlTable} table */
  keyValue(table) {
    const parts = this.dottedKey()
    this.skipSpaces()
    if (this.peek() !== '=') throw this.error('= erwartet')
    this.pos++
    this.skipSpaces()
    const last = /** @type {string} */ (parts.pop())
    const parent = this.descend(table, parts)
    if (Object.hasOwn(parent, last)) throw this.error(`Schlüssel ${last} ist doppelt`)
    define(parent, last, this.value())
  }

  /** @returns {TomlValue} */
  value() {
    const c = this.peek()
    if (c === '"') return this.basicString()
    if (c === "'") return this.literalString()
    if (c === '[') return this.array()
    if (c === '{') return this.inlineTable()
    const rest = this.text.slice(this.pos)
    const bool = rest.match(BOOLEAN)
    if (bool && DELIMITER.test(rest.slice(bool[0].length))) {
      this.pos += bool[0].length
      return bool[0] === 'true'
    }
    const num = rest.match(NUMBER)
    if (num && DELIMITER.test(rest.slice(num[0].length))) {
      this.pos += num[0].length
      return Number(num[0].replaceAll('_', ''))
    }
    throw this.error(`Wert nicht lesbar: ${rest.split('\n')[0]}`)
  }

  /** @returns {string} */
  basicString() {
    if (this.peek(3) === '"""') throw this.error('Mehrzeilige Strings werden nicht unterstützt')
    this.pos++
    let out = ''
    for (;;) {
      const c = this.peek()
      if (c === '' || c === '\n') throw this.error('Nicht geschlossenes Anführungszeichen')
      this.pos++
      if (c === '"') return out
      if (c !== '\\') {
        out += c
        continue
      }
      const e = this.peek()
      this.pos++
      if (e in ESCAPES) {
        out += ESCAPES[e]
      } else if (e === 'u' || e === 'U') {
        const len = e === 'u' ? 4 : 8
        const hex = this.peek(len)
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex))
          throw this.error('Ungültiges \\u-Escape')
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        this.pos += len
      } else {
        throw this.error(`Unbekanntes Escape: \\${e}`)
      }
    }
  }

  /** @returns {string} */
  literalString() {
    if (this.peek(3) === "'''") throw this.error('Mehrzeilige Strings werden nicht unterstützt')
    this.pos++
    const end = this.text.indexOf("'", this.pos)
    const newline = this.text.indexOf('\n', this.pos)
    if (end === -1 || (newline !== -1 && newline < end)) {
      throw this.error('Nicht geschlossenes Anführungszeichen')
    }
    const out = this.text.slice(this.pos, end)
    this.pos = end + 1
    return out
  }

  /** @returns {TomlValue[]} */
  array() {
    this.pos++
    /** @type {TomlValue[]} */
    const list = []
    this.frozen.add(list)
    for (;;) {
      this.skipBlank()
      if (this.peek() === ']') {
        this.pos++
        return list
      }
      if (this.pos >= this.text.length) throw this.error('Nicht geschlossene Liste')
      list.push(this.value())
      this.skipBlank()
      if (this.peek() === ',') this.pos++
      else if (this.peek() !== ']') throw this.error(', oder ] erwartet')
    }
  }

  /** @returns {TomlTable} */
  inlineTable() {
    this.pos++
    /** @type {TomlTable} */
    const table = {}
    this.skipSpaces()
    if (this.peek() === '}') {
      this.pos++
      this.frozen.add(table)
      return table
    }
    for (;;) {
      this.skipSpaces()
      this.keyValue(table)
      this.skipSpaces()
      const c = this.peek()
      this.pos++
      if (c === '}') break
      if (c !== ',') throw this.error(', oder } erwartet')
    }
    // Erst jetzt einfrieren: gepunktete Schlüssel in der Inline-Tabelle
    // legen beim Lesen noch Untertabellen an.
    this.frozen.add(table)
    return table
  }
}

/**
 * @param {string} text
 * @returns {TomlTable}
 */
export function parseToml(text) {
  return new Parser(text).parse()
}

export { TomlError }
