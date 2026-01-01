import { app, BrowserWindow, ipcMain, Notification, Menu, nativeImage, screen, dialog } from 'electron';
import { spawn } from 'child_process';
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

let mainWindow: BrowserWindow | null = null;
let notificationHandler: NotificationHandler;
let badgeManager: BadgeManager;
let backgroundService: BackgroundService;
let isQuitting = false;
let resetApplied = false;

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
const userDataPath = path.join(app.getPath('appData'), APP_DIR_NAME);
app.setPath('userData', userDataPath);
app.setPath('logs', path.join(userDataPath, 'logs'));

const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
const movePromptFile = path.join(app.getPath('userData'), 'move-to-applications-prompted.json');

const uninstallTargets = () => {
  // Only remove app-owned temp directory to avoid touching system temp roots
  const tempDir = path.join(app.getPath('temp'), app.getName());

  return [
    { label: 'User data', path: app.getPath('userData') },
    { label: 'Temporary files', path: tempDir },
    { label: 'Logs', path: app.getPath('logs') },
  ];
};

function scheduleExternalCleanup(paths: string[]): void {
  const filtered = paths.filter(Boolean);
  if (filtered.length === 0) return;

  if (process.platform === 'win32') {
    const quoted = filtered.map((p) => `\\"${p}\\"`).join(',');
    const cmd = `Start-Sleep -Seconds 1; Remove-Item -LiteralPath ${quoted} -Recurse -Force -ErrorAction SilentlyContinue`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const quoted = filtered.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(' ');
  const child = spawn('/bin/sh', ['-c', `sleep 1; rm -rf ${quoted}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
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

function createWindow(): void {
  const restoredState = ensureWindowInBounds(loadWindowState());
  const hasPosition = restoredState.x !== undefined && restoredState.y !== undefined;

  mainWindow = new BrowserWindow({
    width: restoredState.width,
    height: restoredState.height,
    x: hasPosition ? restoredState.x : undefined,
    y: hasPosition ? restoredState.y : undefined,
    center: !hasPosition,
    minWidth: 708,
    minHeight: 400,
    title: 'Messenger',
    icon: getIconPath(),
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

  // Load messenger.com
  mainWindow.loadURL('https://www.messenger.com');

  // Inject notification override script after page loads
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      // First, inject a bridge function and listener that forwards custom events to postMessage
      // This bridges from page context to preload context
      await mainWindow?.webContents.executeJavaScript(`
        (function() {
          // Create a bridge function that forwards to the preload context
          window.__electronNotificationBridge = function(data) {
            // Dispatch a custom event
            const event = new CustomEvent('electron-notification', { detail: data });
            window.dispatchEvent(event);
          };
          
          // Listen for custom events and forward via postMessage (preload can catch this)
          window.addEventListener('electron-notification', function(event) {
            window.postMessage({ type: 'electron-notification', data: event.detail }, '*');
          });
          
          console.log('[Notification Bridge] Bridge function and listener installed');
        })();
      `);

      // Read and inject the notification override script
      const fs = require('fs');
      const path = require('path');
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

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle window close
  mainWindow.on('close', (event: Electron.Event) => {
    const bounds = mainWindow?.getBounds();
    if (bounds) {
      console.log('[Window State] Saving state', bounds);
      saveWindowState(bounds);
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
}

function getIconPath(): string | undefined {
  // Try multiple path resolution strategies
  const possiblePaths: string[] = [];
  
  // Strategy 1: Relative to app path (for packaged apps)
  const appPath = app.getAppPath();
  possiblePaths.push(path.join(appPath, 'assets/icons/icon.icns'));
  possiblePaths.push(path.join(appPath, 'assets/icons/icon.ico'));
  possiblePaths.push(path.join(appPath, 'assets/icons/icon.png'));
  
  // Strategy 2: Relative to __dirname (for development)
  possiblePaths.push(path.join(__dirname, '../../assets/icons/icon.icns'));
  possiblePaths.push(path.join(__dirname, '../../assets/icons/icon.ico'));
  possiblePaths.push(path.join(__dirname, '../../assets/icons/icon.png'));
  
  // Strategy 3: Relative to process.cwd() (for development)
  possiblePaths.push(path.join(process.cwd(), 'assets/icons/icon.icns'));
  possiblePaths.push(path.join(process.cwd(), 'assets/icons/icon.ico'));
  possiblePaths.push(path.join(process.cwd(), 'assets/icons/icon.png'));
  
  // Strategy 4: Platform-specific
  const platformIcon = process.platform === 'win32' ? 'icon.ico' : 
                       process.platform === 'darwin' ? 'icon.icns' : 'icon.png';
  possiblePaths.push(path.join(appPath, 'assets/icons', platformIcon));
  possiblePaths.push(path.join(__dirname, '../../assets/icons', platformIcon));
  possiblePaths.push(path.join(process.cwd(), 'assets/icons', platformIcon));
  
  // Find the first existing icon file
  try {
    for (const iconPath of possiblePaths) {
      if (fs.existsSync(iconPath)) {
        console.log('Found icon at:', iconPath);
        return iconPath;
      }
    }
    console.warn('No icon found. Tried paths:', possiblePaths.slice(0, 3));
  } catch (e) {
    console.error('Error checking icon paths:', e);
  }
  
  return undefined;
}

async function handleUninstallRequest(): Promise<void> {
  const detailByPlatform: Record<NodeJS.Platform, string> = {
    darwin:
      'This removes Messenger app data (settings, cache, logs) from this Mac.\nTo fully remove the application bundle, move Messenger.app to the Trash after this finishes.',
    win32:
      'This removes Messenger app data (settings, cache, logs) from this PC.\nTo fully uninstall the app, remove it from Apps & Features after this finishes.',
    linux:
      'This removes Messenger app data (settings, cache, logs) from this machine.\nIf you installed from a package manager, remove the package separately after this finishes.',
    aix: 'This removes Messenger app data (settings, cache, logs).',
    android: 'This removes Messenger app data (settings, cache, logs).',
    freebsd: 'This removes Messenger app data (settings, cache, logs).',
    haiku: 'This removes Messenger app data (settings, cache, logs).',
    openbsd: 'This removes Messenger app data (settings, cache, logs).',
    sunos: 'This removes Messenger app data (settings, cache, logs).',
    cygwin: 'This removes Messenger app data (settings, cache, logs).',
    netbsd: 'This removes Messenger app data (settings, cache, logs).',
  };

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Uninstall Messenger',
    message: 'Remove all Messenger data from this device?',
    detail: detailByPlatform[process.platform] || detailByPlatform.linux,
  });

  if (response !== 0) {
    return;
  }

  await dialog.showMessageBox({
    type: 'info',
    buttons: ['Quit Messenger'],
    defaultId: 0,
    title: 'Uninstall complete',
    message: 'Messenger will quit and remove its data.',
    detail:
      process.platform === 'darwin'
        ? 'If you want to remove the application itself, move Messenger.app to the Trash.'
        : process.platform === 'win32'
        ? 'If you want to remove the application itself, uninstall Messenger from Apps & Features.'
        : 'If you want to remove the application itself, uninstall it using your package manager or delete the AppImage/binary.',
  });

  // Perform deletion after the app exits to avoid Electron recreating files (Crashpad, logs, etc.)
  const targets = uninstallTargets().map((t) => t.path);
  scheduleExternalCleanup(targets);

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
      autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
        console.warn('[AutoUpdater] manual check failed', err);
        dialog.showMessageBox({
          type: 'warning',
          title: 'Update check failed',
          message: 'Could not check for updates. Please try again later.',
          buttons: ['OK'],
        }).catch(() => {});
      });
    },
  };

  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' as const },
          { role: 'services' as const },
          { type: 'separator' },
          { role: 'hide' as const },
          { role: 'hideOthers' as const },
          { role: 'unhide' as const },
          { type: 'separator' },
          { role: 'quit' as const },
        ],
      },
      {
        label: 'File',
        submenu: [
          checkUpdatesMenuItem,
          uninstallMenuItem,
          { type: 'separator' },
          { role: 'close' as const },
        ],
      },
      { role: 'editMenu' as const },
      { role: 'viewMenu' as const },
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
        checkUpdatesMenuItem,
        uninstallMenuItem,
        { type: 'separator' },
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
    if (mainWindow) {
      mainWindow.webContents.send('notification-action-handler', action, data);
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
      console.log('[FallbackLog]', safeName, payload || {});
    } catch (e) {
      console.warn('[FallbackLog] Failed to log fallback message', e);
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

// Helper function to get dock icon path for macOS
function getDockIconPath(): string | undefined {
  const possiblePaths = [
    // When running from dist/main/main.js
    path.resolve(__dirname, '../../assets/icons/icon.icns'),
    // When running from project root
    path.resolve(process.cwd(), 'assets/icons/icon.icns'),
    // When packaged
    path.join(app.getAppPath(), 'assets/icons/icon.icns'),
  ];
  
  for (const iconPath of possiblePaths) {
    try {
      if (fs.existsSync(iconPath)) {
        return iconPath;
      }
    } catch (e) {
      // Continue to next path
    }
  }
  
  return undefined;
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

// App lifecycle
app.whenReady().then(async () => {
  // Auto-updater setup (skip in dev mode - app-update.yml only exists in published builds)
  if (!isDev) {
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.logger = console;
      autoUpdater.on('update-available', () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Update available',
          message: 'A new version is available. It will download in the background.',
          buttons: ['OK'],
        }).catch(() => {});
      });
      autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Update ready',
          message: 'Update downloaded. Restart to install now?',
          buttons: ['Restart Now', 'Later'],
          cancelId: 1,
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall();
          }
        }).catch(() => {});
      });
      autoUpdater.on('error', (err: unknown) => {
        console.warn('[AutoUpdater] error', err);
      });
      autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
        console.warn('[AutoUpdater] check failed', err);
      });
    } catch (e) {
      console.warn('[AutoUpdater] init failed', e);
    }
  } else {
    console.log('[AutoUpdater] Skipped in development mode');
  }

  // Set dock icon for macOS (must be done after app is ready)
  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = getDockIconPath();
    if (dockIconPath) {
      try {
        const dockIcon = nativeImage.createFromPath(dockIconPath);
        if (!dockIcon.isEmpty()) {
          app.dock.setIcon(dockIcon);
          console.log('✓ Set dock icon from:', dockIconPath);
        }
      } catch (e) {
        console.warn('⚠ Could not set dock icon:', e);
      }
    }
  }

  // Prompt to move to Applications folder on macOS (first run only)
  await promptMoveToApplications();
  
  // Initialize managers
  notificationHandler = new NotificationHandler(() => mainWindow);
  badgeManager = new BadgeManager();
  backgroundService = new BackgroundService();

  // Request notification permission
  if (Notification.isSupported()) {
    // Electron doesn't require explicit permission, but we'll check anyway
  }

  // Create application menu
  createApplicationMenu();

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
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
});

app.on('window-all-closed', () => {
  // Quit on all platforms (including macOS) when the last window closes
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});
