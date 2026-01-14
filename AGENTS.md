# Facebook Messenger Desktop

Electron desktop app wrapping messenger.com with native OS integrations.

## Tech Stack

- Electron 28, TypeScript, electron-builder, electron-updater

## Commands

```bash
npm start           # Dev mode (build + run)
npm run build       # Compile TypeScript
npm run dist:mac    # macOS build
npm run dist:win    # Windows build
npm run dist:linux  # Linux (AppImage, deb, rpm, flatpak)
```

## Project Structure

```
src/main/           # Main process (main.ts, notification-handler.ts, badge-manager.ts)
src/preload/        # Preload scripts (preload.ts, notifications-inject.ts)
dist/               # Compiled JS output
assets/icons/       # App icons (all platforms)
assets/tray/        # System tray icons
```

## Critical Rules

### Release Tags - EXPLICIT PERMISSION REQUIRED

**Never create or push version tags (v*) without explicit user confirmation.**

Tags trigger production releases to all users via GitHub Actions. Always ask and wait for confirmation before running `./scripts/release.sh`.

**Safe without asking**: commits, pushing to main, updating CHANGELOG.md/package.json, running local builds.

### Changelog Requirements

**Before any release**: Always ensure CHANGELOG.md is up to date with all changes for the version being released. Review recent commits and verify every user-facing change is documented.

## Release Process

### How to Release

```bash
./scripts/release.sh <version>

# Examples:
./scripts/release.sh 1.2.3           # Stable release
./scripts/release.sh 1.2.3-beta.1    # Beta release
```

The script automatically:
1. Validates version format and checks CHANGELOG.md/package.json
2. **On macOS**: Builds, signs, notarizes locally (faster), uploads to GitHub, then triggers CI for Windows/Linux
3. **On other platforms**: Triggers CI to build all platforms

### Pre-Release Checklist

- [ ] Code changes completed and tested
- [ ] Update `CHANGELOG.md` with version and changes
- [ ] Update `package.json` version number
- [ ] Commit and push changes to `main`
- [ ] **Get explicit permission before running release script**

### Version Management

- Check latest successful release before creating new version
- If build fails: fix and retry same version, don't bump

### Package Manager Updates

After release, CI automatically updates:
- **Homebrew**: Stable → main cask, Beta → @beta cask
- **Snap**: Promoted every 6 hours via `snap-promote.yml` workflow
- **Flatpak**: Updated via GitHub Pages repo

### Emergency: Delete a Release

```bash
git tag -d vX.Y.Z                      # Delete local tag
git push origin :refs/tags/vX.Y.Z      # Delete remote tag
gh release delete vX.Y.Z --yes         # Delete GitHub release
```

## Code Conventions

### Platform Detection

```typescript
if (process.platform === 'darwin') { /* macOS */ }
else if (process.platform === 'win32') { /* Windows */ }
else { /* Linux */ }
```

### Window Behavior

- macOS: close hides to dock
- Windows/Linux: close minimizes to tray
- `isQuitting` flag controls actual quit

### Code Style

- TypeScript strict mode
- Async/await for promises
- Console logging: `[Component] message`

## Key Files

- `src/main/main.ts` - App entry, window management, menus, auto-update
- `src/preload/notifications-inject.ts` - Injected into messenger.com
- `.github/workflows/release.yml` - Build and release automation
- `.github/workflows/snap-promote.yml` - Snap channel promotion (runs every 6 hours)
- `scripts/release.sh` - Release script (use this to release)

## Commit Messages

Reference issues: `fix: description (#21)` or `fixes #21` to auto-close.
