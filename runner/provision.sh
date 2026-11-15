#!/usr/bin/env bash
#
# Richtet eine frische Ubuntu-24.04-VM als GitHub-Actions-Runner-Host ein.
# Einmal als ubuntu-User mit sudo ausführen. Das Skript ist idempotent:
# ein zweiter Lauf überspringt, was schon da ist.
#
# Was danach vorhanden ist:
#   - 2 GB Swap
#   - Docker (für services:-Container wie postgres/redis)
#   - PHP 8.3 und 8.4 CLI mit den Extensions der Quality-Workflows
#   - composer, git, curl, jq, unzip
#   - User "runner" (kein sudo, Mitglied der docker-Gruppe)
#
# Node fehlt absichtlich: actions/setup-node installiert es je Lauf in den
# Runner-Tool-Cache und respektiert .nvmrc.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Mit sudo ausführen: sudo $0" >&2
  exit 1
fi

echo "==> Swap (2 GB)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

echo "==> Basispakete"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Das Paket shellcheck ist auf GitHub-Hosted-Runnern vorinstalliert, hier nicht. Der
# mautic-Workflow ruft es direkt auf und scheitert sonst am fehlenden Befehl.
apt-get install -y -qq git curl jq unzip ca-certificates software-properties-common shellcheck

echo "==> Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

echo "==> PHP 8.3 + 8.4"
add-apt-repository -y ppa:ondrej/php >/dev/null
apt-get update -qq
# Extensions aus den Quality-Workflows (pdo_pgsql steckt im pgsql-Paket).
# xml und curl dazu: composer und Laravel brauchen beide.
for v in 8.3 8.4; do
  apt-get install -y -qq \
    "php${v}-cli" "php${v}-pgsql" "php${v}-redis" "php${v}-intl" \
    "php${v}-mbstring" "php${v}-bcmath" "php${v}-zip" "php${v}-gd" \
    "php${v}-xml" "php${v}-curl"
done
update-alternatives --set php /usr/bin/php8.4

echo "==> PostgreSQL-Client 17 + redis-tools"
# Auch das ist auf ubuntu-latest vorinstalliert: Laravel lädt den
# Schema-Dump (database/schema/*.sql) über psql statt über Migrationen.
# Fehlt psql, scheitert jeder Test, der eine Datenbank anfasst — mit
# "sh: 1: psql: not found" tief in einer ProcessFailedException.
# Aus dem PGDG-Repo, damit der Client zur Server-Version 17 passt.
if ! command -v psql >/dev/null; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
    >/etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
fi
apt-get install -y -qq postgresql-client-17 redis-tools

echo "==> composer"
if ! command -v composer >/dev/null; then
  EXPECTED=$(curl -fsSL https://composer.github.io/installer.sig)
  curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php
  echo "${EXPECTED}  /tmp/composer-setup.php" | sha384sum -c - >/dev/null
  php /tmp/composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer
  rm /tmp/composer-setup.php
fi

echo "==> User runner"
if ! id runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash runner
fi
usermod -aG docker runner

# Passwortloses sudo ist Voraussetzung, nicht Bequemlichkeit: GitHub-Hosted-
# Runner geben ihrem Job-User genau das, und Actions verlassen sich darauf.
# shivammathur/setup-php etwa legt sein Lock-Verzeichnis per sudo an — ohne
# sudo scheitert es nicht, sondern wartet endlos, und der Job hängt bis zum
# Timeout. Das kostet nichts an Sicherheit: wer einen PR schreiben kann,
# führt hier ohnehin eigenen Code aus (Tests, Build, composer-Scripts). Die
# Schutzgrenze ist, dass nur private Repos ohne Fork-PRs hier laufen.
echo "runner ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/runner
chmod 0440 /etc/sudoers.d/runner
visudo -c -f /etc/sudoers.d/runner >/dev/null

echo "==> Docker-Aufräum-Cron (täglich)"
# system prune räumt Volumes nicht ab, und "until" lässt sich mit --volumes
# nicht kombinieren. Jeder services:-Container (postgres, redis) hinterlässt
# aber ein anonymes Volume. Am 03.10.2026 lagen 634 davon mit 29 GB auf der
# Platte. volume prune löscht ohne -a nur anonyme, unbenutzte Volumes.
# Täglich statt wöchentlich: Ende Oktober 2026 kamen an einem Werktag bis
# 11 GB Volumes dazu, die 80-GB-Platte wäre vor dem Sonntag voll gewesen.
# Die Images behalten ihre 7 Tage, damit der Cache warm bleibt.
cat >/etc/cron.daily/docker-prune <<'EOF'
#!/bin/sh
docker system prune -af --filter "until=168h" >/dev/null 2>&1
docker volume prune -f >/dev/null 2>&1
EOF
chmod +x /etc/cron.daily/docker-prune
rm -f /etc/cron.weekly/docker-prune

echo "==> Aufräum-Cron für Runner-Updates (täglich)"
# Jedes Selbstupdate eines Runners lässt die vorige Version (bin.<ver>,
# externals.<ver>) und _work/_update liegen, zusammen rund 1,4 GB je Runner.
# Am 15.11.2026 lagen so 25 GB unter /opt/gh-runner.
# Es fallen nur Versionen weg, die älter als die aktive sind. Das Selbstupdate
# legt bin.<neu> an und wartet dann auf das Ende des laufenden Jobs. Erst
# danach stellt update.sh die Links um, ohne zu prüfen, ob das Ziel noch da
# ist. Fehlt bin.<neu> dann, startet der Runner nicht mehr.
# Zeigen bin und externals auf verschiedene Versionen, ist ein Update halb
# umgestellt, und der Cron lässt den Runner-Ordner ganz in Ruhe.
# Die Altersgrenze von 60 Minuten ist eine zweite Absicherung.
# _update fällt erst weg, wenn kein Job läuft und beide Links auf die
# neueste Version zeigen. Den Test dazu enthält lib/runner-update-reste.test.mjs.
# RUNNER_ROOT, RUNNER_WORKER_PATTERN und RUNNER_LOG setzt nur der Test.
# pgrep -f taugt hier, anders als im SSH-Befehl der Doku: im Cron steht das
# Muster in keiner fremden Befehlszeile, und pgrep meldet sich nie selbst.
cat >/etc/cron.daily/runner-update-reste <<'EOF'
#!/bin/sh
root=${RUNNER_ROOT:-/opt/gh-runner}
pattern=${RUNNER_WORKER_PATTERN:-'[R]unner\.Worker'}
log=${RUNNER_LOG:-logger -t runner-update-reste}

for dir in "$root"/*/*/; do
  dir=${dir%/}
  [ -L "$dir/bin" ] && [ -L "$dir/externals" ] || continue
  bin=$(basename "$(readlink "$dir/bin")")
  ext=$(basename "$(readlink "$dir/externals")")
  active=${bin#bin.}
  [ "$active" = "${ext#externals.}" ] || continue

  for old in "$dir"/bin.* "$dir"/externals.*; do
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    ver=${old##*/}
    ver=${ver#*.}
    [ "$ver" != "$active" ] || continue
    newer=$(printf '%s\n%s\n' "$ver" "$active" | sort -V | tail -n 1)
    [ "$newer" = "$active" ] || continue
    [ -n "$(find "$old" -maxdepth 0 -mmin +60)" ] || continue
    rm -rf "$old" && $log "entfernt $old"
  done

  update="$dir/_work/_update"
  [ -d "$update" ] || continue
  pgrep -f "$pattern" >/dev/null && continue
  newest=$(for p in "$dir"/bin.* "$dir"/externals.*; do
    [ -d "$p" ] && echo "${p##*/}"
  done | sed 's/^[a-z]*\.//' | sort -V | tail -n 1)
  [ "$bin" = "bin.$newest" ] && [ "$ext" = "externals.$newest" ] || continue
  [ -z "$(find "$update" -mmin -60 | head -n 1)" ] || continue
  rm -rf "$update" && $log "entfernt $update"
done
exit 0
EOF
chmod +x /etc/cron.daily/runner-update-reste

echo "==> Journal auf 500 MB begrenzt"
# Ohne Grenze nimmt journald bis zu 10 % des Dateisystems, höchstens 4 GB.
# Am 15.11.2026 belegte das Journal 2,1 GB. Mit 500 MB reichte es danach
# bis zum 29.10.2026 zurück.
# Den Test dazu enthält lib/runner-journald.test.mjs.
install -d /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/50-groesse.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
systemctl restart systemd-journald

echo "==> unattended-upgrades: noble-updates und nächtlicher Neustart"
# Die Ubuntu-Vorgabe installiert nur das Release- und das Security-Pocket
# und startet nie neu. Am 27.10.2026 wartete ein Kernel-Update seit zwölf
# Tagen auf den Neustart. Eine eigene Datei statt 50unattended-upgrades:
# ein Update des Pakets überschreibt sie nicht. Listen in apt.conf.d werden
# zusammengeführt, die Origins der Vorgabe bleiben also erhalten.
# Docker, die PPA ondrej/php, gh und pgdg bleiben Handarbeit.
# Der Neustart um 03:00 bricht einen Job ab, der gerade läuft. Die
# Runner-Dienste starten danach von selbst.
cat >/etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Allowed-Origins {
	"${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
EOF

# Verwaiste Service-Container: Bricht ein Job ab, räumt der Runner seine
# services:-Container nicht immer weg. Auf GitHub-Hosted fällt die ganze VM
# danach weg, hier bleiben sie laufen — mit belegten Ports, an denen der
# nächste Lauf schon beim "Initialize containers" scheitert.
# Stündlich, Grenze 6 h: kein Job dieser Repos läuft länger (Timeout 45 min),
# und auf dieser VM laufen ausschliesslich Runner-Container.
cat >/etc/cron.hourly/runner-stale-containers <<'EOF'
#!/bin/sh
now=$(date +%s)
docker ps -q | while read -r id; do
  started=$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null) || continue
  ts=$(date -d "$started" +%s 2>/dev/null) || continue
  [ $((now - ts)) -gt 21600 ] && docker rm -f "$id" >/dev/null 2>&1
done
EOF
chmod +x /etc/cron.hourly/runner-stale-containers

echo "Fertig. Nächster Schritt: runner/register.sh je Repository."
