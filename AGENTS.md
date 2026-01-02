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
npm run dist:linux  # Linux AppImage
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

## Version Bumping

Use `npm version` to bump versions - this automatically updates both `package.json` and `package-lock.json`:

```bash
npm version patch   # 0.6.4 → 0.6.5 (bug fixes)
npm version minor   # 0.6.4 → 0.7.0 (new features)
npm version major   # 0.6.4 → 1.0.0 (breaking changes)
```

**Important:** Add `--no-git-tag-version` if you don't want npm to auto-commit and tag:

```bash
npm version patch --no-git-tag-version
```

After bumping:
1. Add entry to `CHANGELOG.md` (newest at top)
2. Format: `## [X.Y.Z] - YYYY-MM-DD`
3. Never use bold (`**text**`) in changelog entries - keep it plain text
4. Commit both `package.json`, `package-lock.json`, and `CHANGELOG.md` together

**Never** manually edit the version in `package.json` - always use `npm version` to keep files in sync.

