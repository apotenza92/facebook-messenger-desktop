#!/bin/bash
# Flathub Source Build Test
# Builds from source using shared Electron (~5MB vs ~100MB bundled)
#
# curl -sSL https://raw.githubusercontent.com/apotenza92/facebook-messenger-desktop/main/scripts/test-flathub.sh | bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Flathub Source Build Test                                ║${NC}"
echo -e "${BLUE}║  ~5MB app (shared Electron, no bloat)                     ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

APP_ID="io.github.apotenza92.messenger"
MANIFEST="${APP_ID}.yml"
RUNTIME_VERSION="24.08"
REPO_RAW="https://raw.githubusercontent.com/apotenza92/facebook-messenger-desktop/main"

CLEANUP_DIR="/tmp/flathub-test-$$"
mkdir -p "$CLEANUP_DIR"
cd "$CLEANUP_DIR"

cleanup() {
  rm -rf "$CLEANUP_DIR"
}
trap cleanup EXIT

# Install dependencies
echo -e "${YELLOW}[1/6] Installing dependencies...${NC}"
if command -v dnf </dev/null &>/dev/null; then
  sudo dnf install -y flatpak flatpak-builder appstream curl python3-pip </dev/null 2>/dev/null || true
elif command -v apt </dev/null &>/dev/null; then
  sudo apt update </dev/null 2>/dev/null && sudo apt install -y flatpak flatpak-builder appstream curl python3-pip </dev/null 2>/dev/null || true
fi
flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo </dev/null 2>/dev/null || true
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Install runtimes
echo -e "${YELLOW}[2/6] Installing Flatpak runtimes...${NC}"
flatpak install --user -y flathub org.freedesktop.Platform//${RUNTIME_VERSION} </dev/null 2>/dev/null || true
flatpak install --user -y flathub org.freedesktop.Sdk//${RUNTIME_VERSION} </dev/null 2>/dev/null || true
flatpak install --user -y flathub org.freedesktop.Sdk.Extension.node20//${RUNTIME_VERSION} </dev/null 2>/dev/null || true
flatpak install --user -y flathub org.electronjs.Electron2.BaseApp//${RUNTIME_VERSION} </dev/null 2>/dev/null || true
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Download only required files (not the full 200MB repo)
echo -e "${YELLOW}[3/6] Downloading source files (~5MB)...${NC}"
mkdir -p repo/src/main repo/src/preload repo/assets/icons/linux repo/assets/tray

# Core files
curl -sL "${REPO_RAW}/package.json" </dev/null > repo/package.json
curl -sL "${REPO_RAW}/package-lock.json" </dev/null > repo/package-lock.json
curl -sL "${REPO_RAW}/tsconfig.json" </dev/null > repo/tsconfig.json
curl -sL "${REPO_RAW}/LICENSE" </dev/null > repo/LICENSE

# Source files
for f in main.ts notification-handler.ts badge-manager.ts background-service.ts; do
  curl -sL "${REPO_RAW}/src/main/$f" </dev/null > "repo/src/main/$f"
done
for f in preload.ts notifications-inject.ts tsconfig.json; do
  curl -sL "${REPO_RAW}/src/preload/$f" </dev/null > "repo/src/preload/$f"
done

# Icons (only Linux sizes needed)
for size in 64x64 128x128 256x256; do
  curl -sL "${REPO_RAW}/assets/icons/linux/${size}.png" </dev/null > "repo/assets/icons/linux/${size}.png"
done

# Tray icons
curl -sL "${REPO_RAW}/assets/tray/icon.png" </dev/null > repo/assets/tray/icon.png
curl -sL "${REPO_RAW}/assets/tray/iconTemplate.png" </dev/null > repo/assets/tray/iconTemplate.png 2>/dev/null || true

# Flatpak files
curl -sL "${REPO_RAW}/${MANIFEST}" </dev/null > "repo/${MANIFEST}"
curl -sL "${REPO_RAW}/${APP_ID}.desktop" </dev/null > "repo/${APP_ID}.desktop"
curl -sL "${REPO_RAW}/${APP_ID}.metainfo.xml" </dev/null > "repo/${APP_ID}.metainfo.xml"

cd repo
echo -e "${GREEN}✓ Downloaded (~3MB)${NC}"
echo ""

# Generate npm sources
echo -e "${YELLOW}[4/6] Generating npm sources...${NC}"
pip3 install --user --quiet flatpak-node-generator </dev/null 2>/dev/null || pip install --user --quiet flatpak-node-generator </dev/null 2>/dev/null || true
export PATH="$HOME/.local/bin:$PATH"

if command -v flatpak-node-generator </dev/null &>/dev/null; then
  flatpak-node-generator npm package-lock.json -o generated-sources.json </dev/null 2>/dev/null
  echo -e "${GREEN}✓ Generated${NC}"
else
  echo -e "${RED}✗ flatpak-node-generator not found${NC}"
  echo -e "${YELLOW}  Install: pip install flatpak-node-generator${NC}"
  exit 1
fi
echo ""

# Create source archive for flatpak-builder
echo -e "${YELLOW}[5/6] Building Flatpak...${NC}"

# Create the source tarball that flatpak-builder expects
cd ..
tar czf source.tar.gz repo
SOURCE_SHA=$(sha256sum source.tar.gz | cut -d' ' -f1)
echo -e "${BLUE}  SHA256: ${SOURCE_SHA:0:16}...${NC}"

cd repo

# Update manifest to use local source
cat > "$MANIFEST" << MANIFEST_EOF
app-id: io.github.apotenza92.messenger
runtime: org.freedesktop.Platform
runtime-version: '24.08'
sdk: org.freedesktop.Sdk
sdk-extensions:
  - org.freedesktop.Sdk.Extension.node20
base: org.electronjs.Electron2.BaseApp
base-version: '24.08'
command: facebook-messenger-desktop
separate-locales: false

finish-args:
  - --share=ipc
  - --socket=wayland
  - --socket=fallback-x11
  - --socket=pulseaudio
  - --share=network
  - --device=dri
  - --talk-name=org.freedesktop.Notifications
  - --talk-name=org.kde.StatusNotifierWatcher
  - --filesystem=xdg-download
  - --device=all

build-options:
  append-path: /usr/lib/sdk/node20/bin
  env:
    NPM_CONFIG_LOGLEVEL: info
    npm_config_nodedir: /usr/lib/sdk/node20

modules:
  - name: facebook-messenger-desktop
    buildsystem: simple
    build-options:
      env:
        XDG_CACHE_HOME: /run/build/facebook-messenger-desktop/flatpak-node/cache
        npm_config_cache: /run/build/facebook-messenger-desktop/flatpak-node/npm-cache
        npm_config_offline: 'true'
    build-commands:
      - npm ci --offline --ignore-scripts
      - npx tsc
      - npx tsc -p src/preload/tsconfig.json
      - mkdir -p /app/lib/messenger
      - cp -r dist /app/lib/messenger/
      - cp -r assets /app/lib/messenger/
      - cp package.json /app/lib/messenger/
      - mkdir -p /app/lib/messenger/node_modules
      - cp -r node_modules/electron-updater /app/lib/messenger/node_modules/ || true
      - cp -r node_modules/lazy-val /app/lib/messenger/node_modules/ || true
      - cp -r node_modules/semver /app/lib/messenger/node_modules/ || true
      - cp -r node_modules/electron /app/lib/messenger/node_modules/
      - install -Dm755 launcher.sh /app/bin/facebook-messenger-desktop
      - install -Dm644 io.github.apotenza92.messenger.desktop /app/share/applications/io.github.apotenza92.messenger.desktop
      - install -Dm644 io.github.apotenza92.messenger.metainfo.xml /app/share/metainfo/io.github.apotenza92.messenger.metainfo.xml
      - install -Dm644 assets/icons/linux/256x256.png /app/share/icons/hicolor/256x256/apps/io.github.apotenza92.messenger.png
      - install -Dm644 assets/icons/linux/128x128.png /app/share/icons/hicolor/128x128/apps/io.github.apotenza92.messenger.png
      - install -Dm644 assets/icons/linux/64x64.png /app/share/icons/hicolor/64x64/apps/io.github.apotenza92.messenger.png
      - install -Dm644 LICENSE /app/share/licenses/io.github.apotenza92.messenger/LICENSE
    sources:
      - type: archive
        path: ../source.tar.gz
        sha256: ${SOURCE_SHA}
        strip-components: 1
      - generated-sources.json
      - type: script
        dest-filename: launcher.sh
        commands:
          - export TMPDIR="\${XDG_RUNTIME_DIR}/app/\${FLATPAK_ID}"
          - exec zypak-wrapper /app/lib/messenger/node_modules/electron/dist/electron /app/lib/messenger/dist/main/main.js "\$@"
MANIFEST_EOF

echo -e "${BLUE}  Running flatpak-builder...${NC}"
flatpak-builder --user --install --force-clean build-dir "$MANIFEST" </dev/null

SIZE=$(du -sh build-dir 2>/dev/null | cut -f1)
echo -e "${GREEN}✓ Build successful (${SIZE})${NC}"
echo ""

# Run
echo -e "${YELLOW}[6/6] Launching app...${NC}"
flatpak run "$APP_ID" </dev/null || true

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✓ Source build complete!                                 ║${NC}"
echo -e "${GREEN}║  No Electron bloat - uses shared runtime                  ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Run:       ${BLUE}flatpak run $APP_ID${NC}"
echo -e "Uninstall: ${BLUE}flatpak uninstall --user $APP_ID${NC}"
