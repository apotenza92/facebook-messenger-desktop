#!/bin/bash
# Flathub Build Test
# Tests the exact build process Flathub will use
#
# Requirements met:
# - Build from source (TypeScript compilation)
# - Runtime 24.08 (not EOL)
# - Offline npm (generated-sources.json)
# - Both architectures (x86_64, aarch64)
# - wayland + fallback-x11 (not both x11 and wayland)
# - Desktop/metainfo in upstream repo
# - License installed to /app/share/licenses/
#
# Usage: ./scripts/test-flatpak.sh

set -e

cd "$(dirname "$0")/.."
APP_ID="io.github.apotenza92.messenger"

echo "=== Flathub Build Test ==="
echo ""

# Check for runtimes
echo "[1/4] Checking runtimes..."
flatpak install --user -y flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 \
  org.freedesktop.Sdk.Extension.node20//24.08 org.electronjs.Electron2.BaseApp//24.08 2>/dev/null || true

# Generate npm sources if needed
echo "[2/4] Generating npm sources..."
if [ ! -f generated-sources.json ]; then
  pip install --user --break-system-packages flatpak-node-generator 2>/dev/null || \
  pip install --user flatpak-node-generator 2>/dev/null || true
  export PATH="$HOME/.local/bin:$PATH"
  flatpak-node-generator npm package-lock.json -o generated-sources.json
fi

# Build
echo "[3/4] Building..."
flatpak-builder --user --install --force-clean \
  --state-dir="$HOME/.cache/flatpak-builder-messenger" \
  build-dir "${APP_ID}.yml"

echo "[4/4] Done!"
echo ""
echo "Run:       flatpak run $APP_ID"
echo "Uninstall: flatpak uninstall --user $APP_ID"
echo "Cleanup:   rm -rf build-dir ~/.cache/flatpak-builder-messenger"
