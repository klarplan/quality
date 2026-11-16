import { spawnSync } from 'node:child_process'

/**
 * Mutagen-Sync für Schritte im ddev-Container.
 *
 * Mit `performance_mode: mutagen` spiegelt ddev das Projekt asynchron
 * zwischen Host und Container. Ein Schritt im Container sieht dann einen
 * alten Stand der Host-Dateien. Was prettier --write oder pint im Container
 * schreibt, sieht der Host erst später. Gemessen in rankscan-website: direkt
 * nach `quality fix` zeigte `git diff` die Datei weiter unformatiert.
 *
 * `ddev mutagen sync` wartet, bis beide Seiten gleich sind. Ein Sync dauerte
 * dort rund 0,6 s.
 *
 * Der Status «problems» aus `ddev describe` sagt allein nichts: in
 * rankscan-website stand er auf «problems: transitioning», und der Sync lief
 * trotzdem mit exit 0. Es zählt deshalb nur der Exit-Code des Syncs.
 */

/**
 * Obergrenze für einen Sync. Ein hängender Mutagen-Daemon soll den Lauf
 * nicht unbegrenzt blockieren. Die Hooks haben eigene, kürzere Grenzen.
 */
export const SYNC_TIMEOUT_MS = 20000

/**
 * Führt `ddev mutagen sync` im ddev-Projekt aus.
 *
 * @param {string} ddevRoot
 * @returns {{ ok: boolean, output: string }}
 */
export function mutagenSync(ddevRoot) {
  const run = spawnSync('ddev', ['mutagen', 'sync'], {
    cwd: ddevRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SYNC_TIMEOUT_MS,
  })
  const output = [run.stdout, run.stderr, run.error?.message].filter(Boolean).join('\n').trim()
  return { ok: run.status === 0, output }
}

/**
 * Meldung, wenn ein Sync scheitert.
 *
 * @param {'vor' | 'nach'} when
 * @param {string} ddevRoot
 * @param {string} output
 * @returns {string}
 */
export function syncFailure(when, ddevRoot, output) {
  const meaning =
    when === 'vor'
      ? 'Der Container hätte einen alten Stand der Dateien geprüft. Der Schritt lief darum nicht.'
      : 'Was der Schritt im Container geschrieben hat, ist auf dem Host noch nicht angekommen.'
  return (
    `\nMutagen-Sync ${when} dem Schritt ist gescheitert (${ddevRoot}).\n` +
    `${output ? `${output}\n` : ''}` +
    `${meaning}\n` +
    `Prüfe den Status mit:  ddev mutagen st\n` +
    `Setze Mutagen zurück mit:  ddev mutagen reset\n`
  )
}
