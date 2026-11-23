#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for candidate in \
  "${NVM_BIN:-}" \
  "/opt/homebrew/bin" \
  "/usr/local/bin" \
  "$HOME/.volta/bin" \
  "$HOME/.local/share/fnm/aliases/default/bin" \
  "$HOME/.fnm/aliases/default/bin" \
  "$HOME/.local/bin"
do
  if [ -n "$candidate" ] && [ -d "$candidate" ] && [[ ":$PATH:" != *":$candidate:"* ]]; then
    export PATH="$candidate:$PATH"
  fi
done

if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
fi

INSTALL_LANG="${TUNNEL_LANG:-}"
PREV_ARG=""
for arg in "$@"; do
  if [ "$PREV_ARG" = "--lang" ]; then
    INSTALL_LANG="$arg"
    PREV_ARG=""
    continue
  fi
  case "$arg" in
    --lang=*) INSTALL_LANG="${arg#--lang=}" ;;
    --lang) PREV_ARG="--lang" ;;
  esac
done
if [ -z "$INSTALL_LANG" ]; then
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
    ru*|RU*) INSTALL_LANG="ru" ;;
    *) INSTALL_LANG="en" ;;
  esac
fi

if ! command -v node >/dev/null 2>&1; then
  if [ "$INSTALL_LANG" = "ru" ]; then
    echo "[ОШИБКА] Node.js не найден (требуется версия >= 22)." >&2
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "Установите Node.js LTS через Homebrew: brew install node" >&2
    else
      echo "Установите Node.js LTS с https://nodejs.org/ или через nvm: nvm install --lts" >&2
    fi
  else
    echo "[ERROR] Node.js was not found (version >= 22 required)." >&2
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "Install Node.js LTS via Homebrew: brew install node" >&2
    else
      echo "Install Node.js LTS from https://nodejs.org/ or via nvm: nvm install --lts" >&2
    fi
  fi
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  if [ "$INSTALL_LANG" = "ru" ]; then
    echo "[ОШИБКА] Требуется Node.js >= 22 (установлена v$(node -v)). Обновите Node.js LTS." >&2
  else
    echo "[ERROR] Node.js >= 22 is required (found v$(node -v)). Please upgrade to Node.js LTS." >&2
  fi
  exit 1
fi

exec node "$SCRIPT_DIR/install.js" "$@"
