# Changelog

## [1.2.3] - 2026-01-14

### Fixed
- **All platforms**: Beta users no longer get stable app installed separately when a stable release comes out
  - Beta channel now receives stable releases through beta-branded installers
  - Preserves taskbar shortcuts, app ID, and user data when updating from beta to stable
  - Applies to Windows, macOS, and Linux (deb/rpm)
- **Windows**: Uninstaller no longer affects the other app variant
  - Beta uninstall won't kill stable process or remove stable shortcuts (and vice versa)
  - Only removes shortcuts that point to the specific installation being uninstalled
  - Correctly cleans up app data folder (Messenger-Beta vs Messenger)
- **Linux**: Package scripts now handle beta and stable independently
  - after-install.sh detects which variant is being installed
  - after-remove.sh only removes symlinks/icons for the variant being uninstalled
- **macOS**: In-app uninstall now uses correct bundle ID for beta vs stable
- **All platforms**: In-app "Logout and Reset" uses correct paths for each variant

## [1.2.2] - 2026-01-14

### Added
- **Side-by-side installation**: Beta and stable versions can now be installed simultaneously on all platforms
- **Menu bar**: Default mode changed to "always visible" for new users

### Fixed
- **Windows**: Taskbar shortcut breaking after auto-update ("shortcut has been moved" error)
- **Windows**: Beta installer no longer tries to close stable "Messenger.exe" (and vice versa)
- **Windows/Linux**: Menu bar hover detection and F10 toggle behavior
- **macOS**: Code signing failing due to Linux icon files being included
- **Linux Snap**: Version stuck on 1.1.8
- **Update dialog**: Traffic light close button sizing and markdown rendering

### Improved
- **Update notifications/dialogs**: "Messenger Beta" branding for beta users
- **Snap promotion**: Runs every 6 hours via dedicated workflow
- **Build config**: Platform-specific files only included for relevant builds
- **Download page**: Various UI improvements including animated connectors

### Changed
- Renamed "Reset & Logout" menu item to "Logout and Reset App"
- Consolidated release documentation into AGENTS.md

## [1.2.2-beta.6] - 2026-01-14

### Improved
- **Update notifications**: Download progress notification now specifies "Messenger Beta" for beta users
  - Notification body and tray tooltip both reflect the app variant being updated
- **Download page**: Beta Version disclaimer spacing reduced for closer proximity to download and command sections
- **Download page**: Added animated connectors from download button to terminal commands
  - macOS: Visual flow from Download → Homebrew installation command
  - Linux: Visual flow from Download → Terminal installation command
- **Download page**: Connectors now visible on mobile devices with optimized stroke width
  - Previously hidden on screens ≤640px, now display with thinner stroke for better mobile UX

## [1.2.2-beta.5] - 2026-01-14

### Fixed
- **Update dialog**: Traffic light close button was oversized (inheriting generic button padding)
- **Update dialog**: Markdown `**bold**` syntax now renders correctly in release notes

## [1.2.2-beta.4] - 2026-01-14

### Fixed
- **macOS**: Code signing failing due to Linux icon files being included in macOS builds
  - `asarUnpack` now only applies to Linux builds

### Improved
- **Snap promotion**: Now runs every 6 hours via dedicated workflow instead of during release
  - More reliable promotion even if Launchpad builds take longer than expected
  - Handles both beta and stable channel promotion automatically
- **Build config**: Platform-specific files only included for relevant builds
  - Windows PowerShell shortcut fix script only bundled in Windows builds
  - NSIS installer/uninstaller icons now correctly use beta icons for beta builds
- **Download page**: Auto-detects OS on page refresh instead of persisting previous selection

### Changed
- Consolidated release documentation into AGENTS.md (removed RELEASE_PROCESS.md)
- New `./scripts/release.sh` for streamlined releases

## [1.2.2-beta.3] - 2026-01-14

### Fixed
- **Windows**: Taskbar shortcut breaking after auto-update ("shortcut has been moved" error)
  - Shortcut fix now runs AFTER app restarts from new location (not before)
  - Tracks version in `last-version.json` to detect when update was applied
  - PowerShell script dynamically detects beta vs stable for correct AUMID
- **Windows**: Beta installer no longer tries to close stable "Messenger.exe" (and vice versa)
  - NSIS script now properly handles beta/stable separation
  - Only updates shortcuts matching the correct app variant

### Improved
- **Download page**: GitHub icon now properly centered below description
- **Download page**: Beta notice moved below Stable/Beta toggle
- **Download page**: Version number displayed below channel toggle (blue for stable, orange for beta)
- **Download page**: Consistent orange color (#ff6b00) across all beta elements
- **Update dialogs**: Now show "Messenger Beta" branding when running beta version
  - "Messenger Beta Update" / "Messenger Beta Update Ready" titles
  - "Messenger Beta is running the latest version" message

### Changed
- Dev menu simplified to Windows update testing only
  - "Test Windows Update & Shortcut Fix": Full workflow simulation with version tracking
  - "Run Shortcut Fix Now": Immediate shortcut fix execution

## [1.2.2-beta.2] - 2026-01-14

### Added
- **Side-by-side installation**: Beta and stable versions can now be installed simultaneously on all platforms
  - Different app identifiers: `com.facebook.messenger.desktop` (stable) vs `com.facebook.messenger.desktop.beta` (beta)
  - Separate user data directories: `Messenger` vs `Messenger-Beta`
  - Separate Homebrew casks: `facebook-messenger-desktop` vs `facebook-messenger-desktop-beta`
  - Different Linux packages: `facebook-messenger-desktop` vs `facebook-messenger-desktop-beta`
  - **Orange app icon** for beta to visually distinguish from stable (blue) version

## [1.2.2-beta.1] - 2026-01-14

### Fixed
- **Windows/Linux**: Menu bar hover detection not working properly
- **Windows/Linux**: F10 now permanently toggles menu bar visibility (previously would hide again when clicking in the app)
- **Windows/Linux**: "Hide Menu Bar" / "Show Menu Bar" label now correctly says "Toggle Menu Bar"
- **Linux Snap**: Version stuck on 1.1.8 - now uses package.json version instead of `git describe`

### Improved
- **Download page**: Beta channel now always shows latest version (beta or stable, whichever is newer)
- **Download page**: Stable/Beta toggle always visible, removed version number display
- **Download page**: Orange theme applied to all buttons when Beta is selected
- **CI**: Snap promotion now waits for Launchpad builds to complete before promoting

### Changed
- Renamed "Reset & Logout" menu item to "Logout and Reset App" for clarity

## [1.2.1] - 2026-01-14

### Fixed
- Beta users not receiving beta updates (issue #34)
  - Worked around electron-updater GitHub provider bug where `allowPrerelease` doesn't work
  - Auto-updater now queries GitHub API directly to find the correct release

### Improved
- Redesigned update notification dialog
  - Custom HTML-based dialog with proper styling and fixed dimensions
  - Scrollable changelog section that doesn't overflow the window
  - Bold section headers and formatted bullet points
  - Dark/light theme support matching system preference
  - Keyboard shortcuts: Enter to download, Escape to dismiss

### Changed
- **Redesigned beta program** - stable and beta are now completely separate app tracks
  - **Stable users**: Install from the download page, receive stable updates only
  - **Beta users**: Install the beta version specifically, receive beta updates only
  - Removed the in-app "Join Beta Program" / "Leave Beta Program" menu toggle
  - Beta versions clearly display as **"Messenger Beta"** in dock, taskbar, window title
  - To switch tracks: uninstall current version, install desired track from download page
  - Legacy beta opt-in preference files are automatically cleaned up on update

### Added
- **Beta installation options** on download page (toggle Stable/Beta at top):
  - macOS: `brew install --cask apotenza92/tap/facebook-messenger-desktop@beta`
  - Linux Snap: `sudo snap install facebook-messenger-desktop --beta`
  - All platforms: Direct download links for beta builds
- Download page dynamically updates all links, commands, and labels per channel

## [1.2.0] - 2026-01-14

### Fixed
- Beta channel users not receiving updates (issue #34)
  - Rewrote auto-update system to use electron-updater's native prerelease support
  - Removed custom YML fetching logic that was causing "internet connection" errors
  - Beta users now properly receive beta updates via GitHub's prerelease flag
  - Stable users only receive stable releases
- Misleading "internet connection" error messages during update checks
  - Now shows accurate error messages based on actual failure type
  - Network errors clearly indicate connection issues
  - Other errors show the actual error message

### Changed
- Simplified update channel architecture
  - Removed generate-channel-yml.js build step
  - Updates now use GitHub Releases prerelease flag instead of separate YML files

## [1.1.9] - 2026-01-13

### Added
- Auto-hide menu bar with hover, Alt, and F10 toggle (issue #31)
  - Menu bar is hidden by default on Windows/Linux
  - Hovering near top of window (3px zone) temporarily shows menu bar
  - Alt key temporarily shows menu bar while held (Electron default behavior)
  - F10 key or View menu item toggles permanent visibility
  - Menu bar state persists correctly between temporary and permanent visibility
- Retry logic for channel version fetching with exponential backoff
  - 3 attempts with 1s, 2s, 4s delays for network resilience
  - Better handling of temporary network issues
  - User-friendly error dialogs instead of silent failures
- Comprehensive AI assistant instructions and release policies
  - Single .ai-instructions.md file for AI models to follow
  - Detailed release process documentation
  - Playwright test suite for update checker scenarios

### Fixed
- Microphone not released after audio calls end (issue #33)
  - Microphone now properly stops when call windows close
  - Works for both user-initiated and remote-initiated hang-ups
  - Added MediaStream tracking and cleanup via preload script
  - Prevents orange microphone indicator from staying active on macOS
  - Also handles video tracks and screen sharing cleanup
- Update checker failing when beta channel is unavailable
  - Fixed Promise.all rejection when one channel fails to fetch
  - Now gracefully handles cases where beta channel doesn't exist
  - Returns null instead of throwing error, allowing fallback to available channel
  - Prevents "Failed to fetch version information from both channels" error for beta users
- Beta/stable channel auto-update system improvements
  - Automatic YML file generation for both latest and beta channels across all platforms
  - Fixed promise error handling with proper rejection and 30-second timeout
  - Network failures now show clear error messages to users
- Windows 11 taskbar shortcuts breaking after auto-updates
  - Auto-updates now run the shortcut fix script before restart
  - Ensures AppUserModelId property is maintained on taskbar pins
  - Shortcuts remain functional after app updates
  - Test feature available in Develop menu for Windows users
- Cross-platform build improvements
  - YML generator now works correctly on macOS, Linux, and Windows
  - Platform-agnostic validation for build artifacts

## [1.1.8-beta.2] - 2026-01-13

### Fixed
- Beta/stable channel auto-update system improvements
  - Automatic YML file generation for both latest and beta channels across all platforms
  - Fixed promise error handling with proper rejection and 30-second timeout
  - Added retry logic with exponential backoff (3 attempts: 1s, 2s, 4s delays)
  - User-friendly error dialogs instead of silent failures
  - Network failures now show clear error messages to users
- Windows 11 taskbar shortcuts breaking after auto-updates
  - Auto-updates now run the shortcut fix script before restart
  - Ensures AppUserModelId property is maintained on taskbar pins
  - Shortcuts remain functional after app updates
  - Test feature available in Develop menu for Windows users

### Added
- Channel YML generator script (scripts/generate-channel-yml.js)
  - Automatically copies latest*.yml to beta*.yml for all platforms
  - Integrated into GitHub Actions workflow after builds
- Retry logic for channel version fetching (fetchChannelVersionWithRetry)
  - Exponential backoff for network resilience
  - Better handling of temporary network issues
- Standalone PowerShell script for Windows shortcut maintenance (scripts/fix-windows-shortcuts.ps1)
  - Uses .NET COM interop to access Windows Shell APIs
  - Updates AppUserModelId property on all Messenger shortcuts
  - Scans taskbar, Start Menu, and Desktop locations
- runWindowsShortcutFix() function for auto-update integration
  - Executes during update-downloaded event
  - Includes detailed result parsing and error handling
- Improved test diagnostics for Windows taskbar fix

## [1.1.8-beta.1] - 2026-01-13

### Added
- Auto-hide menu bar with hover, Alt, and F10 toggle (issue #31)
  - Menu bar is hidden by default on Windows/Linux
  - Hovering near top of window (3px zone) temporarily shows menu bar
  - Alt key temporarily shows menu bar while held (Electron default behavior)
  - F10 key or View menu item toggles permanent visibility
  - Menu bar state persists correctly between temporary and permanent visibility

### Fixed
- TypeScript compilation error in menu creation code

## [1.1.7] - 2026-01-13

### Fixed
- False "No Internet Connection" message during login
  - Error codes -2 (ERR_FAILED) and -3 (ERR_ABORTED) were too broad and caused false positives
  - Now only genuine network errors trigger the offline page
- Users stuck on facebook.com when reopening app
  - App was prematurely setting login flow state on startup
  - Now properly redirects from facebook.com to messenger.com after session validation

### Added
- Reset & Logout menu item for users to clear all session data
  - Accessible from Messenger menu (macOS) or Help menu (Windows/Linux)
  - Clears all cookies, cache, and local storage
  - Returns user to login screen without reinstalling the app
  - Equivalent to `npm run start:reset` but for production users

## [1.1.6] - 2026-01-12

### Fixed
- Login flow: Robust new user login that prevents redirect loops and flash of login page (issue #29)
  - App checks for existing session cookies before showing login page
  - State-based tracking prevents premature redirects during Facebook authentication
  - Properly handles 2FA, checkpoints, and "Trust this device" screens
  - Session persists correctly after app restart
- macOS: Spellcheck now enabled (issue #30)
  - Previously disabled on macOS, now works correctly
  - Both webpage-based and native spellcheck now functional

### Added
- Automated login flow test script (scripts/test-login.js)
  - Uses Playwright to automate the full login flow for testing
  - Integrates with 1Password CLI for credentials and TOTP
  - Tests session persistence after app restart

## [1.1.5] - 2026-01-12

### Changed
- Login flow now uses facebook.com instead of messenger.com
  - Messenger.com's login has issues with "approve from another device" verification
  - Facebook.com provides a more robust and complete authentication flow
  - After login, automatically redirects to Messenger
- New branded login intro page before Facebook authentication
- Consistent banner shown throughout entire login/verification flow

## [1.1.4] - 2026-01-12

### Fixed
- Beta channel: Users now correctly see stable updates when they are newer (issue #28)
  - Previously, beta users on v1.1.2 would not see v1.1.3 stable update
  - Root cause: electron-updater ignores channel setting when allowPrerelease is enabled
  - Fix: Smart update check now fetches both channels and picks the higher version

## [1.1.3] - 2026-01-12

### Fixed
- View menu: Reload and Force Reload now work correctly (issue #26)
  - On macOS, reload was targeting the wrong webContents (empty title bar window instead of Messenger content)
  - Cmd+R / Ctrl+R and Cmd+Shift+R / Ctrl+Shift+R now properly reload the Messenger page
- Badge counter: Added periodic recheck every 30 seconds (issue #27)
  - Catches cases where messages are read on another device
  - The local DOM doesn't update automatically, but periodic rechecks sync the badge count

### Added
- Offline detection with auto-retry (issue #25)
  - When app starts without internet (e.g., at login before network is ready), shows a friendly offline page
  - Includes manual Retry button and automatic retry countdown (10 seconds)
  - No more blank windows when launching without network connectivity

## [1.1.2] - 2026-01-10

### Fixed
- Windows 11: Pinned taskbar shortcuts no longer break after updates
- Beta program: Users now receive stable updates in addition to beta releases

### Added
- Develop menu: "Test Taskbar Fix (Simulate Update)" for testing on Windows

## [1.1.2-beta.2] - 2026-01-10

### Fixed
- Beta users now receive stable updates (issue #24)
  - Previously, beta users would only see newer beta versions, missing stable releases
  - Now beta users receive whichever version is newest, whether beta or stable

## [1.1.2-beta.1] - 2026-01-10

### Fixed
- Windows 11: Pinned taskbar shortcuts no longer break after updates
  - Root cause: WScript.Shell cannot set System.AppUserModel.ID property required by Windows 11
  - Fix: Now uses Windows Shell API via .NET interop to properly set AppUserModelId on shortcuts
  - This ensures Windows 11 maintains the association between the pinned icon and the app

### Added
- Develop menu: "Test Taskbar Fix (Simulate Update)" for beta testers on Windows
  - Runs the same shortcut fix logic that executes during actual updates
  - Shows detailed results of which shortcuts were found and updated
  - Offers to quit the app so you can test clicking the pinned taskbar icon

## [1.1.1] - 2026-01-10

### Fixed
- Facebook Marketplace links now open in system browser (issue #24)
  - Clicking "view more items", "view seller profile", or other Marketplace links in chats now opens them externally
  - The app is signed into Messenger but not Facebook, so Marketplace pages don't work in-app
  - Also redirects other non-Messenger Facebook URLs to system browser while preserving login flow

## [1.1.0] - 2026-01-09

### Summary
- Stability milestone release

## [1.0.10] - 2026-01-09

### Added
- Linux: Flatpak builds now included in releases
  - Available for both x64 and ARM64 architectures
  - Self-hosted Flatpak repository updated automatically on release

## [1.0.9] - 2026-01-09

### Changed
- CI: Attempted native ARM64 runners (reverted in 1.0.10 due to electron-builder issues)

## [1.0.8] - 2026-01-09

### Fixed
- macOS: Icon theme switching now works again (issue #23)
  - Dark icons were accidentally excluded from builds in v1.0.7
  - "Match System", "Light Icon", and "Dark Icon" options now properly switch the dock icon
  - Tahoe glass/clear effects still work in "Match System" mode
- Update dialog changelog section no longer overflows the screen (issue #23)
  - Shows only the changelog for the version being updated to
  - Dialog is now always visible and buttons are accessible

## [1.0.7] - 2026-01-09

### Added
- Update dialogs now show changelog of what's new in the update
  - Fetches changelog from GitHub when update is available
  - Beta users see both stable and beta entries
  - Stable users see only stable release entries
- Develop menu now available to beta testers
  - Access via menu bar on all platforms
  - Includes testing tools: Update workflow, Notification, Taskbar shortcut fix (Windows)

### Changed
- Joining beta program now automatically checks for beta updates
  - Previously showed a message telling users to manually check
  - Now immediately checks and notifies if a beta update is available

### Fixed
- Duplicate notifications for old messages no longer appear (issue #13)
  - Only messages within 1 minute trigger notifications
  - Old unread messages that appear when scrolling or after app restart are now ignored
  - Detects Messenger's relative timestamps (e.g., "5m", "2h", "3d", "1w") to identify old messages
- macOS: Media viewer controls no longer obscured by title bar (issue #21)
  - Close, download, and forward buttons now fully visible when viewing photos/videos
  - Injects CSS to push controls below the custom title bar overlay
- Update check no longer shows "Update check failed" when already on the latest version
  - Beta users especially affected when no newer releases available
  - Now correctly shows "You're up to date!" in these cases
- Notification badge now clears when actively viewing a conversation (issue #22)
  - Previously, badge wouldn't update until switching to another chat
  - Now excludes the currently-viewed conversation from unread count when window is focused
  - Added responsive badge updates when user interacts (clicks, types) in a conversation
- Flatpak: App now launches correctly
  - Fixed Electron binary corruption caused by flatpak-builder stripping
  - Fixed missing resources directory (flatpak-builder flattens archive structure)
  - Added in-app uninstall support via flatpak-spawn

## [1.0.7-beta.7] - 2026-01-09

### Fixed
- Notifications not appearing for new messages (regression from beta.1)
  - Messages within 1 minute ("1m" timestamp) now correctly trigger notifications
  - Previous fix was too aggressive and blocked all messages with any timestamp

## [1.0.7-beta.6] - 2026-01-09

### Fixed
- Notification badge now clears when actively viewing a conversation (issue #22)
  - Previously, badge wouldn't update until switching to another chat
  - Now excludes the currently-viewed conversation from unread count when window is focused
  - Added responsive badge updates when user interacts (clicks, types) in a conversation

## [1.0.7-beta.5] - 2026-01-08

### Added
- Update dialogs now show changelog of what's new in the update
  - Fetches changelog from GitHub when update is available
  - Beta users see both stable and beta entries
  - Stable users see only stable release entries

### Fixed
- Update check no longer shows "Update check failed" when already on the latest version
  - Beta users especially affected when no newer releases available
  - Now correctly shows "You're up to date!" in these cases

## [1.0.7-beta.4] - 2026-01-08

### Added
- Develop menu now available to beta testers
  - Access via menu bar on all platforms
  - Includes testing tools: Update workflow, Notification, Taskbar shortcut fix (Windows)

## [1.0.7-beta.3] - 2026-01-08

### Fixed
- macOS: Media viewer controls no longer obscured by title bar (issue #21)
  - Close, download, and forward buttons now fully visible when viewing photos/videos
  - Injects CSS to push controls below the custom title bar overlay

## [1.0.7-beta.2] - 2026-01-08

### Changed
- Joining beta program now automatically checks for beta updates
  - Previously showed a message telling users to manually check
  - Now immediately checks and notifies if a beta update is available

## [1.0.7-beta.1] - 2026-01-08

### Fixed
- Duplicate notifications for old messages no longer appear (issue #13)
  - Only messages that JUST arrived (no visible timestamp) will trigger notifications
  - Old unread messages that appear when scrolling or after app restart are now ignored
  - Detects Messenger's relative timestamps (e.g., "5m", "2h", "3d", "1w") to identify old messages

## [1.0.6] - 2026-01-08

### Added
- Beta program for early access to new features and bug fixes
  - Join via Messenger menu (macOS) or Help menu (Windows/Linux)
  - "Check for Updates" becomes "Check for Beta Updates" when enrolled
  - Leave anytime from the same menu
  - Snap/Flatpak users shown instructions to switch to direct download for beta access

## [1.0.5] - 2026-01-08

### Changed
- Login page now uses messenger.com/login/ (simpler, cleaner form structure)
- Custom branded login page with Messenger Desktop header, icon, and disclaimer
- Login page icon now uses high-resolution SVG for crisp rendering at any size

### Added
- Native media download handling (issue #20)
  - Images and videos from chat now download directly to Downloads folder
  - No longer opens external browser for Facebook CDN media URLs
  - Shows native notification when download completes
  - Click notification to reveal file in Downloads folder
- Verification page banner for 2FA and security checkpoint pages
  - Shows "You're signing in to Messenger Desktop" with app icon
  - Explains user is completing Facebook verification
  - Includes disclaimer about unofficial app status
  - Platform-specific positioning (accounts for macOS title bar overlay)

## [1.0.4] - 2026-01-07

### Changed
- Linux uninstall now uses Electron's native dialog instead of zenity/kdialog
- All Linux package types now use pkexec for authentication during uninstall
  - deb: apt remove with pkexec
  - rpm: dnf remove with pkexec
  - Snap: snap remove with pkexec
  - Flatpak: flatpak uninstall with pkexec (previously had no auth)
  - AppImage: Deletes the .AppImage file with pkexec
- Snap auto-promotion timeout increased from 60 to 90 minutes (Launchpad builds can be slow)
- Snap promotion workflow now shows detailed status and error reporting

### Added
- AppImage uninstall support
  - Detects AppImage installations via APPIMAGE environment variable
  - Deletes the .AppImage file and cleans up desktop entries/icons
  - Uses systemd-run to survive app exit, with fallback to direct spawn
- Screen sharing support during calls (issue #19)
  - Adds setDisplayMediaRequestHandler for getDisplayMedia() calls
  - Shows a picker dialog to choose which screen or window to share
  - Auto-selects if only one screen is available
  - Includes macOS screen recording permission prompt
- Linux: XWayland mode toggle for screen sharing compatibility
  - Help menu option to switch between native Wayland and XWayland modes
  - When screen sharing on native Wayland, prompts user to switch to XWayland
  - Preference is saved and persists across restarts
  - XWayland provides reliable screen sharing at cost of some Wayland features

### Fixed
- Deb/RPM: App not appearing in GNOME Applications menu
  - electron-builder was generating incomplete Categories field
  - Post-install script now fixes Categories to include InstantMessaging and Chat
- Snap: Desktop file and icon now properly included in snap/gui/ directory
  - Fixes app not appearing in application menu after snap install

## [1.0.3] - 2026-01-07

### Changed
- Snap auto-promotion now polls for build completion instead of fixed wait time
  - Checks every 2 minutes for new builds to appear in edge channel
  - Promotes immediately when builds complete (no more guessing)
  - 60 minute timeout as fallback

### Fixed
- Snap desktop file not being exported correctly (icon not showing in app menu)
  - Added desktop: directive to snapcraft.yaml for proper snapd integration

## [1.0.2] - 2026-01-06

### Added
- Automatic Snap promotion to stable channel after GitHub releases
  - New releases now automatically get promoted from edge to stable on Snap Store

### Fixed
- Linux deb/rpm: Icon not appearing in application menu (was showing generic gear icon)
  - Fixed icon name mismatch between desktop entry and installed icons
  - Added asarUnpack config to extract icons from asar archive for post-install script
  - Icons now correctly installed to /usr/share/icons/hicolor/

## [1.0.1] - 2026-01-06

### Fixed
- Snapcraft builds failing due to YAML indentation issues in heredocs
- Desktop file not being generated correctly for Snap packages
- First successful ARM64 Snap build
- Added note to uninstall dialog about package manager uninstall for Flatpak/Snap/apt/dnf users

## [1.0.0] - 2026-01-06

### Fixed
- Flatpak repository not accessible from self-hosted repo
  - GitHub Pages was serving from main branch /docs folder, but Flatpak repo was deployed to gh-pages branch
  - Now correctly deploys Flatpak repo to docs/flatpak/repo on main branch
  - Added .nojekyll file to prevent Jekyll from ignoring OSTree files

## [0.9.9] - 2026-01-06

### Added
- Bring window to foreground on incoming calls (issue #17)
  - When you receive a call, the app automatically opens if hidden and comes to foreground
  - Works when the app is minimized, in the background, or hidden to the tray
  - Detects calls via notification content and in-page call popup UI
  - On macOS, also bounces the dock icon for extra visibility
- Dark mode app icon with theme switching
  - New "Icon Appearance" submenu with three options: Match System, Light Icon, Dark Icon
  - "Match System" (default) on macOS: Uses native bundle icon, enabling Tahoe's glass/clear effects and automatic dark mode
  - "Match System" on Windows/Linux: Auto-switches between light/dark icons based on OS theme
  - "Light Icon" / "Dark Icon": Override with our custom icons (dark icon has white interior)
  - Menu location: Messenger menu (macOS) or File menu (Windows/Linux)
  - Preference is saved and persists across app restarts
- Notification Settings menu item on all platforms
  - macOS: Messenger menu → Notification Settings (opens System Settings > Notifications)
  - Windows: Help menu → Notification Settings (opens Settings > Notifications)
  - Linux: Help menu → Notification Settings (opens GNOME/KDE notification settings)
  - Helps users easily enable notifications if they're not receiving them (issue #13)
- macOS: Detect if notifications are disabled after app updates (issue #13)
  - Uses a bundled Swift helper to check notification authorization status
  - Prompts users to enable notifications if they're turned off
  - Includes "Don't ask again" checkbox for users who intentionally disabled notifications
  - Only shown once per update, not on every launch

### Fixed
- Snapcraft builds failing due to undefined CRAFT_ARCH variable
  - Now uses CRAFT_ARCH_BUILD_FOR with fallback to SNAPCRAFT_TARGET_ARCH
- macOS dock icon appearing larger than other app icons (issue #15)
  - Icon now matches Apple's design guidelines with ~8.5% transparent margin
  - Allows macOS to properly render shadows around the icon
  - Based on analysis of Apple's Messages.app icon structure

## [0.9.8] - 2026-01-06

### Fixed
- Muted conversations no longer trigger notifications or count toward badge (issue #14)
  - Native notifications now check muted status before sending
  - Badge count excludes muted conversations
  - Detects muted status via the "bell with slash" icon in sidebar
- Fixed Snapcraft builds failing on ARM64 and x64
  - Electron's install script was failing in the restricted build environment
  - Now skips automatic Electron download during npm ci (manual download handles target arch)

## [0.9.7] - 2026-01-06

### Changed
- Refined app icon design for better visual balance and macOS compatibility (issue #15)
  - Restored original Messenger chat bubble shape for proper dock sizing on macOS
  - Simplified network diagram with larger center node and uniform outer nodes
  - Center node is now prominent, outer nodes are 65% the size of center
  - Reduced icon scale from 80% to 72% for macOS Big Sur/Sequoia compatibility
  - Icons now have proper padding for system shadow rendering
- Simplified Linux build workflow
  - Removed redundant ARM64 Flatpak job (cross-compilation in main Linux job handles it)
  - Renamed build jobs for clarity: "Build Linux" now builds all x64 and ARM64 packages

## [0.9.6] - 2026-01-06

### Changed
- All Snap builds now handled by Snapcraft's "Build from GitHub" service
  - Removed electron-builder snap target from GitHub Actions
  - Removed update-snapstore job from release workflow
  - Snapcraft automatically builds and publishes both amd64 and arm64 snaps
  - Added .launchpad.yaml for auto-release to stable channel

### Fixed
- Fixed Flatpak repository deployment to GitHub Pages
  - Previous workflow incorrectly added all source files to gh-pages branch
  - Now properly clones gh-pages separately and only copies flatpak repo files

## [0.9.5] - 2026-01-06

### Changed
- New distinctive app icon featuring an isometric cube/graph design in a speech bubble
  - Visually unique to avoid confusion and potential trademark issues with official Messenger
  - Updated across all platforms: macOS (app, dock, DMG), Windows (taskbar, tray), Linux (all sizes)
- ARM64 Snap builds now use Snapcraft's "Build from GitHub" service
  - snapcraft remote-build has OAuth issues in CI environments
  - x64 Snap still built and uploaded via GitHub Actions
  - ARM64 Snap built automatically by Snapcraft when repo is linked at snapcraft.io

### Fixed
- Fixed repeated notifications for old unread messages (issue #13)
  - Messages left unread indefinitely no longer trigger duplicate notifications
  - Removed time-based expiry; records now cleared only when conversations are read or app restarts
  - Native notification records are now properly cleared when conversations are read

## [0.9.4] - 2026-01-06

### Changed
- Simplified and cleaned up release workflow
  - Separate build jobs per platform for clearer naming
  - Removed unreliable ARM64 Snap remote build (x64 Snap only for now)
  - Added continue-on-error to WinGet/Flatpak updates (don't fail release if these fail)
  - Better error messages for GPG key configuration issues
  - Proper job dependencies (release waits for all builds)

## [0.9.3] - 2026-01-06

### Fixed
- Fixed Linux build failure: Removed ARM64 from electron-builder snap target (ARM64 snap builds via remote build only)
- Fixed snapcraft authentication: Updated to use environment variable directly instead of deprecated --with flag

## [0.9.2] - 2026-01-06

### Added
- Linux ARM64 support for Snap and Flatpak packages
  - Snap ARM64 builds via Snapcraft remote-build service
  - Flatpak ARM64 builds on GitHub Actions ARM64 runners
  - Updated download page to show ARM64 Snap and Flatpak options

### Changed
- Cleaned up flatpak folder structure
  - Moved flatpak-repo.gpg to project root (common convention for public keys)
  - Removed flatpak README.md
- Added engines field to package.json to specify Node.js version requirement

## [0.9.1] - 2026-01-05

### Fixed
- macOS: Fixed badge count not displaying in dock icon
  - Changed from app.setBadgeCount() to app.dock.setBadge() for better reliability
  - Badge now properly shows unread message count on macOS
- Fixed badge updates not working when marking chats as unread
  - Added DOM-based unread conversation counting to catch manually marked unread chats
  - Badge now updates correctly for both new messages and manually marked unread chats
- Improved badge update responsiveness when reading messages
  - Reduced debounce time from 500ms to 200ms for faster updates
  - Added immediate checks on window focus and URL changes
  - Fixed badge flash when opening conversations by adding delay for DOM verification

### Improved
- Badge count detection now works from page context using postMessage bridge
  - No longer depends on electronAPI availability timing
  - More reliable badge updates across all scenarios

## [0.9.0] - 2026-01-05

### Added
- Self-hosted Flatpak repository for Linux users
  - Users can now install via: flatpak remote-add + flatpak install
  - GPG-signed repository hosted on GitHub Pages
  - Shows up in GNOME Software and KDE Discover after adding the repo
  - Updates via flatpak update or software center

### Changed
- Download page: Complete redesign with platform-specific pages
  - Each platform (macOS, Windows, Linux) now has its own dedicated download view
  - Clicking "Other platforms" links switches to that platform's download page instead of direct downloads
  - Architecture toggle (x64/ARM64 for Windows/Linux, Apple Silicon/Intel for macOS) on all platforms
  - Auto-detection selects the correct architecture tab based on user's system
  - Platform text shown as heading above the architecture toggle
- Download page: Added Flatpak install command to Linux downloads
- Linux Snap/Flatpak: Disabled built-in auto-updater
  - These package formats must be updated through their package managers
  - Check for Updates menu now shows helpful message with the correct update command
- Linux deb/rpm: Update installation now uses zenity/kdialog for password prompts
  - More reliable than pkexec which requires a polkit agent
  - Consistent with the uninstall dialog behavior

## [0.8.10] - 2026-01-05

### Fixed
- Fixed audio and video call buttons not working (broken since v0.4.1)
  - Messenger opens calls in a pop-up window which was being blocked
  - Messenger uses about:blank URLs for call windows, which are now allowed
  - Pop-up windows for messenger.com URLs now open as Electron windows
  - Child windows can navigate to messenger.com call URLs after opening
  - External links still open in system browser as before
- macOS: Fixed camera and microphone permissions not being requested
  - App now prompts for camera/microphone access on first launch
  - Added required Info.plist usage description strings
- Linux Flatpak: Added device permissions for webcam and audio access

### Changed
- Added "unofficial" disclaimers throughout the app and documentation
  - README, download page, About dialog, and LICENSE now include trademark notices
  - Clarifies this is a third-party, non-affiliated project
  - All references updated to indicate unofficial status

## [0.8.9] - 2026-01-04

### Fixed
- Linux deb/rpm: Fixed auto-updates returning 404 errors (especially on Fedora)
  - Download URLs were using Node.js arch names (x64/arm64) instead of Linux package names
  - RPM now correctly uses x86_64/aarch64 naming
  - DEB now correctly uses amd64/arm64 naming
- Linux deb/rpm: Fixed app not being available in terminal PATH after installation
  - Symlink now created from /usr/bin/facebook-messenger-desktop to /opt/Messenger/
  - Commands like `which facebook-messenger-desktop` now work as expected
- Linux: Fixed double window appearing when launching app while another instance is running
  - Single instance lock was correctly detecting the other instance but app.quit() is asynchronous
  - Added process.exit() to immediately terminate before window creation code could run

## [0.8.8] - 2026-01-04

### Added
- Linux: Comprehensive diagnostic logging for window creation to debug double window issue
  - Logs timestamps, event sources (second-instance, activate, tray-click), and full state at each step
  - Shows exactly when events fire and what guards block/allow window creation
  - Check logs at ~/.config/Messenger/logs/ or run from terminal to see output

### Fixed
- Windows: Fixed pinned taskbar shortcut showing "Can't open this item" after installing auto-update
  - NSIS installer now deletes and recreates the taskbar shortcut to clear stale state
  - Writes PowerShell script to temp file for reliable execution (avoids escaping issues)
  - Kills any running Messenger process first to prevent file locks
  - Added multiple shell notifications and icon cache refresh for reliability
- Linux: Attempted fix for double window still appearing despite 0.8.7 debounce fix
  - Added app initialization flag to queue second-instance events until window is ready
  - Increased debounce from 500ms to 1000ms to catch rapid double-clicks
- Linux: Fixed 20+ second delay when clicking Uninstall Messenger (especially on Snap)
  - Electron's native dialogs go through xdg-desktop-portal which can be very slow
  - Now uses zenity (GTK) or kdialog (KDE) which are fast and match desktop theme
  - Falls back to Electron dialog if neither tool is available
- Linux deb/rpm: Fixed app icon not appearing in applications menu on Ubuntu
  - Icons are now explicitly installed to hicolor theme during package installation
  - Added after-remove script to clean up icons when package is uninstalled

## [0.8.7] - 2026-01-04

### Fixed
- Fixed slow uninstall dialog on Snap (and other platforms)
  - Confirmation dialog now appears immediately when clicking Uninstall
  - Package manager detection moved to after user confirms, not before
- Linux deb/rpm: Fixed app failing to launch with sandbox error
  - Post-install script now sets correct ownership and SUID permissions on chrome-sandbox
  - Previously required manual fix: sudo chown root:root /opt/Messenger/chrome-sandbox && sudo chmod 4755
- Linux: Fixed double window appearing when clicking dock/dash icon repeatedly
  - Added debounce to prevent both second-instance and activate events from creating windows
- Linux: Fixed app icon appearing too small in dash/dock
  - Increased icon background from 72% to 85% of canvas size
  - Logo now fills 68% of canvas (was 56%)
- Linux deb/rpm: Fixed app icon not showing in application menu
  - Added explicit Icon field to desktop file configuration
- Linux deb/rpm: Fixed installation hanging when installing via terminal
  - Removed dbus-send command that could block without a desktop session

## [0.8.6] - 2026-01-04

### Fixed
- Windows: Fixed taskbar icon becoming blank after auto-update
  - Icon is now re-applied after window ready-to-show and on window show events
  - NSIS installer clears Windows icon cache during updates to force refresh
  - Shell notification sent to refresh taskbar after update completes
- Linux Snap: Fixed app crashing when using in-app uninstaller
  - Snap apps cannot uninstall themselves while running due to sandbox confinement
  - App now quits first, then runs snap remove in a detached process
- Linux Flatpak: Fixed potential crash when using in-app uninstaller
  - Same deferred uninstall approach as Snap for sandbox compatibility
- Linux: Fixed ghost icons remaining in Pop!_OS COSMIC app launcher after uninstall
  - All uninstallers now clear pop-launcher cache
  - All uninstallers now clear COSMIC app cache
  - Desktop database and icon caches are refreshed after uninstall

## [0.8.5] - 2026-01-04

### Fixed
- Linux: App now appears in application menu after installing deb/rpm via terminal
  - Added post-install script that updates desktop database and icon cache
  - Notifies GNOME Shell to refresh its app list

## [0.8.4] - 2026-01-04

### Fixed
- Linux: Fixed double window appearing when clicking dash icon after previously closing window
  - Added isDestroyed() check to prevent showing/focusing destroyed windows
  - Added race condition guard to prevent simultaneous window creation from second-instance and activate events
- Linux: Improved icon sizing in dash - icon now has transparent padding around it
  - White rounded background is now 72% of canvas (was 100%)
  - Messenger logo is 56% of canvas for better visibility within the smaller background
  - Icon now appears properly sized relative to other system icons in GNOME/KDE dash

## [0.8.3] - 2026-01-04

### Fixed
- Linux Snap: Fixed Snap Store upload failing due to duplicate plugs in snap configuration
  - Removed redundant desktop/x11/wayland/unity7 plugs that were already included in "default"
- Linux: Fixed in-app uninstall not actually removing the app on Fedora/RPM systems
  - Detection commands (rpm, dpkg-query) now use full paths for GUI environments
  - pkexec authentication dialog now appears properly (app window hides instead of quitting immediately)
  - Cleanup script waits for package manager to complete before refreshing caches
- Linux: Fixed app icon remaining in application menu after uninstall
  - User-specific desktop entries in ~/.local/share/applications/ are now cleaned up
  - User icons in ~/.local/share/icons/hicolor/ are now removed
  - Desktop database and icon caches are refreshed after uninstall
  - GNOME Shell and KDE Plasma are notified to refresh their app lists

## [0.8.2] - 2026-01-04

### Fixed
- Linux: Fixed duplicate window appearing briefly when clicking dock/dash icon after closing window
  - Activate event handler was incorrectly registered inside createWindow, causing listeners to accumulate
  - Now uses same showMainWindow() function as tray icon for consistent behavior
- Linux: Fixed app icon appearing too large in dash/dock compared to other apps
  - Reduced icon size from 80% to 68% of canvas (16% margins instead of 10%)
  - Now matches proportions of other desktop applications in GNOME/KDE

## [0.8.1] - 2026-01-04

### Fixed
- Windows: Fixed taskbar icon showing as missing after app updates
  - NSIS installer now updates existing pinned shortcuts to point to the new executable
  - Preserves pinned status while refreshing the shortcut target path
- Linux: Restart to update now works for deb and rpm package installs
  - Downloads the correct package type and installs with pkexec (graphical sudo)
  - Previously only worked for AppImage installs
- Linux: Added detection for Snap and Flatpak installs

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