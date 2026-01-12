#!/usr/bin/env node

/**
 * Clears the Messenger-Dev userData folder for a fresh start in dev mode.
 * This does NOT affect the production Messenger app's data.
 * Cross-platform: works on macOS, Windows, and Linux.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getUserDataPath() {
  // Dev mode uses 'Messenger-Dev' folder, separate from production 'Messenger'
  const appName = 'Messenger-Dev';
  
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    default: // Linux and others
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
  }
}

const userDataPath = getUserDataPath();

if (fs.existsSync(userDataPath)) {
  console.log(`Removing dev userData folder: ${userDataPath}`);
  fs.rmSync(userDataPath, { recursive: true, force: true });
  console.log('Done! Dev app will start fresh.');
} else {
  console.log(`No dev userData folder found at: ${userDataPath}`);
  console.log('Dev app will start fresh anyway.');
}
