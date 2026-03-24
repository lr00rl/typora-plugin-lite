#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# typora-plugin-lite · macOS installer
# Supports: install (default), repair, uninstall
# ============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
err()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$(cd "$INSTALLER_DIR/../../dist" 2>/dev/null && pwd || echo "")"
PLUGINS_SRC="$(cd "$INSTALLER_DIR/../../plugins" 2>/dev/null && pwd || echo "")"
DATA_DIR="$HOME/Library/Application Support/abnerworks.Typora/plugins"

TYPORA_PATH=""
COMMAND="install"
SILENT=false

# --- parse arguments -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path)   TYPORA_PATH="$2"; shift 2 ;;
    --silent)    SILENT=true; shift ;;
    install|repair|uninstall) COMMAND="$1"; shift ;;
    -h|--help)
      echo "Usage: install-macos.sh [install|repair|uninstall] [-p /Applications/Typora.app] [--silent]"
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# --- find Typora.app -------------------------------------------------------
find_typora() {
  local candidates=(
    "/Applications/Typora.app"
    "$HOME/Applications/Typora.app"
  )
  for c in "${candidates[@]}"; do
    [[ -d "$c" ]] && echo "$c" && return
  done
  return 1
}

if [[ -z "$TYPORA_PATH" ]]; then
  TYPORA_PATH=$(find_typora) || {
    err "Cannot find Typora.app. Please specify with -p /path/to/Typora.app"
    exit 1
  }
fi
[[ -d "$TYPORA_PATH" ]] || { err "Path does not exist: $TYPORA_PATH"; exit 1; }
info "Found Typora: $TYPORA_PATH"

# --- find index.html -------------------------------------------------------
RESOURCES="$TYPORA_PATH/Contents/Resources"
HTML_DIR="" ; HTML_FILE=""
for candidate in "$RESOURCES/TypeMark" "$RESOURCES/appsrc" "$RESOURCES/app"; do
  if [[ -f "$candidate/index.html" ]]; then
    HTML_DIR="$candidate"
    HTML_FILE="$candidate/index.html"
    break
  fi
done
[[ -n "$HTML_FILE" ]] || { err "Cannot find Typora index.html under $RESOURCES"; exit 1; }
info "Found HTML: $HTML_FILE"

# --- script tag & anchor candidates ----------------------------------------
SCRIPT_TAG='<script src="./tpl/loader.js" defer></script>'
ANCHOR_CANDIDATES=(
  '<script src="./appsrc/main.js" defer></script>'
  '<script src="./appsrc/main.js" aria-hidden="true" defer></script>'
  '<script src="./app/main.js" defer></script>'
  '<script src="./app/main.js" aria-hidden="true" defer></script>'
)

# --- helpers ----------------------------------------------------------------
inject_script() {
  if grep -qF 'tpl/loader.js' "$HTML_FILE" 2>/dev/null; then
    info "Script tag already present, skipping injection"
    return
  fi

  # Try anchor-based injection (after Typora's main.js)
  local injected=false
  for anchor in "${ANCHOR_CANDIDATES[@]}"; do
    if grep -qF "$anchor" "$HTML_FILE" 2>/dev/null; then
      local esc_anchor esc_tag
      esc_anchor=$(printf '%s' "$anchor" | sed 's/[&/\]/\\&/g')
      esc_tag=$(printf '%s' "$SCRIPT_TAG" | sed 's/[&/\]/\\&/g')
      sed -i '' "s|${esc_anchor}|${esc_anchor}\n\t${esc_tag}|" "$HTML_FILE"
      ok "Injected script tag after: $anchor"
      injected=true
      break
    fi
  done

  if [[ "$injected" != true ]]; then
    sed -i '' "s|</body>|${SCRIPT_TAG}\n</body>|" "$HTML_FILE"
    ok "Injected script tag before </body> (fallback)"
  fi
}

remove_script() {
  if grep -qF 'tpl/loader.js' "$HTML_FILE" 2>/dev/null; then
    sed -i '' '/tpl\/loader\.js/d' "$HTML_FILE"
    ok "Removed script tag"
  else
    info "No script tag to remove"
  fi
}

backup_html() {
  local backup="${HTML_FILE}.tpl-backup"
  if [[ ! -f "$backup" ]]; then
    cp "$HTML_FILE" "$backup"
    ok "Backup created: $backup"
  else
    info "Backup already exists"
  fi
}

codesign_app() {
  info "Re-signing Typora.app (ad-hoc)..."
  codesign -f -s - "$TYPORA_PATH" 2>/dev/null || true
  xattr -cr "$TYPORA_PATH" 2>/dev/null || true
  ok "Typora re-signed"
}

copy_dist() {
  if [[ -z "$DIST_DIR" ]] || [[ ! -d "$DIST_DIR" ]]; then
    err "dist/ not found. Run 'pnpm build' first."
    exit 1
  fi

  local tpl="$HTML_DIR/tpl"
  mkdir -p "$tpl/plugins"

  # Clean stale builtin plugins (preserve user-installed third-party plugins)
  local manifest="$DIST_DIR/builtin-plugins.json"
  if [[ -f "$manifest" ]]; then
    # Also clean plugins listed in the OLD manifest (handles renames/removals)
    local old_manifest="$tpl/builtin-plugins.json"
    for mf in "$manifest" "$old_manifest"; do
      if [[ -f "$mf" ]]; then
        # Parse JSON array: ["foo","bar"] → foo bar
        local names
        names=$(python3 -c "import json,sys; [print(n) for n in json.load(open(sys.argv[1]))]" "$mf" 2>/dev/null || true)
        for name in $names; do
          if [[ -d "$tpl/plugins/$name" ]]; then
            rm -rf "$tpl/plugins/$name"
          fi
        done
      fi
    done
  fi

  # Copy core files
  cp "$DIST_DIR/loader.js"     "$tpl/"
  cp "$DIST_DIR/loader.js.map" "$tpl/" 2>/dev/null || true
  cp "$DIST_DIR/core.js"       "$tpl/"
  cp "$DIST_DIR/core.js.map"   "$tpl/" 2>/dev/null || true

  # Copy builtin-plugins.json for next upgrade's cleanup
  if [[ -f "$manifest" ]]; then
    cp "$manifest" "$tpl/"
  fi

  # Copy plugin bundles
  if [[ -d "$DIST_DIR/plugins" ]]; then
    cp -R "$DIST_DIR/plugins/"* "$tpl/plugins/" 2>/dev/null || true
  fi

  # Copy manifest files from source plugins
  if [[ -n "$PLUGINS_SRC" ]] && [[ -d "$PLUGINS_SRC" ]]; then
    for pd in "$PLUGINS_SRC"/*/; do
      local name; name=$(basename "$pd")
      local mf="$pd/manifest.json"
      if [[ -f "$mf" ]]; then
        mkdir -p "$tpl/plugins/$name"
        cp "$mf" "$tpl/plugins/$name/"
      fi
    done
  fi

  ok "Plugin files copied to $tpl"

  mkdir -p "$DATA_DIR/data"
  ok "Data directory: $DATA_DIR/data"
}

# --- commands ---------------------------------------------------------------
cmd_install() {
  ok "=== typora-plugin-lite · macOS install ==="
  backup_html
  copy_dist
  inject_script
  codesign_app
  echo ""
  ok "Installation complete! Restart Typora to activate."
  info "Runtime: $HTML_DIR/tpl/"
  info "Data:    $DATA_DIR/data/"
}

cmd_repair() {
  ok "=== typora-plugin-lite · macOS repair ==="
  copy_dist
  inject_script
  codesign_app
  ok "Repair complete!"
}

cmd_uninstall() {
  ok "=== typora-plugin-lite · macOS uninstall ==="
  remove_script
  if [[ -d "$HTML_DIR/tpl" ]]; then
    rm -rf "$HTML_DIR/tpl"
    ok "Removed $HTML_DIR/tpl/"
  fi
  codesign_app
  echo ""
  ok "Uninstall complete!"
  info "Data preserved at: $DATA_DIR"
  info "To fully remove: rm -rf \"$DATA_DIR\""
}

# --- dispatch ---------------------------------------------------------------
case "$COMMAND" in
  install)   cmd_install ;;
  repair)    cmd_repair ;;
  uninstall) cmd_uninstall ;;
  *) err "Unknown command: $COMMAND"; exit 1 ;;
esac
