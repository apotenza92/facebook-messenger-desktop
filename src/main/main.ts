import { app, BrowserWindow, BrowserView, ipcMain, Notification, Menu, nativeImage, screen, dialog, systemPreferences, Tray, shell, nativeTheme, desktopCapturer } from 'electron';
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

// On Linux: Apply XWayland preference if set (for screen sharing compatibility)
// This must happen before the app is ready
if (process.platform === 'linux' && !process.env.MESSENGER_XWAYLAND_CHECKED) {
  // Mark that we've checked to prevent infinite restart loop
  process.env.MESSENGER_XWAYLAND_CHECKED = '1';
  
  // Check if user prefers XWayland mode
  const userDataPath = app.getPath('userData');
  const xwaylandPrefFile = path.join(userDataPath, 'xwayland-preference.json');
  
  try {
    if (fs.existsSync(xwaylandPrefFile)) {
      const data = JSON.parse(fs.readFileSync(xwaylandPrefFile, 'utf8'));
      const shouldUseXWayland = data.useXWayland === true;
      const currentlyUsingXWayland = process.env.ELECTRON_OZONE_PLATFORM_HINT === 'x11';
      
      // Restart if preference doesn't match current mode
      if (shouldUseXWayland && !currentlyUsingXWayland) {
        console.log('[XWayland] User prefers XWayland mode, restarting...');
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: 'x11', MESSENGER_XWAYLAND_CHECKED: '1' }
        });
        child.unref();
        process.exit(0);
      }
    }
  } catch (e) {
    // Ignore errors, just continue with default mode
  }
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
const iconThemeFile = path.join(app.getPath('userData'), 'icon-theme.json');
const xwaylandPreferenceFile = path.join(app.getPath('userData'), 'xwayland-preference.json');
const betaOptInFile = path.join(app.getPath('userData'), 'beta-opt-in.json');

// XWayland preference for Linux Wayland users (for screen sharing compatibility)
let useXWayland = false;

// Beta program opt-in state
let betaOptedIn = false;

function loadBetaOptIn(): boolean {
  try {
    if (fs.existsSync(betaOptInFile)) {
      const data = JSON.parse(fs.readFileSync(betaOptInFile, 'utf8'));
      return data.betaOptIn === true;
    }
  } catch (e) {
    console.warn('[Beta] Failed to load beta opt-in preference:', e);
  }
  return false;
}

function saveBetaOptIn(optIn: boolean): void {
  try {
    fs.writeFileSync(betaOptInFile, JSON.stringify({ betaOptIn: optIn }));
    betaOptedIn = optIn;
    console.log('[Beta] Saved beta opt-in preference:', optIn);
  } catch (e) {
    console.warn('[Beta] Failed to save beta opt-in preference:', e);
  }
}

function isBetaOptedIn(): boolean {
  return betaOptedIn;
}

function loadXWaylandPreference(): boolean {
  try {
    if (fs.existsSync(xwaylandPreferenceFile)) {
      const data = JSON.parse(fs.readFileSync(xwaylandPreferenceFile, 'utf8'));
      return data.useXWayland === true;
    }
  } catch (e) {
    console.warn('[XWayland] Failed to load preference:', e);
  }
  return false;
}

function saveXWaylandPreference(value: boolean): void {
  try {
    fs.writeFileSync(xwaylandPreferenceFile, JSON.stringify({ useXWayland: value }));
    console.log('[XWayland] Preference saved:', value);
  } catch (e) {
    console.error('[XWayland] Failed to save preference:', e);
  }
}

function isRunningOnWayland(): boolean {
  if (process.platform !== 'linux') return false;
  // Check if we're running on native Wayland (not XWayland)
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  const xdgSessionType = process.env.XDG_SESSION_TYPE;
  const electronOzone = process.env.ELECTRON_OZONE_PLATFORM_HINT;
  
  // If we forced X11 mode, we're on XWayland
  if (electronOzone === 'x11') return false;
  
  // Check for Wayland session
  return xdgSessionType === 'wayland' || !!waylandDisplay;
}

function isRunningXWaylandMode(): boolean {
  // Check if we explicitly set X11 mode via env var
  return process.env.ELECTRON_OZONE_PLATFORM_HINT === 'x11';
}

function restartWithXWaylandMode(useX11: boolean): void {
  saveXWaylandPreference(useX11);
  
  // Restart the app with the appropriate environment
  const args = process.argv.slice(1);
  const options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore' } = {
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
  };
  
  if (useX11) {
    options.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
    console.log('[XWayland] Restarting with XWayland mode...');
  } else {
    delete options.env.ELECTRON_OZONE_PLATFORM_HINT;
    console.log('[XWayland] Restarting with native Wayland mode...');
  }
  
  const child = spawn(process.execPath, args, options);
  child.unref();
  app.quit();
}


// Custom login page CSS - matches docs/index.html style
const LOGIN_PAGE_CSS = `
  /* Prevent scrolling - lock viewport */
  html, body {
    overflow: hidden !important;
    height: 100vh !important;
    max-height: 100vh !important;
  }
  
  /* Hide everything we don't need */
  header, nav, [role="navigation"], footer, [role="contentinfo"] {
    display: none !important;
  }
  
  /* Hide any secondary main content (footer area) */
  main + main, main ~ main {
    display: none !important;
  }
  
  /* Hide headings and subtitles */
  h1:not(.md-title), h2, p:not(form p):not(.md-subtitle):not(.md-trademark) {
    display: none !important;
  }
  
  /* Hide all links outside the form */
  body > a, body > div > a {
    display: none !important;
  }
  
  /* Hide ALL images except our icon */
  img:not(.md-icon):not(#md-app-icon), picture, video {
    display: none !important;
  }
  
  /* Our icon image styling - multiple selectors for maximum specificity */
  img.md-icon,
  #md-app-icon,
  #md-header img,
  #md-wrapper img.md-icon {
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    width: 72px !important;
    height: 72px !important;
    min-width: 72px !important;
    min-height: 72px !important;
    max-width: 72px !important;
    max-height: 72px !important;
    margin: 0 auto 12px auto !important;
    border-radius: 16px !important;
    position: relative !important;
    z-index: 9999 !important;
    transform: none !important;
    clip: auto !important;
    overflow: visible !important;
  }
  
  /* Hide all main elements to prevent layout issues */
  main {
    display: contents !important;
  }
  
  /* Clean centered layout */
  body {
    margin: 0 !important;
    padding: 0 !important;
    min-height: 100vh !important;
    background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 50%, #f8f9fa 100%) !important;
    overflow-x: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
  }
  
  /* Wrapper for centering content */
  #md-wrapper {
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    min-height: 100vh !important;
    padding: 1.5rem !important;
    box-sizing: border-box !important;
  }
  
  @media (prefers-color-scheme: dark) {
    body {
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0f0f23 100%) !important;
    }
  }
  
  /* Our custom header - with proper spacing */
  #md-header {
    text-align: center;
    margin-bottom: 1.25rem;
    display: flex !important;
    flex-direction: column;
    align-items: center;
  }
  
  #md-header .md-icon {
    width: 72px !important;
    height: 72px !important;
    margin-bottom: 0.75rem !important;
    border-radius: 20px !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
  }
  
  #md-header .md-title {
    font-size: 1.65rem !important;
    font-weight: 600 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    color: #1a1a1a !important;
    margin: 0 0 0.6rem 0 !important;
    display: block !important;
  }
  
  #md-header .md-subtitle {
    font-size: 0.9rem !important;
    font-weight: 400 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    color: #666 !important;
    line-height: 1.4 !important;
    max-width: 380px !important;
    margin: 0 0 0.75rem 0 !important;
    display: block !important;
  }
  
  #md-header .md-trademark {
    font-size: 0.7rem !important;
    font-weight: 400 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    color: #888 !important;
    line-height: 1.4 !important;
    max-width: 380px !important;
    margin: 0 0 0.75rem 0 !important;
    display: block !important;
  }
  
  #md-header .md-github {
    display: inline-flex !important;
    align-items: center !important;
    gap: 0.35rem !important;
    font-size: 0.8rem !important;
    font-weight: 500 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    color: #0084ff !important;
    text-decoration: none !important;
    transition: opacity 0.2s ease !important;
  }
  
  #md-header .md-github:hover {
    opacity: 0.8 !important;
  }
  
  #md-header .md-github svg {
    width: 16px !important;
    height: 16px !important;
    fill: currentColor !important;
  }
  
  @media (prefers-color-scheme: dark) {
    #md-header .md-title {
      color: #ffffff !important;
    }
    #md-header .md-subtitle {
      color: #888 !important;
    }
    #md-header .md-trademark {
      color: #666 !important;
    }
  }
  
  /* Hide Facebook's original form completely */
  form {
    position: absolute !important;
    left: -9999px !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  
  /* Our custom form styling */
  #md-login-form {
    background: white;
    padding: 24px;
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.1);
    max-width: 360px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  
  #md-login-form input[type="text"],
  #md-login-form input[type="password"] {
    width: 100%;
    padding: 14px 16px;
    border: 1px solid #dddfe2;
    border-radius: 8px;
    font-size: 16px;
    box-sizing: border-box;
    background: #f5f6f7;
    transition: border-color 0.2s, background 0.2s;
  }
  
  #md-login-form input[type="text"]:focus,
  #md-login-form input[type="password"]:focus {
    border-color: #0084ff;
    outline: none;
    background: white;
  }
  
  #md-login-form input::placeholder {
    color: #8a8d91;
  }
  
  #md-login-form button {
    background: #0084ff;
    color: white;
    border: none;
    border-radius: 24px;
    padding: 12px 24px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
    margin-top: 4px;
  }
  
  #md-login-form button:hover {
    background: #0073e6;
  }
  
  #md-login-form button:active {
    background: #0062cc;
  }
  
  #md-login-form .md-checkbox-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }
  
  #md-login-form .md-checkbox-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    margin: 0;
    cursor: pointer;
    accent-color: #0084ff;
  }
  
  #md-login-form .md-checkbox-row label {
    font-size: 14px;
    color: #65676b;
    cursor: pointer;
    user-select: none;
  }
  
  @media (prefers-color-scheme: dark) {
    #md-login-form {
      background: #242526;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3), 0 0 1px rgba(255, 255, 255, 0.1);
    }
    
    #md-login-form input[type="text"],
    #md-login-form input[type="password"] {
      background: #3a3b3c;
      border-color: #3a3b3c;
      color: #e4e6eb;
    }
    
    #md-login-form input[type="text"]:focus,
    #md-login-form input[type="password"]:focus {
      background: #4a4b4c;
      border-color: #0084ff;
    }
    
    #md-login-form input::placeholder {
      color: #8a8d91;
    }
    
    #md-login-form .md-checkbox-row label {
      color: #b0b3b8;
    }
  }
`;

// JavaScript to inject the header with branding (icon embedded as base64)
// Also moves the form directly after the header
const LOGIN_PAGE_HEADER_JS = `
  (function() {
    // Only inject once
    if (document.getElementById('md-wrapper')) return;
    
    // Hide all existing body children (Facebook's UI) but keep form accessible
    Array.from(document.body.children).forEach(child => {
      if (child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE') {
        child.style.cssText = 'position: absolute !important; left: -9999px !important; opacity: 0 !important;';
      }
    });
    
    // Create wrapper for centering
    const wrapper = document.createElement('div');
    wrapper.id = 'md-wrapper';
    
    // Create header
    const header = document.createElement('div');
    header.id = 'md-header';
    
    // Icon (SVG embedded - actual app icon with white rounded rect background for crisp rendering at any size)
    const iconImg = document.createElement('img');
    iconImg.className = 'md-icon';
    iconImg.src = "data:image/svg+xml,%3Csvg viewBox='0 0 1000 1000' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='1000' height='1000' rx='200' fill='%23ffffff'/%3E%3Cg transform='translate(55,50) scale(0.89)'%3E%3Cpath d='M1000 486c0 279-218 485-500 485-51 0-99-7-145-19-9-3-18-2-27 2l-99 44c-26 11-55-7-56-35l-3-89c0-11-5-21-13-28C60 758 0 632 0 486 0 207 219 1 501 1c282 0 499 206 499 485z' fill='%230866ff'/%3E%3Cg stroke='%23fff' stroke-width='15' stroke-linecap='round'%3E%3Cline x1='500' y1='130' x2='840' y2='295'/%3E%3Cline x1='840' y1='295' x2='840' y2='665'/%3E%3Cline x1='840' y1='665' x2='500' y2='830'/%3E%3Cline x1='500' y1='830' x2='160' y2='665'/%3E%3Cline x1='160' y1='665' x2='160' y2='295'/%3E%3Cline x1='160' y1='295' x2='500' y2='130'/%3E%3Cline x1='500' y1='480' x2='500' y2='130'/%3E%3Cline x1='500' y1='480' x2='840' y2='295'/%3E%3Cline x1='500' y1='480' x2='840' y2='665'/%3E%3Cline x1='500' y1='480' x2='500' y2='830'/%3E%3Cline x1='500' y1='480' x2='160' y2='665'/%3E%3Cline x1='500' y1='480' x2='160' y2='295'/%3E%3C/g%3E%3Ccircle cx='500' cy='480' r='90' fill='%23fff'/%3E%3Ccircle cx='500' cy='130' r='58' fill='%23fff'/%3E%3Ccircle cx='840' cy='295' r='58' fill='%23fff'/%3E%3Ccircle cx='840' cy='665' r='58' fill='%23fff'/%3E%3Ccircle cx='500' cy='830' r='58' fill='%23fff'/%3E%3Ccircle cx='160' cy='665' r='58' fill='%23fff'/%3E%3Ccircle cx='160' cy='295' r='58' fill='%23fff'/%3E%3C/g%3E%3C/svg%3E";
    iconImg.alt = 'Messenger Desktop';
    header.appendChild(iconImg);
    
    // Title
    const title = document.createElement('h1');
    title.className = 'md-title';
    title.textContent = 'Messenger Desktop';
    header.appendChild(title);
    
    // Subtitle
    const subtitle = document.createElement('p');
    subtitle.className = 'md-subtitle';
    subtitle.textContent = 'An unofficial, open-source desktop application for Facebook Messenger.';
    header.appendChild(subtitle);
    
    // Trademark
    const trademark = document.createElement('p');
    trademark.className = 'md-trademark';
    trademark.textContent = 'This project is not affiliated with, endorsed by, or connected to Meta Platforms, Inc. "Facebook" and "Messenger" are trademarks of Meta Platforms, Inc.';
    header.appendChild(trademark);
    
    // GitHub link
    const githubLink = document.createElement('a');
    githubLink.className = 'md-github';
    githubLink.href = 'https://github.com/apotenza92/facebook-messenger-desktop';
    githubLink.target = '_blank';
    githubLink.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg> View on GitHub';
    header.appendChild(githubLink);
    
    wrapper.appendChild(header);
    
    // Create our custom login form
    const customForm = document.createElement('div');
    customForm.id = 'md-login-form';
    
    const emailInput = document.createElement('input');
    emailInput.type = 'text';
    emailInput.id = 'md-email';
    emailInput.placeholder = 'Email address or phone number';
    emailInput.autocomplete = 'username';
    customForm.appendChild(emailInput);
    
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.id = 'md-password';
    passwordInput.placeholder = 'Password';
    passwordInput.autocomplete = 'current-password';
    customForm.appendChild(passwordInput);
    
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.id = 'md-login-btn';
    loginBtn.textContent = 'Log In';
    customForm.appendChild(loginBtn);
    
    const checkboxRow = document.createElement('div');
    checkboxRow.className = 'md-checkbox-row';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'md-keep-signed-in';
    checkboxRow.appendChild(checkbox);
    
    const checkboxLabel = document.createElement('label');
    checkboxLabel.htmlFor = 'md-keep-signed-in';
    checkboxLabel.textContent = 'Keep me signed in';
    checkboxRow.appendChild(checkboxLabel);
    
    customForm.appendChild(checkboxRow);
    wrapper.appendChild(customForm);
    
    document.body.insertBefore(wrapper, document.body.firstChild);
    
    // Handle login submission
    function submitLogin() {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      const keepSignedIn = checkbox.checked;
      
      if (!email || !password) {
        if (!email) emailInput.style.borderColor = '#f44336';
        if (!password) passwordInput.style.borderColor = '#f44336';
        return;
      }
      
      // Find Facebook's login form specifically (it has id="login_form")
      const fbForm = document.querySelector('form#login_form') || document.querySelector('form');
      if (!fbForm) {
        console.error('[LoginPage] Could not find Facebook form');
        alert('Login error: Could not find login form. Please reload the page.');
        return;
      }
      
      console.log('[LoginPage] Found form:', fbForm.id || 'no id');
      
      // Find Facebook's inputs using their specific names
      const fbEmailInput = fbForm.querySelector('input[name="email"]') || 
                          fbForm.querySelector('input[type="text"]');
      const fbPasswordInput = fbForm.querySelector('input[name="pass"]') || 
                             fbForm.querySelector('input[type="password"]');
      const fbCheckbox = fbForm.querySelector('input[name="persistent"]') ||
                        fbForm.querySelector('input[type="checkbox"]');
      
      console.log('[LoginPage] Found inputs - email:', !!fbEmailInput, 'password:', !!fbPasswordInput);
      
      if (fbEmailInput && fbPasswordInput) {
        // Fill in Facebook's form
        fbEmailInput.value = email;
        fbPasswordInput.value = password;
        
        // Dispatch events so React recognizes the values
        ['input', 'change', 'blur'].forEach(eventType => {
          fbEmailInput.dispatchEvent(new Event(eventType, { bubbles: true }));
          fbPasswordInput.dispatchEvent(new Event(eventType, { bubbles: true }));
        });
        
        // Handle checkbox
        if (fbCheckbox && keepSignedIn !== fbCheckbox.checked) {
          fbCheckbox.click();
        }
        
        // Click Facebook's login button - use specific selectors
        setTimeout(() => {
          // The login button has id="loginbutton" and name="login"
          const fbLoginBtn = fbForm.querySelector('#loginbutton') ||
                            fbForm.querySelector('button[name="login"]') ||
                            fbForm.querySelector('button[type="submit"]');
          if (fbLoginBtn) {
            console.log('[LoginPage] Clicking Facebook login button:', fbLoginBtn.id || fbLoginBtn.name || fbLoginBtn.textContent);
            fbLoginBtn.click();
          } else {
            console.log('[LoginPage] No button found, submitting form directly');
            fbForm.submit();
          }
        }, 100);
      } else {
        console.error('[LoginPage] Could not find Facebook form inputs');
        alert('Login error: Could not find form inputs. Please reload the page.');
      }
    }
    
    loginBtn.addEventListener('click', submitLogin);
    
    // Enter key handling
    emailInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') passwordInput.focus();
    });
    passwordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitLogin();
    });
    
    // Clear error styling on input
    emailInput.addEventListener('input', () => emailInput.style.borderColor = '');
    passwordInput.addEventListener('input', () => passwordInput.style.borderColor = '');
    
    console.log('[LoginPage] Custom login form created');
  })();
`;

function getLoginPageCSS(): string {
  return LOGIN_PAGE_CSS;
}

// Check if URL is a login/unauthenticated page (show disclaimer banner)
function isLoginPage(url: string): boolean {
  // Show custom login form on messenger.com/login/ page
  const isMessengerDomain = url.startsWith('https://www.messenger.com') || url.startsWith('https://messenger.com');
  if (!isMessengerDomain) return false;
  
  // If URL has /t/ (conversation thread), user is logged in
  // If URL has /e2ee/t/ (encrypted thread), user is logged in
  const hasConversationPath = url.includes('/t/') || url.includes('/e2ee/');
  if (hasConversationPath) return false;
  
  // Only show custom login form on the dedicated login page
  // The URL should be exactly /login/ or /login (with optional query params)
  const urlObj = new URL(url);
  const isLoginPath = urlObj.pathname === '/login/' || urlObj.pathname === '/login';
  
  return isLoginPath;
}

// Check if URL is a Facebook CDN media URL (for native download handling)
// Facebook serves images, videos, and other media from *.fbcdn.net domains
function isFacebookMediaUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    // Facebook CDN patterns: scontent*.fbcdn.net, video*.fbcdn.net, etc.
    return hostname.endsWith('.fbcdn.net');
  } catch {
    return false;
  }
}

// Check if we're on a Facebook verification/checkpoint page (2FA, security check, etc.)
function isVerificationPage(url: string): boolean {
  const isMessengerDomain = url.startsWith('https://www.messenger.com') || url.startsWith('https://messenger.com');
  const isFacebookDomain = url.startsWith('https://www.facebook.com') || url.startsWith('https://facebook.com');
  
  if (!isMessengerDomain && !isFacebookDomain) return false;
  
  // These are security/verification pages where we should show a banner
  return url.includes('/checkpoint') || 
         url.includes('/recover') ||
         url.includes('/challenge') ||
         url.includes('/two_step_verification') ||
         url.includes('/login/identify') ||
         url.includes('/login/device-based');
}

// CSS for the verification page banner (shown during 2FA, security checks, etc.)
// Generate verification banner CSS with platform-specific offset
function getVerificationBannerCSS(): string {
  // macOS has hybrid title bar overlay, other platforms don't
  const topOffset = process.platform === 'darwin' ? '16px' : '0px';
  const bodyPadding = process.platform === 'darwin' ? '85px' : '70px';
  
  return `
  #md-verification-banner {
    position: fixed;
    top: ${topOffset};
    left: 0;
    right: 0;
    background: linear-gradient(135deg, #0084ff 0%, #0066cc 100%);
    color: #ffffff;
    padding: 12px 24px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    z-index: 999999;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  }
  #md-verification-banner .md-icon {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
  }
  #md-verification-banner .md-content {
    text-align: left;
  }
  #md-verification-banner a {
    color: #ffffff;
    text-decoration: underline;
    font-weight: 500;
  }
  #md-verification-banner a:hover {
    opacity: 0.9;
  }
  #md-verification-banner .md-app-name {
    font-weight: 700;
    font-size: 15px;
    display: block;
  }
  #md-verification-banner .md-subtitle {
    font-size: 12px;
    opacity: 0.9;
    margin-top: 2px;
    display: block;
  }
  /* Add top padding to page content so banner doesn't overlap */
  body {
    padding-top: ${bodyPadding} !important;
  }
`;
}

const VERIFICATION_BANNER_JS = `
  (function() {
    if (document.getElementById('md-verification-banner')) return;
    
    const banner = document.createElement('div');
    banner.id = 'md-verification-banner';
    banner.innerHTML = \`
      <img class="md-icon" src="data:image/svg+xml,%3Csvg viewBox='0 0 1000 1000' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='1000' height='1000' rx='200' fill='%23ffffff'/%3E%3Cg transform='translate(55,50) scale(0.89)'%3E%3Cpath d='M1000 486c0 279-218 485-500 485-51 0-99-7-145-19-9-3-18-2-27 2l-99 44c-26 11-55-7-56-35l-3-89c0-11-5-21-13-28C60 758 0 632 0 486 0 207 219 1 501 1c282 0 499 206 499 485z' fill='%230866ff'/%3E%3Cg stroke='%23fff' stroke-width='15' stroke-linecap='round'%3E%3Cline x1='500' y1='130' x2='840' y2='295'/%3E%3Cline x1='840' y1='295' x2='840' y2='665'/%3E%3Cline x1='840' y1='665' x2='500' y2='830'/%3E%3Cline x1='500' y1='830' x2='160' y2='665'/%3E%3Cline x1='160' y1='665' x2='160' y2='295'/%3E%3Cline x1='160' y1='295' x2='500' y2='130'/%3E%3Cline x1='500' y1='480' x2='500' y2='130'/%3E%3Cline x1='500' y1='480' x2='840' y2='295'/%3E%3Cline x1='500' y1='480' x2='840' y2='665'/%3E%3Cline x1='500' y1='480' x2='500' y2='830'/%3E%3Cline x1='500' y1='480' x2='160' y2='665'/%3E%3Cline x1='500' y1='480' x2='160' y2='295'/%3E%3C/g%3E%3Ccircle cx='500' cy='480' r='90' fill='%23fff'/%3E%3Ccircle cx='500' cy='130' r='58' fill='%23fff'/%3E%3Ccircle cx='840' cy='295' r='58' fill='%23fff'/%3E%3Ccircle cx='840' cy='665' r='58' fill='%23fff'/%3E%3Ccircle cx='500' cy='830' r='58' fill='%23fff'/%3E%3Ccircle cx='160' cy='665' r='58' fill='%23fff'/%3E%3Ccircle cx='160' cy='295' r='58' fill='%23fff'/%3E%3C/g%3E%3C/svg%3E" alt="Messenger Desktop" />
      <div class="md-content">
        <span class="md-app-name">You're signing in to Messenger Desktop</span>
        <span class="md-subtitle">
          Complete the verification below to continue. This is an unofficial, open-source app — not affiliated with Meta.
        </span>
      </div>
    \`;
    document.body.appendChild(banner);
    console.log('[VerificationBanner] Banner added to verification page');
  })();
`;

// Inject simplified login page CSS (hides most elements, keeps login form + disclaimer)
// Also injects a banner on verification pages
async function injectLoginPageCSS(webContents: Electron.WebContents): Promise<void> {
  try {
    const url = webContents.getURL();
    if (isLoginPage(url)) {
      await webContents.insertCSS(getLoginPageCSS());
      await webContents.executeJavaScript(LOGIN_PAGE_HEADER_JS);
      console.log('[LoginPage] Custom login page styling injected');
    } else if (isVerificationPage(url)) {
      await webContents.insertCSS(getVerificationBannerCSS());
      await webContents.executeJavaScript(VERIFICATION_BANNER_JS);
      console.log('[VerificationPage] Banner injected on verification page');
    }
  } catch (e) {
    console.warn('[LoginPage] Failed to inject styling:', e);
  }
}

// Icon theme: 'light', 'dark', or 'system' (default)
// 'system' mode: Auto-switches between our light/dark icons based on OS dark mode
// This ensures our dark icon (with white interior) is shown instead of system's
// automatic darkening which would make everything dark including the interior
type IconTheme = 'light' | 'dark' | 'system';
let currentIconTheme: IconTheme = 'system';

// Request single instance lock early (before app.whenReady) to prevent race conditions
// on Linux/Windows where multiple instances might start before lock is checked
const gotTheLock = app.requestSingleInstanceLock();
console.log(`[SingleInstance] Lock acquired: ${gotTheLock}`);
if (!gotTheLock) {
  // Another instance is already running - quit immediately
  // app.quit() is asynchronous and doesn't stop code execution, so we must also
  // call process.exit() to prevent whenReady() callbacks from running
  console.log('[SingleInstance] Another instance is already running, quitting...');
  app.quit();
  process.exit(0);
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

// ===== Icon Theme Functions =====

function loadIconTheme(): IconTheme {
  try {
    if (fs.existsSync(iconThemeFile)) {
      const raw = fs.readFileSync(iconThemeFile, 'utf8');
      const parsed = JSON.parse(raw);
      // Handle migration from old 'native' setting
      if (parsed.theme === 'native') {
        return 'system';
      }
      if (parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system') {
        console.log('[Icon Theme] Loaded theme:', parsed.theme);
        return parsed.theme;
      }
    }
  } catch (e) {
    console.warn('[Icon Theme] Failed to load theme, using default:', e);
  }
  console.log('[Icon Theme] Using default theme: system');
  return 'system';
}

function saveIconTheme(theme: IconTheme): void {
  try {
    fs.writeFileSync(iconThemeFile, JSON.stringify({ theme }));
    console.log('[Icon Theme] Saved theme:', theme);
  } catch (e) {
    console.warn('[Icon Theme] Failed to save theme:', e);
  }
}

function shouldUseDarkIcon(): boolean {
  if (currentIconTheme === 'light') return false;
  if (currentIconTheme === 'dark') return true;
  // 'system' mode: use nativeTheme to determine
  return nativeTheme.shouldUseDarkColors;
}

function getIconSubdir(): string {
  // Returns 'dark' or '' (empty for light/default icons)
  return shouldUseDarkIcon() ? 'dark' : '';
}

function applyCurrentIconTheme(): void {
  const useDark = shouldUseDarkIcon();
  console.log(`[Icon Theme] Applying theme, useDark=${useDark}, currentIconTheme=${currentIconTheme}`);
  
  // Update window icon (Windows/Linux only)
  if (process.platform !== 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    const icon = getWindowIcon();
    if (icon) {
      mainWindow.setIcon(icon);
      console.log('[Icon Theme] Window icon updated');
    }
  }
  
  // Update macOS dock icon
  if (process.platform === 'darwin' && app.dock) {
    if (currentIconTheme === 'system') {
      // In 'system' mode on macOS: Use native bundle icon
      // This allows Tahoe's glass/clear effects AND automatic dark mode handling
      app.dock.setIcon(null as unknown as Electron.NativeImage);
      console.log('[Icon Theme] macOS system mode - using native bundle icon (system effects enabled)');
    } else {
      // Explicit light/dark selection - use our custom icon
      const dockIcon = getDockIcon();
      if (dockIcon) {
        app.dock.setIcon(dockIcon);
        console.log('[Icon Theme] Dock icon updated (explicit selection)');
      }
    }
  }
  
  // Update tray icon (Windows/Linux only - macOS uses template)
  if (tray && process.platform !== 'darwin') {
    const trayIconPath = getTrayIconPath();
    if (trayIconPath) {
      tray.setImage(trayIconPath);
      console.log('[Icon Theme] Tray icon updated');
    }
  }
}

function setIconTheme(theme: IconTheme): void {
  if (theme === currentIconTheme) return;
  
  currentIconTheme = theme;
  saveIconTheme(theme);
  applyCurrentIconTheme();
  
  // Rebuild menu to update checkmarks
  createApplicationMenu();
}

function getDockIcon(): Electron.NativeImage | undefined {
  // For macOS dock, get the appropriate PNG icon
  const appPath = app.getAppPath();
  const subdir = getIconSubdir();
  
  // The icon.png in dark or root directory
  const possiblePaths: string[] = [];
  if (subdir) {
    possiblePaths.push(
      path.join(appPath, 'assets/icons', subdir, 'icon.png'),
      path.join(__dirname, '../../assets/icons', subdir, 'icon.png'),
      path.join(process.cwd(), 'assets/icons', subdir, 'icon.png'),
    );
  }
  // Fallback to light icons
  possiblePaths.push(
    path.join(appPath, 'assets/icons/icon.png'),
    path.join(__dirname, '../../assets/icons/icon.png'),
    path.join(process.cwd(), 'assets/icons/icon.png'),
  );
  
  for (const iconPath of possiblePaths) {
    if (fs.existsSync(iconPath)) {
      try {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          console.log('[Icon] Created dock nativeImage from:', iconPath);
          return icon;
        }
      } catch (e) {
        console.error('[Icon] Failed to create dock nativeImage:', e);
      }
    }
  }
  
  return undefined;
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
      console.log(`[Permissions] Request received: ${permission}`, {
        url,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        details: JSON.stringify(details),
      });
      
      if (!url.startsWith('https://www.messenger.com') && !url.startsWith('https://messenger.com')) {
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
      const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock'];
      const isAllowed = requestingOrigin.startsWith('https://www.messenger.com') || requestingOrigin.startsWith('https://messenger.com');
      const hasPermission = isAllowed && allowedPermissions.includes(permission);
      console.log(`[Permissions] Check: ${permission} from ${requestingOrigin} -> ${hasPermission ? 'allowed' : 'denied'}`);
      return hasPermission;
    });

    // Set up screen sharing handler for getDisplayMedia() calls
    // This is required for the "Share Screen" button to work during calls
    contentView.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
      console.log('[Screen Share] Display media request received');
      
      // On native Wayland, screen sharing has limited support - offer to switch to XWayland
      if (isRunningOnWayland() && !isRunningXWaylandMode()) {
        const result = await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          title: 'Screen Sharing on Wayland',
          message: 'Screen sharing may not work reliably on native Wayland.',
          detail: 'For reliable screen sharing, you can restart the app using XWayland compatibility mode.\n\nWould you like to restart with XWayland mode enabled?',
          buttons: ['Restart with XWayland', 'Try Anyway', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        });
        
        if (result.response === 0) {
          // User chose to restart with XWayland
          restartWithXWaylandMode(true);
          callback({});
          return;
        } else if (result.response === 2) {
          // User cancelled
          callback({});
          return;
        }
        // User chose "Try Anyway" - continue with screen sharing
      }
      
      try {
        // Get available screen/window sources
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 150, height: 150 },
          fetchWindowIcons: true,
        });
        
        console.log(`[Screen Share] Found ${sources.length} sources`);
        
        if (sources.length === 0) {
          console.log('[Screen Share] No sources available');
          callback({});
          return;
        }
        
        // If only one screen and no windows, auto-select it
        const screens = sources.filter(s => s.id.startsWith('screen:'));
        if (screens.length === 1 && sources.length === 1) {
          console.log('[Screen Share] Auto-selecting single screen:', screens[0].name);
          callback({ video: screens[0] });
          return;
        }
        
        // Show a picker dialog for the user to choose
        // Build choices array with source names
        const choices = sources.map((source, index) => {
          const icon = source.id.startsWith('screen:') ? '🖥️' : '🪟';
          return `${icon} ${source.name}`;
        });
        
        // Use Electron's dialog to let user pick
        const result = await dialog.showMessageBox(mainWindow!, {
          type: 'question',
          title: 'Share Screen',
          message: 'Choose what to share:',
          detail: 'Select a screen or window to share during your call.',
          buttons: [...choices, 'Cancel'],
          defaultId: 0,
          cancelId: choices.length,
        });
        
        if (result.response < sources.length) {
          const selectedSource = sources[result.response];
          console.log('[Screen Share] User selected:', selectedSource.name);
          callback({ video: selectedSource });
        } else {
          console.log('[Screen Share] User cancelled');
          callback({});
        }
      } catch (error) {
        console.error('[Screen Share] Error getting sources:', error);
        callback({});
      }
    });

    // Set up native download handler for Facebook CDN media files
    // This handles downloads initiated via webContents.downloadURL()
    contentView.webContents.session.on('will-download', (event, item, webContents) => {
      const url = item.getURL();
      const suggestedFilename = item.getFilename();
      console.log('[Download] Download started:', { url, filename: suggestedFilename });
      
      // Auto-save to Downloads folder
      const downloadsPath = app.getPath('downloads');
      const savePath = path.join(downloadsPath, suggestedFilename);
      item.setSavePath(savePath);
      
      // Log progress
      item.on('updated', (event, state) => {
        if (state === 'progressing') {
          if (item.isPaused()) {
            console.log('[Download] Paused');
          } else {
            const received = item.getReceivedBytes();
            const total = item.getTotalBytes();
            const percent = total > 0 ? Math.round((received / total) * 100) : 0;
            console.log(`[Download] Progress: ${percent}% (${received} / ${total})`);
          }
        } else if (state === 'interrupted') {
          console.log('[Download] Interrupted');
        }
      });
      
      // Handle completion
      item.once('done', (event, state) => {
        if (state === 'completed') {
          console.log('[Download] Completed:', savePath);
          // Show native notification
          const notification = new Notification({
            title: 'Download Complete',
            body: `Saved to Downloads: ${suggestedFilename}`,
          });
          notification.on('click', () => {
            // Open the Downloads folder and select the file
            shell.showItemInFolder(savePath);
          });
          notification.show();
        } else if (state === 'cancelled') {
          console.log('[Download] Cancelled');
        } else {
          console.log('[Download] Failed:', state);
        }
      });
    });

    // Load messenger.com/login/ directly - simpler login page with just the form
    contentView.webContents.loadURL('https://www.messenger.com/login/');

    // Handle new window requests (target="_blank" links, window.open, etc.)
    // Allow Messenger pop-up windows (for calls) but open external URLs in system browser
    contentView.webContents.setWindowOpenHandler(({ url, features, frameName, disposition }) => {
      console.log('[Window] Window open request:', {
        url,
        features,
        frameName,
        disposition,
      });
      
      // Allow messenger.com URLs to open as new windows (needed for video/audio calls)
      // Also allow about:blank - Messenger opens call windows with about:blank first, then navigates
      const isMessengerUrl = url.startsWith('https://www.messenger.com') || url.startsWith('https://messenger.com');
      const isAboutBlank = url === 'about:blank';
      
      if (isMessengerUrl || isAboutBlank) {
        console.log('[Window] Allowing Messenger pop-up window:', url);
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 800,
            height: 600,
            minWidth: 400,
            minHeight: 300,
            title: 'Messenger Call',
            icon: isDev ? undefined : getIconPath(),
            webPreferences: {
              preload: path.join(__dirname, '../preload/preload.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
              webSecurity: true,
              spellcheck: true,
            },
          },
        };
      }
      
      // Check if this is a Facebook media URL - download natively instead of opening browser
      if (isFacebookMediaUrl(url)) {
        console.log('[Download] Initiating native download for Facebook media:', url);
        contentView!.webContents.downloadURL(url);
        return { action: 'deny' };
      }
      
      // Open external URLs in system browser
      console.log('[Window] Opening external URL in browser:', url);
      shell.openExternal(url).catch((err) => {
        console.error('[External Link] Failed to open URL:', url, err);
      });
      return { action: 'deny' };
    });
    
    // Set up permission handlers on child windows (for call windows)
    contentView.webContents.on('did-create-window', (childWindow, details) => {
      console.log('[Window] Child window created:', {
        url: details.url,
        frameName: details.frameName,
        options: details.options,
      });
      
      // Allow navigation to messenger.com URLs (for about:blank windows that navigate to call URLs)
      childWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        console.log('[Window] Child window navigation requested:', navigationUrl);
        if (!navigationUrl.startsWith('https://www.messenger.com') && !navigationUrl.startsWith('https://messenger.com') && navigationUrl !== 'about:blank') {
          console.log('[Window] Blocking navigation to non-messenger URL:', navigationUrl);
          event.preventDefault();
        }
      });
      
      // Set up permission handler for the child window's session
      childWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const url = webContents.getURL();
        const requestingUrl = details.requestingUrl || url;
        console.log(`[Permissions] Child window request: ${permission}`, {
          url,
          requestingUrl,
          isMainFrame: details.isMainFrame,
          details: JSON.stringify(details),
        });
        
        // Check both current URL and requesting URL (for about:blank windows)
        const isMessengerUrl = url.startsWith('https://www.messenger.com') || url.startsWith('https://messenger.com') || url === 'about:blank';
        const isMessengerRequest = requestingUrl.startsWith('https://www.messenger.com') || requestingUrl.startsWith('https://messenger.com');
        
        if (!isMessengerUrl && !isMessengerRequest) {
          console.log(`[Permissions] Denied ${permission} for non-messenger URL: ${url} (requesting: ${requestingUrl})`);
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
          console.log(`[Permissions] Allowing ${permission} for messenger.com (child window)`);
          callback(true);
        } else {
          console.log(`[Permissions] Denied ${permission} - not in allowlist (child window)`);
          callback(false);
        }
      });
      
      childWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
        const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock'];
        const isAllowed = requestingOrigin.startsWith('https://www.messenger.com') || requestingOrigin.startsWith('https://messenger.com');
        const hasPermission = isAllowed && allowedPermissions.includes(permission);
        console.log(`[Permissions] Child window check: ${permission} from ${requestingOrigin} -> ${hasPermission ? 'allowed' : 'denied'}`);
        return hasPermission;
      });
      
      // Set up screen sharing handler for child windows (call windows)
      childWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
        console.log('[Screen Share] Display media request received (child window)');
        
        // On native Wayland, screen sharing has limited support - offer to switch to XWayland
        if (isRunningOnWayland() && !isRunningXWaylandMode()) {
          const result = await dialog.showMessageBox(childWindow, {
            type: 'warning',
            title: 'Screen Sharing on Wayland',
            message: 'Screen sharing may not work reliably on native Wayland.',
            detail: 'For reliable screen sharing, you can restart the app using XWayland compatibility mode.\n\nWould you like to restart with XWayland mode enabled?',
            buttons: ['Restart with XWayland', 'Try Anyway', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
          });
          
          if (result.response === 0) {
            restartWithXWaylandMode(true);
            callback({});
            return;
          } else if (result.response === 2) {
            callback({});
            return;
          }
        }
        
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 150, height: 150 },
            fetchWindowIcons: true,
          });
          
          console.log(`[Screen Share] Found ${sources.length} sources (child window)`);
          
          if (sources.length === 0) {
            console.log('[Screen Share] No sources available');
            callback({});
            return;
          }
          
          // If only one screen and no windows, auto-select it
          const screens = sources.filter(s => s.id.startsWith('screen:'));
          if (screens.length === 1 && sources.length === 1) {
            console.log('[Screen Share] Auto-selecting single screen:', screens[0].name);
            callback({ video: screens[0] });
            return;
          }
          
          // Show picker dialog
          const choices = sources.map((source) => {
            const icon = source.id.startsWith('screen:') ? '🖥️' : '🪟';
            return `${icon} ${source.name}`;
          });
          
          const result = await dialog.showMessageBox(childWindow, {
            type: 'question',
            title: 'Share Screen',
            message: 'Choose what to share:',
            detail: 'Select a screen or window to share during your call.',
            buttons: [...choices, 'Cancel'],
            defaultId: 0,
            cancelId: choices.length,
          });
          
          if (result.response < sources.length) {
            const selectedSource = sources[result.response];
            console.log('[Screen Share] User selected:', selectedSource.name);
            callback({ video: selectedSource });
          } else {
            console.log('[Screen Share] User cancelled');
            callback({});
          }
        } catch (error) {
          console.error('[Screen Share] Error getting sources:', error);
          callback({});
        }
      });
      
      // Log when child window loads
      childWindow.webContents.on('did-finish-load', () => {
        console.log('[Window] Child window finished loading:', childWindow.webContents.getURL());
      });
      
      // Log console messages from child window
      childWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Child Window Console ${level}]`, message, `(${sourceId}:${line})`);
      });
    });

    // Inject notification override script after page loads
    contentView.webContents.on('did-finish-load', async () => {
      const currentUrl = contentView?.webContents.getURL() || '';
      console.log('[ContentView] Page loaded:', currentUrl);
      
      // Inject custom login page CSS on login pages
      if (contentView) {
        await injectLoginPageCSS(contentView.webContents);
      }
      
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
    
    // Handle navigation events to inject disclaimer on page changes
    contentView.webContents.on('did-navigate', async (event, url) => {
      console.log('[ContentView] Navigated to:', url);
      if (contentView && url.startsWith('https://')) {
        await injectLoginPageCSS(contentView.webContents);
      }
    });
    
    contentView.webContents.on('did-navigate-in-page', async (event, url) => {
      // In-page navigation (SPA-style) - re-check if we're on login page
      if (contentView && url.startsWith('https://')) {
        await injectLoginPageCSS(contentView.webContents);
      }
    });

    // Log console messages from content view
    contentView.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Content View Console ${level}]`, message, `(${sourceId}:${line})`);
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
      console.log(`[Permissions] Request received: ${permission}`, {
        url,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        details: JSON.stringify(details),
      });
      
      if (!url.startsWith('https://www.messenger.com') && !url.startsWith('https://messenger.com')) {
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
      const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock'];
      const isAllowed = requestingOrigin.startsWith('https://www.messenger.com') || requestingOrigin.startsWith('https://messenger.com');
      const hasPermission = isAllowed && allowedPermissions.includes(permission);
      console.log(`[Permissions] Check: ${permission} from ${requestingOrigin} -> ${hasPermission ? 'allowed' : 'denied'}`);
      return hasPermission;
    });

    // Set up native download handler for Facebook CDN media files (fallback path)
    mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
      const url = item.getURL();
      const suggestedFilename = item.getFilename();
      console.log('[Download] Download started:', { url, filename: suggestedFilename });
      
      // Auto-save to Downloads folder
      const downloadsPath = app.getPath('downloads');
      const savePath = path.join(downloadsPath, suggestedFilename);
      item.setSavePath(savePath);
      
      // Log progress
      item.on('updated', (event, state) => {
        if (state === 'progressing') {
          if (item.isPaused()) {
            console.log('[Download] Paused');
          } else {
            const received = item.getReceivedBytes();
            const total = item.getTotalBytes();
            const percent = total > 0 ? Math.round((received / total) * 100) : 0;
            console.log(`[Download] Progress: ${percent}% (${received} / ${total})`);
          }
        } else if (state === 'interrupted') {
          console.log('[Download] Interrupted');
        }
      });
      
      // Handle completion
      item.once('done', (event, state) => {
        if (state === 'completed') {
          console.log('[Download] Completed:', savePath);
          // Show native notification
          const notification = new Notification({
            title: 'Download Complete',
            body: `Saved to Downloads: ${suggestedFilename}`,
          });
          notification.on('click', () => {
            // Open the Downloads folder and select the file
            shell.showItemInFolder(savePath);
          });
          notification.show();
        } else if (state === 'cancelled') {
          console.log('[Download] Cancelled');
        } else {
          console.log('[Download] Failed:', state);
        }
      });
    });

    // Load messenger.com/login/ directly - simpler login page with just the form
    mainWindow.loadURL('https://www.messenger.com/login/');

    // Handle new window requests (target="_blank" links, window.open, etc.)
    // Allow Messenger pop-up windows (for calls) but open external URLs in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url, features, frameName, disposition }) => {
      console.log('[Window] Window open request:', {
        url,
        features,
        frameName,
        disposition,
      });
      
      // Allow messenger.com URLs to open as new windows (needed for video/audio calls)
      // Also allow about:blank - Messenger opens call windows with about:blank first, then navigates
      const isMessengerUrl = url.startsWith('https://www.messenger.com') || url.startsWith('https://messenger.com');
      const isAboutBlank = url === 'about:blank';
      
      if (isMessengerUrl || isAboutBlank) {
        console.log('[Window] Allowing Messenger pop-up window:', url);
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 800,
            height: 600,
            minWidth: 400,
            minHeight: 300,
            title: 'Messenger Call',
            icon: isDev ? undefined : getIconPath(),
            webPreferences: {
              preload: path.join(__dirname, '../preload/preload.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
              webSecurity: true,
              spellcheck: true,
            },
          },
        };
      }
      
      // Check if this is a Facebook media URL - download natively instead of opening browser
      if (isFacebookMediaUrl(url)) {
        console.log('[Download] Initiating native download for Facebook media:', url);
        mainWindow!.webContents.downloadURL(url);
        return { action: 'deny' };
      }
      
      // Open external URLs in system browser
      console.log('[Window] Opening external URL in browser:', url);
      shell.openExternal(url).catch((err) => {
        console.error('[External Link] Failed to open URL:', url, err);
      });
      return { action: 'deny' };
    });
    
    // Set up permission handlers on child windows (for call windows)
    mainWindow.webContents.on('did-create-window', (childWindow, details) => {
      console.log('[Window] Child window created:', {
        url: details.url,
        frameName: details.frameName,
        options: details.options,
      });
      
      // Allow navigation to messenger.com URLs (for about:blank windows that navigate to call URLs)
      childWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        console.log('[Window] Child window navigation requested:', navigationUrl);
        if (!navigationUrl.startsWith('https://www.messenger.com') && !navigationUrl.startsWith('https://messenger.com') && navigationUrl !== 'about:blank') {
          console.log('[Window] Blocking navigation to non-messenger URL:', navigationUrl);
          event.preventDefault();
        }
      });
      
      // Set up permission handler for the child window's session
      childWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const url = webContents.getURL();
        const requestingUrl = details.requestingUrl || url;
        console.log(`[Permissions] Child window request: ${permission}`, {
          url,
          requestingUrl,
          isMainFrame: details.isMainFrame,
          details: JSON.stringify(details),
        });
        
        // Check both current URL and requesting URL (for about:blank windows)
        const isMessengerUrl = url.startsWith('https://www.messenger.com') || url.startsWith('https://messenger.com') || url === 'about:blank';
        const isMessengerRequest = requestingUrl.startsWith('https://www.messenger.com') || requestingUrl.startsWith('https://messenger.com');
        
        if (!isMessengerUrl && !isMessengerRequest) {
          console.log(`[Permissions] Denied ${permission} for non-messenger URL: ${url} (requesting: ${requestingUrl})`);
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
          console.log(`[Permissions] Allowing ${permission} for messenger.com (child window)`);
          callback(true);
        } else {
          console.log(`[Permissions] Denied ${permission} - not in allowlist (child window)`);
          callback(false);
        }
      });
      
      childWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
        const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock'];
        const isAllowed = requestingOrigin.startsWith('https://www.messenger.com') || requestingOrigin.startsWith('https://messenger.com');
        const hasPermission = isAllowed && allowedPermissions.includes(permission);
        console.log(`[Permissions] Child window check: ${permission} from ${requestingOrigin} -> ${hasPermission ? 'allowed' : 'denied'}`);
        return hasPermission;
      });
      
      // Set up screen sharing handler for child windows (call windows)
      childWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
        console.log('[Screen Share] Display media request received (child window)');
        
        // On native Wayland, screen sharing has limited support - offer to switch to XWayland
        if (isRunningOnWayland() && !isRunningXWaylandMode()) {
          const result = await dialog.showMessageBox(childWindow, {
            type: 'warning',
            title: 'Screen Sharing on Wayland',
            message: 'Screen sharing may not work reliably on native Wayland.',
            detail: 'For reliable screen sharing, you can restart the app using XWayland compatibility mode.\n\nWould you like to restart with XWayland mode enabled?',
            buttons: ['Restart with XWayland', 'Try Anyway', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
          });
          
          if (result.response === 0) {
            restartWithXWaylandMode(true);
            callback({});
            return;
          } else if (result.response === 2) {
            callback({});
            return;
          }
        }
        
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 150, height: 150 },
            fetchWindowIcons: true,
          });
          
          console.log(`[Screen Share] Found ${sources.length} sources (child window)`);
          
          if (sources.length === 0) {
            console.log('[Screen Share] No sources available');
            callback({});
            return;
          }
          
          // If only one screen and no windows, auto-select it
          const screens = sources.filter(s => s.id.startsWith('screen:'));
          if (screens.length === 1 && sources.length === 1) {
            console.log('[Screen Share] Auto-selecting single screen:', screens[0].name);
            callback({ video: screens[0] });
            return;
          }
          
          // Show picker dialog
          const choices = sources.map((source) => {
            const icon = source.id.startsWith('screen:') ? '🖥️' : '🪟';
            return `${icon} ${source.name}`;
          });
          
          const result = await dialog.showMessageBox(childWindow, {
            type: 'question',
            title: 'Share Screen',
            message: 'Choose what to share:',
            detail: 'Select a screen or window to share during your call.',
            buttons: [...choices, 'Cancel'],
            defaultId: 0,
            cancelId: choices.length,
          });
          
          if (result.response < sources.length) {
            const selectedSource = sources[result.response];
            console.log('[Screen Share] User selected:', selectedSource.name);
            callback({ video: selectedSource });
          } else {
            console.log('[Screen Share] User cancelled');
            callback({});
          }
        } catch (error) {
          console.error('[Screen Share] Error getting sources:', error);
          callback({});
        }
      });
      
      // Log when child window loads
      childWindow.webContents.on('did-finish-load', () => {
        console.log('[Window] Child window finished loading:', childWindow.webContents.getURL());
      });
      
      // Log console messages from child window
      childWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Child Window Console ${level}]`, message, `(${sourceId}:${line})`);
      });
    });

    // Log console messages from main window
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Main Window Console ${level}]`, message, `(${sourceId}:${line})`);
    });

    mainWindow.webContents.on('did-finish-load', async () => {
      const currentUrl = mainWindow?.webContents.getURL() || '';
      console.log('[MainWindow] Page loaded:', currentUrl);
      
      // Inject custom login page CSS on login pages
      if (mainWindow) {
        await injectLoginPageCSS(mainWindow.webContents);
      }
      
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
    
    // Handle navigation events to inject disclaimer on page changes
    mainWindow.webContents.on('did-navigate', async (event, url) => {
      console.log('[MainWindow] Navigated to:', url);
      if (mainWindow && url.startsWith('https://')) {
        await injectLoginPageCSS(mainWindow.webContents);
      }
    });
    
    mainWindow.webContents.on('did-navigate-in-page', async (event, url) => {
      // In-page navigation (SPA-style) - re-check if we're on login page
      if (mainWindow && url.startsWith('https://')) {
        await injectLoginPageCSS(mainWindow.webContents);
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
  const subdir = getIconSubdir();
  
  // On Windows, try ICO first (contains multiple sizes for taskbar), then PNG
  // On Linux, use PNG
  const iconFiles = process.platform === 'win32' 
    ? ['icon.ico', 'icon.png'] 
    : ['icon.png'];
  
  const possiblePaths: string[] = [];
  for (const iconFile of iconFiles) {
    // Try dark icons first if dark mode
    if (subdir) {
      possiblePaths.push(
        path.join(appPath, 'assets/icons', subdir, iconFile),
        path.join(__dirname, '../../assets/icons', subdir, iconFile),
        path.join(process.cwd(), 'assets/icons', subdir, iconFile),
      );
    }
    // Fallback to light icons
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
  const subdir = getIconSubdir();

  // macOS uses template icons (always same), Windows/Linux use themed icons
  const platformIcon =
    process.platform === 'win32'
      ? 'icon.ico'
      : process.platform === 'darwin'
      ? 'iconTemplate.png'  // macOS template icons are not themed
      : 'icon-rounded.png';  // Linux: use the nicer rounded icon

  const possiblePaths: string[] = [];
  
  // For Windows/Linux, try dark icons first if in dark mode
  // macOS uses template icons which don't need theming
  if (subdir && process.platform !== 'darwin') {
    possiblePaths.push(
      path.join(trayDir, subdir, platformIcon),
      path.join(devTrayDir, subdir, platformIcon),
    );
  }
  
  // Fallback to light/default icons
  possiblePaths.push(
    path.join(trayDir, platformIcon),
    path.join(devTrayDir, platformIcon),
  );

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

type InstallSource = 'homebrew' | 'winget' | 'deb' | 'rpm' | 'snap' | 'flatpak' | 'appimage' | 'direct';

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
      // Check for containerized installs first (snap/flatpak), then AppImage, then system packages (deb/rpm)
      if (detectSnapInstall()) {
        writeInstallSourceCache('snap');
        console.log('[InstallSource] Detected: snap');
      } else if (detectFlatpakInstall()) {
        writeInstallSourceCache('flatpak');
        console.log('[InstallSource] Detected: flatpak');
      } else if (detectAppImageInstall()) {
        writeInstallSourceCache('appimage');
        console.log('[InstallSource] Detected: appimage');
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
            console.log('[InstallSource] Detected: direct (manual installation)');
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

function detectAppImageInstall(): boolean {
  // AppImage sets the APPIMAGE environment variable to the full path of the .AppImage file
  if (process.platform !== 'linux') {
    return false;
  }
  
  if (process.env.APPIMAGE) {
    console.log('[InstallSource] Detected AppImage installation via APPIMAGE env:', process.env.APPIMAGE);
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
  
  if (source === 'appimage' && process.platform === 'linux') {
    // AppImage requires the APPIMAGE env var to know the file path
    const appImagePath = process.env.APPIMAGE;
    if (appImagePath) {
      console.log('[Uninstall] Using cached AppImage detection, path:', appImagePath);
      return {
        name: 'AppImage',
        detected: true,
        // The uninstall command will delete the AppImage file itself
        uninstallCommand: ['/usr/bin/pkexec', '/bin/rm', '-f', appImagePath],
      };
    } else {
      console.log('[Uninstall] AppImage cached but APPIMAGE env var not set - falling back to cleanup only');
      return null;
    }
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
    
    // Determine the package manager command
    const pmCmd = pm.name.includes('deb') 
      ? `/usr/bin/apt remove -y ${LINUX_PACKAGE_NAME}`
      : `/usr/bin/dnf remove -y ${LINUX_PACKAGE_NAME}`;
    
    // Use pkexec for authentication - this shows the system's native authentication dialog
    // pkexec requires a polkit authentication agent, which all modern desktop environments provide
    const cleanupScript = `
      # Run package manager uninstall with pkexec for authentication
      /usr/bin/pkexec /bin/sh -c "${pmCmd}"
      UNINSTALL_EXIT=$?
      
      # Only proceed with cleanup if uninstall succeeded
      if [ $UNINSTALL_EXIT -eq 0 ]; then
        echo "Uninstall succeeded, cleaning up..."
        # Wait for package manager to finish
        sleep 1
        
        # Purge config files too (for deb packages) - needs auth again
        if command -v dpkg >/dev/null 2>&1; then
          /usr/bin/pkexec /usr/bin/dpkg --purge ${LINUX_PACKAGE_NAME} 2>/dev/null || true
        fi
        
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
        
        # Kill any remaining Messenger processes aggressively
        pkill -9 -f "facebook-messenger-desktop" 2>/dev/null || true
        pkill -9 -f "/opt/Messenger" 2>/dev/null || true
        pkill -9 -f "Messenger" 2>/dev/null || true
        
        echo "Cleanup complete!"
      else
        echo "Uninstall failed or was cancelled"
      fi
    `.trim();
    
    // Pass graphical environment variables for pkexec dialog
    const env = {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':0',
      XAUTHORITY: process.env.XAUTHORITY || `${homeDir}/.Xauthority`,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() || 1000}`,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || '',
    };
    
    const child = spawn('/bin/sh', ['-c', cleanupScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    
    // Log output for debugging
    child.stderr?.on('data', (data: Buffer) => {
      console.log('[Uninstall] stderr:', data.toString().trim());
    });
    child.stdout?.on('data', (data: Buffer) => {
      console.log('[Uninstall] stdout:', data.toString().trim());
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
  // Use pkexec for authentication to support both user and system installs.
  const homeDir = process.env.HOME || '';
  
  // Write the uninstall script to a temp file so systemd-run can execute it
  const scriptPath = path.join('/tmp', `messenger-flatpak-uninstall-${Date.now()}.sh`);
  
  const uninstallScript = `#!/bin/sh
# Wait for the Messenger flatpak to fully exit
sleep 3

# Wait for any messenger processes to terminate (with timeout)
WAIT_COUNT=0
while pgrep -f "${FLATPAK_APP_ID}" > /dev/null 2>&1; do
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $WAIT_COUNT -gt 30 ]; then
    break
  fi
done

# Additional wait to ensure flatpak recognizes the app is closed
sleep 2

# Run flatpak uninstall with pkexec for authentication
# This shows the system's native authentication dialog
/usr/bin/pkexec /usr/bin/flatpak uninstall -y ${FLATPAK_APP_ID}
UNINSTALL_EXIT=$?

# Only proceed with cleanup if uninstall succeeded
if [ $UNINSTALL_EXIT -eq 0 ]; then
  sleep 2
  
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

# Clean up this script
rm -f "${scriptPath}"
`;

  try {
    // Write script to temp location (accessible outside flatpak sandbox)
    fs.writeFileSync(scriptPath, uninstallScript, { mode: 0o755 });
    console.log('[Uninstall] Wrote uninstall script to:', scriptPath);
    
    // Use systemd-run to schedule execution outside the Flatpak's sandbox
    // This ensures the process survives when the Flatpak app exits
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
        // Minimal env outside flatpak
        HOME: homeDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DISPLAY: process.env.DISPLAY || ':0',
        XAUTHORITY: process.env.XAUTHORITY || `${homeDir}/.Xauthority`,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() || 1000}`,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '',
      },
    });
    child.unref();
    console.log('[Uninstall] Scheduled Flatpak uninstall via systemd-run');
  } catch (error) {
    console.error('[Uninstall] Failed to schedule flatpak uninstall:', error);
    // Fallback: try direct spawn (might not work but better than nothing)
    const child = spawn('/usr/bin/sh', ['-c', `sleep 3 && /usr/bin/pkexec /usr/bin/flatpak uninstall -y ${FLATPAK_APP_ID}`], {
      detached: true,
      stdio: 'ignore',
      env: {
        HOME: homeDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DISPLAY: process.env.DISPLAY || ':0',
      },
    });
    child.unref();
    console.log('[Uninstall] Fallback: scheduled flatpak uninstall via direct spawn');
  }
}

function scheduleAppImageUninstall(): void {
  // AppImage files are self-contained executables that the user downloads.
  // We schedule the deletion to run AFTER the app exits.
  // The APPIMAGE environment variable contains the full path to the .AppImage file.
  const homeDir = process.env.HOME || '';
  const appImagePath = process.env.APPIMAGE;
  
  if (!appImagePath) {
    console.log('[Uninstall] APPIMAGE env var not set - cannot delete AppImage file');
    return;
  }
  
  // Write the uninstall script to a temp file
  const scriptPath = path.join('/tmp', `messenger-appimage-uninstall-${Date.now()}.sh`);
  
  const uninstallScript = `#!/bin/sh
# Wait for the Messenger AppImage to fully exit
sleep 3

# Wait for any messenger processes to terminate (with timeout)
WAIT_COUNT=0
while pgrep -f "${LINUX_PACKAGE_NAME}" > /dev/null 2>&1; do
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $WAIT_COUNT -gt 30 ]; then
    break
  fi
done

# Additional wait to ensure the file handle is released
sleep 2

# Delete the AppImage file with pkexec for authentication
# This shows the system's native authentication dialog
/usr/bin/pkexec /bin/rm -f "${appImagePath}"
UNINSTALL_EXIT=$?

# Only proceed with cleanup if deletion succeeded
if [ $UNINSTALL_EXIT -eq 0 ]; then
  echo "AppImage deleted successfully"
  sleep 1
  
  # Remove user-specific desktop entries that might persist
  rm -f "${homeDir}/.local/share/applications/${LINUX_PACKAGE_NAME}.desktop" 2>/dev/null
  rm -f "${homeDir}/.local/share/applications/Messenger.desktop" 2>/dev/null
  rm -f "${homeDir}/.local/share/applications/messenger.desktop" 2>/dev/null
  rm -f "${homeDir}/.local/share/applications/appimagekit"*"messenger"*.desktop 2>/dev/null
  
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
  
  # Refresh icon caches
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "${homeDir}/.local/share/icons/hicolor" 2>/dev/null || true
  fi
  
  # Force desktop environment to reload application list
  if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --type=signal --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.AppLaunchContext 2>/dev/null || true
  fi
  
  touch "${homeDir}/.local/share/applications" 2>/dev/null || true
else
  echo "Failed to delete AppImage (user may have cancelled authentication)"
fi

# Clean up this script
rm -f "${scriptPath}"
`;

  try {
    // Write script to temp location
    fs.writeFileSync(scriptPath, uninstallScript, { mode: 0o755 });
    console.log('[Uninstall] Wrote AppImage uninstall script to:', scriptPath);
    
    // Use systemd-run to schedule execution that survives app exit
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
        HOME: homeDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DISPLAY: process.env.DISPLAY || ':0',
        XAUTHORITY: process.env.XAUTHORITY || `${homeDir}/.Xauthority`,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() || 1000}`,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '',
      },
    });
    child.unref();
    console.log('[Uninstall] Scheduled AppImage uninstall via systemd-run');
  } catch (error) {
    console.error('[Uninstall] Failed to schedule AppImage uninstall:', error);
    // Fallback: try direct spawn
    const child = spawn('/usr/bin/sh', ['-c', `sleep 3 && /usr/bin/pkexec /bin/rm -f "${appImagePath}"`], {
      detached: true,
      stdio: 'ignore',
      env: {
        HOME: homeDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DISPLAY: process.env.DISPLAY || ':0',
      },
    });
    child.unref();
    console.log('[Uninstall] Fallback: scheduled AppImage uninstall via direct spawn');
  }
}

async function handleUninstallRequest(): Promise<void> {
  // Show confirmation dialog IMMEDIATELY - don't do any detection before this
  // Use Electron's native dialog on all platforms - it shows the system's standard dialog
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Uninstall Messenger',
    message: 'Uninstall Messenger from this device?',
    detail: 'This will quit Messenger and remove all app data (settings, cache, and logs).',
  });
  const confirmed = response === 0;

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

  // Special handling for Snap/Flatpak/AppImage: must quit app FIRST, then run uninstall
  // These run in sandboxes or are self-contained and need special handling
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
  
  if (packageManager?.name === 'AppImage') {
    console.log('[Uninstall] AppImage detected - scheduling uninstall after app quits');
    scheduleAppImageUninstall();
    app.quit();
    return;
  }

  if (packageManager) {
    // For Linux package managers with pkexec, we need to give time for the authentication dialog to appear
    // DON'T hide the window immediately - keep the app visible so pkexec has proper graphical context
    const needsAuthDialog = packageManager.name.includes('deb') || 
                            packageManager.name.includes('rpm');
    if (process.platform === 'linux' && needsAuthDialog) {
      console.log('[Uninstall] Running uninstall with authentication dialog...');
      
      // Minimize the window instead of hiding - this keeps graphical context available
      // for pkexec while getting out of the user's way
      mainWindow?.minimize();
      
      // Run the package manager uninstall command
      runPackageManagerUninstall(packageManager);
      
      // Give the authentication dialog time to show and complete
      // The app will be killed by the package manager or cleanup script
      // Use a longer timeout since user needs to authenticate
      setTimeout(() => {
        console.log('[Uninstall] Quitting after timeout (uninstall may have completed or failed)...');
        app.quit();
      }, 60000); // 60 second timeout as fallback
      return;
    }
    
    // Run the package manager uninstall command for other cases
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

  const isSnap = detectSnapInstall();
  const isFlatpak = detectFlatpakInstall();
  const isBeta = isBetaOptedIn();
  
  // Check for Updates label changes based on beta status
  const checkUpdatesMenuItem: Electron.MenuItemConstructorOptions = {
    label: isBeta ? 'Check for Beta Updates…' : 'Check for Updates…',
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
      if (isSnap) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Snap Updates',
          message: 'This app was installed via Snap.',
          detail: 'To update, run "sudo snap refresh facebook-messenger-desktop" in your terminal or use your software center.',
          buttons: ['OK'],
        }).catch(() => {});
        return;
      }
      if (isFlatpak) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Flatpak Updates',
          message: 'This app was installed via Flatpak.',
          detail: 'To update, run "flatpak update" in your terminal or use your software center.',
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

  // Beta Program menu item - Join or Leave based on current status
  const betaProgramMenuItem: Electron.MenuItemConstructorOptions = {
    label: isBeta ? 'Leave Beta Program…' : 'Join Beta Program…',
    enabled: !isDev,
    click: async () => {
      if (isDev) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Development Mode',
          message: 'Beta program is not available in development mode.',
          buttons: ['OK'],
        }).catch(() => {});
        return;
      }

      // Snap/Flatpak users can't use beta - electron-updater doesn't work for them
      if (isSnap || isFlatpak) {
        const packageType = isSnap ? 'Snap' : 'Flatpak';
        const result = await dialog.showMessageBox({
          type: 'info',
          title: 'Beta Not Available',
          message: `Beta updates are not available for ${packageType} installations.`,
          detail: `${packageType} uses its own update system which doesn't support beta channels.\n\nTo join the beta program, you'll need to:\n1. Download the AppImage, .deb, or .rpm from GitHub\n2. Uninstall this ${packageType} version\n3. Install the downloaded package\n4. Join the beta program from the new install`,
          buttons: ['View Downloads', `Uninstall ${packageType}…`, 'Cancel'],
          defaultId: 2,
          cancelId: 2,
        });

        if (result.response === 0) {
          // Open GitHub releases page
          shell.openExternal('https://github.com/apotenza92/facebook-messenger-desktop/releases');
        } else if (result.response === 1) {
          // Trigger uninstall
          void handleUninstallRequest();
        }
        return;
      }

      if (isBeta) {
        // Leave beta program
        const result = await dialog.showMessageBox({
          type: 'question',
          title: 'Leave Beta Program',
          message: 'Leave the beta program?',
          detail: 'You\'ll only receive stable releases. Your current version will continue to work until the next stable update.',
          buttons: ['Leave Beta', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        });

        if (result.response === 0) {
          saveBetaOptIn(false);
          autoUpdater.allowPrerelease = false;
          // Rebuild menu to update labels
          createApplicationMenu();
          dialog.showMessageBox({
            type: 'info',
            title: 'Left Beta Program',
            message: 'You\'ve left the beta program.',
            detail: 'You\'ll now only receive stable updates.',
            buttons: ['OK'],
          }).catch(() => {});
        }
      } else {
        // Join beta program
        const result = await dialog.showMessageBox({
          type: 'question',
          title: 'Join Beta Program',
          message: 'Join the beta program?',
          detail: 'You\'ll receive early access to new features and bug fixes, but beta versions may be less stable.\n\nYou can leave anytime from the menu.',
          buttons: ['Join Beta', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        });

        if (result.response === 0) {
          saveBetaOptIn(true);
          autoUpdater.allowPrerelease = true;
          // Rebuild menu to update labels
          createApplicationMenu();
          dialog.showMessageBox({
            type: 'info',
            title: 'Joined Beta Program',
            message: 'Welcome to the beta program!',
            detail: 'You\'ll now receive beta updates. Use "Check for Beta Updates" to see if any are available.',
            buttons: ['OK'],
          }).catch(() => {});
        }
      }
    },
  };

  const viewOnGitHubMenuItem: Electron.MenuItemConstructorOptions = {
    label: 'View on GitHub',
    click: () => { openGitHubPage(); },
  };

  // Menu item for opening system notification settings
  const notificationSettingsMenuItem: Electron.MenuItemConstructorOptions = {
    label: 'Notification Settings…',
    click: () => {
      openNotificationSettings();
    },
  };

  // XWayland mode toggle for Linux Wayland users (for screen sharing compatibility)
  const xwaylandMenuItem: Electron.MenuItemConstructorOptions | null = process.platform === 'linux' ? {
    label: isRunningXWaylandMode() ? 'Use Native Wayland Mode…' : 'Use XWayland Mode (for Screen Sharing)…',
    click: async () => {
      const currentlyXWayland = isRunningXWaylandMode();
      const title = currentlyXWayland ? 'Switch to Native Wayland' : 'Switch to XWayland Mode';
      const message = currentlyXWayland 
        ? 'Switch back to native Wayland mode?' 
        : 'Switch to XWayland mode for better screen sharing?';
      const detail = currentlyXWayland
        ? 'Native Wayland provides better display scaling and touch support, but screen sharing may not work reliably.\n\nThe app will restart to apply this change.'
        : 'XWayland mode provides better compatibility for screen sharing during calls.\n\nTrade-offs:\n• Screen sharing will work reliably\n• Display scaling may be slightly blurry on HiDPI screens\n• Some Wayland-specific features may be limited\n\nThe app will restart to apply this change.';
      
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        title,
        message,
        detail,
        buttons: ['Restart Now', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      
      if (result.response === 0) {
        restartWithXWaylandMode(!currentlyXWayland);
      }
    },
  } : null;

  // Icon theme submenu - allows switching between light/dark/system icons
  const iconThemeSubmenu: Electron.MenuItemConstructorOptions = {
    label: 'Icon Appearance',
    submenu: [
      {
        label: 'Match System',
        type: 'radio',
        checked: currentIconTheme === 'system',
        click: () => { setIconTheme('system'); },
      },
      {
        label: 'Light Icon',
        type: 'radio',
        checked: currentIconTheme === 'light',
        click: () => { setIconTheme('light'); },
      },
      {
        label: 'Dark Icon',
        type: 'radio',
        checked: currentIconTheme === 'dark',
        click: () => { setIconTheme('dark'); },
      },
    ],
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
          betaProgramMenuItem,
          notificationSettingsMenuItem,
          iconThemeSubmenu,
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
        iconThemeSubmenu,
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
    {
      label: 'Help',
      submenu: [
        viewOnGitHubMenuItem,
        checkUpdatesMenuItem,
        betaProgramMenuItem,
        notificationSettingsMenuItem,
        // XWayland mode option for Linux users (for screen sharing compatibility)
        ...(xwaylandMenuItem ? [{ type: 'separator' as const }, xwaylandMenuItem] : []),
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
    console.log(`[IPC] Received update-unread-count: ${count}`);
    if (badgeManager) {
      badgeManager.updateBadgeCount(count);
    } else {
      console.warn('[IPC] BadgeManager not initialized yet');
    }
  });

  // Handle clear badge request
  ipcMain.on('clear-badge', () => {
    badgeManager.clearBadge();
  });

  // Handle incoming call - bring window to foreground
  // This is triggered when Messenger shows an incoming call popup
  ipcMain.on('incoming-call', () => {
    console.log('[IPC] Incoming call detected - bringing window to foreground');
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Restore if minimized
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      // Show the window (unhides if hidden)
      mainWindow.show();
      // Focus the window to bring it to foreground
      mainWindow.focus();
      
      // On macOS, also bounce the dock icon to get user attention
      if (process.platform === 'darwin' && app.dock) {
        app.dock.bounce('critical');
      }
    }
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

// Notification permission state tracking
interface NotificationPermissionState {
  requested: boolean;
  date: string;
  version: string;
  neverPromptAgain?: boolean; // User chose "Don't ask again" for denied notifications
}

// Notification authorization status from macOS
type NotificationAuthStatus = 'authorized' | 'denied' | 'not-determined' | 'provisional' | 'ephemeral' | 'unknown' | 'error';

// Read notification permission state
function readNotificationPermissionState(): NotificationPermissionState | null {
  try {
    if (fs.existsSync(notificationPermissionFile)) {
      return JSON.parse(fs.readFileSync(notificationPermissionFile, 'utf8'));
    }
  } catch (e) {
    // Ignore errors, will request again
  }
  return null;
}

// Save notification permission state
function saveNotificationPermissionState(state: NotificationPermissionState): void {
  try {
    fs.writeFileSync(notificationPermissionFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[Notification Permission] Failed to save state:', e);
  }
}

// Check macOS notification authorization using the bundled Swift helper app
// Returns the authorization status or 'error' if the helper is not available
async function checkNotificationAuthorization(): Promise<NotificationAuthStatus> {
  if (process.platform !== 'darwin') {
    return 'unknown';
  }

  // In dev mode, the helper won't exist (it's compiled during packaging)
  if (!app.isPackaged) {
    console.log('[Notification Permission] Dev mode - skipping authorization check');
    return 'unknown';
  }

  // Find the notification helper app bundle in Resources folder
  // The helper is packaged as NotificationHelper.app/Contents/MacOS/NotificationHelper
  const helperAppPath = path.join(process.resourcesPath, 'NotificationHelper.app', 'Contents', 'MacOS', 'NotificationHelper');

  if (!fs.existsSync(helperAppPath)) {
    console.log('[Notification Permission] Helper not found at:', helperAppPath);
    return 'error';
  }

  return new Promise((resolve) => {
    exec(`"${helperAppPath}"`, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.warn('[Notification Permission] Helper execution failed:', error.message);
        resolve('error');
        return;
      }

      const status = stdout.trim() as NotificationAuthStatus;
      console.log('[Notification Permission] Authorization status:', status);
      
      // Validate the status is one of the expected values
      const validStatuses: NotificationAuthStatus[] = ['authorized', 'denied', 'not-determined', 'provisional', 'ephemeral', 'unknown'];
      if (validStatuses.includes(status)) {
        resolve(status);
      } else {
        resolve('unknown');
      }
    });
  });
}

// Open System Settings > Notifications
function openNotificationSettings(): void {
  if (process.platform === 'darwin') {
    // This opens System Settings directly to the Notifications section
    // Works on macOS Ventura (13+) and later including Sequoia
    shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension').catch(() => {
      // Fallback for older macOS versions
      shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications').catch(() => {
        // Ultimate fallback: open System Settings
        shell.openPath('/System/Applications/System Settings.app').catch(() => {
          shell.openPath('/System/Applications/System Preferences.app').catch(() => {});
        });
      });
    });
  } else if (process.platform === 'win32') {
    // Windows: Open Settings > System > Notifications
    shell.openExternal('ms-settings:notifications').catch(() => {
      // Fallback: Open general Settings app
      shell.openPath('ms-settings:').catch(() => {});
    });
  } else {
    // Linux: Try common desktop environment settings
    // GNOME uses gnome-control-center, KDE uses systemsettings
    const { exec } = require('child_process');
    
    // Try GNOME first (most common)
    exec('gnome-control-center notifications', (error: Error | null) => {
      if (error) {
        // Try KDE Plasma
        exec('systemsettings kcm_notifications', (kdeError: Error | null) => {
          if (kdeError) {
            // Try older KDE
            exec('systemsettings5 kcm_notifications', (kde5Error: Error | null) => {
              if (kde5Error) {
                // Fallback: Try to open general settings
                exec('gnome-control-center', (gnomeError: Error | null) => {
                  if (gnomeError) {
                    exec('systemsettings', () => {});
                  }
                });
              }
            });
          }
        });
      }
    });
  }
}

// Request notification permission on macOS
// Runs on first launch AND after updates to ensure users don't miss the permission prompt
async function requestNotificationPermission(): Promise<void> {
  // Only needed on macOS
  if (process.platform !== 'darwin') return;
  
  const currentVersion = app.getVersion();
  const state = readNotificationPermissionState();
  
  // Determine if we should prompt
  const isFirstLaunch = !state;
  const isPostUpdate = state && state.version !== currentVersion;
  
  if (!isFirstLaunch && !isPostUpdate) {
    console.log('[Notification Permission] Already requested for this version, skipping');
    return;
  }
  
  if (isFirstLaunch) {
    console.log('[Notification Permission] First launch - requesting permission');
    
    // Save state before showing notification
    saveNotificationPermissionState({
      requested: true,
      date: new Date().toISOString(),
      version: currentVersion,
    });

    // On macOS, showing a notification triggers the system permission prompt
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Welcome to Messenger',
        body: 'You\'ll receive notifications here when you get new messages.',
        silent: true,
      });
      notification.show();
      console.log('[Notification Permission] Welcome notification shown to trigger permission prompt');
    }
  } else if (isPostUpdate) {
    console.log('[Notification Permission] Post-update - checking authorization status');
    
    // Update version in state (preserve neverPromptAgain setting)
    saveNotificationPermissionState({
      requested: true,
      date: state?.date || new Date().toISOString(),
      version: currentVersion,
      neverPromptAgain: state?.neverPromptAgain,
    });

    // Check if notifications are denied and prompt user
    // Delay to not block startup and let the app fully load first
    setTimeout(async () => {
      const authStatus = await checkNotificationAuthorization();
      
      if (authStatus === 'denied') {
        // Check if user previously chose "Don't ask again"
        const currentState = readNotificationPermissionState();
        if (currentState?.neverPromptAgain) {
          console.log('[Notification Permission] Notifications denied but user chose not to be prompted');
          return;
        }
        
        console.log('[Notification Permission] Notifications are denied - prompting user');
        
        const result = await dialog.showMessageBox({
          type: 'info',
          title: 'Notifications Disabled',
          message: 'Messenger notifications are turned off',
          detail: 'You won\'t receive notifications for new messages. Would you like to enable them in System Settings?',
          buttons: ['Open Settings', 'Not Now'],
          defaultId: 0,
          cancelId: 1,
          checkboxLabel: 'Don\'t ask again',
          checkboxChecked: false,
        });
        
        // Save "Don't ask again" preference if checked
        if (result.checkboxChecked) {
          console.log('[Notification Permission] User chose "Don\'t ask again"');
          const updatedState = readNotificationPermissionState();
          if (updatedState) {
            updatedState.neverPromptAgain = true;
            saveNotificationPermissionState(updatedState);
          }
        }
        
        if (result.response === 0) {
          openNotificationSettings();
        }
      } else if (authStatus === 'not-determined') {
        // Permission not yet requested - show a notification to trigger the prompt
        console.log('[Notification Permission] Permission not determined - triggering prompt');
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: 'Messenger Updated',
            body: 'You\'ll receive notifications here when you get new messages.',
            silent: true,
          });
          notification.show();
        }
      }
    }, 3000);
  }
}

// Request media permissions on macOS (camera/microphone)
// This prompts the user for permission on first launch to ensure calls work
async function requestMediaPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return;

  try {
    // Check current permission status first
    const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    
    console.log('[Media Permissions] Camera status:', cameraStatus);
    console.log('[Media Permissions] Microphone status:', micStatus);
    
    // Request permissions if not yet determined
    // This triggers the macOS system permission prompt
    if (cameraStatus === 'not-determined') {
      console.log('[Media Permissions] Requesting camera access...');
      const cameraGranted = await systemPreferences.askForMediaAccess('camera');
      console.log('[Media Permissions] Camera access:', cameraGranted ? 'granted' : 'denied');
    }
    
    if (micStatus === 'not-determined') {
      console.log('[Media Permissions] Requesting microphone access...');
      const micGranted = await systemPreferences.askForMediaAccess('microphone');
      console.log('[Media Permissions] Microphone access:', micGranted ? 'granted' : 'denied');
    }
    
    // If permissions are denied, log info for user
    const finalCameraStatus = systemPreferences.getMediaAccessStatus('camera');
    const finalMicStatus = systemPreferences.getMediaAccessStatus('microphone');
    
    if (finalCameraStatus === 'denied' || finalMicStatus === 'denied') {
      console.log('[Media Permissions] Some permissions denied - user may need to enable in System Settings > Privacy & Security for video/audio calls to work');
    }
  } catch (e) {
    console.warn('[Media Permissions] Failed to request permissions:', e);
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
  // Map Node.js arch to Linux package arch naming conventions
  // RPM uses: x86_64 / aarch64
  // DEB uses: amd64 / arm64
  let archName: string;
  if (packageType === 'rpm') {
    archName = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  } else {
    archName = process.arch === 'arm64' ? 'arm64' : 'amd64';
  }
  const fileName = `facebook-messenger-desktop-${archName}.${packageType}`;
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

// Install a Linux package using zenity/kdialog for password prompt (with pkexec fallback)
async function installLinuxPackage(filePath: string, packageType: 'deb' | 'rpm'): Promise<void> {
  console.log(`[AutoUpdater] Installing ${packageType} package: ${filePath}`);
  
  const installCmd = packageType === 'deb'
    ? `/usr/bin/apt install -y "${filePath}"`
    : `/usr/bin/dnf install -y "${filePath}"`;
  
  // Build install script using zenity/kdialog for password prompt
  // This is more reliable than pkexec which requires a polkit authentication agent
  const installScript = `
    INSTALL_EXIT=1
    
    # Method 1: Try zenity for password prompt (GNOME/GTK desktops)
    if command -v zenity >/dev/null 2>&1; then
      PASSWORD=$(zenity --password --title="Authentication Required" --text="Enter password to install update:" 2>/dev/null)
      if [ -n "$PASSWORD" ]; then
        echo "$PASSWORD" | sudo -S ${installCmd} 2>/dev/null
        INSTALL_EXIT=$?
      fi
    fi
    
    # Method 2: Try kdialog for password prompt (KDE desktops)
    if [ $INSTALL_EXIT -ne 0 ] && command -v kdialog >/dev/null 2>&1; then
      PASSWORD=$(kdialog --password "Enter password to install update:" --title "Authentication Required" 2>/dev/null)
      if [ -n "$PASSWORD" ]; then
        echo "$PASSWORD" | sudo -S ${installCmd} 2>/dev/null
        INSTALL_EXIT=$?
      fi
    fi
    
    # Method 3: Fall back to pkexec (if polkit agent is running)
    if [ $INSTALL_EXIT -ne 0 ] && command -v pkexec >/dev/null 2>&1; then
      /usr/bin/pkexec /bin/sh -c "${installCmd}" 2>/dev/null
      INSTALL_EXIT=$?
    fi
    
    exit $INSTALL_EXIT
  `;
  
  return new Promise((resolve, reject) => {
    const proc = spawn('/bin/sh', ['-c', installScript], {
      stdio: 'pipe',
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':0',
      },
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
      console.error(`[AutoUpdater] Failed to spawn install script:`, err);
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
    autoUpdater.allowPrerelease = isBetaOptedIn();
    autoUpdater.logger = console;
    
    console.log('[AutoUpdater] Beta opt-in:', isBetaOptedIn() ? 'enabled' : 'disabled');

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
    credits: `An unofficial, third-party desktop app for Facebook Messenger\n\nNot affiliated with Facebook, Inc. or Meta Platforms, Inc.\n\nGitHub: ${GITHUB_REPO_URL}`,
    website: GITHUB_REPO_URL,
  });

  // Load beta opt-in preference
  betaOptedIn = loadBetaOptIn();
  console.log('[Beta] Loaded beta opt-in preference:', betaOptedIn);

  // Auto-updater setup (skip in dev mode, Snap, and Flatpak - they use their own update mechanisms)
  if (isDev) {
    console.log('[AutoUpdater] Skipped in development mode');
  } else if (detectSnapInstall()) {
    console.log('[AutoUpdater] Skipped for Snap installation (use "sudo snap refresh" instead)');
  } else if (detectFlatpakInstall()) {
    console.log('[AutoUpdater] Skipped for Flatpak installation (use "flatpak update" instead)');
  } else {
    setupAutoUpdater();
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
  
  // Request media permissions (camera/microphone) for video/audio calls on macOS
  await requestMediaPermissions();

  // Load icon theme preference
  currentIconTheme = loadIconTheme();
  console.log(`[Icon Theme] Initial theme: ${currentIconTheme}`);
  
  // Listen for system theme changes (for 'system' mode auto-switching)
  nativeTheme.on('updated', () => {
    if (currentIconTheme === 'system') {
      console.log('[Icon Theme] System theme changed, updating icons');
      applyCurrentIconTheme();
    }
  });
  
  // Apply initial icon theme (for macOS dock icon)
  if (process.platform === 'darwin') {
    applyCurrentIconTheme();
  }

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
