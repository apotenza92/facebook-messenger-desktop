import { app, BrowserWindow, BrowserView, ipcMain, Notification, Menu, nativeImage, screen, dialog, systemPreferences, Tray, shell, nativeTheme } from 'electron';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import * as path from 'path';
import * as fs from 'fs';
import { NotificationHandler } from './notification-handler';
import { BadgeManager } from './badge-manager';
import { BackgroundService } from './background-service';
import { autoUpdater } from 'electron-updater';

const resetFlag =
  process.argv.includes('--reset-window') ||
  process.argv.includes('--reset'); // legacy
const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

console.log(`Messenger starting on ${process.platform} ${process.arch}`);

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
    // Also clean up Saved Application State
    targets.push({ label: 'Saved app state', path: path.join(homeDir, 'Library', 'Saved Application State', 'com.electron.messenger.savedState') });
  } else {
    // Linux: cache is in ~/.cache/ (not ~/.config/ where userData lives)
    targets.push({ label: 'Cache', path: path.join(homeDir, '.cache', APP_DIR_NAME) });
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

  // Run the NSIS uninstaller in silent mode after a delay
  // /S = silent mode, _?= sets the install directory to prevent immediate reboot
  const cmd = `Start-Sleep -Seconds 2; Start-Process -FilePath '${uninstallerPath.replace(/'/g, "''")}' -ArgumentList '/S'`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
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

function createWindow(): void {
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

  // Restore window when dock icon is clicked (macOS)
  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
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
      : 'icon.png';

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

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
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
      tray.on('click', () => showMainWindow());
    } else {
      tray.on('double-click', () => showMainWindow());
    }
    
    console.log('[Tray] Tray created successfully');
  } catch (e) {
    console.warn('[Tray] Failed to create tray', e);
  }
}

// Package manager constants
const HOMEBREW_CASK = 'apotenza92/tap/facebook-messenger-desktop';
const WINGET_ID = 'apotenza92.FacebookMessengerDesktop';

type PackageManagerInfo = {
  name: string;
  detected: boolean;
  uninstallCommand: string[];
};

async function detectHomebrewInstall(): Promise<PackageManagerInfo> {
  const result: PackageManagerInfo = {
    name: 'Homebrew',
    detected: false,
    uninstallCommand: ['brew', 'uninstall', '--cask', HOMEBREW_CASK],
  };
  
  if (process.platform !== 'darwin') {
    return result;
  }
  
  try {
    // Check if this cask is installed via Homebrew
    await execAsync(`brew list --cask ${HOMEBREW_CASK}`);
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
    // Check if this package is installed via winget
    const { stdout } = await execAsync(`winget list --id ${WINGET_ID} --accept-source-agreements`);
    // winget list returns the package info if found, check if our ID is in the output
    if (stdout.includes(WINGET_ID) || stdout.includes('FacebookMessengerDesktop')) {
      result.detected = true;
      console.log('[Uninstall] Detected winget installation');
    }
  } catch {
    // Command failed = not installed via winget or winget not available
    console.log('[Uninstall] Not installed via winget or winget unavailable');
  }
  
  return result;
}

async function detectPackageManager(): Promise<PackageManagerInfo | null> {
  if (process.platform === 'darwin') {
    const homebrew = await detectHomebrewInstall();
    if (homebrew.detected) return homebrew;
  } else if (process.platform === 'win32') {
    const winget = await detectWingetInstall();
    if (winget.detected) return winget;
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
  } else {
    // On macOS/Linux, spawn directly
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    child.unref();
  }
}

async function handleUninstallRequest(): Promise<void> {
  // Show confirmation dialog immediately (don't wait for slow package manager detection)
  const getDetailText = (): string => {
    switch (process.platform) {
      case 'darwin':
        return 'This removes Messenger app data (settings, cache, logs) from this Mac.\n\nTo fully remove the application bundle, move Messenger.app to the Trash after this finishes.';
      case 'win32':
        return 'This removes Messenger app data (settings, cache, logs) from this PC.\nTo fully uninstall the app, remove it from Apps & Features after this finishes.';
      case 'linux':
        return 'This removes Messenger app data (settings, cache, logs) from this machine.\nIf you installed from a package manager, remove the package separately after this finishes.';
      default:
        return 'This removes Messenger app data (settings, cache, logs).';
    }
  };

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Uninstall Messenger',
    message: 'Remove all Messenger data from this device?',
    detail: getDetailText(),
  });

  if (response !== 0) {
    return;
  }

  // Only detect package manager after user confirms (winget detection is slow on Windows)
  const packageManager = await detectPackageManager();

  // Show completion dialog with appropriate message
  const getCompletionDetail = (): string => {
    if (packageManager) {
      return `The ${packageManager.name} uninstall command will run after the app quits.`;
    }
    switch (process.platform) {
      case 'darwin':
        return 'The app will be moved to Trash after it quits.';
      case 'win32':
        return 'The uninstaller will run after the app quits.';
      default:
        return 'If you want to remove the application itself, uninstall it using your package manager or delete the AppImage/binary.';
    }
  };

  await dialog.showMessageBox({
    type: 'info',
    buttons: ['Quit Messenger'],
    defaultId: 0,
    title: 'Uninstall complete',
    message: 'Messenger will quit and remove its data.',
    detail: getCompletionDetail(),
  });

  // Remove from dock (macOS) or taskbar (Windows)
  removeFromDockAndTaskbar();

  // Perform deletion after the app exits to avoid Electron recreating files (Crashpad, logs, etc.)
  const targets = uninstallTargets().map((t) => t.path);
  scheduleExternalCleanup(targets);

  if (packageManager) {
    // Run the package manager uninstall command
    runPackageManagerUninstall(packageManager);
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

  // Dev-only menu for testing features
  const developMenu: Electron.MenuItemConstructorOptions = {
    label: 'Develop',
    visible: isDev,
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
      developMenu,
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
    developMenu,
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
  
  // Update taskbar/dock progress
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(percent / 100);
    
    // Update window title with progress
    mainWindow.setTitle(`Downloading ${percent}% - Messenger`);
  }

  // Update tray tooltip with progress
  if (tray) {
    tray.setToolTip(`Messenger - Downloading ${percent}% (${speed})`);
  }
}

function hideDownloadProgress(): void {
  isDownloading = false;
  
  // Clear taskbar/dock progress
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(-1); // -1 removes the progress bar
    
    // Restore original window title
    mainWindow.setTitle(originalWindowTitle);
    
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

async function showUpdateAvailableDialog(version: string): Promise<void> {
  // On Windows, redirect to download page for manual download
  // This is a temporary workaround until code signing is set up
  // Without signing, auto-updates get blocked by Windows Application Control
  if (process.platform === 'win32') {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version of Messenger is available`,
      detail: `Version ${version} is available. Click "Download" to open the download page.\n\nNote: After downloading, you may need to right-click the installer → Properties → Unblock before running it.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      console.log('[AutoUpdater] Windows user redirected to download page');
      shell.openExternal('https://apotenza92.github.io/facebook-messenger-desktop/').catch((err) => {
        console.error('[AutoUpdater] Failed to open download page:', err);
      });
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
  createWindow();
  setupIpcHandlers();

  // Prevent multiple instances
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        // Window may be hidden (close to tray) or minimized
        if (!mainWindow.isVisible()) {
          mainWindow.show();
        }
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    });
  }
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
