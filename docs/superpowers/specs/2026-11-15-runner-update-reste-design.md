# Update-Reste der Runner automatisch entfernen

Freigegeben von René am 15.11.2026.

## Zweck

Jedes Selbstupdate eines Runners lässt die vorige Version (`bin.<ver>`,
`externals.<ver>`) und `_work/_update` liegen. Das sind rund 1,4 GB je
Runner, bei 8 Runnern über 11 GB. Am 15.11.2026 lagen so 25 GB unter
`/opt/gh-runner`. Ein täglicher Cron soll diese Reste entfernen.

## Ziele und Grenzen

- Der Cron löscht nie die aktive Version.
- Der Cron greift nicht in einen laufenden Job oder ein laufendes Update.
- Kein Ziel: andere Platzfresser (Journal, Caches, Sicherungen in `/root`).

## Ansätze

1. Ein Schritt in `/etc/cron.daily/docker-prune`. Verworfen: der Cron hat
   einen anderen Zweck, und ein Fehler darin würde das Docker-Aufräumen
   mitreissen.
2. Ein eigenes Skript `runner/runner-update-reste.sh`. Verworfen: die
   Einrichtung kopiert nur `provision.sh` und `register.sh` auf die VM.
3. **Gewählt:** ein eigener Cron `/etc/cron.daily/runner-update-reste`,
   angelegt von `provision.sh` als Heredoc wie die anderen Crons.

## Regeln

In jedem Ordner `$RUNNER_ROOT/*/*/` mit einem Link `bin`:

- Zeigen `bin` und `externals` auf verschiedene Versionen, bleibt der
  Runner-Ordner unberührt.
- `bin.*` und `externals.*` fallen weg, wenn ihre Version älter als die
  aktive ist (`sort -V`) und der Ordner älter als 60 Minuten. Eine neuere
  Version bleibt immer stehen: das Selbstupdate legt `bin.<neu>` an und
  wartet dann auf das Ende des Jobs, der länger als 60 Minuten laufen kann.
  Nachtrag nach dem Review vom 15.11.2026.
- `_work/_update` fällt weg, wenn alle drei Bedingungen gelten:
  - Kein `Runner.Worker` läuft.
  - `bin` und `externals` zeigen auf die neueste vorhandene Version
    (`sort -V`).
  - In `_work/_update` hat sich seit 60 Minuten nichts geändert.
- Jede Löschung geht mit `logger -t runner-update-reste` ins Journal.

Umgebungsvariablen für den Test, mit den Werten der VM als Vorgabe:
`RUNNER_ROOT` (`/opt/gh-runner`), `RUNNER_WORKER_PATTERN`
(`[R]unner\.Worker`), `RUNNER_LOG` (`logger -t runner-update-reste`). Das
Muster muss einstellbar sein, weil auf dem CI-Runner selbst ein
`Runner.Worker` läuft.

## Test

`runner/runner-update-reste.test.mjs` liest das Heredoc aus `provision.sh`
und baut die Ordner in einem Temp-Ordner nach. `npm test` bekommt dafür
`'runner/*.test.mjs'`.

## Offen

Den genauen Inhalt von `_work/_update` auf der VM hat niemand angesehen. Die
Regeln hängen nicht davon ab.
