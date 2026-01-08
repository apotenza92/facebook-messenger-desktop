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
REPO="https://github.com/apotenza92/facebook-messenger-desktop"

CLEANUP_DIR="/tmp/flathub-test-$$"
mkdir -p "$CLEANUP_DIR"
cd "$CLEANUP_DIR"

cleanup() {
  rm -rf "$CLEANUP_DIR"
}
trap cleanup EXIT

# Install dependencies
echo -e "${YELLOW}[1/6] Installing dependencies...${NC}"
if command -v dnf &> /dev/null; then
  sudo dnf install -y flatpak flatpak-builder appstream curl git python3-pip </dev/null 2>/dev/null || true
elif command -v apt &> /dev/null; then
  sudo apt update </dev/null && sudo apt install -y flatpak flatpak-builder appstream curl git python3-pip </dev/null 2>/dev/null || true
elif command -v pacman &> /dev/null; then
  sudo pacman -Sy --noconfirm flatpak flatpak-builder appstream curl git python3-pip </dev/null 2>/dev/null || true
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

# Download only what we need (not the full 200MB repo)
echo -e "${YELLOW}[3/6] Downloading source files...${NC}"
LATEST_TAG=$(curl -sL "https://api.github.com/repos/apotenza92/facebook-messenger-desktop/releases/latest" </dev/null | grep '"tag_name"' | cut -d'"' -f4)
[ -z "$LATEST_TAG" ] && LATEST_TAG="main"
echo -e "${BLUE}  Version: $LATEST_TAG${NC}"

# Download source tarball (much smaller than git clone)
curl -sL "${REPO}/archive/refs/tags/${LATEST_TAG}.tar.gz" </dev/null | tar xz
mv facebook-messenger-desktop-* repo
cd repo
echo -e "${GREEN}✓ Done${NC}"
echo ""

# Generate npm sources
echo -e "${YELLOW}[4/6] Generating npm sources...${NC}"
if [ ! -f "generated-sources.json" ]; then
  pip3 install --user flatpak-node-generator </dev/null 2>/dev/null || pip install --user flatpak-node-generator </dev/null 2>/dev/null || true
  export PATH="$HOME/.local/bin:$PATH"
  
  if command -v flatpak-node-generator &> /dev/null; then
    flatpak-node-generator npm package-lock.json -o generated-sources.json </dev/null
    echo -e "${GREEN}✓ Generated${NC}"
  else
    echo -e "${RED}✗ flatpak-node-generator not found${NC}"
    echo -e "${YELLOW}  Install: pip install flatpak-node-generator${NC}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Already exists${NC}"
fi
echo ""

# Build
echo -e "${YELLOW}[5/6] Building Flatpak...${NC}"
SOURCE_URL="${REPO}/archive/refs/tags/${LATEST_TAG}.tar.gz"
SOURCE_SHA=$(curl -sL "$SOURCE_URL" </dev/null | sha256sum | cut -d' ' -f1)
echo -e "${BLUE}  SHA256: ${SOURCE_SHA:0:16}...${NC}"

sed -i "s|REPLACE_WITH_SOURCE_SHA256|$SOURCE_SHA|g" "$MANIFEST"
sed -i "s|v0.9.1|${LATEST_TAG}|g" "$MANIFEST"

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
