# AI Agent Instructions

This document provides context for AI coding assistants working on this project.

## Project Overview

A self-contained Electron desktop app wrapping Facebook Messenger (messenger.com) with native OS integrations. Built because Facebook deprecated their official desktop app.

## Tech Stack

- **Electron 28** - Desktop framework
- **TypeScript** - All source code in `src/`
- **electron-builder** - Packaging and distribution
- **electron-updater** - Auto-updates via GitHub releases

## Project Structure

```
src/
├── main/           # Main process (Node.js)
│   ├── main.ts     # App entry, window management, menus, auto-update
│   ├── notification-handler.ts
│   ├── badge-manager.ts
│   └── background-service.ts
└── preload/        # Preload scripts (bridge between main/renderer)
    ├── preload.ts
    └── notifications-inject.ts  # Injected into messenger.com

dist/               # Compiled JS (don't edit directly)
assets/
├── icons/          # App icons (all sizes, all platforms)
└── tray/           # System tray icons
scripts/            # Build/dev scripts
```

## Build Commands

```bash
npm start           # Dev mode (build + run)
npm run build       # Compile TypeScript only
npm run dist        # Build distributable for current platform
npm run dist:mac    # macOS (both architectures)
npm run dist:win    # Windows (both architectures)
npm run dist:linux  # Linux (AppImage, .deb, .rpm, Snap, Flatpak)
```

## Key Conventions

### Platform-Specific Code

Use `process.platform` checks:
- `'darwin'` - macOS
- `'win32'` - Windows
- `'linux'` - Linux

Example pattern used throughout:
```typescript
if (process.platform === 'darwin') {
  // macOS-specific
} else if (process.platform === 'win32') {
  // Windows-specific
} else {
  // Linux/other
}
```

### Menu Structure

- **macOS**: App menu under "Messenger" name (standard macOS convention)
- **Windows/Linux**: Help menu contains app-level items (Check for Updates, About, etc.)

### Window Behavior

- **macOS**: Close hides to dock (standard behavior)
- **Windows/Linux**: Close minimizes to system tray (if tray enabled)
- `isQuitting` flag controls whether close actually quits

### Auto-Updates

- Uses GitHub releases as update source
- `autoUpdater` from electron-updater
- Manual download approval (not auto-download)
- Windows requires special handling for `quitAndInstall()`

### Package Manager Support

App can be installed via:
- **Homebrew**: `brew install --cask apotenza92/tap/facebook-messenger-desktop`
- **winget**: `winget install apotenza92.FacebookMessengerDesktop`

Uninstall logic detects package manager installation and runs appropriate uninstall command.

## Code Style

- TypeScript strict mode
- Async/await for promises
- Console logging with prefixes: `[Component] message`
- Error handling: catch and log, show user-friendly dialogs for critical errors

## Testing Changes

1. Run `npm start` for dev mode
2. Test on target platform (some features are platform-specific)
3. For update testing, must build distributable and test with actual releases

## Common Tasks

### Adding a Menu Item

Edit `createApplicationMenu()` in `main.ts`. Note the platform-specific menu structures.

### Modifying Window Behavior

Check `createWindow()` and the window event handlers (`close`, `focus`, etc.) in `main.ts`.

### Changing Notification Behavior

`notifications-inject.ts` intercepts messenger.com's notifications. `notification-handler.ts` handles displaying native notifications.

## Development Workflow

### Regular Development

For day-to-day development, use normal git commits and pushes:

```bash
git add -A
git commit -m "Description of changes"
git push
```

This does NOT trigger a release - it just updates the main branch.

### Creating a Release

**⚠️ NEVER push release tags (`git push --follow-tags`) without EXPLICIT permission from the user in a separate, independent message.** Do not assume permission is granted as part of a larger request. Wait for the user to explicitly say "push the release" or similar before running any push command that includes tags.

When ready to publish a new version:

1. Add entry to `CHANGELOG.md` (newest at top)
   - Format: `## [X.Y.Z] - YYYY-MM-DD`
   - Never use bold (`**text**`) in changelog entries - keep it plain text

2. Commit with proper issue references in the commit message:
   - Use `fixes #21` or `closes #21` to auto-close issues and create "mentioned in commit" links
   - Do NOT use `(#21)` in parentheses - GitHub may not recognize it
   - Example: `fix(macOS): media viewer controls obscured - fixes #21`

3. Run `npm version` to bump version AND create an **annotated** git tag:
   ```bash
   npm version patch   # 0.6.4 → 0.6.5 (bug fixes)
   npm version minor   # 0.6.4 → 0.7.0 (new features)
   npm version major   # 0.6.4 → 1.0.0 (breaking changes)
   ```
   This automatically updates `package.json`, `package-lock.json`, commits, and creates an annotated `vX.Y.Z` tag.

3. **STOP and wait for user permission** before pushing.

4. Only after explicit user approval, push with tags to trigger the release workflow:
   ```bash
   git push --follow-tags
   ```

**Important:**
- **Always use `npm version`** - it creates annotated tags which `--follow-tags` will push
- Do NOT use `npm version patch --no-git-tag-version` - this skips the tag which is needed to trigger releases
- Never manually edit the version in `package.json` - always use `npm version` to keep files in sync
- The GitHub Actions "Build and Release" workflow is triggered by version tags (e.g., `v0.6.7`)

**Why this matters:** Git has two types of tags:
- **Annotated tags** (created by `npm version`) - Full objects with metadata; pushed by `--follow-tags`
- **Lightweight tags** (created by `git tag v1.0.0`) - Simple pointers; NOT pushed by `--follow-tags`

If you ever need to manually recreate a tag, either:
- Use `git tag -a v1.0.0 -m "Release v1.0.0"` (annotated), OR
- Push explicitly with `git push origin v1.0.0`

### CRITICAL: Version Management Rules

**Before creating ANY release:**

1. **Check the latest successful release** on GitHub releases page
2. **Test builds locally first** before pushing version tags:
   ```bash
   npm run dist:mac      # Test macOS build
   npm run dist:win      # Test Windows build  
   npm run dist:linux    # Test Linux build
   ```
3. **Only bump version ONCE** - the next version after the latest successful release

**If a release build fails:**
- Do NOT keep bumping versions trying to fix it
- Fix the issue, then reset `package.json` version to what it should be (one above last successful release)
- Use `npm version X.Y.Z` with the exact version number to set it correctly

**Example:** If v0.7.5 was the last successful release and builds are failing:
1. Fix the build issue
2. Reset version: edit `package.json` to `"version": "0.7.5"` (or one below target)
3. Then run `npm version patch` to get `0.7.6`
4. Push with tags

**Never publish broken releases** - users will receive update notifications for versions that don't work.

### Linux Build Notes

- **Snap**: 
  - **x64**: Built with electron-builder on GitHub Actions and uploaded to Snap Store
  - **ARM64**: Use Snapcraft's "Build from GitHub" service (https://snapcraft.io/facebook-messenger-desktop/builds)
- **Flatpak**: Builds for both x64 and ARM64 (using GitHub's free ARM64 runners)
- **Test Linux builds on CI** - local macOS/Windows machines may lack required tools

