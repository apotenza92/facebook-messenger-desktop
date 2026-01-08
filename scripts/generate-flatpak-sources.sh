#!/bin/bash
# Generate flatpak npm sources for Flathub submission
# Run this whenever package-lock.json changes

set -e

echo "Installing flatpak-node-generator..."
pip install --user flatpak-node-generator 2>/dev/null || pip3 install --user flatpak-node-generator

echo "Generating sources from package-lock.json..."
cd "$(dirname "$0")/.."

# Generate the npm sources file
flatpak-node-generator npm package-lock.json -o generated-sources.json

echo "✓ Generated generated-sources.json"
echo ""
echo "Next steps:"
echo "  1. git add generated-sources.json"
echo "  2. Commit and push"
echo "  3. Run: ./scripts/test-flathub.sh"
