#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# typora-plugin-lite · Cross-platform installer dispatcher
#
# Usage:
#   ./install.sh                    — Auto-detect OS and install
#   ./install.sh repair             — Re-inject after Typora update (macOS)
#   ./install.sh uninstall          — Remove plugin
#   ./install.sh -p /path/to/typora — Specify custom Typora path
#
# One-liner:
#   curl -fsSL <url>/install.sh | bash
#   wget -qO-  <url>/install.sh | bash
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- detect OS ---------------------------------------------------------------
detect_os() {
  case "$OSTYPE" in
    darwin*)    echo "macos" ;;
    linux-gnu*) echo "linux" ;;
    msys*|cygwin*|win32*) echo "windows" ;;
    *)          echo "unknown" ;;
  esac
}

OS=$(detect_os)

case "$OS" in
  macos)
    exec bash "$SCRIPT_DIR/bin/install-macos.sh" "$@"
    ;;
  linux)
    exec bash "$SCRIPT_DIR/bin/install-linux.sh" "$@"
    ;;
  windows)
    echo "[error] For Windows, use PowerShell:"
    echo "  powershell -ExecutionPolicy Bypass -File packages/installer/bin/install-windows.ps1"
    exit 1
    ;;
  *)
    echo "[error] Unsupported OS: $OSTYPE"
    echo "Supported: macOS, Linux, Windows (PowerShell)"
    exit 1
    ;;
esac
