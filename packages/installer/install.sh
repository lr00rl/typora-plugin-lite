#!/bin/bash
set -euo pipefail

# typora-plugin-lite installer for macOS
# Strategy: copy files INTO Typora's TypeMark directory (like typora-copilot),
# use relative path <script src="./tpl/loader.js"> so WKWebView trusts it.
#
# Usage:
#   ./install.sh          — Full install (copy files + inject script + codesign)
#   ./install.sh repair   — Re-inject script tag + re-codesign (after Typora update)
#   ./install.sh uninstall — Remove script tag + tpl dir + re-codesign

TYPORA_APP="/Applications/Typora.app"
DATA_DIR="$HOME/Library/Application Support/abnerworks.Typora/plugins"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$(cd "$SCRIPT_DIR/../../dist" 2>/dev/null && pwd || echo "")"

# Resolve where Typora's HTML lives
RESOURCES="$TYPORA_APP/Contents/Resources"
HTML_DIR=""
HTML_FILE=""
for candidate in \
  "$RESOURCES/TypeMark" \
  "$RESOURCES/app" \
  "$RESOURCES/appsrc"; do
  if [[ -f "$candidate/index.html" ]]; then
    HTML_DIR="$candidate"
    HTML_FILE="$candidate/index.html"
    break
  fi
done

# Script tag to insert (relative path — critical for WKWebView)
SCRIPT_TAG='<script src="./tpl/loader.js" defer></script>'
# Anchor: insert after Typora's own main.js script
ANCHOR_CANDIDATES=(
  '<script src="./appsrc/main.js" defer></script>'
  '<script src="./appsrc/main.js" aria-hidden="true" defer></script>'
  '<script src="./app/main.js" defer></script>'
  '<script src="./app/main.js" aria-hidden="true" defer></script>'
)

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }
die()   { red "ERROR: $*" >&2; exit 1; }

check_typora() {
  [[ -d "$TYPORA_APP" ]] || die "Typora not found at $TYPORA_APP"
  [[ -n "$HTML_FILE" ]]  || die "Cannot find Typora HTML entry under $RESOURCES"
  green "Found Typora HTML: $HTML_FILE"
}

inject_script() {
  if grep -qF 'tpl/loader.js' "$HTML_FILE" 2>/dev/null; then
    yellow "Script tag already present, skipping injection"
    return
  fi

  # Try inserting after Typora's main.js (like typora-copilot does)
  local injected=false
  for anchor in "${ANCHOR_CANDIDATES[@]}"; do
    if grep -qF "$anchor" "$HTML_FILE" 2>/dev/null; then
      # Escape for sed
      local esc_anchor esc_tag
      esc_anchor=$(printf '%s' "$anchor" | sed 's/[&/\]/\\&/g')
      esc_tag=$(printf '%s' "$SCRIPT_TAG" | sed 's/[&/\]/\\&/g')
      sed -i '' "s|${esc_anchor}|${esc_anchor}\n\t${esc_tag}|" "$HTML_FILE"
      green "Injected script tag after: $anchor"
      injected=true
      break
    fi
  done

  if [[ "$injected" != true ]]; then
    # Fallback: inject before </body>
    sed -i '' "s|</body>|${SCRIPT_TAG}\n</body>|" "$HTML_FILE"
    green "Injected script tag before </body> (fallback)"
  fi
}

remove_script() {
  if grep -qF 'tpl/loader.js' "$HTML_FILE" 2>/dev/null; then
    sed -i '' '/tpl\/loader\.js/d' "$HTML_FILE"
    green "Removed script tag from $HTML_FILE"
  else
    yellow "No tpl script tag found to remove"
  fi
}

codesign_app() {
  yellow "Re-signing Typora.app (ad-hoc)..."
  codesign -f -s - "$TYPORA_APP" 2>/dev/null && \
    xattr -cr "$TYPORA_APP" 2>/dev/null
  green "Typora re-signed successfully"
}

copy_dist() {
  if [[ -z "$DIST_DIR" ]] || [[ ! -d "$DIST_DIR" ]]; then
    die "dist/ not found. Run 'pnpm build' first."
  fi

  local TPL_DIR="$HTML_DIR/tpl"
  mkdir -p "$TPL_DIR/plugins"

  # Copy core files into Typora's TypeMark/tpl/
  cp "$DIST_DIR/loader.js"     "$TPL_DIR/"
  cp "$DIST_DIR/loader.js.map" "$TPL_DIR/" 2>/dev/null || true
  cp "$DIST_DIR/core.js"       "$TPL_DIR/"
  cp "$DIST_DIR/core.js.map"   "$TPL_DIR/" 2>/dev/null || true

  # Copy plugin main.js files
  if [[ -d "$DIST_DIR/plugins" ]]; then
    cp -r "$DIST_DIR/plugins/"* "$TPL_DIR/plugins/" 2>/dev/null || true
  fi

  green "Copied dist files to $TPL_DIR"

  # Also create data dir in user space (for settings, caches — survives updates)
  mkdir -p "$DATA_DIR/data"
  green "Data directory: $DATA_DIR/data"
}

copy_manifests() {
  local TPL_DIR="$HTML_DIR/tpl"
  local SRC_PLUGINS="$SCRIPT_DIR/../../plugins"
  if [[ -d "$SRC_PLUGINS" ]]; then
    for plugin_dir in "$SRC_PLUGINS"/*/; do
      local plugin_name
      plugin_name=$(basename "$plugin_dir")
      local manifest="$plugin_dir/manifest.json"
      if [[ -f "$manifest" ]]; then
        mkdir -p "$TPL_DIR/plugins/$plugin_name"
        cp "$manifest" "$TPL_DIR/plugins/$plugin_name/"
      fi
    done
    green "Copied plugin manifests"
  fi
}

# --- Commands ---

cmd_install() {
  green "=== typora-plugin-lite installer ==="
  check_typora
  copy_dist
  copy_manifests
  inject_script
  codesign_app
  green "=== Installation complete ==="
  echo "Restart Typora to activate plugins."
  echo ""
  echo "Runtime files: $HTML_DIR/tpl/"
  echo "Plugin data:   $DATA_DIR/data/"
}

cmd_repair() {
  green "=== typora-plugin-lite repair ==="
  check_typora
  copy_dist
  copy_manifests
  inject_script
  codesign_app
  green "=== Repair complete ==="
}

cmd_uninstall() {
  green "=== typora-plugin-lite uninstall ==="
  check_typora
  remove_script
  # Remove tpl directory from TypeMark
  if [[ -d "$HTML_DIR/tpl" ]]; then
    rm -rf "$HTML_DIR/tpl"
    green "Removed $HTML_DIR/tpl/"
  fi
  codesign_app
  green "=== Uninstall complete ==="
  echo "Plugin data preserved at: $DATA_DIR"
  echo "To fully remove data, run: rm -rf \"$DATA_DIR\""
}

# --- Main ---

case "${1:-install}" in
  install)   cmd_install ;;
  repair)    cmd_repair ;;
  uninstall) cmd_uninstall ;;
  *)         die "Unknown command: $1. Use: install, repair, or uninstall" ;;
esac
