#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# typora-plugin-lite · macOS uninstaller
# ============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
err()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }

TYPORA_PATH=""
SILENT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path) TYPORA_PATH="$2"; shift 2 ;;
    --silent)  SILENT=true; shift ;;
    -h|--help)
      echo "Usage: uninstall-macos.sh [-p|--path /Applications/Typora.app] [--silent]"
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# --- find Typora.app -------------------------------------------------------
find_typora() {
  local candidates=("/Applications/Typora.app" "$HOME/Applications/Typora.app")
  for c in "${candidates[@]}"; do
    [[ -d "$c" ]] && echo "$c" && return
  done
  return 1
}

if [[ -z "$TYPORA_PATH" ]]; then
  TYPORA_PATH=$(find_typora) || { err "Cannot find Typora.app. Use -p to specify."; exit 1; }
fi

# --- find index.html -------------------------------------------------------
find_html() {
  local candidates=(
    "$TYPORA_PATH/Contents/Resources/TypeMark/index.html"
    "$TYPORA_PATH/Contents/Resources/appsrc/index.html"
    "$TYPORA_PATH/Contents/Resources/app/index.html"
  )
  for c in "${candidates[@]}"; do
    [[ -f "$c" ]] && echo "$c" && return
  done
  return 1
}

HTML_FILE=$(find_html) || { err "Cannot find Typora index.html"; exit 1; }
HTML_DIR="$(dirname "$HTML_FILE")"
info "Found HTML: $HTML_FILE"

# --- restore from backup or remove script tag -------------------------------
BACKUP_FILE="${HTML_FILE}.tpl-backup"
if [[ -f "$BACKUP_FILE" ]]; then
  cp "$BACKUP_FILE" "$HTML_FILE"
  rm "$BACKUP_FILE"
  ok "Restored from backup"
else
  # Remove injected script tag
  SCRIPT_TAG='<script src="./tpl/loader.js" defer></script>'
  if grep -qF "$SCRIPT_TAG" "$HTML_FILE"; then
    sed -i '' "s|${SCRIPT_TAG}||g" "$HTML_FILE"
    ok "Script tag removed"
  else
    info "No injected script tag found"
  fi
fi

# --- remove tpl/ directory --------------------------------------------------
TPL_DIR="$HTML_DIR/tpl"
if [[ -d "$TPL_DIR" ]]; then
  rm -rf "$TPL_DIR"
  ok "Removed $TPL_DIR"
fi

echo ""
ok "typora-plugin-lite uninstalled successfully!"
info "Restart Typora to complete."
echo ""
