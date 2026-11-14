/**
 * Bausteine von `quality gate`: welche Basis gilt, ob das Repo bereit ist,
 * und welche Secret-Scans laufen.
 *
 * Das Board committet den Merge vor dem Gate (agent-desk 31b06a3). Ein offener
 * Merge entsteht nur noch von Hand. Das Gate bricht dann ab, statt den Trailer
 * aus den Branch-Commits nachzubauen (Entscheid René, 14.11.2026).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** @import { Step } from './types.mjs' */

/** Ein Zustand, in dem das Gate keine Aussage machen kann. Exit 2. */
export class GateError extends Error {}

/**
 * Die Basis des Gates: --base, sonst CC_INTEGRATION_BASE, sonst origin/main.
 * cc setzt CC_INTEGRATION_BASE auf den Commit von main vor dem Merge.
 *
 * @param {string | null} option
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveBase(option, env) {
  return option ?? (env.CC_INTEGRATION_BASE?.trim() || 'origin/main')
}

/**
 * @param {string[]} args
 * @param {string} root
 */
function gitSucceeds(args, root) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Wirft GateError bei einem offenen Merge oder einer Basis, die kein Commit
 * ist. Eine falsche Basis darf nicht grün werden: gitleaks meldete sonst
 * «0 commits scanned».
 *
 * Gibt die volle SHA der Basis zurück. Alle Teile prüfen gegen diese SHA,
 * nicht gegen den Namen. Ein Name wie `main` ist mehrdeutig, wenn eine Datei
 * so heisst. `git log` bricht dann ab, und gitleaks meldete grün.
 *
 * @param {string} root
 * @param {string} base
 * @returns {string}
 */
export function assertGateReady(root, base) {
  if (gitSucceeds(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root)) {
    throw new GateError('Ein Merge ist offen. Committe den Merge und starte das Gate erneut.')
  }
  try {
    return execFileSync('git', ['rev-parse', '-q', '--verify', `${base}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new GateError(`Basis "${base}" ist kein Commit in diesem Repository.`)
  }
}

/**
 * Die Secret-Scans als normale Prüfschritte.
 *
 * Beide Scans schalten textconv und externe Diff-Programme ab. Eine
 * Git-Konfiguration des Nutzers könnte sonst Inhalt vor gitleaks verstecken.
 *
 * Der zweite Scan gilt dem Merge-Commit. `git log -p` zeigt für ihn keinen
 * Diff. Was beim Lösen von Konflikten dazukommt, steht in keinem
 * Branch-Commit. Darum geht sein kombinierter Diff separat an gitleaks.
 *
 * @param {{ root: string, base: string, binary: string }} opts
 * @returns {Step[]}
 */
export function secretScanSteps({ root, base, binary }) {
  const config = existsSync(join(root, '.gitleaks.toml')) ? ['--config', '.gitleaks.toml'] : []
  /** @type {Step[]} */
  const steps = [
    {
      name: 'gitleaks: Commits',
      cmd: binary,
      args: [
        'git',
        '--redact',
        '--verbose',
        ...config,
        `--log-opts=--no-textconv --no-ext-diff HEAD --not ${base}`,
        '.',
      ],
      cwd: root,
    },
  ]
  if (gitSucceeds(['rev-parse', '-q', '--verify', 'HEAD^2'], root)) {
    steps.push({
      name: 'gitleaks: Merge-Commit',
      cmd: 'bash',
      args: [
        '-c',
        'set -o pipefail; git show --cc --no-color --no-ext-diff --no-textconv --format= HEAD | "$0" stdin --redact --verbose "$@"',
        binary,
        ...config,
      ],
      cwd: root,
    })
  }
  return steps
}
