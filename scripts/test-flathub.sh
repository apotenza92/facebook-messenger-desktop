#!/bin/bash
# Flathub Submission Test Script
# Based on https://docs.flathub.org/docs/for-app-authors/requirements
#
# Run from anywhere:
#   curl -sSL https://raw.githubusercontent.com/apotenza92/facebook-messenger-desktop/main/scripts/test-flathub.sh | bash
#
# Or from cloned repo:
#   ./scripts/test-flathub.sh

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
RUNTIME_VERSION="24.08"

# Detect if running from repo or standalone
if [ -f "$MANIFEST" ]; then
  echo -e "${BLUE}Running from repository${NC}"
  PROJECT_ROOT=$(pwd)
  CLEANUP_DIR=""
else
  echo -e "${BLUE}Cloning repository...${NC}"
  CLEANUP_DIR="/tmp/flathub-test-$$"
  mkdir -p "$CLEANUP_DIR"
  cd "$CLEANUP_DIR"
  git clone --depth 1 https://github.com/apotenza92/facebook-messenger-desktop.git repo
  cd repo
  PROJECT_ROOT=$(pwd)
fi
echo ""

cleanup() {
  [ -n "$CLEANUP_DIR" ] && rm -rf "$CLEANUP_DIR"
}
trap cleanup EXIT

# Install dependencies
echo -e "${YELLOW}[1/5] Installing dependencies...${NC}"
if command -v dnf &> /dev/null; then
  sudo dnf install -y flatpak flatpak-builder appstream git curl 2>/dev/null || true
elif command -v apt &> /dev/null; then
  sudo apt update && sudo apt install -y flatpak flatpak-builder appstream git curl 2>/dev/null || true
elif command -v pacman &> /dev/null; then
  sudo pacman -Sy --noconfirm flatpak flatpak-builder appstream git curl 2>/dev/null || true
fi
flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo 2>/dev/null || true
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Install runtimes
echo -e "${YELLOW}[2/5] Installing Flatpak runtimes...${NC}"
flatpak install --user -y flathub org.freedesktop.Platform//${RUNTIME_VERSION} 2>/dev/null || true
flatpak install --user -y flathub org.freedesktop.Sdk//${RUNTIME_VERSION} 2>/dev/null || true
flatpak install --user -y flathub org.electronjs.Electron2.BaseApp//${RUNTIME_VERSION} 2>/dev/null || true
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Validate metainfo
echo -e "${YELLOW}[3/5] Validating metainfo...${NC}"
if command -v appstreamcli &> /dev/null; then
  appstreamcli validate "${APP_ID}.metainfo.xml" || true
fi
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Update placeholders and build
echo -e "${YELLOW}[4/5] Building Flatpak...${NC}"

LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.9.1")
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")

# Fetch SHA256 for AppImages if placeholders exist
if grep -q "REPLACE_WITH" "$MANIFEST"; then
  echo -e "${BLUE}  Fetching SHA256 hashes for AppImages...${NC}"
  
  X64_URL="https://github.com/apotenza92/facebook-messenger-desktop/releases/download/${LATEST_TAG}/facebook-messenger-desktop-x86_64.AppImage"
  ARM64_URL="https://github.com/apotenza92/facebook-messenger-desktop/releases/download/${LATEST_TAG}/facebook-messenger-desktop-arm64.AppImage"
  
  X64_SHA=$(curl -sL "$X64_URL" | sha256sum | cut -d' ' -f1)
  ARM64_SHA=$(curl -sL "$ARM64_URL" | sha256sum | cut -d' ' -f1)
  
  echo -e "${BLUE}  x86_64:  $X64_SHA${NC}"
  echo -e "${BLUE}  aarch64: $ARM64_SHA${NC}"
  
  # Update manifest
  sed -i "s|REPLACE_WITH_X64_SHA256|$X64_SHA|g" "$MANIFEST"
  sed -i "s|REPLACE_WITH_ARM64_SHA256|$ARM64_SHA|g" "$MANIFEST"
  sed -i "s|REPLACE_WITH_COMMIT|$COMMIT|g" "$MANIFEST"
  sed -i "s|tag: v0.9.1|tag: ${LATEST_TAG}|g" "$MANIFEST"
  sed -i "s|/v0.9.1/|/${LATEST_TAG}/|g" "$MANIFEST"
fi

rm -rf build-dir .flatpak-builder 2>/dev/null || true
flatpak-builder --user --install --force-clean build-dir "$MANIFEST"
echo -e "${GREEN}✓ Build successful${NC}"
echo ""

# Run
echo -e "${YELLOW}[5/5] Launching app (close window when done)...${NC}"
flatpak run "$APP_ID" || true

echo ""
echo -e "${GREEN}✓ Flathub test complete!${NC}"
echo ""
echo -e "Run again:  flatpak run $APP_ID"
echo -e "Uninstall:  flatpak uninstall --user $APP_ID"
