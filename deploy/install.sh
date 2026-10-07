#!/usr/bin/env bash
# Installs or updates the program on an Ubuntu server.
#
#   sudo bash deploy/install.sh             # install or update
#   sudo bash deploy/install.sh --rollback  # go back to the version before
#
# What it does:
# - Installs Node (a fixed version, checked against the SHA-256 value in this file).
# - Creates the miniwatch user.
# - Installs the code as a new release in /opt/mini-watch/releases. The code belongs to root.
#   The service can read it but cannot change it.
# - Checks the new release with "doctor --offline" while the old release still runs.
# - Switches to the new release in one step, restarts the service and waits until it is connected.
#   If it does not connect, the script goes back to the release before.
# - Keeps settings and data in /var/lib/mini-watch. Only the miniwatch user can read them.
# It does not change config.json or tokens.json.
# Older versions kept the code directly in /opt/mini-watch and the data next to it. The script moves them once.
set -euo pipefail

APP=/opt/mini-watch
RELEASES=$APP/releases
CURRENT=$APP/current
DATA=/var/lib/mini-watch
UNIT=/etc/systemd/system/mini-watch.service
WRAPPER=/usr/local/bin/mini-watch
KEEP_RELEASES=3
HEALTH_WAIT_S=120
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Node: a fixed version. To update it, change the version and both SHA-256 values from
# https://nodejs.org/dist/vX.Y.Z/SHASUMS256.txt (check the signature of that file, see nodejs.org).
NODE_MAJOR=22
NODE_VERSION=22.23.3
NODE_SHA256_X64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
NODE_SHA256_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
# The service starts $NODE (see deploy/mini-watch.service). So check that file, not any node on the PATH.
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm

if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null; then
  echo "This script is only for Linux servers with systemd (for example Ubuntu 24.04)." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

# The release that is in use, and the release before it (by name, the names start with the date).
current_release() { readlink -f "$CURRENT" 2>/dev/null || true; }
previous_release() {
  local cur prev="" r
  cur="$(current_release)"
  for r in $(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort); do
    [ "$r" = "$cur" ] && break
    prev="$r"
  done
  echo "$prev"
}

# Uses a release: its unit file, its "mini-watch" command and the "current" link. One rename switches the link.
switch_to() {
  install -o root -g root -m 644 "$1/mini-watch.service" "$UNIT"
  install -o root -g root -m 755 "$1/mini-watch" "$WRAPPER"
  ln -sfn "$1" "$APP/current.new"
  mv -T "$APP/current.new" "$CURRENT"
  systemctl daemon-reload
}

# Keeps the newest releases. Never deletes the release in use or the release given as $1.
cleanup_releases() {
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$KEEP_RELEASES" | while read -r old; do
    if [ "$old" != "$(current_release)" ] && [ "$old" != "${1:-}" ]; then rm -rf "$old"; fi
  done
}

# True when the service subscribed to the stream after the time $1 (seconds since 1970).
wait_healthy() {
  local deadline=$(($(date +%s) + HEALTH_WAIT_S))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if journalctl -u mini-watch --since "@$1" -o cat --no-pager 2>/dev/null | grep -q "Subscribed: "; then
      return 0
    fi
    sleep 3
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  PREV="$(previous_release)"
  if [ -z "$PREV" ]; then
    echo "There is no release before $(basename "$(current_release)")." >&2
    exit 1
  fi
  switch_to "$PREV"
  systemctl restart mini-watch
  echo "Back to the release $(basename "$PREV"). The service restarted."
  exit 0
fi

if [ ! -x "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  echo "Installing Node $NODE_VERSION..."
  case "$(uname -m)" in
    x86_64) ARCH=x64 SUM=$NODE_SHA256_X64 ;;
    aarch64) ARCH=arm64 SUM=$NODE_SHA256_ARM64 ;;
    *) echo "This processor type is not supported: $(uname -m)" >&2; exit 1 ;;
  esac
  FILE="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$FILE" -o "$TMP/$FILE"
  echo "$SUM  $TMP/$FILE" | sha256sum -c -
  tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1
  rm -rf "$TMP"
  echo "Installed $FILE (SHA-256 $SUM)."
fi
echo "Node: $("$NODE" -v), OpenSSL: $("$NODE" -p process.versions.openssl)"

id miniwatch >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin miniwatch
WAS_ACTIVE=0
systemctl is-active --quiet mini-watch && WAS_ACTIVE=1

# Settings and data: only the miniwatch user can read them.
install -d -o miniwatch -g miniwatch -m 700 "$DATA"
OLD_DATA=0
for f in config.json tokens.json state.json messages.jsonl run.log; do
  [ -f "$APP/$f" ] && OLD_DATA=1
done
if [ "$OLD_DATA" = 1 ]; then
  systemctl stop mini-watch 2>/dev/null || true # The old program writes these files.
  for f in config.json tokens.json state.json messages.jsonl; do
    if [ -f "$APP/$f" ]; then
      if [ -e "$DATA/$f" ]; then
        echo "Both $APP/$f and $DATA/$f exist. The script keeps $DATA/$f." >&2
        mv "$APP/$f" "$DATA/$f.old"
      else
        mv "$APP/$f" "$DATA/$f"
      fi
    fi
  done
  # The log now goes to the system journal. Keep the old log file.
  [ -f "$APP/run.log" ] && mv "$APP/run.log" "$DATA/run-before-journal.log"
  echo "Moved the data from $APP to $DATA."
fi
if [ ! -f "$DATA/config.json" ]; then
  install -m 600 "$REPO/config.example.json" "$DATA/config.json"
  NEW_CONFIG=1
fi
chown -R miniwatch:miniwatch "$DATA"
chmod -R u+rwX,go-rwx "$DATA"

# A new release. The running service does not use it yet.
STAMP="$(date +%Y%m%d-%H%M%S)-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)"
REL="$RELEASES/$STAMP"
install -d -o root -g root -m 755 "$APP" "$RELEASES" "$REL"
install -o root -g root -m 644 "$REPO/mini_watch.mjs" "$REPO/package.json" "$REPO/package-lock.json" "$REL/"
# --ignore-scripts: no code from the packages runs during the install. The packages need no install scripts.
(cd "$REL" && HOME=/root PATH="/usr/local/bin:/usr/bin:/bin" "$NPM" ci --omit=dev --ignore-scripts --silent)
# The unit file and the command start this release by its real path.
sed "s#/opt/mini-watch/current/#$REL/#g" "$REPO/deploy/mini-watch.service" >"$REL/mini-watch.service"
sed "s#/opt/mini-watch/current/#$REL/#g" "$REPO/deploy/mini-watch" >"$REL/mini-watch"
chown -R root:root "$REL"
chmod -R u+rwX,go+rX,go-w "$REL"
chmod 755 "$REL/mini-watch"

"$NODE" --check "$REL/mini_watch.mjs"
if [ -f "$DATA/tokens.json" ]; then
  echo "Checking the new release with the current settings:"
  if ! (cd / && runuser -u miniwatch -- env MINI_WATCH_DATA="$DATA" "$NODE" "$REL/mini_watch.mjs" doctor --offline); then
    rm -rf "$REL"
    echo "The new release does not accept the current setup. Nothing changed. Correct the FAIL lines and run the script again." >&2
    exit 1
  fi
fi

# Older versions had the code directly in /opt/mini-watch. Keep it as a release, so a rollback can use it.
if [ -f "$APP/mini_watch.mjs" ]; then
  LEGACY="$RELEASES/00000000-000000-before-releases"
  install -d -o root -g root -m 755 "$LEGACY"
  for f in mini_watch.mjs package.json package-lock.json node_modules; do
    if [ -e "$APP/$f" ]; then mv "$APP/$f" "$LEGACY/"; fi
  done
  rm -rf "$APP/.npm"
  if [ -f "$UNIT" ]; then sed "s#$APP/mini_watch.mjs#$LEGACY/mini_watch.mjs#g" "$UNIT" >"$LEGACY/mini-watch.service"; fi
  if [ -f "$WRAPPER" ]; then sed "s#$APP/mini_watch.mjs#$LEGACY/mini_watch.mjs#g" "$WRAPPER" >"$LEGACY/mini-watch"; fi
  chown -R root:root "$LEGACY"
  ln -sfn "$LEGACY" "$CURRENT"
  echo "Kept the old code as the release $(basename "$LEGACY")."
fi

BEFORE="$(current_release)"
switch_to "$REL"
sync # Write the new files to disk. A sudden shutdown must not leave empty files.
echo "Release: $STAMP"

if [ "$WAS_ACTIVE" = 1 ]; then
  SINCE="$(date +%s)"
  systemctl restart mini-watch
  if wait_healthy "$SINCE"; then
    echo "The service restarted and is connected to the stream."
  else
    echo "The service did not connect in $HEALTH_WAIT_S seconds. Log: sudo journalctl -u mini-watch -n 50" >&2
    if [ -n "$BEFORE" ] && [ -f "$BEFORE/mini-watch.service" ]; then
      switch_to "$BEFORE"
      systemctl restart mini-watch
      echo "Went back to the release $(basename "$BEFORE"). If BMW had a short problem, run the update again later." >&2
    fi
    cleanup_releases "$REL"
    exit 1
  fi
fi

cleanup_releases "$BEFORE"

echo
echo "Install done."
if [ "${NEW_CONFIG:-0}" = 1 ]; then
  echo "Next step: sudo nano $DATA/config.json  (set client_id, ntfy_topic, language and timezone)"
elif [ ! -f "$DATA/tokens.json" ]; then
  echo "Next step: log in with: sudo mini-watch login  (docs/en/04-server-setup.md, part 7)"
fi
