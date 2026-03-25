#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# typora-plugin-lite · Linux installer
# ============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
err()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)/dist"
TYPORA_PATH=""
SILENT=false

# --- parse arguments -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path) TYPORA_PATH="$2"; shift 2 ;;
    --silent)  SILENT=true; shift ;;
    -h|--help)
      echo "Usage: install-linux.sh [-p|--path /usr/share/typora] [--silent]"
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# --- find Typora ------------------------------------------------------------
find_typora() {
  local candidates=(
    "/usr/share/typora"
    "/usr/local/share/typora"
    "/opt/typora"
    "/opt/Typora"
    "$HOME/.local/share/Typora"
    "$HOME/.local/share/typora"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

if [[ -z "$TYPORA_PATH" ]]; then
  TYPORA_PATH=$(find_typora) || {
    err "Cannot find Typora. Please specify with -p /path/to/typora"
    exit 1
  }
fi

if [[ ! -d "$TYPORA_PATH" ]]; then
  err "Typora path does not exist: $TYPORA_PATH"
  exit 1
fi
info "Found Typora: $TYPORA_PATH"

# --- find window.html -------------------------------------------------------
find_html() {
  local candidates=(
    "$TYPORA_PATH/resources/app/window.html"
    "$TYPORA_PATH/resources/appsrc/window.html"
    "$TYPORA_PATH/resources/window.html"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

HTML_FILE=$(find_html) || {
  err "Cannot find Typora window.html in $TYPORA_PATH"
  exit 1
}
HTML_DIR="$(dirname "$HTML_FILE")"
info "Found HTML: $HTML_FILE"

# --- check dist exists (before modifying anything) --------------------------
if [[ ! -d "$DIST_DIR" ]]; then
  err "dist/ directory not found at $DIST_DIR"
  err "Please run 'pnpm build' first."
  exit 1
fi

# --- check write permissions ------------------------------------------------
if [[ ! -w "$HTML_FILE" ]]; then
  warn "No write permission. Trying with sudo..."
  SUDO="sudo"
else
  SUDO=""
fi

# --- check if already installed ---------------------------------------------
SCRIPT_TAG='<script src="./tpl/loader.js" defer="defer"></script>'
if grep -qF "$SCRIPT_TAG" "$HTML_FILE"; then
  warn "Plugin already installed. Re-installing..."
  $SUDO sed -i "s|${SCRIPT_TAG}||g" "$HTML_FILE"
fi

# --- backup -----------------------------------------------------------------
BACKUP_FILE="${HTML_FILE}.tpl-backup"
if [[ ! -f "$BACKUP_FILE" ]]; then
  $SUDO cp "$HTML_FILE" "$BACKUP_FILE"
  ok "Backup created: $BACKUP_FILE"
else
  info "Backup already exists, skipping"
fi

# --- inject script tag ------------------------------------------------------
# Find the last </script> or </body> and insert after/before it
if grep -q '</body>' "$HTML_FILE"; then
  $SUDO sed -i "s|</body>|${SCRIPT_TAG}\n</body>|" "$HTML_FILE"
elif grep -q '</html>' "$HTML_FILE"; then
  $SUDO sed -i "s|</html>|${SCRIPT_TAG}\n</html>|" "$HTML_FILE"
else
  echo "$SCRIPT_TAG" | $SUDO tee -a "$HTML_FILE" > /dev/null
fi
ok "Script tag injected"

# --- copy dist → tpl/ -------------------------------------------------------
TPL_DIR="$HTML_DIR/tpl"
$SUDO mkdir -p "$TPL_DIR/plugins"

# Clean stale builtin plugins only (preserve user-installed third-party plugins)
MANIFEST="$DIST_DIR/builtin-plugins.json"
if [[ -f "$MANIFEST" ]]; then
  for mf in "$MANIFEST" "$TPL_DIR/builtin-plugins.json"; do
    if [[ -f "$mf" ]]; then
      names=$(python3 -c "import json,sys; [print(n) for n in json.load(open(sys.argv[1]))]" "$mf" 2>/dev/null || true)
      for name in $names; do
        if [[ -d "$TPL_DIR/plugins/$name" ]]; then
          $SUDO rm -rf "$TPL_DIR/plugins/$name"
        fi
      done
    fi
  done
fi

# Copy core files
$SUDO cp "$DIST_DIR/loader.js"     "$TPL_DIR/"
$SUDO cp "$DIST_DIR/loader.js.map" "$TPL_DIR/" 2>/dev/null || true
$SUDO cp "$DIST_DIR/core.js"       "$TPL_DIR/"
$SUDO cp "$DIST_DIR/core.js.map"   "$TPL_DIR/" 2>/dev/null || true
[[ -f "$MANIFEST" ]] && $SUDO cp "$MANIFEST" "$TPL_DIR/"

# Copy plugin bundles
if [[ -d "$DIST_DIR/plugins" ]]; then
  $SUDO cp -R "$DIST_DIR/plugins/"* "$TPL_DIR/plugins/" 2>/dev/null || true
fi
ok "Plugin files copied to $TPL_DIR"

# --- done -------------------------------------------------------------------
echo ""
ok "typora-plugin-lite installed successfully!"
info "Restart Typora to activate plugins."
echo ""
