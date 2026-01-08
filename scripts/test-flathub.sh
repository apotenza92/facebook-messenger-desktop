#!/bin/bash
# Flathub Submission Test Script
# Based on https://docs.flathub.org/docs/for-app-authors/requirements (2025/2026)
#
# Run from anywhere:
#   curl -sSL https://raw.githubusercontent.com/apotenza92/facebook-messenger-desktop/main/scripts/test-flathub.sh | bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Flathub Test: io.github.apotenza92.messenger             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

APP_ID="io.github.apotenza92.messenger"
MANIFEST="${APP_ID}.yml"
METAINFO="${APP_ID}.metainfo.xml"
DESKTOP="${APP_ID}.desktop"
RUNTIME_VERSION="24.08"
REPO_RAW="https://raw.githubusercontent.com/apotenza92/facebook-messenger-desktop/main"

# Detect if running from repo or standalone
if [ -f "$MANIFEST" ] && [ -f "$METAINFO" ]; then
  echo -e "${BLUE}Running from repository${NC}"
  WORK_DIR=$(pwd)
  CLEANUP_DIR=""
else
  echo -e "${BLUE}Downloading files...${NC}"
  CLEANUP_DIR="/tmp/flathub-test-$$"
  WORK_DIR="$CLEANUP_DIR"
  mkdir -p "$WORK_DIR"
  cd "$WORK_DIR"
  curl -sSLO "$REPO_RAW/$MANIFEST"
  curl -sSLO "$REPO_RAW/$METAINFO"
  curl -sSLO "$REPO_RAW/$DESKTOP"
  # Try to get generated-sources.json if it exists
  curl -sSLO "$REPO_RAW/generated-sources.json" 2>/dev/null || true
  echo -e "${GREEN}✓ Done${NC}"
fi
echo ""

cleanup() {
  [ -n "$CLEANUP_DIR" ] && rm -rf "$CLEANUP_DIR"
}
trap cleanup EXIT

# Check if source build is possible (generated-sources.json exists)
if [ -f "generated-sources.json" ]; then
  BUILD_MODE="source"
  echo -e "${GREEN}✓ Source build mode (recommended for Flathub)${NC}"
else
  BUILD_MODE="appimage"
  echo -e "${YELLOW}⚠ AppImage mode (for testing only)${NC}"
  echo -e "${YELLOW}  For Flathub submission, run: ./scripts/generate-flatpak-sources.sh${NC}"
fi
echo ""

# Install dependencies
echo -e "${YELLOW}[1/5] Installing dependencies...${NC}"
if command -v dnf &> /dev/null; then
  sudo dnf install -y flatpak flatpak-builder appstream curl 2>/dev/null || true
elif command -v apt &> /dev/null; then
  sudo apt update && sudo apt install -y flatpak flatpak-builder appstream curl 2>/dev/null || true
elif command -v pacman &> /dev/null; then
  sudo pacman -Sy --noconfirm flatpak flatpak-builder appstream curl 2>/dev/null || true
fi
flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo 2>/dev/null || true
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Install runtimes
echo -e "${YELLOW}[2/5] Installing Flatpak runtimes...${NC}"
flatpak install --user -y flathub org.freedesktop.Platform//${RUNTIME_VERSION} 2>/dev/null || true
flatpak install --user -y flathub org.freedesktop.Sdk//${RUNTIME_VERSION} 2>/dev/null || true
flatpak install --user -y flathub org.electronjs.Electron2.BaseApp//${RUNTIME_VERSION} 2>/dev/null || true
if [ "$BUILD_MODE" = "source" ]; then
  flatpak install --user -y flathub org.freedesktop.Sdk.Extension.node20//${RUNTIME_VERSION} 2>/dev/null || true
fi
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Validate metainfo
echo -e "${YELLOW}[3/5] Validating metainfo...${NC}"
if command -v appstreamcli &> /dev/null; then
  appstreamcli validate "$METAINFO" || true
fi
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Prepare manifest
echo -e "${YELLOW}[4/5] Building Flatpak ($BUILD_MODE mode)...${NC}"

LATEST_TAG=$(curl -sL "https://api.github.com/repos/apotenza92/facebook-messenger-desktop/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
[ -z "$LATEST_TAG" ] && LATEST_TAG="v0.9.1"
echo -e "${BLUE}  Release: $LATEST_TAG${NC}"

if [ "$BUILD_MODE" = "appimage" ]; then
  # Create AppImage-based manifest for testing
  cat > "$MANIFEST" << 'MANIFEST_EOF'
app-id: io.github.apotenza92.messenger
runtime: org.freedesktop.Platform
runtime-version: '24.08'
sdk: org.freedesktop.Sdk
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
modules:
  - name: facebook-messenger-desktop
    buildsystem: simple
    build-commands:
      - chmod +x facebook-messenger-desktop.AppImage
      - ./facebook-messenger-desktop.AppImage --appimage-extract
      - mkdir -p /app/messenger
      - cp -r squashfs-root/* /app/messenger/
      - install -Dm755 launcher.sh /app/bin/facebook-messenger-desktop
      - install -Dm644 io.github.apotenza92.messenger.desktop /app/share/applications/io.github.apotenza92.messenger.desktop
      - install -Dm644 io.github.apotenza92.messenger.metainfo.xml /app/share/metainfo/io.github.apotenza92.messenger.metainfo.xml
      - install -Dm644 squashfs-root/usr/share/icons/hicolor/256x256/apps/facebook-messenger-desktop.png /app/share/icons/hicolor/256x256/apps/io.github.apotenza92.messenger.png
      - install -Dm644 squashfs-root/usr/share/icons/hicolor/128x128/apps/facebook-messenger-desktop.png /app/share/icons/hicolor/128x128/apps/io.github.apotenza92.messenger.png  
      - install -Dm644 squashfs-root/usr/share/icons/hicolor/64x64/apps/facebook-messenger-desktop.png /app/share/icons/hicolor/64x64/apps/io.github.apotenza92.messenger.png
    sources:
      - type: file
        only-arches: [x86_64]
        url: APPIMAGE_X64_URL
        sha256: APPIMAGE_X64_SHA
        dest-filename: facebook-messenger-desktop.AppImage
      - type: file
        only-arches: [aarch64]
        url: APPIMAGE_ARM64_URL
        sha256: APPIMAGE_ARM64_SHA
        dest-filename: facebook-messenger-desktop.AppImage
      - type: file
        path: io.github.apotenza92.messenger.desktop
      - type: file
        path: io.github.apotenza92.messenger.metainfo.xml
      - type: script
        dest-filename: launcher.sh
        commands:
          - export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
          - exec zypak-wrapper /app/messenger/facebook-messenger-desktop "$@"
MANIFEST_EOF

  # Fill in URLs and hashes
  X64_URL="https://github.com/apotenza92/facebook-messenger-desktop/releases/download/${LATEST_TAG}/facebook-messenger-desktop-x86_64.AppImage"
  ARM64_URL="https://github.com/apotenza92/facebook-messenger-desktop/releases/download/${LATEST_TAG}/facebook-messenger-desktop-arm64.AppImage"
  
  echo -e "${BLUE}  Fetching SHA256 hashes...${NC}"
  X64_SHA=$(curl -sL "$X64_URL" | sha256sum | cut -d' ' -f1)
  ARM64_SHA=$(curl -sL "$ARM64_URL" | sha256sum | cut -d' ' -f1)
  
  sed -i "s|APPIMAGE_X64_URL|$X64_URL|g" "$MANIFEST"
  sed -i "s|APPIMAGE_ARM64_URL|$ARM64_URL|g" "$MANIFEST"
  sed -i "s|APPIMAGE_X64_SHA|$X64_SHA|g" "$MANIFEST"
  sed -i "s|APPIMAGE_ARM64_SHA|$ARM64_SHA|g" "$MANIFEST"
  
else
  # Source build - update placeholders
  SOURCE_URL="https://github.com/apotenza92/facebook-messenger-desktop/archive/refs/tags/${LATEST_TAG}.tar.gz"
  SOURCE_SHA=$(curl -sL "$SOURCE_URL" | sha256sum | cut -d' ' -f1)
  sed -i "s|REPLACE_WITH_SOURCE_SHA256|$SOURCE_SHA|g" "$MANIFEST"
  sed -i "s|v0.9.1|${LATEST_TAG}|g" "$MANIFEST"
fi

echo -e "${BLUE}  Running flatpak-builder...${NC}"
rm -rf build-dir .flatpak-builder 2>/dev/null || true
flatpak-builder --user --install --force-clean build-dir "$MANIFEST"

SIZE=$(du -sh build-dir 2>/dev/null | cut -f1)
echo -e "${GREEN}✓ Build successful (${SIZE})${NC}"
echo ""

# Run
echo -e "${YELLOW}[5/5] Launching app...${NC}"
flatpak run "$APP_ID" || true

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✓ Test complete!                                         ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Run again:  ${BLUE}flatpak run $APP_ID${NC}"
echo -e "Uninstall:  ${BLUE}flatpak uninstall --user $APP_ID${NC}"

if [ "$BUILD_MODE" = "appimage" ]; then
  echo ""
  echo -e "${YELLOW}Note: This was a test build using AppImage.${NC}"
  echo -e "${YELLOW}For Flathub submission, generate source build:${NC}"
  echo -e "  ${BLUE}pip install flatpak-node-generator${NC}"
  echo -e "  ${BLUE}flatpak-node-generator npm package-lock.json${NC}"
  echo -e "  ${BLUE}git add generated-sources.json && git commit && git push${NC}"
fi
