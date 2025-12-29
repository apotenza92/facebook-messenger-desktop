import { app, BrowserWindow, ipcMain, Notification, Menu, nativeImage, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { NotificationHandler } from './notification-handler';
import { BadgeManager } from './badge-manager';
import { BackgroundService } from './background-service';

const resetFlag = process.argv.includes('--reset') || process.env.MESSENGER_RESET_STATE === '1';
const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
let notificationHandler: NotificationHandler;
let badgeManager: BadgeManager;
let backgroundService: BackgroundService;
let isQuitting = false;
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');

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

function loadWindowState(): WindowState {
  // If explicitly requested, clear saved state to force defaults (window size/position only)
  if (resetFlag && fs.existsSync(windowStateFile)) {
    try {
      fs.rmSync(windowStateFile);
      console.log('[Window State] Cleared stored state for reset flag');
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

// Set app name early (before app is ready)
app.setName('Messenger');

function createWindow(): void {
  const restoredState = ensureWindowInBounds(loadWindowState());
  const hasPosition = restoredState.x !== undefined && restoredState.y !== undefined;

  mainWindow = new BrowserWindow({
    width: restoredState.width,
    height: restoredState.height,
    x: hasPosition ? restoredState.x : undefined,
    y: hasPosition ? restoredState.y : undefined,
    center: !hasPosition,
    minWidth: 400,
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

  // Inject notification override script after page loads (like Caprine does)
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
        // Fallback: inject inline script
        await mainWindow?.webContents.executeJavaScript(`
          (function() {
            const augmentedNotification = Object.assign(
              class {
                constructor(title, options) {
                  // Handle React props (Messenger uses React)
                  let {body} = options || {};
                  const bodyProperties = body?.props;
                  body = bodyProperties ? bodyProperties.content?.[0] : (options?.body || '');
                  
                  const titleProperties = title?.props;
                  title = titleProperties ? titleProperties.content?.[0] : (title || '');
                  
                  // Use bridge function if available
                  if (window.__electronNotificationBridge) {
                    window.__electronNotificationBridge({
                      title: String(title),
                      body: String(body),
                      icon: options?.icon,
                      tag: options?.tag,
                      silent: options?.silent,
                    });
                  }
                }
                close() {}
                static requestPermission() { return Promise.resolve('granted'); }
                static get permission() { return 'granted'; }
              },
              Notification
            );
            Object.assign(window, {Notification: augmentedNotification});
            try {
              Object.defineProperty(window, 'Notification', {
                value: augmentedNotification,
                writable: false,
                configurable: false,
                enumerable: true,
              });
            } catch (e) {}
            console.log('[Notification Inject] Override applied');
          })();
        `);
        console.log('[Main Process] Injected fallback notification override');
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
    const fs = require('fs');
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

// IPC Handlers
function createApplicationMenu(): void {
  // On macOS, use native menu (no customizations)
  // Electron will provide default native menus automatically
  if (process.platform === 'darwin') {
    return;
  }

  // For other platforms, provide basic menus
  const template: Electron.MenuItemConstructorOptions[] = [
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
  const fs = require('fs');
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

// App lifecycle
app.whenReady().then(() => {
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
  // On macOS, keep app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});
