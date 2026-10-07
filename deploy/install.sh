#!/usr/bin/env bash
# Installs or updates the program on an Ubuntu server.
# Run from the repository root: sudo bash deploy/install.sh
# What it does: installs Node 22 (with a checksum check), creates the miniwatch user,
# copies the code to /opt/mini-watch (owned by root, read-only for the service),
# installs the dependencies, the "mini-watch" command and the systemd service.
# Settings and data stay in /var/lib/mini-watch. Only the miniwatch user can read them.
# It does not change config.json or tokens.json. It restarts the service if the service runs.
# Older versions kept the data in /opt/mini-watch. The script moves that data to /var/lib/mini-watch.
set -euo pipefail

APP=/opt/mini-watch
DATA=/var/lib/mini-watch
NODE_MAJOR=22
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null; then
  echo "This script is only for Linux servers with systemd (for example Ubuntu 24.04)." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

# The service starts $NODE (see deploy/mini-watch.service). So check that file, not any node on the PATH.
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm
node_major() { "$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ ! -x "$NODE" ] || [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  echo "Installing Node $NODE_MAJOR..."
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "This processor type is not supported: $(uname -m)" >&2; exit 1 ;;
  esac
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -o "node-v${NODE_MAJOR}[^ ]*-linux-${ARCH}.tar.xz" "$TMP/SHASUMS256.txt" | head -1)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1
  rm -rf "$TMP"
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

# Code: owned by root. The service can read it but cannot change it.
install -d -o root -g root -m 755 "$APP"
rm -rf "$APP/.npm"
install -o root -g root -m 644 "$REPO/mini_watch.mjs" "$REPO/package.json" "$REPO/package-lock.json" "$APP/"
# --ignore-scripts: no code from the packages runs during the install. The packages need no install scripts.
(cd "$APP" && HOME=/root PATH="/usr/local/bin:/usr/bin:/bin" "$NPM" ci --omit=dev --ignore-scripts --silent)
chown -R root:root "$APP"
chmod -R u+rwX,go+rX,go-w "$APP"

install -o root -g root -m 755 "$REPO/deploy/mini-watch" /usr/local/bin/mini-watch
install -o root -g root -m 644 "$REPO/deploy/mini-watch.service" /etc/systemd/system/mini-watch.service
systemctl daemon-reload
sync # Write the new files to disk. A sudden shutdown must not leave empty files.

if [ "$WAS_ACTIVE" = 1 ]; then
  systemctl restart mini-watch
  echo "The service restarted."
fi

echo
echo "Install done."
if [ "${NEW_CONFIG:-0}" = 1 ]; then
  echo "Next step: sudo nano $DATA/config.json  (set client_id, ntfy_topic, language and timezone)"
elif [ ! -f "$DATA/tokens.json" ]; then
  echo "Next step: log in with: sudo mini-watch login  (docs/en/04-server-setup.md, part 7)"
fi
