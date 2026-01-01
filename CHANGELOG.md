# Changelog

## [0.3.1] - 2026-01-01

### Fixed
- Release workflow now requires CHANGELOG.md entry (no more broken changelog links)
- Added missing changelog entries for versions 0.1.8 through 0.3.0

## [0.3.0] - 2026-01-01

### Changed
- Version bump for stable release

## [0.2.3] - 2026-01-01

### Added
- Initial Winget support for Windows users (pending approval)

## [0.2.2] - 2026-01-01

### Changed
- Simplified artifact names by removing version numbers for cleaner direct download links

## [0.2.1] - 2026-01-01

### Added
- Automatic Homebrew cask update in release workflow

## [0.2.0] - 2026-01-01

### Added
- Homebrew installation support for macOS (`brew install apotenza92/tap/facebook-messenger-desktop`)
- Rounded app icon for README

## [0.1.9] - 2026-01-01

### Fixed
- Auto-updater now works on macOS (switched to zip format, added yml manifests to releases)
- Async/await handling in app initialization

## [0.1.8] - 2026-01-01

### Fixed
- Notifications now show correct thread when sidebar is scrolled

## [0.1.7] - 2026-01-01

### Added
- Custom DMG installer with branded background and icon for macOS

### Improved
- Notification fallback system now correctly identifies the sender by reading the newest thread from the chat list
- Simplified development workflow: `npm run start` for local testing, `npm run dist:*` for releases
- Auto-updater only runs in production builds (skipped in development mode)

### Fixed
- Notifications now show the correct sender name and message preview instead of the currently open conversation
- "Check for Updates" menu item disabled in development mode to avoid errors
- Removed redundant `start-dev.js` script in favor of simpler `dev.js`

## [0.1.6] - 2025-12-31

### Added
- Fallback notification system for when Messenger's service worker is unavailable
- Title-based unread count detection triggers native notifications

## [0.1.5] - 2025-12-30

### Added
- In-app uninstall command wipes Messenger data (user data, logs, temp) after quit with clearer prompts.
- Uninstall scheduling runs cleanup after exit to avoid immediate re-creation.

### Fixed
- Consistent `userData`/logs path pinned to `Messenger` to avoid spawning `facebook-messenger-desktop`.
- Window state uses pinned path; reset flags still supported.
- Mac build now produces separate arm64 and x64 DMGs with clearer names; Windows/Linux artifacts named more plainly.

## [0.1.4] - 2025-12-30

### Fixed
- macOS release artifacts are now signed and notarized (CI wired with Apple Developer credentials).

## [0.1.3] - 2025-12-30

### Fixed
- Window position/size now persists reliably; added one-time `--reset-window` flag for dev resets.
- Dev launches pass CLI args through; start script forwards args.

## [0.1.2] - 2025-12-30

### Fixed
- Release workflow stability and artifact scope (only dmg/exe/AppImage)
- Electron-builder config validation (DMG config moved to root)

## [0.1.1] - 2025-12-30

### Fixed
- Windows icon packaging (real multi-size ICO)
- Release workflow: prevent auto-publish, ensure release notes file is generated, and allow contents write

## [0.1.0] - 2025-12-30

### Added
- Initial beta release