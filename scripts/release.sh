#!/bin/bash
set -euo pipefail

# Release script for Facebook Messenger Desktop
# Creates a version tag and pushes it to trigger CI builds

print_usage() {
  echo "Usage: ./scripts/release.sh <version> [--dry-run]"
  echo "Examples:"
  echo "  ./scripts/release.sh 1.2.3"
  echo "  ./scripts/release.sh 1.2.3-beta.1"
  echo "  ./scripts/release.sh 1.2.3 --dry-run"
}

VERSION=""
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      if [ -z "$VERSION" ]; then
        VERSION="$arg"
      else
        echo "Error: Unexpected argument '$arg'"
        print_usage
        exit 1
      fi
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  print_usage
  exit 1
fi

# Validate version format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format. Use semver (e.g., 1.2.3 or 1.2.3-beta.1)"
  exit 1
fi

IS_STABLE=false
if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  IS_STABLE=true
fi

TAG="v$VERSION"

echo "========================================"
echo "Release: $TAG"
if [ "$DRY_RUN" = true ]; then
  echo "Mode: DRY RUN"
fi
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

if [ "$IS_STABLE" = true ]; then
  read -r -p "Type \"yes do it\" to continue: " STABLE_CONFIRMATION
  if [ "$STABLE_CONFIRMATION" != "yes do it" ]; then
    echo "Error: Stable releases require exact confirmation phrase."
    exit 1
  fi
  echo "✓ Stable release confirmation accepted"
  echo ""
fi

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would create tag $TAG"
  echo "[DRY RUN] Would push tag $TAG to origin"
  echo ""
  echo "✓ Dry run complete"
  exit 0
fi

# Create the tag and push
echo "Creating tag $TAG..."
git tag "$TAG"
git push origin "$TAG"

echo ""
echo "========================================"
echo "Release $TAG initiated!"
echo "========================================"
echo ""
echo "CI is now building all platforms..."
echo "Monitor at: https://github.com/apotenza92/facebook-messenger-desktop/actions"
