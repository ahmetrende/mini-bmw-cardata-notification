#!/usr/bin/env bash
# Installs or updates the program on an Ubuntu server.
# Run from the repository root: sudo bash deploy/install.sh
# What it does: installs Node 22 (with a checksum check), creates the miniwatch user,
# copies the code to /opt/mini-watch, installs the dependencies and installs the systemd service.
# It does not change config.json or tokens.json. It restarts the service if the service runs.
set -euo pipefail

APP=/opt/mini-watch
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

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
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
echo "Node: $(node -v), OpenSSL: $(node -p process.versions.openssl)"

id miniwatch >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin miniwatch
install -d -o miniwatch -g miniwatch "$APP"
install -o miniwatch -g miniwatch -m 644 "$REPO/mini_watch.mjs" "$REPO/package.json" "$REPO/package-lock.json" "$APP/"

if [ ! -f "$APP/config.json" ]; then
  install -o miniwatch -g miniwatch -m 600 "$REPO/config.example.json" "$APP/config.json"
  NEW_CONFIG=1
fi

(cd "$APP" && sudo -u miniwatch HOME="$APP" npm ci --omit=dev --silent)

install -o root -g root -m 644 "$REPO/deploy/mini-watch.service" /etc/systemd/system/mini-watch.service
systemctl daemon-reload
sync # Write the new files to disk. A sudden shutdown must not leave empty files.

if systemctl is-active --quiet mini-watch; then
  systemctl restart mini-watch
  echo "The service restarted."
fi

echo
echo "Install done."
if [ "${NEW_CONFIG:-0}" = 1 ]; then
  echo "Next step: sudo nano $APP/config.json  (set client_id, ntfy_topic and language)"
elif [ ! -f "$APP/tokens.json" ]; then
  echo "Next step: log in. See docs/en/04-server-setup.md, part 7."
fi
