import { app, BrowserWindow, BrowserView, ipcMain, Notification, Menu, nativeImage, screen, dialog, systemPreferences, Tray, shell, nativeTheme } from 'electron';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';

const execAsync = promisify(exec);
import * as path from 'path';
import * as fs from 'fs';
import { NotificationHandler } from './notification-handler';
import { BadgeManager } from './badge-manager';
import { BackgroundService } from './background-service';
import { autoUpdater } from 'electron-updater';

// On Linux AppImage: fork and detach from terminal so the command returns immediately
// This must happen before single instance lock is acquired
if (process.platform === 'linux' && process.env.APPIMAGE && !process.env.MESSENGER_FORKED) {
  const child = spawn(process.argv[0], process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MESSENGER_FORKED: '1' }
  });
  child.unref();
  process.exit(0);
}

const resetFlag =
  process.argv.includes('--reset-window') ||
  process.argv.includes('--reset'); // legacy
const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

const appStartTime = Date.now();
console.log(`[App] Starting at ${appStartTime} on ${process.platform} ${process.arch}`);

// In dev mode, kill any existing production Messenger instances to avoid conflicts
if (isDev) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      // Kill production Messenger.exe (but not this Electron dev process)
      // Look for Messenger.exe in Program Files or LocalAppData (installed locations)
      execSync('taskkill /F /IM "Messenger.exe" /FI "WINDOWTITLE ne electron*"', { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      // Kill production Messenger.app (but not this dev process)
      // pkill with -f matches the full path, so we target /Applications/Messenger.app
      execSync('pkill -f "/Applications/Messenger.app" || true', { stdio: 'ignore' });
    } else {
      // Linux: kill any Messenger process from installed location
      execSync('pkill -f "/opt/Messenger" || pkill -f "messenger-desktop" || true', { stdio: 'ignore' });
    }
    console.log('[Dev Mode] Killed any existing production Messenger instances');
  } catch {
    // Ignore errors - process might not exist
  }
}

let mainWindow: BrowserWindow | null = null;
let contentView: BrowserView | null = null;
let notificationHandler: NotificationHandler;
let badgeManager: BadgeManager;
let backgroundService: BackgroundService;
let isQuitting = false;
let resetApplied = false;
let manualUpdateCheckInProgress = false;
let updateDownloadedAndReady = false;
let tray: Tray | null = null;
let titleOverlay: BrowserView | null = null;
let isCreatingWindow = false; // Guard against race conditions during window creation
let lastShowWindowTime = 0; // Debounce for showMainWindow to prevent double window on Linux
let appReady = false; // Flag to indicate app is fully initialized (window created)
let pendingShowWindow = false; // Queue second-instance events that arrive before app is ready
const overlayHeight = 32;

type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

const defaultWindowState: WindowState = {
  width: 1000,
  height: 750,
};

// Set app name early and explicitly pin userData/log paths so they don't default to the package name
const APP_DIR_NAME = 'Messenger';
app.setName(APP_DIR_NAME);

// Set AppUserModelId for Windows taskbar icon and grouping (must be set before app is ready)
if (process.platform === 'win32') {
  app.setAppUserModelId('com.facebook.messenger.desktop');
}

const userDataPath = path.join(app.getPath('appData'), APP_DIR_NAME);
app.setPath('userData', userDataPath);
app.setPath('logs', path.join(userDataPath, 'logs'));

const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
const movePromptFile = path.join(app.getPath('userData'), 'move-to-applications-prompted.json');
const notificationPermissionFile = path.join(app.getPath('userData'), 'notification-permission-requested.json');
const snapHelpShownFile = path.join(app.getPath('userData'), 'snap-help-shown.json');

// Request single instance lock early (before app.whenReady) to prevent race conditions
// on Linux/Windows where multiple instances might start before lock is checked
const gotTheLock = app.requestSingleInstanceLock();
console.log(`[SingleInstance] Lock acquired: ${gotTheLock}`);
if (!gotTheLock) {
  // Another instance is already running - quit immediately
  console.log('[SingleInstance] Another instance is already running, quitting...');
  app.quit();
} else {
  // Handle second instance attempts - show existing window or create one
  // Uses showMainWindow() for consistent behavior with tray icon click
  app.on('second-instance', () => {
    const now = Date.now();
    console.log(`[SecondInstance] Event fired at ${now}`);
    console.log(`[SecondInstance] State: appReady=${appReady}, isCreatingWindow=${isCreatingWindow}, mainWindow=${mainWindow ? 'exists' : 'null'}, pendingShowWindow=${pendingShowWindow}`);
    
    // If app isn't ready yet, queue the request instead of calling showMainWindow immediately
    // This prevents race conditions on Linux where second-instance fires before window is created
    if (!appReady) {
      console.log('[SecondInstance] App not ready yet, queuing show request');
      pendingShowWindow = true;
      return;
    }
    console.log('[SecondInstance] Calling showMainWindow()');
    showMainWindow('second-instance');
  });
}

const uninstallTargets = () => {
  // Only remove app-owned temp directory to avoid touching system temp roots
  const tempDir = path.join(app.getPath('temp'), app.getName());

  // Collect all data directories - cache is often in a different location than userData!
  // Windows: userData = %APPDATA%\Messenger, cache = %LOCALAPPDATA%\Messenger
  // macOS: userData = ~/Library/Application Support/Messenger, cache = ~/Library/Caches/Messenger
  // Linux: userData = ~/.config/Messenger, cache = ~/.cache/Messenger
  const targets = [
    { label: 'User data', path: app.getPath('userData') },
    { label: 'Temporary files', path: tempDir },
    { label: 'Logs', path: app.getPath('logs') },
    { label: 'Crash dumps', path: app.getPath('crashDumps') },
  ];

  // Add platform-specific cache directory (separate from userData!)
  // This is where Chromium stores browser cache, GPU cache, etc.
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    // Windows: cache is in LocalAppData (not Roaming AppData where userData lives)
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      targets.push({ label: 'Cache', path: path.join(localAppData, APP_DIR_NAME) });
    }
  } else if (process.platform === 'darwin') {
    // macOS: cache is in ~/Library/Caches/ (not Application Support where userData lives)
    targets.push({ label: 'Cache', path: path.join(homeDir, 'Library', 'Caches', APP_DIR_NAME) });
    // Clean up all other macOS system directories that may contain app data
    const bundleId = 'com.facebook.messenger.desktop';
    targets.push({ label: 'Saved app state', path: path.join(homeDir, 'Library', 'Saved Application State', `${bundleId}.savedState`) });
    targets.push({ label: 'Preferences', path: path.join(homeDir, 'Library', 'Preferences', `${bundleId}.plist`) });
    targets.push({ label: 'HTTP storage', path: path.join(homeDir, 'Library', 'HTTPStorages', bundleId) });
    targets.push({ label: 'WebKit data', path: path.join(homeDir, 'Library', 'WebKit', bundleId) });
  } else {
    // Linux: cache is in ~/.cache/ (not ~/.config/ where userData lives)
    targets.push({ label: 'Cache', path: path.join(homeDir, '.cache', APP_DIR_NAME) });
    // Also clean ~/.local/share which some Electron apps use
    targets.push({ label: 'Local data', path: path.join(homeDir, '.local', 'share', APP_DIR_NAME) });
    // Clean up user-specific desktop entries that might have been created
    // These can persist after package removal and leave ghost icons in app menus
    const linuxPkgName = 'facebook-messenger-desktop';
    targets.push({ label: 'Desktop entry', path: path.join(homeDir, '.local', 'share', 'applications', `${linuxPkgName}.desktop`) });
    targets.push({ label: 'Desktop entry (alt)', path: path.join(homeDir, '.local', 'share', 'applications', 'Messenger.desktop') });
    // User icon directories (in case icons were copied there)
    targets.push({ label: 'User icons', path: path.join(homeDir, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', `${linuxPkgName}.png`) });
    targets.push({ label: 'User icons', path: path.join(homeDir, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', `${linuxPkgName}.png`) });
  }

  // Add sessionData if different from userData (Electron 28+)
  try {
    const sessionDataPath = app.getPath('sessionData');
    if (sessionDataPath && sessionDataPath !== app.getPath('userData')) {
      targets.push({ label: 'Session data', path: sessionDataPath });
    }
  } catch {
    // sessionData path not available in older Electron versions
  }

  // Deduplicate paths (some paths like logs may be inside userData)
  const uniquePaths = new Map<string, { label: string; path: string }>();
  for (const target of targets) {
    if (target.path && !uniquePaths.has(target.path)) {
      uniquePaths.set(target.path, target);
    }
  }

  return Array.from(uniquePaths.values());
};

function scheduleExternalCleanup(paths: string[]): void {
  const filtered = paths.filter(Boolean);
  if (filtered.length === 0) return;

  if (process.platform === 'win32') {
    // Build PowerShell commands to delete each path
    // Use separate Remove-Item calls for reliability, and handle paths that may not exist
    const deleteCommands = filtered.map((p) => {
      // Escape single quotes in paths for PowerShell
      const escaped = p.replace(/'/g, "''");
      return `if (Test-Path -LiteralPath '${escaped}') { Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction SilentlyContinue }`;
    }).join('; ');
    
    const cmd = `Start-Sleep -Seconds 2; ${deleteCommands}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const quoted = filtered.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(' ');
  const child = spawn('/bin/sh', ['-c', `sleep 2; rm -rf ${quoted}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// Schedule moving the macOS app bundle to Trash after the app quits
function scheduleMacAppTrash(): void {
  if (process.platform !== 'darwin' || isDev) return;

  // Get the path to the .app bundle
  const exePath = app.getPath('exe');
  // exe is inside Messenger.app/Contents/MacOS/Messenger, so go up 3 levels
  const appBundlePath = path.resolve(exePath, '../../..');
  
  // Only proceed if it looks like a .app bundle
  if (!appBundlePath.endsWith('.app')) {
    console.log('[Uninstall] Not a .app bundle, skipping trash:', appBundlePath);
    return;
  }

  console.log('[Uninstall] Scheduling app bundle for Trash:', appBundlePath);

  // Use AppleScript to move to Trash (safer, recoverable)
  // Wait for app to quit, then move to Trash
  const script = `sleep 2; osascript -e 'tell application "Finder" to delete POSIX file "${appBundlePath}"' 2>/dev/null || true`;
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// Schedule running the Windows uninstaller after the app quits
function scheduleWindowsUninstaller(): void {
  if (process.platform !== 'win32' || isDev) return;

  // NSIS uninstaller is in the app installation directory
  const installDir = path.dirname(app.getPath('exe'));
  const uninstallerPath = path.join(installDir, 'Uninstall Messenger.exe');

  if (!fs.existsSync(uninstallerPath)) {
    console.log('[Uninstall] Uninstaller not found:', uninstallerPath);
    return;
  }

  console.log('[Uninstall] Scheduling uninstaller:', uninstallerPath);

  // Create a temporary VBS script to run the uninstaller with elevation
  // VBS is more reliable for UAC elevation than PowerShell when the parent process exits
  const tempDir = app.getPath('temp');
  const vbsPath = path.join(tempDir, 'messenger-uninstall.vbs');
  
  // VBS script that waits for the app to exit, then runs the uninstaller elevated
  // Using ShellExecute with "runas" verb triggers UAC properly
  // Note: VBS doesn't need backslash escaping, but we need to escape quotes by doubling them
  const vbsContent = `
Set WshShell = CreateObject("WScript.Shell")
WScript.Sleep 2000
Set objShell = CreateObject("Shell.Application")
objShell.ShellExecute "${uninstallerPath.replace(/"/g, '""')}", "/S", "", "runas", 1
`;

  try {
    fs.writeFileSync(vbsPath, vbsContent.trim(), 'utf8');
    console.log('[Uninstall] Created uninstall script:', vbsPath);
    
    // Run the VBS script detached
    const child = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    console.error('[Uninstall] Failed to create uninstall script:', err);
  }
}

function removeFromDockAndTaskbar(): void {
  if (process.platform === 'darwin') {
    // Remove from macOS dock by editing the dock plist directly
    // Find and remove only the Messenger entry from persistent-apps
    const homeDir = process.env.HOME || '';
    const dockPlist = path.join(homeDir, 'Library', 'Preferences', 'com.apple.dock.plist');
    
    // Use a shell script that finds and removes Messenger from the dock
    const script = `
      PLIST="${dockPlist}"
      if [ -f "$PLIST" ]; then
        # Count persistent-apps entries
        COUNT=$(/usr/libexec/PlistBuddy -c "Print persistent-apps" "$PLIST" 2>/dev/null | grep -c "Dict" || echo "0")
        
        # Search backwards to safely remove entries (indices shift when removing)
        for ((i=COUNT-1; i>=0; i--)); do
          LABEL=$(/usr/libexec/PlistBuddy -c "Print persistent-apps:$i:tile-data:file-label" "$PLIST" 2>/dev/null || echo "")
          if [ "$LABEL" = "Messenger" ]; then
            /usr/libexec/PlistBuddy -c "Delete persistent-apps:$i" "$PLIST" 2>/dev/null
          fi
        done
        
        # Restart Dock to apply changes
        killall Dock 2>/dev/null || true
      fi
    `;
    
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else if (process.platform === 'win32') {
    // Remove from Windows taskbar by deleting the pinned shortcut
    const taskbarPath = path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Internet Explorer',
      'Quick Launch',
      'User Pinned',
      'TaskBar'
    );
    
    // Delete any Messenger shortcuts from the taskbar
    const cmd = `
      $taskbarPath = "${taskbarPath.replace(/\\/g, '\\\\')}"
      if (Test-Path $taskbarPath) {
        Get-ChildItem -Path $taskbarPath -Filter "*Messenger*" | Remove-Item -Force -ErrorAction SilentlyContinue
      }
    `;
    
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }
}

function loadWindowState(): WindowState {
  // If explicitly requested, clear saved state to force defaults (window size/position only)
  if (resetFlag && !resetApplied && fs.existsSync(windowStateFile)) {
    try {
      fs.rmSync(windowStateFile);
      console.log('[Window State] Cleared stored state for reset flag');
      resetApplied = true;
    } catch (e) {
      console.warn('[Window State] Failed to clear state for reset flag:', e);
    }
  }

  try {
    if (fs.existsSync(windowStateFile)) {
      const raw = fs.readFileSync(windowStateFile, 'utf8');
      const parsed = JSON.parse(raw) as WindowState;
      console.log('[Window State] Loaded state', parsed);
      // Basic validation
      if (parsed.width && parsed.height) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[Window State] Failed to load state, using defaults:', e);
  }
  console.log('[Window State] Using default state', defaultWindowState);
  return { ...defaultWindowState };
}

function saveWindowState(bounds: Electron.Rectangle): void {
  try {
    fs.writeFileSync(windowStateFile, JSON.stringify({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }));
  } catch (e) {
    console.warn('[Window State] Failed to save state:', e);
  }
}

function ensureWindowInBounds(state: WindowState): WindowState {
  const display = screen.getDisplayMatching({
    x: state.x ?? 0,
    y: state.y ?? 0,
    width: state.width,
    height: state.height,
  });
  const { x, y, width, height } = display.workArea;

  const safeWidth = Math.min(state.width, width);
  const safeHeight = Math.min(state.height, height);

  const centeredX = Math.round(x + (width - safeWidth) / 2);
  const centeredY = Math.round(y + (height - safeHeight) / 2);

  const safeX = Math.max(x, Math.min((state.x ?? centeredX), x + width - safeWidth));
  const safeY = Math.max(y, Math.min((state.y ?? centeredY), y + height - safeHeight));

  return { x: safeX, y: safeY, width: safeWidth, height: safeHeight };
}

function getOverlayColors(): { background: string; text: string; symbols: string } {
  const isDark = nativeTheme.shouldUseDarkColors;
  // Colors matched to Messenger's actual background colors
  return isDark
    ? { background: '#1a1a1a', text: '#f5f5f7', symbols: '#f5f5f7' }
    : { background: '#f5f5f5', text: '#1c1c1e', symbols: '#1c1c1e' };
}

function createWindow(source: string = 'unknown'): void {
  const now = Date.now();
  const windowState = mainWindow 
    ? (mainWindow.isDestroyed() ? 'destroyed' : 'exists')
    : 'null';
  
  console.log(`[CreateWindow] Called from: ${source} at ${now}`);
  console.log(`[CreateWindow] Pre-check state: mainWindow=${windowState}, isCreatingWindow=${isCreatingWindow}`);
  
  // Guard against creating multiple windows due to race conditions
  // (e.g., second-instance + activate firing simultaneously on Linux)
  if (isCreatingWindow || (mainWindow && !mainWindow.isDestroyed())) {
    console.log(`[CreateWindow] BLOCKED - isCreatingWindow=${isCreatingWindow}, mainWindow=${windowState}`);
    return;
  }
  
  console.log('[CreateWindow] Guard passed, setting isCreatingWindow=true');
  isCreatingWindow = true;
  
  const restoredState = ensureWindowInBounds(loadWindowState());
  const hasPosition = restoredState.x !== undefined && restoredState.y !== undefined;
  const isMac = process.platform === 'darwin';
  const colors = getOverlayColors();

  mainWindow = new BrowserWindow({
    width: restoredState.width,
    height: restoredState.height,
    x: hasPosition ? restoredState.x : undefined,
    y: hasPosition ? restoredState.y : undefined,
    center: !hasPosition,
    minWidth: 725,
    minHeight: 400,
    title: 'Messenger',
    // Only set custom icon in production - dev mode uses default Electron icon
    icon: isDev ? undefined : getIconPath(),
    // Use native hidden inset style on macOS to remove the separator while keeping drag area/buttons
    // Use default frame on Windows/Linux for standard title bar and menu
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          titleBarOverlay: {
            color: colors.background,
            symbolColor: colors.symbols,
            height: overlayHeight,
          },
          trafficLightPosition: { x: 12, y: 10 },
          backgroundColor: colors.background,
        }
      : {
          // Windows/Linux: use standard frame with visible menu bar
          frame: true,
          autoHideMenuBar: false,
        }),
    webPreferences: {
      // On macOS, main window doesn't load web content (we use BrowserView)
      // On other platforms, load directly with preload
      preload: !isMac ? path.join(__dirname, '../preload/preload.js') : undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !isMac ? false : undefined,
      webSecurity: true,
      spellcheck: !isMac ? true : undefined,
      enableWebSQL: false,
    },
  });

  // Explicitly set window icon for Windows/Linux taskbar (production only)
  // Dev mode uses default Electron icon for consistency across platforms
  if (!isMac && !isDev) {
    const windowIcon = getWindowIcon();
    if (windowIcon) {
      mainWindow.setIcon(windowIcon);
      console.log('[Icon] Window icon set successfully');
    }
    
    // On Windows, re-apply icon after window is ready to fix blank icon after auto-update
    // Windows caches icons by path, and after an update the executable path changes
    // Re-applying the icon after ready-to-show ensures Windows refreshes its cache
    if (process.platform === 'win32') {
      mainWindow.once('ready-to-show', () => {
        const icon = getWindowIcon();
        if (icon && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setIcon(icon);
          console.log('[Icon] Windows taskbar icon re-applied after ready-to-show');
        }
      });
      
      // Also re-apply icon when window is shown (handles case where window was hidden)
      mainWindow.on('show', () => {
        const icon = getWindowIcon();
        if (icon && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setIcon(icon);
        }
      });
    }
  }

  // On macOS, use BrowserView for content with title bar overlay on top
  // Hybrid approach: content pushed down partially, overlay covers rest + some of Messenger's top UI
  // On other platforms, load directly in the main window
  const windowBounds = mainWindow.getBounds();
  const contentOffset = 16; // Content pushed down 16px; overlay (24px) covers 16px dedicated + 8px of content

  if (isMac) {
    // Create content BrowserView for messenger.com
    contentView = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        spellcheck: true,
        enableWebSQL: false,
      },
    });

    mainWindow.addBrowserView(contentView);
    // Content starts at y=contentOffset; overlay sits on top covering the gap + some of Messenger's UI
    contentView.setBounds({
      x: 0,
      y: contentOffset,
      width: windowBounds.width,
      height: windowBounds.height - contentOffset,
    });
    contentView.setAutoResize({ width: true, height: true });

    // Set up permission handler on content view's session
    contentView.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const url = webContents.getURL();
      
      if (!url.startsWith('https://www.messenger.com')) {
        console.log(`[Permissions] Denied ${permission} for non-messenger URL: ${url}`);
        callback(false);
        return;
      }

      const allowedPermissions = [
        'media',
        'mediaKeySystem',
        'notifications',
        'fullscreen',
        'pointerLock',
      ];

      if (allowedPermissions.includes(permission)) {
        console.log(`[Permissions] Allowing ${permission} for messenger.com`);
        callback(true);
      } else {
        console.log(`[Permissions] Denied ${permission} - not in allowlist`);
        callback(false);
      }
    });

    contentView.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (requestingOrigin.startsWith('https://www.messenger.com')) {
        const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock'];
        return allowedPermissions.includes(permission);
      }
      return false;
    });

    // Load messenger.com in content view
    contentView.webContents.loadURL('https://www.messenger.com');

    // Handle new window requests (target="_blank" links, window.open, etc.)
    // Open external URLs in system browser instead of new Electron windows
    contentView.webContents.setWindowOpenHandler(({ url }) => {
      // Open all URLs in system browser - this is the standard behavior for wrapped web apps
      shell.openExternal(url).catch((err) => {
        console.error('[External Link] Failed to open URL:', url, err);
      });
      return { action: 'deny' };
    });

    // Inject notification override script after page loads
    contentView.webContents.on('did-finish-load', async () => {
      try {
        await contentView?.webContents.executeJavaScript(`
          (function() {
            window.__electronNotificationBridge = function(data) {
              const event = new CustomEvent('electron-notification', { detail: data });
              window.dispatchEvent(event);
            };
            window.addEventListener('electron-notification', function(event) {
              window.postMessage({ type: 'electron-notification', data: event.detail }, '*');
            });
            console.log('[Notification Bridge] Bridge function and listener installed');
          })();
        `);

        const notificationScriptPath = path.join(__dirname, '../preload/notifications-inject.js');
        if (fs.existsSync(notificationScriptPath)) {
          const notificationScript = fs.readFileSync(notificationScriptPath, 'utf8');
          await contentView?.webContents.executeJavaScript(notificationScript);
          console.log('[Main Process] Notification override script injected successfully');
        } else {
          console.warn('[Main Process] Notification script not found at:', notificationScriptPath);
        }
      } catch (error) {
        console.error('[Main Process] Failed to inject notification script:', error);
      }
    });

    // Update title bar overlay when page title changes (e.g., "(5) Messenger" for unread counts)
    contentView.webContents.on('page-title-updated', (event, title) => {
      updateTitleOverlayText(title);
      // Also update the main window title for dock/taskbar
      if (mainWindow) {
        mainWindow.setTitle(title);
      }
    });

    // Handle window resize to maintain correct content bounds
    mainWindow.on('resize', () => {
      if (!mainWindow || !contentView) return;
      const bounds = mainWindow.getBounds();
      contentView.setBounds({
        x: 0,
        y: contentOffset,
        width: bounds.width,
        height: bounds.height - contentOffset,
      });
    });
  } else {
    // Non-macOS: load directly in main window (standard frame)
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const url = webContents.getURL();
      
      if (!url.startsWith('https://www.messenger.com')) {
        console.log(`[Permissions] Denied ${permission} for non-messenger URL: ${url}`);
        callback(false);
        return;
      }

      const allowedPermissions = [
        'media',
        'mediaKeySystem',
        'notifications',
        'fullscreen',
        'pointerLock',
      ];

      if (allowedPermissions.includes(permission)) {
        console.log(`[Permissions] Allowing ${permission} for messenger.com`);
        callback(true);
      } else {
        console.log(`[Permissions] Denied ${permission} - not in allowlist`);
        callback(false);
      }
    });

    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (requestingOrigin.startsWith('https://www.messenger.com')) {
        const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock'];
        return allowedPermissions.includes(permission);
      }
      return false;
    });

    mainWindow.loadURL('https://www.messenger.com');

    // Handle new window requests (target="_blank" links, window.open, etc.)
    // Open external URLs in system browser instead of new Electron windows
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url).catch((err) => {
        console.error('[External Link] Failed to open URL:', url, err);
      });
      return { action: 'deny' };
    });

    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        await mainWindow?.webContents.executeJavaScript(`
          (function() {
            window.__electronNotificationBridge = function(data) {
              const event = new CustomEvent('electron-notification', { detail: data });
              window.dispatchEvent(event);
            };
            window.addEventListener('electron-notification', function(event) {
              window.postMessage({ type: 'electron-notification', data: event.detail }, '*');
            });
            console.log('[Notification Bridge] Bridge function and listener installed');
          })();
        `);

        const notificationScriptPath = path.join(__dirname, '../preload/notifications-inject.js');
        if (fs.existsSync(notificationScriptPath)) {
          const notificationScript = fs.readFileSync(notificationScriptPath, 'utf8');
          await mainWindow?.webContents.executeJavaScript(notificationScript);
          console.log('[Main Process] Notification override script injected successfully');
        } else {
          console.warn('[Main Process] Notification script not found at:', notificationScriptPath);
        }
      } catch (error) {
        console.error('[Main Process] Failed to inject notification script:', error);
      }
    });

    // Update window title when page title changes (for dock/taskbar)
    mainWindow.webContents.on('page-title-updated', (event, title) => {
      if (mainWindow) {
        mainWindow.setTitle(title);
      }
    });
  }

  // Handle window closed
  mainWindow.on('closed', () => {
    // Window is already destroyed at this point, just clean up references
    titleOverlay = null;
    contentView = null;
    mainWindow = null;
  });

  // Handle window close
  mainWindow.on('close', (event: Electron.Event) => {
    const bounds = mainWindow?.getBounds();
    if (bounds) {
      console.log('[Window State] Saving state', bounds);
      saveWindowState(bounds);
    }

    if (!isQuitting) {
      event.preventDefault();
      if (process.platform === 'darwin') {
        // macOS: standard behavior - hide app but keep in dock
        app.hide();
      } else if (tray) {
        // Windows/Linux with tray: hide to system tray
        mainWindow?.hide();
      } else {
        // Windows/Linux without tray: minimize to taskbar instead of hiding
        // This ensures users can still access the app via taskbar
        mainWindow?.minimize();
      }
      return;
    }
  });

  if (isMac && mainWindow) {
    setupTitleOverlay(mainWindow, overlayHeight);
    nativeTheme.on('updated', () => {
      if (!mainWindow) return;
      const colors = getOverlayColors();
      mainWindow.setTitleBarOverlay?.({
        color: colors.background,
        symbolColor: colors.symbols,
        height: overlayHeight,
      });
      mainWindow.setBackgroundColor(colors.background);
      updateTitleOverlayColors();
    });
  }

  // Window creation complete
  console.log(`[CreateWindow] Complete at ${Date.now()}, setting isCreatingWindow=false`);
  isCreatingWindow = false;
}

function getIconPath(): string | undefined {
  // Determine platform-specific icon file for BrowserWindow constructor
  // Windows: .ico works in BrowserWindow, macOS: uses app bundle icon, Linux: .png
  // Note: For BrowserWindow on Windows, .ico is preferred
  const platformIcon = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  
  const appPath = app.getAppPath();
  
  // Try platform-specific icon first, then fall back to .png
  const possiblePaths: string[] = [
    // Packaged app paths
    path.join(appPath, 'assets/icons', platformIcon),
    // Development paths (relative to dist/main/)
    path.join(__dirname, '../../assets/icons', platformIcon),
    // Development paths (relative to project root)
    path.join(process.cwd(), 'assets/icons', platformIcon),
    // Fallback to PNG
    path.join(appPath, 'assets/icons/icon.png'),
    path.join(__dirname, '../../assets/icons/icon.png'),
    path.join(process.cwd(), 'assets/icons/icon.png'),
  ];
  
  // Find the first existing icon file
  try {
    for (const iconPath of possiblePaths) {
      if (fs.existsSync(iconPath)) {
        console.log(`[Icon] Found icon for BrowserWindow: ${iconPath}`);
        return iconPath;
      }
    }
    console.warn('[Icon] No icon found for BrowserWindow');
  } catch (e) {
    console.error('[Icon] Error checking icon paths:', e);
  }
  
  return undefined;
}

function getWindowIcon(): Electron.NativeImage | undefined {
  // For Windows taskbar, ICO files work better as they contain multiple sizes
  // For Linux, PNG is the standard format
  const appPath = app.getAppPath();
  
  // On Windows, try ICO first (contains multiple sizes for taskbar), then PNG
  // On Linux, use PNG
  const iconFiles = process.platform === 'win32' 
    ? ['icon.ico', 'icon.png'] 
    : ['icon.png'];
  
  const possiblePaths: string[] = [];
  for (const iconFile of iconFiles) {
    possiblePaths.push(
      path.join(appPath, 'assets/icons', iconFile),
      path.join(__dirname, '../../assets/icons', iconFile),
      path.join(process.cwd(), 'assets/icons', iconFile),
    );
  }
  
  for (const iconPath of possiblePaths) {
    if (fs.existsSync(iconPath)) {
      try {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          console.log('[Icon] Created nativeImage from:', iconPath);
          return icon;
        }
        console.warn('[Icon] Icon image is empty:', iconPath);
      } catch (e) {
        console.error('[Icon] Failed to create nativeImage:', e);
      }
    }
  }
  
  console.warn('[Icon] No valid icon found for nativeImage');
  return undefined;
}

function getTrayIconPath(): string | undefined {
  const trayDir = path.join(app.getAppPath(), 'assets', 'tray');
  const devTrayDir = path.join(process.cwd(), 'assets', 'tray');

  const platformIcon =
    process.platform === 'win32'
      ? 'icon.ico'
      : process.platform === 'darwin'
      ? 'iconTemplate.png'
      : 'icon-rounded.png';  // Linux: use the nicer rounded icon

  const possiblePaths = [
    path.join(trayDir, platformIcon),
    path.join(devTrayDir, platformIcon),
  ];

  try {
    for (const iconPath of possiblePaths) {
      if (fs.existsSync(iconPath)) {
        return iconPath;
      }
    }
  } catch (e) {
    console.warn('[Tray] Failed to resolve tray icon path', e);
  }

  return undefined;
}

function showMainWindow(source: string = 'unknown'): void {
  const now = Date.now();
  const timeSinceLast = now - lastShowWindowTime;
  const windowState = mainWindow 
    ? (mainWindow.isDestroyed() ? 'destroyed' : `exists(visible=${mainWindow.isVisible()},minimized=${mainWindow.isMinimized()})`)
    : 'null';
  
  console.log(`[ShowWindow] Called from: ${source}`);
  console.log(`[ShowWindow] Time: ${now}, since last: ${timeSinceLast}ms`);
  console.log(`[ShowWindow] State: mainWindow=${windowState}, isCreatingWindow=${isCreatingWindow}, appReady=${appReady}`);
  
  // Debounce: On Linux, rapid clicks on dock/dash icon can trigger multiple second-instance events.
  // Use a longer debounce (1 second) to catch double-clicks and rapid repeated clicks.
  if (timeSinceLast < 1000) {
    console.log(`[ShowWindow] DEBOUNCED - only ${timeSinceLast}ms since last call`);
    return;
  }
  lastShowWindowTime = now;
  
  // Check if window exists and is not destroyed
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log('[ShowWindow] Window exists and not destroyed - showing and focusing');
    if (mainWindow.isMinimized()) {
      console.log('[ShowWindow] Window was minimized, restoring');
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  
  // Don't create a new window if one is already being created (race condition guard)
  if (isCreatingWindow) {
    console.log('[ShowWindow] BLOCKED - window creation already in progress');
    return;
  }
  
  // Clean up stale reference if window was destroyed
  if (mainWindow) {
    console.log('[ShowWindow] Cleaning up destroyed window reference');
    mainWindow = null;
  }
  
  console.log('[ShowWindow] Creating new window...');
  createWindow(source);
}

function createTray(): void {
  if (process.platform === 'darwin' || tray) {
    return;
  }

  const trayIconPath = getTrayIconPath();
  if (!trayIconPath) {
    console.warn('[Tray] No tray icon found, skipping tray creation');
    return;
  }

  console.log('[Tray] Creating tray with icon:', trayIconPath);

  try {
    const trayIcon = nativeImage.createFromPath(trayIconPath);
    if (trayIcon.isEmpty()) {
      console.warn('[Tray] Icon loaded but is empty, path:', trayIconPath);
      return;
    }
    
    tray = new Tray(trayIcon);
    tray.setToolTip('Messenger');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Messenger',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    
    // On Windows, single-click shows the app (more intuitive than double-click)
    // On Linux, keep double-click as single-click typically shows context menu
    if (process.platform === 'win32') {
      tray.on('click', () => showMainWindow('tray-click'));
    } else {
      tray.on('double-click', () => showMainWindow('tray-double-click'));
    }
    
    console.log('[Tray] Tray created successfully');
  } catch (e) {
    console.warn('[Tray] Failed to create tray', e);
  }
}

// Package manager constants
const HOMEBREW_CASK = 'apotenza92/tap/facebook-messenger-desktop';
const WINGET_ID = 'apotenza92.FacebookMessengerDesktop';
const LINUX_PACKAGE_NAME = 'facebook-messenger-desktop';
const SNAP_PACKAGE_NAME = 'facebook-messenger-desktop';
const FLATPAK_APP_ID = 'com.facebook.messenger.desktop';

type PackageManagerInfo = {
  name: string;
  detected: boolean;
  uninstallCommand: string[];
};

// Cache file for install source detection (detected once on first run, never changes)
const INSTALL_SOURCE_CACHE_FILE = 'install-source.json';

type InstallSource = 'homebrew' | 'winget' | 'deb' | 'rpm' | 'snap' | 'flatpak' | 'direct';

function getInstallSourceCachePath(): string {
  return path.join(app.getPath('userData'), INSTALL_SOURCE_CACHE_FILE);
}

type InstallSourceCache = {
  source: InstallSource;
  version: string;
};

function readInstallSourceCache(): InstallSourceCache | null {
  try {
    const cachePath = getInstallSourceCachePath();
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(data);
      // Handle old cache format (just { source }) by treating it as version mismatch
      if (parsed.source && parsed.version) {
        return parsed as InstallSourceCache;
      }
    }
  } catch (error) {
    console.log('[InstallSource] Failed to read cache:', error instanceof Error ? error.message : 'unknown');
  }
  return null;
}

function writeInstallSourceCache(source: InstallSource): void {
  try {
    const cachePath = getInstallSourceCachePath();
    const cache: InstallSourceCache = { source, version: app.getVersion() };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    console.log('[InstallSource] Saved install source:', source, 'for version:', app.getVersion());
  } catch (error) {
    console.log('[InstallSource] Failed to write cache:', error instanceof Error ? error.message : 'unknown');
  }
}

// Detect install source on startup and cache it
// Re-detects if: no cache, cached as 'direct', or app version changed (possible reinstall via different method)
async function detectAndCacheInstallSource(): Promise<void> {
  // Skip in dev mode
  if (isDev) return;
  
  const cached = readInstallSourceCache();
  const currentVersion = app.getVersion();
  const versionChanged = cached && cached.version !== currentVersion;
  
  // Re-detect if:
  // 1. No cache (first run)
  // 2. Cached as 'direct' (user might have reinstalled via package manager)
  // 3. Version changed (user might have reinstalled via different method)
  const shouldRedetect = !cached || cached.source === 'direct' || versionChanged;
  
  if (!shouldRedetect) {
    console.log('[InstallSource] Using cached:', cached.source, '(version:', cached.version + ')');
    return;
  }
  
  const reason = !cached ? 'first run' : versionChanged ? `version changed ${cached.version} → ${currentVersion}` : 're-checking direct install';
  console.log('[InstallSource] Detecting install source...', `(${reason})`);
  
  try {
    if (process.platform === 'darwin') {
      const homebrew = await detectHomebrewInstall();
      const newSource = homebrew.detected ? 'homebrew' : 'direct';
      writeInstallSourceCache(newSource);
      console.log('[InstallSource] Detected:', newSource);
    } else if (process.platform === 'win32') {
      const winget = await detectWingetInstall();
      const newSource = winget.detected ? 'winget' : 'direct';
      writeInstallSourceCache(newSource);
      console.log('[InstallSource] Detected:', newSource);
    } else if (process.platform === 'linux') {
      // Check for containerized installs first (snap/flatpak), then system packages (deb/rpm)
      if (detectSnapInstall()) {
        writeInstallSourceCache('snap');
        console.log('[InstallSource] Detected: snap');
      } else if (detectFlatpakInstall()) {
        writeInstallSourceCache('flatpak');
        console.log('[InstallSource] Detected: flatpak');
      } else {
        // Check for .deb (Debian/Ubuntu), then .rpm (Fedora/RHEL)
        const deb = await detectDebInstall();
        if (deb.detected) {
          writeInstallSourceCache('deb');
          console.log('[InstallSource] Detected: deb');
        } else {
          const rpm = await detectRpmInstall();
          if (rpm.detected) {
            writeInstallSourceCache('rpm');
            console.log('[InstallSource] Detected: rpm');
          } else {
            writeInstallSourceCache('direct');
            console.log('[InstallSource] Detected: direct (AppImage or manual)');
          }
        }
      }
    } else {
      writeInstallSourceCache('direct');
      console.log('[InstallSource] Detected: direct');
    }
  } catch (error) {
    console.log('[InstallSource] Detection failed:', error instanceof Error ? error.message : 'unknown');
    // On failure, only write 'direct' if no cache exists - don't overwrite good data
    if (!cached) {
      writeInstallSourceCache('direct');
    }
  }
}

// Find brew executable - Electron apps launched from GUI don't have PATH from shell config
function findBrewExecutable(): string | null {
  const brewPaths = [
    '/opt/homebrew/bin/brew',  // Apple Silicon
    '/usr/local/bin/brew',      // Intel Mac
    '/home/linuxbrew/.linuxbrew/bin/brew', // Linux (unlikely but supported)
  ];
  
  for (const brewPath of brewPaths) {
    if (fs.existsSync(brewPath)) {
      console.log('[Homebrew] Found brew at:', brewPath);
      return brewPath;
    }
  }
  
  console.log('[Homebrew] brew not found in common locations');
  return null;
}

async function detectHomebrewInstall(): Promise<PackageManagerInfo> {
  const brewPath = findBrewExecutable();
  
  const result: PackageManagerInfo = {
    name: 'Homebrew',
    detected: false,
    uninstallCommand: brewPath 
      ? [brewPath, 'uninstall', '--cask', HOMEBREW_CASK]
      : ['brew', 'uninstall', '--cask', HOMEBREW_CASK],
  };
  
  if (process.platform !== 'darwin') {
    return result;
  }
  
  if (!brewPath) {
    console.log('[Uninstall] Homebrew not installed on this system');
    return result;
  }
  
  try {
    // Check if this cask is installed via Homebrew (use full path)
    await execAsync(`"${brewPath}" list --cask ${HOMEBREW_CASK}`);
    result.detected = true;
    console.log('[Uninstall] Detected Homebrew cask installation');
  } catch {
    // Command failed = not installed via Homebrew
    console.log('[Uninstall] Not installed via Homebrew');
  }
  
  return result;
}

async function detectWingetInstall(): Promise<PackageManagerInfo> {
  const result: PackageManagerInfo = {
    name: 'winget',
    detected: false,
    uninstallCommand: ['winget', 'uninstall', '--id', WINGET_ID, '--silent'],
  };
  
  if (process.platform !== 'win32') {
    return result;
  }
  
  try {
    // Check if this package is installed via winget (with 5 second timeout)
    const { stdout } = await execAsync(`winget list --id ${WINGET_ID} --accept-source-agreements`, { timeout: 5000 });
    // winget list returns the package info if found, check if our ID is in the output
    if (stdout.includes(WINGET_ID) || stdout.includes('FacebookMessengerDesktop')) {
      result.detected = true;
      console.log('[Uninstall] Detected winget installation');
    }
  } catch (error) {
    // Command failed, timed out, or winget not available
    console.log('[Uninstall] winget detection failed or timed out:', error instanceof Error ? error.message : 'unknown error');
  }
  
  return result;
}

async function detectDebInstall(): Promise<PackageManagerInfo> {
  const result: PackageManagerInfo = {
    name: 'apt (deb)',
    detected: false,
    // Use pkexec for graphical sudo prompt - use full paths for GUI environments
    uninstallCommand: ['/usr/bin/pkexec', '/usr/bin/apt', 'remove', '-y', LINUX_PACKAGE_NAME],
  };
  
  if (process.platform !== 'linux') {
    return result;
  }
  
  try {
    // Check if package is installed via dpkg
    // Use full path since GUI apps may not have /usr/bin in PATH
    const env = { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH || ''}` };
    const { stdout } = await execAsync(`/usr/bin/dpkg-query -W -f='\${Status}' ${LINUX_PACKAGE_NAME} 2>/dev/null`, { env });
    if (stdout.includes('install ok installed')) {
      result.detected = true;
      console.log('[Uninstall] Detected .deb package installation');
    }
  } catch {
    // Command failed = not installed via dpkg
    console.log('[Uninstall] Not installed via .deb package');
  }
  
  return result;
}

async function detectRpmInstall(): Promise<PackageManagerInfo> {
  const result: PackageManagerInfo = {
    name: 'dnf (rpm)',
    detected: false,
    // Use pkexec for graphical sudo prompt - use full paths for GUI environments
    uninstallCommand: ['/usr/bin/pkexec', '/usr/bin/dnf', 'remove', '-y', LINUX_PACKAGE_NAME],
  };
  
  if (process.platform !== 'linux') {
    return result;
  }
  
  try {
    // Check if package is installed via rpm
    // Use full path to rpm since GUI apps may not have /usr/bin in PATH
    // Also set PATH explicitly to handle various Linux environments
    const env = { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH || ''}` };
    await execAsync(`/usr/bin/rpm -q ${LINUX_PACKAGE_NAME}`, { env });
    result.detected = true;
    console.log('[Uninstall] Detected .rpm package installation');
  } catch {
    // Command failed = not installed via rpm
    console.log('[Uninstall] Not installed via .rpm package');
  }
  
  return result;
}

function detectSnapInstall(): boolean {
  // Snap apps run from /snap/ paths and have SNAP environment variable
  if (process.platform !== 'linux') {
    return false;
  }
  
  // Check for SNAP environment variable (set by snapd when running snap apps)
  if (process.env.SNAP) {
    console.log('[InstallSource] Detected Snap installation via SNAP env');
    return true;
  }
  
  // Also check if running from /snap/ path
  const execPath = process.execPath;
  if (execPath.startsWith('/snap/')) {
    console.log('[InstallSource] Detected Snap installation via exec path');
    return true;
  }
  
  return false;
}

function detectFlatpakInstall(): boolean {
  // Flatpak apps run with FLATPAK_ID environment variable
  if (process.platform !== 'linux') {
    return false;
  }
  
  // Check for FLATPAK_ID environment variable (set by Flatpak runtime)
  if (process.env.FLATPAK_ID) {
    console.log('[InstallSource] Detected Flatpak installation via FLATPAK_ID env');
    return true;
  }
  
  // Also check if running from Flatpak path
  const execPath = process.execPath;
  if (execPath.includes('/app/') && execPath.includes('flatpak')) {
    console.log('[InstallSource] Detected Flatpak installation via exec path');
    return true;
  }
  
  return false;
}

function detectPackageManagerFromCache(): PackageManagerInfo | null {
  // Read from cache (instant) instead of running slow detection commands
  const cached = readInstallSourceCache();
  const source = cached?.source;
  
  if (!source || source === 'direct') {
    console.log('[Uninstall] Install source:', source ?? 'not cached');
    return null;
  }
  
  if (source === 'homebrew' && process.platform === 'darwin') {
    const brewPath = findBrewExecutable();
    if (!brewPath) {
      console.log('[Uninstall] Homebrew cached but brew not found - falling back to direct uninstall');
      return null;
    }
    console.log('[Uninstall] Using cached Homebrew detection');
    return {
      name: 'Homebrew',
      detected: true,
      uninstallCommand: [brewPath, 'uninstall', '--cask', HOMEBREW_CASK],
    };
  }
  
  if (source === 'winget' && process.platform === 'win32') {
    console.log('[Uninstall] Using cached winget detection');
    return {
      name: 'winget',
      detected: true,
      uninstallCommand: ['winget', 'uninstall', '--id', WINGET_ID, '--silent'],
    };
  }
  
  if (source === 'deb' && process.platform === 'linux') {
    console.log('[Uninstall] Using cached .deb detection');
    return {
      name: 'apt (deb)',
      detected: true,
      uninstallCommand: ['/usr/bin/pkexec', '/usr/bin/apt', 'remove', '-y', LINUX_PACKAGE_NAME],
    };
  }
  
  if (source === 'rpm' && process.platform === 'linux') {
    console.log('[Uninstall] Using cached .rpm detection');
    return {
      name: 'dnf (rpm)',
      detected: true,
      uninstallCommand: ['/usr/bin/pkexec', '/usr/bin/dnf', 'remove', '-y', LINUX_PACKAGE_NAME],
    };
  }
  
  if (source === 'snap' && process.platform === 'linux') {
    console.log('[Uninstall] Using cached Snap detection');
    return {
      name: 'Snap',
      detected: true,
      uninstallCommand: ['/usr/bin/pkexec', '/usr/bin/snap', 'remove', SNAP_PACKAGE_NAME],
    };
  }
  
  if (source === 'flatpak' && process.platform === 'linux') {
    console.log('[Uninstall] Using cached Flatpak detection');
    return {
      name: 'Flatpak',
      detected: true,
      uninstallCommand: ['/usr/bin/flatpak', 'uninstall', '-y', FLATPAK_APP_ID],
    };
  }
  
  return null;
}

function runPackageManagerUninstall(pm: PackageManagerInfo): void {
  console.log(`[Uninstall] Running ${pm.name} uninstall:`, pm.uninstallCommand.join(' '));
  
  const [command, ...args] = pm.uninstallCommand;
  
  if (process.platform === 'win32') {
    // On Windows, run via cmd to ensure proper PATH resolution
    const child = spawn('cmd.exe', ['/c', ...pm.uninstallCommand], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else if (process.platform === 'linux' && (pm.name.includes('deb') || pm.name.includes('rpm'))) {
    // On Linux with deb/rpm, run uninstall followed by desktop/icon cache refresh
    // This ensures the app icon is properly removed from application menus
    const homeDir = process.env.HOME || '';
    const uninstallCmd = pm.uninstallCommand.join(' ');
    
    // Build comprehensive cleanup script:
    // 1. Run the package manager uninstall (with pkexec for authentication)
    // 2. Remove any lingering user desktop entries
    // 3. Refresh icon caches (both system and user)
    // 4. Update desktop database
    // 5. Kill any remaining Messenger processes
    const cleanupScript = `
      # Run package manager uninstall (this will show pkexec authentication dialog)
      ${uninstallCmd}
      UNINSTALL_EXIT=$?
      
      # Only proceed with cleanup if uninstall succeeded
      if [ $UNINSTALL_EXIT -eq 0 ]; then
        # Wait for package manager to finish
        sleep 1
        
        # Remove user-specific desktop entries that might persist
        rm -f "${homeDir}/.local/share/applications/${LINUX_PACKAGE_NAME}.desktop" 2>/dev/null
        rm -f "${homeDir}/.local/share/applications/Messenger.desktop" 2>/dev/null
        rm -f "${homeDir}/.local/share/applications/messenger.desktop" 2>/dev/null
        
        # Remove user icons if they exist
        rm -f "${homeDir}/.local/share/icons/hicolor/"*"/apps/${LINUX_PACKAGE_NAME}.png" 2>/dev/null
        rm -f "${homeDir}/.local/share/icons/hicolor/"*"/apps/messenger.png" 2>/dev/null
        
        # Clear pop-launcher cache (for Pop!_OS COSMIC)
        rm -rf "${homeDir}/.cache/pop-launcher/" 2>/dev/null || true
        rm -rf "${homeDir}/.local/share/pop-launcher/" 2>/dev/null || true
        
        # Clear COSMIC app cache
        rm -rf "${homeDir}/.cache/cosmic"* 2>/dev/null || true
        
        # Update user desktop database
        if command -v update-desktop-database >/dev/null 2>&1; then
          update-desktop-database "${homeDir}/.local/share/applications" 2>/dev/null || true
        fi
        
        # Refresh icon caches (user space - no sudo needed)
        if command -v gtk-update-icon-cache >/dev/null 2>&1; then
          gtk-update-icon-cache -f -t "${homeDir}/.local/share/icons/hicolor" 2>/dev/null || true
        fi
        
        # Force GNOME Shell to reload application list (if running GNOME)
        if command -v dbus-send >/dev/null 2>&1; then
          dbus-send --type=signal --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.AppLaunchContext 2>/dev/null || true
        fi
        
        # For KDE Plasma, touch the applications directory to trigger refresh
        touch "${homeDir}/.local/share/applications" 2>/dev/null || true
        
        # Kill any remaining Messenger processes (the app should already be hidden/closing)
        pkill -f "facebook-messenger-desktop" 2>/dev/null || true
        pkill -f "/opt/Messenger" 2>/dev/null || true
      fi
    `.trim();
    
    const child = spawn('/bin/sh', ['-c', cleanupScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else {
    // Note: Snap and Flatpak are handled by scheduleSnapUninstall() and scheduleFlatpakUninstall()
    // which are called from handleUninstallRequest() before this function
    // On macOS (Homebrew), spawn directly
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    child.unref();
  }
}

function scheduleSnapUninstall(): void {
  // Snap apps can't uninstall themselves while running due to sandbox confinement.
  // We schedule the uninstall to run AFTER the app exits.
  // CRITICAL: Normal detached processes don't survive Snap app exit due to cgroup cleanup.
  // We must use systemd-run to escape the Snap's process lifecycle management.
  const homeDir = process.env.HOME || '';
  
  // Write the uninstall script to a temp file so systemd-run can execute it
  const scriptPath = path.join('/tmp', `messenger-snap-uninstall-${Date.now()}.sh`);
  
  const uninstallScript = `#!/bin/sh
# Wait for the Messenger snap to fully exit
sleep 3

# Wait for any messenger processes to terminate (with timeout)
WAIT_COUNT=0
while pgrep -f "snap.*${SNAP_PACKAGE_NAME}" > /dev/null 2>&1; do
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $WAIT_COUNT -gt 30 ]; then
    break
  fi
done

# Additional wait to ensure snap daemon recognizes the app is closed
sleep 2

# Run snap remove with pkexec for authentication
/usr/bin/pkexec /usr/bin/snap remove ${SNAP_PACKAGE_NAME}
UNINSTALL_EXIT=$?

# Only proceed with cleanup if uninstall succeeded
if [ $UNINSTALL_EXIT -eq 0 ]; then
  sleep 2
  
  # Remove user-specific desktop entries that might persist
  rm -f "${homeDir}/.local/share/applications/${SNAP_PACKAGE_NAME}_"*.desktop 2>/dev/null
  rm -f "${homeDir}/.local/share/applications/${LINUX_PACKAGE_NAME}.desktop" 2>/dev/null
  rm -f "${homeDir}/.local/share/applications/Messenger.desktop" 2>/dev/null
  
  # Clear pop-launcher cache (for Pop!_OS COSMIC)
  rm -rf "${homeDir}/.cache/pop-launcher/" 2>/dev/null || true
  rm -rf "${homeDir}/.local/share/pop-launcher/" 2>/dev/null || true
  
  # Clear COSMIC app cache
  rm -rf "${homeDir}/.cache/cosmic"* 2>/dev/null || true
  
  # Update user desktop database
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${homeDir}/.local/share/applications" 2>/dev/null || true
  fi
  
  # Refresh icon caches
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "${homeDir}/.local/share/icons/hicolor" 2>/dev/null || true
  fi
  
  # Force desktop environment to reload application list
  if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --type=signal --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.AppLaunchContext 2>/dev/null || true
  fi
  
  touch "${homeDir}/.local/share/applications" 2>/dev/null || true
fi

# Clean up this script
rm -f "${scriptPath}"
`;

  try {
    // Write script to temp location (accessible outside snap sandbox)
    fs.writeFileSync(scriptPath, uninstallScript, { mode: 0o755 });
    console.log('[Uninstall] Wrote uninstall script to:', scriptPath);
    
    // Use systemd-run to schedule execution outside the Snap's cgroup
    // This ensures the process survives when the Snap app exits
    // --user: Run in user session (no root needed to start)
    // --scope: Run in a new scope that persists after we exit
    // --collect: Clean up the scope after the script finishes
    const child = spawn('/usr/bin/systemd-run', [
      '--user',
      '--scope',
      '--collect',
      '--description=Messenger Uninstaller',
      '/bin/sh', scriptPath,
    ], {
      detached: true,
      stdio: 'ignore',
      env: {
        // Minimal env outside snap
        HOME: homeDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DISPLAY: process.env.DISPLAY || ':0',
        XAUTHORITY: process.env.XAUTHORITY || `${homeDir}/.Xauthority`,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() || 1000}`,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '',
      },
    });
    child.unref();
    console.log('[Uninstall] Scheduled Snap uninstall via systemd-run');
  } catch (error) {
    console.error('[Uninstall] Failed to schedule snap uninstall:', error);
    // Fallback: try direct spawn (might not work but better than nothing)
    const child = spawn('/usr/bin/sh', ['-c', `sleep 3 && /usr/bin/pkexec /usr/bin/snap remove ${SNAP_PACKAGE_NAME}`], {
      detached: true,
      stdio: 'ignore',
      env: {
        HOME: homeDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DISPLAY: process.env.DISPLAY || ':0',
      },
    });
    child.unref();
    console.log('[Uninstall] Fallback: scheduled snap uninstall via direct spawn');
  }
}

function scheduleFlatpakUninstall(): void {
  // Flatpak apps run in a sandbox and may have issues uninstalling themselves while running.
  // We schedule the uninstall to run AFTER the app exits by spawning a detached process.
  const homeDir = process.env.HOME || '';
  
  // This script runs outside the Flatpak sandbox after the app quits
  const uninstallScript = `
    #!/bin/sh
    # Wait for the Messenger flatpak to fully exit
    sleep 2
    
    # Wait for any messenger processes to terminate
    while pgrep -f "${FLATPAK_APP_ID}" > /dev/null 2>&1; do
      sleep 1
    done
    
    # Additional wait to ensure flatpak recognizes the app is closed
    sleep 1
    
    # Run flatpak uninstall (no sudo needed for user installs, may prompt for system installs)
    /usr/bin/flatpak uninstall -y ${FLATPAK_APP_ID}
    UNINSTALL_EXIT=$?
    
    # Only proceed with cleanup if uninstall succeeded
    if [ $UNINSTALL_EXIT -eq 0 ]; then
      sleep 1
      
      # Remove user-specific desktop entries that might persist
      rm -f "${homeDir}/.local/share/applications/${FLATPAK_APP_ID}.desktop" 2>/dev/null
      rm -f "${homeDir}/.local/share/applications/${LINUX_PACKAGE_NAME}.desktop" 2>/dev/null
      rm -f "${homeDir}/.local/share/applications/Messenger.desktop" 2>/dev/null
      
      # Clear pop-launcher cache (for Pop!_OS COSMIC)
      rm -rf "${homeDir}/.cache/pop-launcher/" 2>/dev/null || true
      rm -rf "${homeDir}/.local/share/pop-launcher/" 2>/dev/null || true
      
      # Clear COSMIC app cache
      rm -rf "${homeDir}/.cache/cosmic"* 2>/dev/null || true
      
      # Update user desktop database
      if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "${homeDir}/.local/share/applications" 2>/dev/null || true
      fi
      
      # Refresh icon caches
      if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -f -t "${homeDir}/.local/share/icons/hicolor" 2>/dev/null || true
      fi
      
      # Force desktop environment to reload application list
      if command -v dbus-send >/dev/null 2>&1; then
        dbus-send --type=signal --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.AppLaunchContext 2>/dev/null || true
      fi
      
      touch "${homeDir}/.local/share/applications" 2>/dev/null || true
    fi
  `.trim();
  
  console.log('[Uninstall] Scheduling Flatpak uninstall to run after app exits');
  
  // Spawn detached process that will outlive the app
  const child = spawn('/usr/bin/sh', ['-c', uninstallScript], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Ensure we're using system paths
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    },
  });
  child.unref();
}

// Show confirmation dialog using native Linux tools (zenity/kdialog) to bypass slow xdg-desktop-portal
// These tools are commonly pre-installed and match the user's desktop theme
async function showLinuxConfirmDialog(options: {
  title: string;
  message: string;
  detail?: string;
}): Promise<boolean> {
  const fullMessage = options.detail 
    ? `${options.message}\n\n${options.detail}`
    : options.message;
  
  // Try zenity first (GTK, common on GNOME/Ubuntu), then kdialog (KDE)
  const zenityCmd = `zenity --question --title="${options.title}" --text="${fullMessage.replace(/"/g, '\\"')}" --ok-label="Uninstall" --cancel-label="Cancel" 2>/dev/null`;
  const kdialogCmd = `kdialog --warningyesno "${fullMessage.replace(/"/g, '\\"')}" --title "${options.title}" --yes-label "Uninstall" --no-label "Cancel" 2>/dev/null`;
  
  return new Promise((resolve) => {
    // Try zenity first
    exec(zenityCmd, (error) => {
      if (error && error.code === 127) {
        // zenity not found, try kdialog
        exec(kdialogCmd, (error2) => {
          if (error2 && error2.code === 127) {
            // Neither found, fall back to Electron dialog (may be slow on Snap)
            console.log('[Dialog] Neither zenity nor kdialog found, falling back to Electron dialog');
            dialog.showMessageBox({
              type: 'warning',
              buttons: ['Uninstall', 'Cancel'],
              defaultId: 0,
              cancelId: 1,
              title: options.title,
              message: options.message,
              detail: options.detail,
            }).then(({ response }) => resolve(response === 0));
          } else {
            // kdialog found - exit code 0 = Yes, 1 = No
            resolve(!error2);
          }
        });
      } else {
        // zenity found - exit code 0 = OK, 1 = Cancel
        resolve(!error);
      }
    });
  });
}

async function handleUninstallRequest(): Promise<void> {
  // Show confirmation dialog IMMEDIATELY - don't do any detection before this
  let confirmed: boolean;
  
  if (process.platform === 'linux') {
    // On Linux (especially Snap), Electron's native dialog goes through xdg-desktop-portal
    // which can be extremely slow (20+ seconds). Use zenity/kdialog instead which are fast
    // and match the user's desktop theme.
    confirmed = await showLinuxConfirmDialog({
      title: 'Uninstall Messenger',
      message: 'Uninstall Messenger from this device?',
      detail: 'This will quit Messenger and remove all app data (settings, cache, and logs).',
    });
  } else {
    // Use native dialog on macOS/Windows where it's fast
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Uninstall', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Uninstall Messenger',
      message: 'Uninstall Messenger from this device?',
      detail: 'This will quit Messenger and remove all app data (settings, cache, and logs).',
    });
    confirmed = response === 0;
  }

  if (!confirmed) {
    return;
  }

  // Only after user confirms, detect the package manager (may involve file I/O)
  const packageManager = detectPackageManagerFromCache();

  // Remove from dock (macOS) or taskbar (Windows)
  removeFromDockAndTaskbar();

  // Perform deletion after the app exits to avoid Electron recreating files (Crashpad, logs, etc.)
  const targets = uninstallTargets().map((t) => t.path);
  scheduleExternalCleanup(targets);

  // Special handling for Snap/Flatpak: must quit app FIRST, then run uninstall
  // These run in sandboxes that prevent uninstalling from within
  if (packageManager?.name === 'Snap') {
    console.log('[Uninstall] Snap detected - scheduling uninstall after app quits');
    scheduleSnapUninstall();
    app.quit();
    return;
  }
  
  if (packageManager?.name === 'Flatpak') {
    console.log('[Uninstall] Flatpak detected - scheduling uninstall after app quits');
    scheduleFlatpakUninstall();
    app.quit();
    return;
  }

  if (packageManager) {
    // Run the package manager uninstall command
    runPackageManagerUninstall(packageManager);
    
    // For Linux package managers with pkexec, we need to give time for the authentication dialog to appear
    // Hide the window but don't quit immediately - the uninstall script will terminate the app
    const needsAuthDialog = packageManager.name.includes('deb') || 
                            packageManager.name.includes('rpm');
    if (process.platform === 'linux' && needsAuthDialog) {
      console.log('[Uninstall] Hiding window for authentication dialog...');
      mainWindow?.hide();
      // Give the authentication dialog time to show and complete
      // The app will be killed by the package manager or cleanup script
      setTimeout(() => {
        console.log('[Uninstall] Quitting after delay for authentication...');
        app.quit();
      }, 30000); // 30 second timeout as fallback
      return;
    }
  } else {
    // Automatically remove the app bundle/installation
    if (process.platform === 'darwin') {
      scheduleMacAppTrash();
    } else if (process.platform === 'win32') {
      scheduleWindowsUninstaller();
    }
  }

  app.quit();
}

// IPC Handlers
function createApplicationMenu(): void {
  const uninstallMenuItem: Electron.MenuItemConstructorOptions = {
    label: 'Uninstall Messenger…',
    click: () => {
      void handleUninstallRequest();
    },
  };

  const checkUpdatesMenuItem: Electron.MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    enabled: !isDev,
    click: () => {
      if (isDev) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Development Mode',
          message: 'Auto-updates are disabled in development mode.',
          buttons: ['OK'],
        }).catch(() => {});
        return;
      }
      manualUpdateCheckInProgress = true;
      // Use checkForUpdates() instead of checkForUpdatesAndNotify() to use our custom update window
      autoUpdater.checkForUpdates().catch((err: unknown) => {
        console.warn('[AutoUpdater] manual check failed', err);
        dialog.showMessageBox({
          type: 'warning',
          title: 'Update check failed',
          message: 'Could not check for updates. Please try again later.',
          buttons: ['OK'],
        }).catch(() => {});
      }).finally(() => {
        manualUpdateCheckInProgress = false;
      });
    },
  };

  const viewOnGitHubMenuItem: Electron.MenuItemConstructorOptions = {
    label: 'View on GitHub',
    click: () => { openGitHubPage(); },
  };

  // Dev-only menu for testing features (only included in menu when isDev is true)
  const developMenu: Electron.MenuItemConstructorOptions = {
    label: 'Develop',
    submenu: [
      {
        label: 'Test Update Workflow…',
        click: async () => {
          // Simulate the full update workflow
          const testVersion = '99.0.0';
          
          // Step 1: Show "Update Available" dialog
          const downloadResult = await dialog.showMessageBox({
            type: 'info',
            title: 'Update Available (Test)',
            message: 'A new version of Messenger is available',
            detail: `Version ${testVersion} is ready to download. Would you like to download it now?\n\n(This is a test - no actual update will be downloaded)`,
            buttons: ['Download Now', 'Later'],
            defaultId: 0,
            cancelId: 1,
          });
          
          if (downloadResult.response !== 0) {
            console.log('[Test] User chose to update later');
            return;
          }
          
          // Step 2: Show download progress (native - taskbar + title + tray + notifications)
          console.log('[Test] Starting simulated download');
          showDownloadProgress();
          
          let progress = 0;
          
          // Simulate download progress
          await new Promise<void>((resolve) => {
            const testInterval = setInterval(() => {
              progress += Math.random() * 12 + 3;
              if (progress >= 100) {
                progress = 100;
                clearInterval(testInterval);
                const speed = (1.5 + Math.random() * 2).toFixed(1) + ' MB/s';
                updateDownloadProgress(100, speed, '67.5 MB', '67.5 MB');
                setTimeout(() => {
                  hideDownloadProgress();
                  resolve();
                }, 500);
              } else {
                const speed = (1.5 + Math.random() * 2).toFixed(1) + ' MB/s';
                const downloaded = ((progress / 100) * 67.5).toFixed(1) + ' MB';
                updateDownloadProgress(Math.round(progress), speed, downloaded, '67.5 MB');
              }
            }, 300);
          });
          
          // Step 3: Show "Update Ready" dialog
          console.log('[Test] Download complete, showing restart dialog');
          const restartResult = await dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready (Test)',
            message: 'Update downloaded successfully',
            detail: `Version ${testVersion} has been downloaded. Restart now to apply the update.\n\n(This is a test - clicking "Restart Now" will restart the app)`,
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
            cancelId: 1,
          });
          
          if (restartResult.response === 0) {
            console.log('[Test] User chose to restart - relaunching app');
            app.relaunch();
            app.quit();
          } else {
            console.log('[Test] User chose to restart later');
          }
        },
      },
      {
        label: 'Test Notification',
        click: () => { testNotification(); },
      },
      { type: 'separator' },
      { role: 'toggleDevTools' as const },
      { role: 'forceReload' as const },
    ],
  };

  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' as const },
          { type: 'separator' },
          viewOnGitHubMenuItem,
          checkUpdatesMenuItem,
          { type: 'separator' },
          { role: 'services' as const },
          { type: 'separator' },
          { role: 'hide' as const },
          { role: 'hideOthers' as const },
          { role: 'unhide' as const },
          { type: 'separator' },
          uninstallMenuItem,
          { type: 'separator' },
          { role: 'quit' as const },
        ],
      },
      {
        label: 'File',
        submenu: [
          { role: 'close' as const },
        ],
      },
      { role: 'editMenu' as const },
      { role: 'viewMenu' as const },
      { role: 'windowMenu' as const },
      // Only include Develop menu in dev mode
      ...(isDev ? [developMenu] : []),
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    return;
  }

  // For other platforms, provide basic menus
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Help',
      submenu: [
        viewOnGitHubMenuItem,
        checkUpdatesMenuItem,
        { type: 'separator' },
        uninstallMenuItem,
        { type: 'separator' },
        { role: 'about' as const },
      ],
    },
    // Only include Develop menu in dev mode
    ...(isDev ? [developMenu] : []),
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function setupIpcHandlers(): void {
  // Handle notification requests from renderer
  ipcMain.on('show-notification', (event, data) => {
    console.log('[Main Process] Received notification request:', data);
    if (notificationHandler) {
      notificationHandler.showNotification(data);
    } else {
      console.warn('[Main Process] Notification handler not ready, queuing notification');
      // Initialize handler if not ready
      notificationHandler = new NotificationHandler(() => mainWindow);
      notificationHandler.showNotification(data);
    }
  });

  // Handle unread count updates
  ipcMain.on('update-unread-count', (event, count: number) => {
    badgeManager.updateBadgeCount(count);
  });

  // Handle clear badge request
  ipcMain.on('clear-badge', () => {
    badgeManager.clearBadge();
  });

  // Handle notification click (emitted by notification handler)
  // This is handled directly in the notification handler's click event

  // Handle notification action (reply, etc.)
  ipcMain.on('notification-action', (event, action: string, data: any) => {
    // On macOS, content is in contentView; otherwise in mainWindow
    const targetContents = process.platform === 'darwin' && contentView
      ? contentView.webContents
      : mainWindow?.webContents;
    if (targetContents) {
      targetContents.send('notification-action-handler', action, data);
    }
  });

  // Handle test notification request
  ipcMain.on('test-notification', () => {
    testNotification();
  });

  // Handle fallback debug logs from preload/page
  ipcMain.on('log-fallback', (_event, data) => {
    try {
      const { event: name, payload } = data || {};
      const safeName = name || 'fallback';
      // Only log in dev mode to reduce noise, and wrap to handle EPIPE
      if (isDev) {
        try {
          console.log('[FallbackLog]', safeName, payload || {});
        } catch {
          // Ignore write errors (e.g., EPIPE when pipe is closed)
        }
      }
    } catch {
      // Silently ignore logging failures
    }
  });
}

// Test notification function
function testNotification(): void {
  if (!notificationHandler) {
    console.warn('Notification handler not initialized yet');
    return;
  }

  notificationHandler.showNotification({
    title: 'Test Notification',
    body: 'This is a test notification from Messenger Desktop! Click to focus the app.',
    tag: 'test-notification',
    silent: false,
  });

  // Also test badge count
  badgeManager.updateBadgeCount(5);
  console.log('Test notification sent and badge count set to 5');
}

// Check if app is running from /Applications (macOS only)
function isInApplicationsFolder(): boolean {
  if (process.platform !== 'darwin') return true;
  
  const appPath = app.getPath('exe');
  // Check both /Applications and ~/Applications
  return appPath.startsWith('/Applications/') || 
         appPath.includes('/Applications/') ||
         appPath.startsWith(path.join(app.getPath('home'), 'Applications/'));
}

// Check if we've already prompted the user about moving to Applications
function hasPromptedMoveToApplications(): boolean {
  try {
    if (fs.existsSync(movePromptFile)) {
      const data = JSON.parse(fs.readFileSync(movePromptFile, 'utf8'));
      return data.prompted === true;
    }
  } catch (e) {
    // Ignore errors, will prompt again
  }
  return false;
}

// Mark that we've prompted the user
function setPromptedMoveToApplications(): void {
  try {
    fs.writeFileSync(movePromptFile, JSON.stringify({ prompted: true, date: new Date().toISOString() }));
  } catch (e) {
    console.warn('[Move Prompt] Failed to save prompt state:', e);
  }
}

// Prompt user to move app to Applications folder (macOS only)
async function promptMoveToApplications(): Promise<void> {
  if (process.platform !== 'darwin' || isDev) return;
  if (isInApplicationsFolder()) return;
  if (hasPromptedMoveToApplications()) return;

  // Get the path to the .app bundle
  const exePath = app.getPath('exe');
  // exe is inside Messenger.app/Contents/MacOS/Messenger, so go up 3 levels
  const appBundlePath = path.resolve(exePath, '../../..');
  const appName = path.basename(appBundlePath);
  const destinationPath = path.join('/Applications', appName);

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Move to Applications?',
    message: 'Move Messenger to your Applications folder?',
    detail: 'Messenger works best when installed in your Applications folder. This enables auto-updates and better macOS integration.',
  });

  // Remember that we prompted (regardless of choice)
  setPromptedMoveToApplications();

  if (response !== 0) {
    return;
  }

  // Check if app already exists in Applications
  if (fs.existsSync(destinationPath)) {
    const { response: overwriteResponse } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Replace existing app?',
      message: 'Messenger already exists in Applications.',
      detail: 'Do you want to replace it with this version?',
    });

    if (overwriteResponse !== 0) {
      return;
    }

    // Remove existing app
    try {
      fs.rmSync(destinationPath, { recursive: true, force: true });
    } catch (e) {
      await dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Could not replace app',
        message: 'Failed to remove existing Messenger from Applications.',
        detail: 'Please manually move the app to Applications.',
      });
      return;
    }
  }

  // Move the app using shell command (handles permissions better)
  try {
    const { execSync } = require('child_process');
    execSync(`mv "${appBundlePath}" "${destinationPath}"`, { stdio: 'ignore' });
    
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['Relaunch'],
      defaultId: 0,
      title: 'Move successful',
      message: 'Messenger has been moved to Applications.',
      detail: 'The app will now relaunch from its new location.',
    });

    // Relaunch from new location
    const newExePath = path.join(destinationPath, 'Contents/MacOS', path.basename(exePath));
    spawn(newExePath, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  } catch (e) {
    console.error('[Move to Applications] Failed:', e);
    await dialog.showMessageBox({
      type: 'error',
      buttons: ['OK'],
      title: 'Move failed',
      message: 'Could not move Messenger to Applications.',
      detail: 'Please manually drag Messenger.app to your Applications folder.',
    });
  }
}

// Check if we've already requested notification permission
function hasRequestedNotificationPermission(): boolean {
  try {
    if (fs.existsSync(notificationPermissionFile)) {
      const data = JSON.parse(fs.readFileSync(notificationPermissionFile, 'utf8'));
      return data.requested === true;
    }
  } catch (e) {
    // Ignore errors, will request again
  }
  return false;
}

// Mark that we've requested notification permission
function setRequestedNotificationPermission(): void {
  try {
    fs.writeFileSync(notificationPermissionFile, JSON.stringify({ requested: true, date: new Date().toISOString() }));
  } catch (e) {
    console.warn('[Notification Permission] Failed to save request state:', e);
  }
}

// Request notification permission on macOS (first launch only)
async function requestNotificationPermission(): Promise<void> {
  // Only needed on macOS
  if (process.platform !== 'darwin') return;
  
  // Skip if we've already requested
  if (hasRequestedNotificationPermission()) {
    console.log('[Notification Permission] Already requested, skipping');
    return;
  }

  console.log('[Notification Permission] Requesting permission on first launch');
  
  // Mark as requested before showing the notification (to avoid re-prompting on crash)
  setRequestedNotificationPermission();

  // On macOS, showing a notification triggers the system permission prompt
  // We'll show a welcome notification to trigger the permission request
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'Welcome to Messenger',
      body: 'You\'ll receive notifications here when you get new messages.',
      silent: true,
    });
    notification.show();
    console.log('[Notification Permission] Welcome notification shown to trigger permission prompt');
  }
}

// Request media permissions on macOS (camera/microphone)
// This will prompt the user when they first try to use these features
async function checkMediaPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return;

  try {
    // Check current permission status (doesn't prompt, just checks)
    const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    
    console.log('[Media Permissions] Camera status:', cameraStatus);
    console.log('[Media Permissions] Microphone status:', micStatus);
    
    // If permissions are 'not-determined', they'll be prompted when first accessed
    // If permissions are 'denied', user needs to enable in System Preferences
    if (cameraStatus === 'denied' || micStatus === 'denied') {
      console.log('[Media Permissions] Some permissions denied - user may need to enable in System Preferences for calls');
    }
  } catch (e) {
    console.warn('[Media Permissions] Failed to check status:', e);
  }
}

// Snap desktop integration help (shown once on first run)
// When snap is manually installed (not pre-installed with distro), users may need to set up desktop integration
function showSnapDesktopIntegrationHelp(): void {
  // Only show for Linux snap installs
  if (process.platform !== 'linux' || !process.env.SNAP) {
    return;
  }

  // Only show once
  try {
    if (fs.existsSync(snapHelpShownFile)) {
      return;
    }
    fs.writeFileSync(snapHelpShownFile, JSON.stringify({ shown: true, date: new Date().toISOString() }));
  } catch (e) {
    // Continue anyway if file operations fail
  }

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                     Messenger - Snap Installation Help                     ║');
  console.log('╠════════════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                            ║');
  console.log('║  If the app doesn\'t appear in your applications menu, you may need to     ║');
  console.log('║  set up desktop integration for snap packages:                             ║');
  console.log('║                                                                            ║');
  console.log('║  1. Add snap desktop directory to your environment:                        ║');
  console.log('║     Add this line to ~/.profile or /etc/profile.d/snap.sh:                 ║');
  console.log('║                                                                            ║');
  console.log('║     export XDG_DATA_DIRS="/var/lib/snapd/desktop:$XDG_DATA_DIRS"           ║');
  console.log('║                                                                            ║');
  console.log('║  2. Log out and back in (or restart your session)                          ║');
  console.log('║                                                                            ║');
  console.log('║  3. Alternatively, run: sudo update-desktop-database                       ║');
  console.log('║                                                                            ║');
  console.log('║  This is only needed when snap is manually installed (not pre-configured   ║');
  console.log('║  with Ubuntu or other distros that include snap by default).               ║');
  console.log('║                                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

// Auto-updater state
let pendingUpdateVersion: string | null = null;
let originalWindowTitle: string = 'Messenger';
let isDownloading = false;

function showDownloadProgress(): void {
  isDownloading = true;
  
  // Store original title to restore later
  if (mainWindow && !mainWindow.isDestroyed()) {
    originalWindowTitle = mainWindow.getTitle() || 'Messenger';
  }
  
  // Show native notification that download is starting
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'Downloading Update',
      body: 'Messenger is downloading an update in the background...',
      silent: true,
    });
    notification.show();
  }
  
  // Update tray tooltip
  if (tray) {
    tray.setToolTip('Messenger - Downloading update...');
  }
}

function updateDownloadProgress(percent: number, speed: string, downloaded: string, total: string): void {
  if (!isDownloading) return;
  
  // Show detailed progress: "Downloading update: 45% (34.2 / 67.5 MB) @ 2.3 MB/s"
  const progressTitle = `Downloading update: ${percent}% (${downloaded} / ${total}) @ ${speed}`;
  
  // Update taskbar/dock progress
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(percent / 100);
    
    // Update window title with progress (all platforms)
    mainWindow.setTitle(progressTitle);
  }
  
  // On macOS, also update the custom title overlay (the visible title bar)
  if (process.platform === 'darwin') {
    updateTitleOverlayText(progressTitle);
  }

  // Update tray tooltip with same progress info
  if (tray) {
    tray.setToolTip(`Messenger - ${progressTitle}`);
  }
}

function hideDownloadProgress(): void {
  isDownloading = false;
  
  // Clear taskbar/dock progress
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(-1); // -1 removes the progress bar
    
    // Restore original window title
    mainWindow.setTitle(originalWindowTitle);
    
    // On macOS, also restore the custom title overlay
    if (process.platform === 'darwin') {
      updateTitleOverlayText(originalWindowTitle);
    }
    
    // Flash taskbar to get attention (Windows)
    if (process.platform === 'win32') {
      mainWindow.flashFrame(true);
      // Stop flashing after a few seconds
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.flashFrame(false);
        }
      }, 3000);
    }
  }
  
  // Restore tray tooltip
  if (tray) {
    tray.setToolTip('Messenger');
  }
  
  // Note: No notification here - the "Update Ready" dialog will be shown by the auto-updater
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// GitHub repo URL for about dialog
const GITHUB_REPO_URL = 'https://github.com/apotenza92/facebook-messenger-desktop';

function openGitHubPage(): void {
  shell.openExternal(GITHUB_REPO_URL).catch((err) => {
    console.error('[GitHub] Failed to open URL:', err);
  });
}

// Windows direct download function - downloads installer to Downloads folder and runs it
async function downloadWindowsUpdate(version: string): Promise<void> {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const fileName = `Messenger-windows-${arch}-setup.exe`;
  const downloadUrl = `https://github.com/apotenza92/FacebookMessengerDesktop/releases/download/v${version}/${fileName}`;
  
  // Get user's Downloads folder
  const downloadsPath = app.getPath('downloads');
  const filePath = path.join(downloadsPath, fileName);
  
  console.log(`[AutoUpdater] Starting Windows direct download: ${downloadUrl}`);
  console.log(`[AutoUpdater] Saving to: ${filePath}`);
  
  showDownloadProgress();
  
  return new Promise((resolve, reject) => {
    // Function to handle the actual download (after redirects)
    const downloadFromUrl = (url: string, redirectCount = 0): void => {
      if (redirectCount > 5) {
        hideDownloadProgress();
        reject(new Error('Too many redirects'));
        return;
      }
      
      const request = https.get(url, (response) => {
        // Handle redirects (GitHub uses 302 redirects to the actual file)
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            console.log(`[AutoUpdater] Following redirect to: ${redirectUrl}`);
            downloadFromUrl(redirectUrl, redirectCount + 1);
            return;
          }
        }
        
        if (response.statusCode !== 200) {
          hideDownloadProgress();
          reject(new Error(`Download failed with status: ${response.statusCode}`));
          return;
        }
        
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;
        const startTime = Date.now();
        
        // Delete existing file if present
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.warn('[AutoUpdater] Could not delete existing file:', e);
        }
        
        const fileStream = fs.createWriteStream(filePath);
        
        response.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length;
          
          // Calculate progress
          const percent = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const speedBps = elapsedSeconds > 0 ? downloadedSize / elapsedSeconds : 0;
          const speedKB = Math.round(speedBps / 1024);
          const speedDisplay = speedKB > 1024 
            ? `${(speedKB / 1024).toFixed(1)} MB/s` 
            : `${speedKB} KB/s`;
          const downloaded = formatBytes(downloadedSize);
          const total = formatBytes(totalSize);
          
          updateDownloadProgress(percent, speedDisplay, downloaded, total);
        });
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          hideDownloadProgress();
          console.log(`[AutoUpdater] Download complete: ${filePath}`);
          resolve();
        });
        
        fileStream.on('error', (err) => {
          hideDownloadProgress();
          // Clean up partial file
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore cleanup errors
          }
          reject(err);
        });
      });
      
      request.on('error', (err) => {
        hideDownloadProgress();
        reject(err);
      });
    };
    
    downloadFromUrl(downloadUrl);
  });
}

// Linux direct download function - downloads .deb or .rpm package and installs with pkexec
async function downloadLinuxPackage(version: string, packageType: 'deb' | 'rpm'): Promise<string> {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const fileName = `facebook-messenger-desktop-${arch}.${packageType}`;
  const downloadUrl = `https://github.com/apotenza92/FacebookMessengerDesktop/releases/download/v${version}/${fileName}`;
  
  // Get user's Downloads folder
  const downloadsPath = app.getPath('downloads');
  const filePath = path.join(downloadsPath, fileName);
  
  console.log(`[AutoUpdater] Starting Linux ${packageType} download: ${downloadUrl}`);
  console.log(`[AutoUpdater] Saving to: ${filePath}`);
  
  showDownloadProgress();
  
  return new Promise((resolve, reject) => {
    // Function to handle the actual download (after redirects)
    const downloadFromUrl = (url: string, redirectCount = 0): void => {
      if (redirectCount > 5) {
        hideDownloadProgress();
        reject(new Error('Too many redirects'));
        return;
      }
      
      const request = https.get(url, (response) => {
        // Handle redirects (GitHub uses 302 redirects to the actual file)
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            console.log(`[AutoUpdater] Following redirect to: ${redirectUrl}`);
            downloadFromUrl(redirectUrl, redirectCount + 1);
            return;
          }
        }
        
        if (response.statusCode !== 200) {
          hideDownloadProgress();
          reject(new Error(`Download failed with status: ${response.statusCode}`));
          return;
        }
        
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;
        const startTime = Date.now();
        
        // Delete existing file if present
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.warn('[AutoUpdater] Could not delete existing file:', e);
        }
        
        const fileStream = fs.createWriteStream(filePath);
        
        response.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length;
          
          // Calculate progress
          const percent = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const speedBps = elapsedSeconds > 0 ? downloadedSize / elapsedSeconds : 0;
          const speedKB = Math.round(speedBps / 1024);
          const speedDisplay = speedKB > 1024 
            ? `${(speedKB / 1024).toFixed(1)} MB/s` 
            : `${speedKB} KB/s`;
          const downloaded = formatBytes(downloadedSize);
          const total = formatBytes(totalSize);
          
          updateDownloadProgress(percent, speedDisplay, downloaded, total);
        });
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          hideDownloadProgress();
          console.log(`[AutoUpdater] Download complete: ${filePath}`);
          resolve(filePath);
        });
        
        fileStream.on('error', (err) => {
          hideDownloadProgress();
          // Clean up partial file
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore cleanup errors
          }
          reject(err);
        });
      });
      
      request.on('error', (err) => {
        hideDownloadProgress();
        reject(err);
      });
    };
    
    downloadFromUrl(downloadUrl);
  });
}

// Install a Linux package using pkexec (graphical sudo prompt)
async function installLinuxPackage(filePath: string, packageType: 'deb' | 'rpm'): Promise<void> {
  console.log(`[AutoUpdater] Installing ${packageType} package: ${filePath}`);
  
  let installCommand: string[];
  if (packageType === 'deb') {
    // Use apt for deb packages (handles dependencies better than dpkg)
    installCommand = ['pkexec', 'apt', 'install', '-y', filePath];
  } else {
    // Use dnf for rpm packages (handles dependencies better than rpm)
    installCommand = ['pkexec', 'dnf', 'install', '-y', filePath];
  }
  
  return new Promise((resolve, reject) => {
    const proc = spawn(installCommand[0], installCommand.slice(1), {
      stdio: 'pipe',
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[AutoUpdater] Package installed successfully`);
        resolve();
      } else {
        console.error(`[AutoUpdater] Package install failed with code ${code}`);
        console.error(`[AutoUpdater] stdout: ${stdout}`);
        console.error(`[AutoUpdater] stderr: ${stderr}`);
        reject(new Error(`Installation failed: ${stderr || stdout || `exit code ${code}`}`));
      }
    });
    
    proc.on('error', (err) => {
      console.error(`[AutoUpdater] Failed to spawn pkexec:`, err);
      reject(err);
    });
  });
}

async function showUpdateAvailableDialog(version: string): Promise<void> {
  // On Linux, electron-updater only supports AppImage for auto-updates.
  // For deb/rpm, we download and install the package directly.
  // For snap/flatpak, they have their own update mechanisms.
  if (process.platform === 'linux') {
    const cached = readInstallSourceCache();
    const source = cached?.source;
    
    // Handle deb/rpm - download and install directly
    if (source === 'deb' || source === 'rpm') {
      const packageType = source;
      const packageManagerName = source === 'deb' ? 'apt (deb)' : 'dnf (rpm)';
      
      console.log(`[AutoUpdater] Linux ${packageType} install detected, offering direct download`);
      
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `A new version of Messenger is available`,
        detail: `Version ${version} is available.\n\nThe update will be downloaded and installed using ${packageManagerName}. You'll be prompted for your password to authorize the installation.`,
        buttons: ['Download and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      
      if (result.response === 0) {
        try {
          // Download the package
          const filePath = await downloadLinuxPackage(version, packageType);
          
          // Show confirmation before installing
          const installResult = await dialog.showMessageBox({
            type: 'info',
            title: 'Download Complete',
            message: 'Update downloaded successfully',
            detail: `The update has been downloaded to:\n${filePath}\n\nClick "Install Now" to install the update. You'll be prompted for your password.\n\nMessenger will restart after installation.`,
            buttons: ['Install Now', 'Open Downloads Folder', 'Later'],
            defaultId: 0,
            cancelId: 2,
          });
          
          if (installResult.response === 0) {
            // Install the package
            console.log('[AutoUpdater] Starting package installation...');
            try {
              await installLinuxPackage(filePath, packageType);
              
              // Installation succeeded - restart the app
              await dialog.showMessageBox({
                type: 'info',
                title: 'Update Installed',
                message: 'Update installed successfully',
                detail: 'Messenger will now restart to apply the update.',
                buttons: ['OK'],
              });
              
              isQuitting = true;
              app.relaunch();
              app.exit(0);
            } catch (installErr) {
              console.error('[AutoUpdater] Package installation failed:', installErr);
              const errorMsg = installErr instanceof Error ? installErr.message : String(installErr);
              
              // Check if user cancelled the pkexec prompt
              if (errorMsg.includes('126') || errorMsg.includes('dismissed') || errorMsg.includes('cancelled')) {
                await dialog.showMessageBox({
                  type: 'info',
                  title: 'Installation Cancelled',
                  message: 'Installation was cancelled',
                  detail: 'The update has been saved to your Downloads folder. You can install it manually later.',
                  buttons: ['OK'],
                });
              } else {
                await dialog.showMessageBox({
                  type: 'error',
                  title: 'Installation Failed',
                  message: 'Could not install the update',
                  detail: `${errorMsg}\n\nThe update has been saved to:\n${filePath}\n\nYou can install it manually with:\nsudo ${packageType === 'deb' ? 'apt install' : 'dnf install'} "${filePath}"`,
                  buttons: ['OK'],
                });
              }
              shell.showItemInFolder(filePath);
            }
          } else if (installResult.response === 1) {
            shell.showItemInFolder(filePath);
          }
        } catch (err) {
          console.error('[AutoUpdater] Linux package download failed:', err);
          const errorMsg = err instanceof Error ? err.message : String(err);
          
          const fallbackResult = await dialog.showMessageBox({
            type: 'error',
            title: 'Download Failed',
            message: 'Could not download the update',
            detail: `${errorMsg}\n\nWould you like to open the download page instead?`,
            buttons: ['Open Download Page', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          });
          
          if (fallbackResult.response === 0) {
            shell.openExternal('https://apotenza92.github.io/facebook-messenger-desktop/').catch((shellErr) => {
              console.error('[AutoUpdater] Failed to open download page:', shellErr);
            });
          }
        }
      }
      return;
    }
    
    // Handle snap/flatpak - these update through their own mechanisms
    if (source === 'snap' || source === 'flatpak') {
      let updateInstructions = '';
      let packageManagerName = '';
      
      if (source === 'snap') {
        packageManagerName = 'Snap Store';
        updateInstructions = 'Snap updates automatically, or run:\nsudo snap refresh facebook-messenger-desktop';
      } else {
        packageManagerName = 'Flatpak';
        updateInstructions = 'Run:\nflatpak update com.facebook.messenger.desktop';
      }
      
      console.log(`[AutoUpdater] Linux ${source} install detected, showing manual update instructions`);
      
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `A new version of Messenger is available`,
        detail: `Version ${version} is available.\n\nYou installed Messenger via ${packageManagerName}. Please update using your package manager.\n\n${updateInstructions}`,
        buttons: ['Open Download Page', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      
      if (result.response === 0) {
        shell.openExternal('https://apotenza92.github.io/facebook-messenger-desktop/').catch((err) => {
          console.error('[AutoUpdater] Failed to open download page:', err);
        });
      }
      return;
    }
    // 'direct' means AppImage - continue with normal auto-update flow below
  }

  // On Windows, download directly and run installer
  // This is a temporary workaround until code signing is set up
  // Without signing, auto-updates get blocked by Windows Application Control
  if (process.platform === 'win32') {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version of Messenger is available`,
      detail: `Version ${version} is available. The installer will be downloaded to your Downloads folder.\n\n⚠️ Windows Security Note:\nIf Windows SmartScreen appears, click "More info" → "Run anyway".\nIf the installer won't run, right-click the file → Properties → check "Unblock" → OK.`,
      buttons: ['Download and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      console.log('[AutoUpdater] Windows user starting direct download');
      
      try {
        await downloadWindowsUpdate(version);
        
        // Get the downloaded file path
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const fileName = `Messenger-windows-${arch}-setup.exe`;
        const downloadsPath = app.getPath('downloads');
        const filePath = path.join(downloadsPath, fileName);
        
        // Show success dialog and offer to run installer
        const installResult = await dialog.showMessageBox({
          type: 'info',
          title: 'Download Complete',
          message: 'Update downloaded successfully',
          detail: `The installer has been saved to:\n${filePath}\n\nClick "Install Now" to run the installer. Messenger will close automatically.\n\nIf Windows blocks the file, right-click → Properties → Unblock.`,
          buttons: ['Install Now', 'Open Downloads Folder', 'Later'],
          defaultId: 0,
          cancelId: 2,
        });
        
        if (installResult.response === 0) {
          // Run the installer and quit the app immediately (no extra confirmation dialog)
          console.log('[AutoUpdater] Opening installer and quitting...');
          const openError = await shell.openPath(filePath);
          
          if (openError) {
            console.error('[AutoUpdater] Failed to open installer:', openError);
            // Show error and fall back to showing in explorer
            await dialog.showMessageBox({
              type: 'error',
              title: 'Could Not Open Installer',
              message: 'The installer could not be opened automatically',
              detail: `Error: ${openError}\n\nThe file has been saved to your Downloads folder. Please run it manually.\n\nIf the file is blocked: right-click → Properties → check "Unblock" → OK.`,
              buttons: ['Show in Downloads'],
            });
            shell.showItemInFolder(filePath);
          } else {
            // Quit immediately to allow installer to run - no additional dialog needed
            console.log('[AutoUpdater] Installer launched, quitting app...');
            isQuitting = true;
            app.quit();
          }
        } else if (installResult.response === 1) {
          // Open the Downloads folder with the file selected
          shell.showItemInFolder(filePath);
        }
        // If "Later", do nothing
      } catch (err) {
        console.error('[AutoUpdater] Windows direct download failed:', err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        
        // Fall back to opening download page
        const fallbackResult = await dialog.showMessageBox({
          type: 'error',
          title: 'Download Failed',
          message: 'Could not download the update automatically',
          detail: `${errorMsg}\n\nWould you like to open the download page instead?`,
          buttons: ['Open Download Page', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        
        if (fallbackResult.response === 0) {
          shell.openExternal('https://apotenza92.github.io/facebook-messenger-desktop/').catch((shellErr) => {
            console.error('[AutoUpdater] Failed to open download page:', shellErr);
          });
        }
      }
    }
    return;
  }

  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Update Available',
    message: `A new version of Messenger is available`,
    detail: `Version ${version} is ready to download. Would you like to download it now?`,
    buttons: ['Download Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    console.log('[AutoUpdater] User chose to download');
    pendingUpdateVersion = version;
    showDownloadProgress();
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[AutoUpdater] Download failed:', err);
      hideDownloadProgress();
      const errorMsg = err instanceof Error ? err.message : String(err);
      dialog.showMessageBox({
        type: 'error',
        title: 'Download Failed',
        message: 'Could not download the update',
        detail: errorMsg,
        buttons: ['OK'],
      }).catch(() => {});
    });
  } else {
    console.log('[AutoUpdater] User chose to update later');
  }
}

async function showUpdateReadyDialog(version: string): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: 'Update downloaded successfully',
    detail: `Version ${version} has been downloaded. Restart now to apply the update.`,
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    console.log('[AutoUpdater] User chose to restart');
    isQuitting = true;
    
    // On Linux, quitAndInstall() can terminate abruptly causing crash messages.
    // Close all windows cleanly first to save session state.
    if (process.platform === 'linux') {
      console.log('[AutoUpdater] Linux: Closing windows cleanly before update...');
      // Close all windows first to trigger proper cleanup
      BrowserWindow.getAllWindows().forEach(win => {
        try {
          win.destroy();
        } catch (e) {
          console.log('[AutoUpdater] Error destroying window:', e);
        }
      });
      // Small delay to allow cleanup, then quit and install
      setTimeout(() => {
        console.log('[AutoUpdater] Linux: Calling quitAndInstall...');
        autoUpdater.quitAndInstall(false, true);
      }, 300);
      // Fallback: Force quit on Linux if quitAndInstall doesn't work within 2 seconds
      setTimeout(() => {
        console.log('[AutoUpdater] Linux: Force quitting for update install');
        app.exit(0);
      }, 2000);
    } else {
      // On Windows, quitAndInstall() doesn't always properly quit the app
      // Use setImmediate to ensure event loop is cleared, and pass (false, true)
      // to ensure the app restarts after install. Add fallback app.exit() for Windows.
      setImmediate(() => {
        autoUpdater.quitAndInstall(false, true);
      });
      
      // Fallback: Force quit on Windows if quitAndInstall doesn't work within 1 second
      if (process.platform === 'win32') {
        setTimeout(() => {
          console.log('[AutoUpdater] Force quitting for Windows update install');
          app.exit(0);
        }, 1000);
      }
    }
  } else {
    console.log('[AutoUpdater] User chose to restart later');
  }
}

function setupAutoUpdater(): void {
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    autoUpdater.on('update-available', (info) => {
      const version = info?.version || 'unknown';
      console.log('[AutoUpdater] Update available:', version);
      showUpdateAvailableDialog(version);
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent);
      const speedKB = Math.round(progress.bytesPerSecond / 1024);
      const speedDisplay = speedKB > 1024 
        ? `${(speedKB / 1024).toFixed(1)} MB/s` 
        : `${speedKB} KB/s`;
      const downloaded = formatBytes(progress.transferred);
      const total = formatBytes(progress.total);
      
      console.log(`[AutoUpdater] Download progress: ${percent}% (${speedDisplay})`);
      updateDownloadProgress(percent, speedDisplay, downloaded, total);
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[AutoUpdater] No update available');
      if (!manualUpdateCheckInProgress) {
        return;
      }
      dialog.showMessageBox({
        type: 'info',
        title: 'No Updates Available',
        message: "You're up to date!",
        detail: 'Messenger is running the latest version.',
        buttons: ['OK'],
      }).catch(() => {});
    });

    autoUpdater.on('update-downloaded', (info) => {
      const version = info?.version || pendingUpdateVersion || '';
      console.log('[AutoUpdater] Update downloaded:', version);
      hideDownloadProgress();
      updateDownloadedAndReady = true;
      showUpdateReadyDialog(version);
    });

    autoUpdater.on('error', (err: unknown) => {
      console.error('[AutoUpdater] error', err);
      hideDownloadProgress();
    });

    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.warn('[AutoUpdater] check failed', err);
    });
  } catch (e) {
    console.warn('[AutoUpdater] init failed', e);
  }
}

// App lifecycle
app.whenReady().then(async () => {
  // Set about panel options for macOS native about panel
  // Include GitHub link in credits
  const year = new Date().getFullYear();
  app.setAboutPanelOptions({
    applicationName: 'Messenger',
    applicationVersion: app.getVersion(),
    copyright: `© ${year} Alex Potenza`,
    credits: `An unofficial desktop app for Facebook Messenger\n\nGitHub: ${GITHUB_REPO_URL}`,
    website: GITHUB_REPO_URL,
  });

  // Auto-updater setup (skip in dev mode - app-update.yml only exists in published builds)
  if (!isDev) {
    setupAutoUpdater();
  } else {
    console.log('[AutoUpdater] Skipped in development mode');
  }

  // Show snap desktop integration help on first run (Linux snap only)
  showSnapDesktopIntegrationHelp();

  // Detect and cache install source in background (so uninstall is instant later)
  // This runs async and doesn't block startup
  void detectAndCacheInstallSource();

  // Note: On macOS, the dock icon comes from the app bundle's .icns file
  // We don't call app.dock.setIcon() because that would override the properly-sized
  // .icns icon with a PNG that lacks proper canvas padding, causing the icon to
  // appear larger than other dock icons. Let macOS handle the dock icon natively.

  // Prompt to move to Applications folder on macOS (first run only)
  await promptMoveToApplications();
  
  // Initialize managers
  notificationHandler = new NotificationHandler(() => mainWindow);
  badgeManager = new BadgeManager();
  badgeManager.setWindowGetter(() => mainWindow);
  backgroundService = new BackgroundService();

  // Request notification permission on first launch (triggers macOS permission prompt)
  await requestNotificationPermission();
  
  // Check media permission status (informational - actual prompts happen when messenger.com requests access)
  await checkMediaPermissions();

  // Create application menu
  createApplicationMenu();

  // Create system tray (Windows/Linux)
  createTray();

  // Create window
  console.log(`[App] whenReady: About to create window at ${Date.now()}`);
  createWindow('whenReady');
  setupIpcHandlers();

  // Mark app as fully initialized - now safe to handle second-instance events
  appReady = true;
  console.log(`[App] App fully ready at ${Date.now()}, appReady=true, pendingShowWindow=${pendingShowWindow}`);
  
  // Process any second-instance events that arrived before we were ready
  if (pendingShowWindow) {
    console.log('[App] Processing pending show window request');
    pendingShowWindow = false;
    // Use setTimeout to ensure all initialization is complete
    setTimeout(() => showMainWindow('pending-from-second-instance'), 100);
  }

  // Restore window when dock/taskbar icon is clicked
  // This must be registered ONCE here, not inside createWindow() to avoid accumulating listeners
  // Uses showMainWindow() for consistent behavior with tray icon click
  app.on('activate', () => {
    console.log(`[Activate] Event fired at ${Date.now()}`);
    console.log(`[Activate] State: appReady=${appReady}, isCreatingWindow=${isCreatingWindow}, mainWindow=${mainWindow ? (mainWindow.isDestroyed() ? 'destroyed' : 'exists') : 'null'}`);
    showMainWindow('activate');
  });
});

function setupTitleOverlay(window: BrowserWindow, overlayHeight: number, title: string = 'Messenger'): void {
  if (titleOverlay) {
    window.removeBrowserView(titleOverlay);
    titleOverlay = null;
  }

  titleOverlay = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  });

  const { background: backgroundColor, text: textColor } = getOverlayColors();
  // Escape HTML entities in title to prevent XSS
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  window.addBrowserView(titleOverlay);
  titleOverlay.setBounds({ x: 0, y: 0, width: window.getBounds().width, height: overlayHeight });
  titleOverlay.setAutoResize({ width: true });
  titleOverlay.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            html, body {
              margin: 0;
              padding: 0;
              width: 100%;
              height: 100%;
              background: ${backgroundColor};
              -webkit-user-select: none;
              cursor: default;
            }
            .bar {
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 0 72px;
              height: 100%;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              font-size: 13px;
              color: ${textColor};
              -webkit-app-region: drag;
            }
          </style>
        </head>
        <body>
          <div class="bar">${safeTitle}</div>
        </body>
      </html>
    `)}`
  );
}

// Update just the title text in the overlay without rebuilding it
function updateTitleOverlayText(title: string): void {
  if (!titleOverlay) return;
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "\\'");
  titleOverlay.webContents.executeJavaScript(`document.querySelector('.bar').textContent = '${safeTitle}';`).catch(() => {});
}

// Update overlay colors in-place without recreating the BrowserView
function updateTitleOverlayColors(): void {
  if (!titleOverlay) return;
  const { background: backgroundColor, text: textColor } = getOverlayColors();
  titleOverlay.webContents.executeJavaScript(`
    document.body.style.background = '${backgroundColor}';
    document.documentElement.style.background = '${backgroundColor}';
    document.querySelector('.bar').style.color = '${textColor}';
  `).catch(() => {});
}

app.on('window-all-closed', () => {
  // Keep running in background unless user explicitly quits
  if (isQuitting) {
    app.quit();
    return;
  }

  if (process.platform === 'darwin') {
    // Standard macOS behavior: keep app running
    return;
  }

  // If tray exists, keep alive; otherwise quit
  if (tray) {
    return;
  }

  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  
  // Close download progress window if open
  hideDownloadProgress();
  
  // Note: If an update was downloaded, autoInstallOnAppQuit (set to true in setupAutoUpdater)
  // will automatically install the update when the app quits.
  // We don't call quitAndInstall() here because that can cause "app can't be closed" errors
  // on Windows when the installer tries to start while the app is still closing.
  if (updateDownloadedAndReady) {
    console.log('[AutoUpdater] Update will be installed on quit via autoInstallOnAppQuit');
  }
});
