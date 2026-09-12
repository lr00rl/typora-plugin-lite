# Shared installer helpers. Sourced by install-macos.sh and install-linux.sh.
# Expects: err() from the caller.

overlay_plugin_manifests() {
  local tpl="$1"
  local src="$2"
  local sudo="${3-}"
  [[ -n "$src" && -d "$src" ]] || return 0
  local pd name mf
  for pd in "$src"/*/; do
    [[ -d "$pd" ]] || continue
    name=$(basename "$pd")
    mf="$pd/manifest.json"
    if [[ -f "$mf" ]]; then
      $sudo mkdir -p "$tpl/plugins/$name"
      $sudo cp "$mf" "$tpl/plugins/$name/"
    fi
  done
}

write_builtin_plugins_json() {
  local tpl="$1"
  local src="$2"
  local sudo="${3-}"
  [[ -n "$src" && -d "$src" ]] || return 0
  python3 -c "
import json, os, sys
src = sys.argv[1]
names = [
    name for name in sorted(os.listdir(src))
    if os.path.isfile(os.path.join(src, name, 'manifest.json'))
]
print(json.dumps(names, indent=2))
" "$src" | $sudo tee "$tpl/builtin-plugins.json" >/dev/null
}

assert_installed_plugin_manifests() {
  local plugins_dir="$1"
  [[ -d "$plugins_dir" ]] || return 0
  local pd missing=0
  for pd in "$plugins_dir"/*/; do
    [[ -d "$pd" ]] || continue
    if [[ ! -f "$pd/manifest.json" ]]; then
      err "plugin $(basename "$pd") has no manifest.json"
      missing=1
    fi
  done
  return "$missing"
}

# Write the default theme pack into Typora's official themes folder as the
# real user (never as root). Missing node or a network error is a warning.
seed_theme_pack() {
  local script="$1"
  local as_user="${2-}"
  local node_bin=""
  if [[ -n "$as_user" && "$as_user" != "root" ]]; then
    node_bin=$(sudo -u "$as_user" -H bash -lc 'command -v node' 2>/dev/null || true)
  else
    node_bin=$(command -v node || true)
  fi
  if [[ -z "$node_bin" || ! -f "$script" ]]; then
    warn "theme pack seed skipped (node or seed script missing); plugin will fetch on first launch"
    return 0
  fi
  if [[ -n "$as_user" && "$as_user" != "root" ]]; then
    if sudo -u "$as_user" -H "$node_bin" "$script"; then
      ok "Theme pack seeded into Typora themes folder"
    else
      warn "theme pack seed failed; plugin will fetch on first launch"
    fi
    return 0
  fi
  if "$node_bin" "$script"; then
    ok "Theme pack seeded into Typora themes folder"
  else
    warn "theme pack seed failed; plugin will fetch on first launch"
  fi
}
