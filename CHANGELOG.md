# Changelog

## [0.8.0] - 2026-01-04

### Added
- Linux Snap: First-run help message for desktop integration (XDG_DATA_DIRS setup)
- Linux: New rounded tray icon for better visibility in system tray

### Fixed
- Linux AppImage: App now detaches from terminal immediately so the command returns
- Linux Snap: Added desktop integration plugs for better system integration (wayland, x11, unity7)
- Linux: Auto-update no longer shows crash message (windows closed cleanly before quitAndInstall)
- Windows: Improved update dialog with clear SmartScreen bypass and file unblock instructions

### Changed
- Linux Snap: Updated to core22 base for better compatibility

## [0.7.9] - 2026-01-04

### Fixed
- Linux: Fixed app showing with wrong icon (gear) in taskbar/dock due to WMClass mismatch
- Fixed race condition where clicking app icon could spawn multiple instances before single instance lock was checked

## [0.7.8] - 2026-01-04

### Fixed
- Linux: In-app uninstall now properly removes .deb and .rpm packages
  - Automatically detects if installed via apt/dpkg or dnf/rpm
  - Uses pkexec for graphical password prompt to run package manager uninstall
  - No longer shows "remove the package separately" message for .deb/.rpm installs

### Changed
- Download page: Extension now shown next to download button instead of in button text

## [0.7.7] - 2026-01-04

### Fixed
- Linux: Desktop icon now appears in application menu after installing .deb/.rpm packages
  - Icons are now installed to hicolor icon theme in all required sizes (16x16 through 512x512)
  - Added StartupWMClass to .desktop file for proper window grouping in taskbar

## [0.7.6] - 2026-01-03

### Added
- Linux: Now builds Snap packages for Snap Store users (x64 only)
- Linux: Now builds Flatpak packages for Flathub users (x64 only)
- Download page: Added Snap and Flatpak options to Linux format picker
- Download page: Install commands for each Linux format (apt, dnf, snap, flatpak)
- Download page: Copy button for each install command

### Changed
- Linux packages now use consistent naming: facebook-messenger-desktop-{arch}.{ext}
- Download page: Detected platform is now hidden from Other platforms section
- Download page: Linux section shows clean format list with install instructions

## [0.7.5] - 2026-01-03

### Added
- Linux: Now builds .deb packages for Debian/Ubuntu users
- Linux: Now builds .rpm packages for Fedora/RHEL users
- Linux: Added ARM64 support for all package formats (Raspberry Pi, Pine64, etc.)
- Download page: Linux users now see a format picker with AppImage, .deb, and .rpm options
- Download page: Added toggle to switch between x64 and ARM64 builds

### Improved
- Download page: All Linux downloads now listed in "Other platforms" section
- Consistent file naming across all Linux formats (x64/arm64 instead of mixed amd64/x86_64/aarch64)

## [0.7.4] - 2026-01-03

### Fixed
- Notifications for old unread messages no longer appear when opening the app
  - Native notifications are now suppressed during initial 8-second startup period
  - Prevents Messenger from flooding notifications for messages that were already there

## [0.7.3] - 2026-01-04

### Fixed
- Windows: In-app uninstall now properly removes the app from Apps and Features
- Windows: Uninstaller now kills running Messenger process and removes taskbar pins
- macOS: Fixed Homebrew detection by using full path to brew executable
- Windows: Fixed dialog buttons showing ampersand instead of and

### Improved
- Simplified uninstall flow to single confirmation dialog on all platforms
- Added administrator permission notice to Windows uninstall dialog
- Install source detection now re-runs when app version changes (handles reinstall via different method)
- Consistent uninstall messaging across all platforms

## [0.7.2] - 2026-01-03

### Fixed
- Uninstall dialog no longer hangs - install source is now detected at startup and cached
- Uninstalling via Apps and Features now fully removes all app data (login, cache, etc.)
- macOS: Fixed Saved Application State cleanup using wrong bundle ID

### Improved
- Install source (winget/Homebrew/direct) is detected once on first run and cached permanently
  - No more slow winget/brew commands at uninstall time
  - Detection only happens once - install method never changes
- Complete data removal on all platforms during uninstall:
  - Windows: Now cleans both %APPDATA% and %LOCALAPPDATA% via NSIS uninstaller
  - macOS: Now also cleans Preferences, HTTPStorages, and WebKit directories
  - Linux: Now also cleans ~/.local/share directory
- Updated uninstall dialog text to correctly indicate automatic uninstall behavior

## [0.7.1] - 2026-01-03

### Improved
- Windows: Updates now download automatically instead of redirecting to download page
  - Installer downloads directly to Downloads folder with progress tracking
  - After download, app offers to run installer automatically
  - Built-in SmartScreen bypass instructions shown before quitting

## [0.7.0] - 2026-01-03

### Fixed
- Develop menu no longer appears in production builds (was showing on Windows/Linux)

## [0.6.8] - 2026-01-03

### Added
- Native download progress UI for updates:
  - Taskbar/dock progress bar shows download percentage
  - Title bar shows detailed progress (e.g., "Downloading update: 45% (34.2 MB / 67.5 MB) @ 2.3 MB/s")
  - System tray tooltip shows progress and speed
  - Windows: Taskbar flashes when download completes
- Develop menu (dev mode only) with testing tools:
  - Test Update Workflow: Simulates the full update download experience
  - Test Notification: Sends a test notification
  - Quick access to DevTools and Force Reload
- Dev mode now automatically kills existing production Messenger instances to avoid conflicts

### Fixed
- macOS: Download progress now shows in the custom title bar overlay (was only updating dock)

### Improved
- Uninstall dialog now appears immediately instead of waiting for package manager detection
- macOS: Uninstall now automatically moves app bundle to Trash after quit
- Windows: Uninstall now automatically runs the NSIS uninstaller after quit

### Changed
- Windows: Tray icon now uses rounded style to match the app icon

## [0.6.6] - 2026-01-02

### Fixed
- Uninstall now properly removes all app data, including cache directory (was causing login to persist after reinstall)
  - Windows: Now cleans both %APPDATA%\Messenger and %LOCALAPPDATA%\Messenger
  - macOS: Now cleans both ~/Library/Application Support/Messenger and ~/Library/Caches/Messenger
  - Linux: Now cleans both ~/.config/Messenger and ~/.cache/Messenger
- Fixed Windows uninstall cleanup command using incorrect PowerShell syntax for multiple paths

### Improved
- macOS: Uninstall now also removes Saved Application State (window position memory)
- Increased cleanup delay from 1 to 2 seconds for more reliable file deletion

## [0.6.5] - 2026-01-02

### Changed
- Windows: Auto-updates now redirect to download page instead of failing silently (temporary workaround until code signing is set up)

### Improved
- Download page now shows version number and release date (fetched from GitHub releases)

## [0.6.4] - 2026-01-02

### Fixed
- Windows: "Restart Now" for updates now properly quits the app to install the update

### Improved
- Uninstall now detects Homebrew (macOS) and winget (Windows) installations and runs the appropriate package manager uninstall command

## [0.6.3] - 2026-01-02

### Changed
- **Windows/Linux menus**: Reorganized menus to follow platform conventions
  - Help menu now contains: View on GitHub, Check for Updates, Uninstall, About
  - File menu simplified to just Quit
- **macOS**: View on GitHub in Messenger menu (unchanged, follows macOS conventions)

## [0.6.0] - 2026-01-02

### Added
- **GitHub link in About dialog** - All platforms now show a link to the project's GitHub page
- **Custom About dialog for Windows/Linux** - Beautiful, modern dialog matching macOS aesthetics with app icon, version, and GitHub link

### Fixed
- **"Messenger can't be closed" error during auto-update** - Fixed race condition in quit handler that prevented the NSIS installer from starting properly on Windows
- **Duplicate version display** - Windows no longer shows version in brackets (e.g., was showing "0.5.8 (0.5.8.0)")

### Changed
- About dialog now respects system dark/light mode on Windows/Linux
- macOS About panel now includes credits with GitHub URL

## [0.5.8] - 2026-01-02

### Changed
- **Update dialogs**: Replaced custom update window with native OS dialogs for a cleaner, more consistent experience

## [0.5.7] - 2026-01-02

### Fixed
- **Windows about dialog**: Version now displays correctly (e.g. "0.5.7" instead of "0.5.7.0")

### Improved
- **Uninstaller**: Now removes app from macOS dock and Windows taskbar when uninstalling
- **Uninstaller dialog**: Better formatting with spacing between lines on macOS

## [0.5.6] - 2026-01-02

### Fixed
- **Windows about dialog**: Version now displays correctly as "0.5.6" instead of "0.5.6.0"

## [0.5.5] - 2026-01-02

### Fixed
- **Update dialog fixes**: Restart button now shows correctly, window properly sized for all platforms, uses standard app icon
- **Windows system tray**: Fixed tray icon not appearing (was malformed ICO file)
- **Windows tray behavior**: Single-click now shows app (standard Windows convention)
- **Update install on quit**: If user clicks "Later" then quits, update installs silently without auto-restarting (respects user's choice to quit)

### Added
- Windows/Linux: "About Messenger" now in File menu

## [0.5.4] - 2026-01-02

### Fixed
- macOS: "Check for Updates" no longer shows a brief flash notification - now consistently uses the custom update window

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