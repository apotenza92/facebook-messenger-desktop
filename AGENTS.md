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

Tags trigger production releases to all users via GitHub Actions. Always ask and wait for confirmation before:
- `git tag v*`
- `git push origin v*`
- `gh release create`

**Safe without asking**: commits, pushing to main, updating CHANGELOG.md/package.json, running builds.

### Version Management

- Check latest successful release before creating new version
- If build fails: fix and retry same version, don't bump
- See RELEASE_PROCESS.md for full procedures

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
- `.github/workflows/release.yml` - Release automation

## Commit Messages

Reference issues: `fix: description (#21)` or `fixes #21` to auto-close.
