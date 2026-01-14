#!/bin/bash
set -euo pipefail

# Release script for Facebook Messenger Desktop
# Automatically builds macOS locally if on a Mac (faster), otherwise CI handles it

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Examples:"
  echo "  ./scripts/release.sh 1.2.3"
  echo "  ./scripts/release.sh 1.2.3-beta.1"
  exit 1
fi

# Validate version format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format. Use semver (e.g., 1.2.3 or 1.2.3-beta.1)"
  exit 1
fi

TAG="v$VERSION"

echo "========================================"
echo "Release: $TAG"
echo "========================================"
echo ""

# Check we're on main branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "Warning: You're on branch '$BRANCH', not 'main'"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "Error: You have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists"
  exit 1
fi

# Verify CHANGELOG.md has entry for this version
if ! grep -q "\[$VERSION\]" CHANGELOG.md; then
  echo "Error: No CHANGELOG.md entry found for version $VERSION"
  echo "Please add changelog entry before releasing."
  exit 1
fi

# Verify package.json version matches
PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" != "$VERSION" ]; then
  echo "Error: package.json version ($PKG_VERSION) doesn't match release version ($VERSION)"
  echo "Please update package.json first."
  exit 1
fi

echo "✓ Pre-flight checks passed"
echo ""

# Detect if we're on macOS
if [ "$(uname)" == "Darwin" ]; then
  echo "Detected macOS - will build locally for faster signing/notarization"
  echo ""
  
  # Check for required environment variables
  MISSING_VARS=()
  [ -z "${CSC_LINK:-}" ] && MISSING_VARS+=("CSC_LINK")
  [ -z "${APPLE_ID:-}" ] && MISSING_VARS+=("APPLE_ID")
  [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && MISSING_VARS+=("APPLE_APP_SPECIFIC_PASSWORD")
  
  if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo "Warning: Missing signing environment variables: ${MISSING_VARS[*]}"
    echo "The build will not be signed/notarized."
    read -p "Continue with unsigned build? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  fi
  
  echo "Building macOS app..."
  npm ci
  npm run generate-icons
  npm run build
  npm run dist:mac
  
  echo ""
  echo "✓ macOS build complete"
  echo ""
  
  # Create the tag and push
  echo "Creating tag $TAG..."
  git tag "$TAG"
  git push origin "$TAG"
  
  echo ""
  echo "Waiting for GitHub release to be created..."
  sleep 10
  
  # Upload macOS artifacts to release
  echo "Uploading macOS artifacts to release..."
  
  # Find and upload the artifacts
  for file in release/*.zip release/*.yml release/*.blockmap; do
    if [ -f "$file" ]; then
      echo "  Uploading: $file"
      gh release upload "$TAG" "$file" --clobber || true
    fi
  done
  
  echo ""
  echo "✓ macOS artifacts uploaded"
  echo ""
  echo "CI is now building Windows and Linux..."
  echo "Monitor at: https://github.com/apotenza92/facebook-messenger-desktop/actions"
  
else
  echo "Not on macOS - CI will build all platforms"
  echo ""
  
  # Create the tag and push
  echo "Creating tag $TAG..."
  git tag "$TAG"
  git push origin "$TAG"
  
  echo ""
  echo "CI is now building all platforms..."
  echo "Monitor at: https://github.com/apotenza92/facebook-messenger-desktop/actions"
fi

echo ""
echo "========================================"
echo "Release $TAG initiated!"
echo "========================================"
