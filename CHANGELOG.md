# Changelog

## [0.5.3] - 2026-01-02

### Added
- **Visual update progress window** - New unified window shows download progress with speed indicator (works on all platforms)
- User now chooses when to download updates instead of automatic background downloads
- Single window transitions through all states: available → downloading → ready to install
- Cancel button during download, clear error messages if something fails

### Changed
- **macOS menu reorganization** - "Check for Updates" and "Uninstall" now under the Messenger app menu (more standard macOS behavior)
- Added standard Window menu on macOS for window management
- File menu now only contains standard items (Close Window)

### Fixed
- Updates no longer appear to "download forever" - errors are now shown to the user instead of silently failing

## [0.5.2] - 2026-01-02

### Fixed
- macOS dock icon now displays at correct size when app is running (removed custom dock icon override that caused oversized icon)
- Windows: Clicking taskbar icon now properly restores window when app is running in system tray
- Auto-update "Restart Now" now properly quits the app to install updates (previously just hid the window due to close-to-tray behavior)

## [0.5.1] - 2026-01-02

### Fixed
- Windows taskbar icon now displays correctly at all sizes (uses ICO file with multiple resolutions)

## [0.5.0] - 2026-01-02

### Added
- **Windows ARM support!** Native ARM64 builds for Windows on ARM devices
- **System tray** for Windows/Linux - app stays running in background when window is closed
- **Windows taskbar badges** show unread message count overlay
- Tray context menu with Show/Hide, Check for Updates, and Quit options
- External links (target="_blank") now open in system browser instead of new Electron windows
- Platform and architecture logging on startup for debugging

### Changed
- **Windows/Linux now use native window frames** instead of custom title bar overlay (cleaner look)
- Improved Windows taskbar icon grouping with proper AppUserModelId
- Build scripts are now cross-platform compatible (works on Windows, macOS, Linux)
- Minimum window width adjusted to ensure sidebar always visible on Windows

### Fixed
- Windows notifications now show "Messenger" instead of app ID in final builds
- Muted conversations no longer trigger notifications
- Icon handling improved across all platforms (rounded icons for Windows/Linux)

### Technical
- Added `scripts/clean.js` for cross-platform build cleanup
- Icon generation scripts auto-install dependencies if missing
- Added `--force` flag to regenerate icons even if they exist
- Reduced logging noise in production builds

## [0.4.2] - 2026-01-02

### Changed
- Version bump

## [0.4.1] - 2026-01-01

### Fixed
- **No more notification spam on app launch!** Existing unread messages are now recorded before notifications are enabled
- Fixed notifications appearing for every message when opening "Message Requests" or other sections
- Added settling period after navigation to prevent false notifications when switching between views

### Technical
- MutationObserver now scans and records all existing unread conversations before accepting new notifications
- URL change detection triggers re-settling to handle SPA navigation
- Multiple scan passes ensure late-loading conversations are also recorded

## [0.4.0] - 2026-01-01

### Added
- **Audio & video calls now work!** Added camera and microphone permission support
- macOS entitlements for camera and microphone access (required for notarized builds)
- Permission handler for media access requests from messenger.com
- Notification permission prompt on first launch (macOS)

### Technical
- Added `entitlements.mac.plist` with camera, microphone, and JIT entitlements
- Added `setPermissionRequestHandler` and `setPermissionCheckHandler` for media permissions

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