#!/bin/bash
set -euo pipefail

# typora-plugin-lite installer for macOS
# Usage:
#   ./install.sh          — Full install (copy files + inject script + codesign)
#   ./install.sh repair   — Re-inject script tag + re-codesign (after Typora update)
#   ./install.sh uninstall — Remove script tag + re-codesign (preserves plugin data)

TYPORA_APP="/Applications/Typora.app"
PLUGINS_DIR="$HOME/Library/Application Support/abnerworks.Typora/plugins"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$(cd "$SCRIPT_DIR/../../dist" 2>/dev/null && pwd || echo "")"

# Resolve where Typora's HTML lives
RESOURCES="$TYPORA_APP/Contents/Resources"
HTML_FILE=""
for candidate in \
  "$RESOURCES/TypeMark/index.html" \
  "$RESOURCES/window.html" \
  "$RESOURCES/app/window.html"; do
  if [[ -f "$candidate" ]]; then
    HTML_FILE="$candidate"
    break
  fi
done

TAG='<script src="file://PLUGINS_DIR/loader.js" type="module"></script>'

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

check_typora() {
  [[ -d "$TYPORA_APP" ]] || die "Typora not found at $TYPORA_APP"
  [[ -n "$HTML_FILE" ]]  || die "Cannot find Typora HTML entry under $RESOURCES"
  green "Found Typora HTML: $HTML_FILE"
}

# Build the actual script tag with resolved path
script_tag() {
  local escaped_dir
  escaped_dir=$(printf '%s' "$PLUGINS_DIR" | sed 's/ /%20/g')
  echo "<script src=\"file://${escaped_dir}/loader.js\" type=\"module\"></script>"
}

inject_script() {
  local tag
  tag=$(script_tag)

  if grep -qF 'typora-plugin-lite' "$HTML_FILE" 2>/dev/null || grep -qF 'loader.js' "$HTML_FILE" 2>/dev/null; then
    yellow "Script tag already present, skipping injection"
    return
  fi

  # Inject before </body>
  sed -i '' "s|</body>|${tag}\n</body>|" "$HTML_FILE"
  green "Injected script tag into $HTML_FILE"
}

remove_script() {
  if grep -qF 'loader.js' "$HTML_FILE" 2>/dev/null; then
    sed -i '' '/loader\.js/d' "$HTML_FILE"
    green "Removed script tag from $HTML_FILE"
  else
    yellow "No script tag found to remove"
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

  mkdir -p "$PLUGINS_DIR"
  mkdir -p "$PLUGINS_DIR/data"

  # Copy core files
  cp "$DIST_DIR/loader.js"     "$PLUGINS_DIR/"
  cp "$DIST_DIR/loader.js.map" "$PLUGINS_DIR/" 2>/dev/null || true
  cp "$DIST_DIR/core.js"       "$PLUGINS_DIR/"
  cp "$DIST_DIR/core.js.map"   "$PLUGINS_DIR/" 2>/dev/null || true

  # Copy plugins
  if [[ -d "$DIST_DIR/plugins" ]]; then
    cp -r "$DIST_DIR/plugins" "$PLUGINS_DIR/"
  fi

  green "Copied dist files to $PLUGINS_DIR"
}

copy_manifests() {
  # Copy manifest.json files from source plugin dirs
  local SRC_PLUGINS="$SCRIPT_DIR/../../plugins"
  if [[ -d "$SRC_PLUGINS" ]]; then
    for plugin_dir in "$SRC_PLUGINS"/*/; do
      local plugin_name
      plugin_name=$(basename "$plugin_dir")
      local manifest="$plugin_dir/manifest.json"
      if [[ -f "$manifest" ]]; then
        mkdir -p "$PLUGINS_DIR/plugins/$plugin_name"
        cp "$manifest" "$PLUGINS_DIR/plugins/$plugin_name/"
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
}

cmd_repair() {
  green "=== typora-plugin-lite repair ==="
  check_typora
  inject_script
  codesign_app
  green "=== Repair complete ==="
}

cmd_uninstall() {
  green "=== typora-plugin-lite uninstall ==="
  check_typora
  remove_script
  codesign_app
  green "=== Uninstall complete ==="
  echo "Plugin data preserved at: $PLUGINS_DIR"
  echo "To fully remove, run: rm -rf \"$PLUGINS_DIR\""
}

# --- Main ---

case "${1:-install}" in
  install)   cmd_install ;;
  repair)    cmd_repair ;;
  uninstall) cmd_uninstall ;;
  *)         die "Unknown command: $1. Use: install, repair, or uninstall" ;;
esac
