#!/usr/bin/env node

/**
 * Development startup script
 * Builds an app bundle and launches it so macOS shows the correct name and icon
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Extra args passed after -- (e.g., npm start -- --reset-window)
const extraArgs = process.argv.slice(2);

// Check if dist folder exists and has required files
const distMain = path.join(__dirname, '../dist/main/main.js');
if (!fs.existsSync(distMain)) {
  console.error('Error: dist/main/main.js not found. Run "npm run build" first.');
  process.exit(1);
}

// Find or build the app bundle
const possibleAppPaths = [
  path.join(__dirname, '../release/mac-arm64/Messenger.app'),
  path.join(__dirname, '../release/mac/Messenger.app'),
  path.join(__dirname, '../release/darwin-arm64/Messenger.app'),
];

let appPath = null;
for (const appPathCandidate of possibleAppPaths) {
  if (fs.existsSync(appPathCandidate)) {
    appPath = appPathCandidate;
    break;
  }
}

// Check if we need to rebuild
let needsRebuild = !appPath;
if (appPath) {
  try {
    const appAsarPath = path.join(appPath, 'Contents/Resources/app.asar');
    if (fs.existsSync(appAsarPath)) {
      const distMtime = fs.statSync(distMain).mtime;
      const asarMtime = fs.statSync(appAsarPath).mtime;
      needsRebuild = distMtime > asarMtime;
    } else {
      needsRebuild = true;
    }
  } catch (e) {
    // If we can't check, rebuild to be safe
    needsRebuild = true;
  }
}

if (needsRebuild) {
  console.log('Building app bundle for development...');
  try {
    execSync('npx electron-builder --dir --mac', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
    
    // Try to find it again
    for (const appPathCandidate of possibleAppPaths) {
      if (fs.existsSync(appPathCandidate)) {
        appPath = appPathCandidate;
        break;
      }
    }
  } catch (e) {
    console.error('Failed to build app bundle:', e);
    process.exit(1);
  }
}

if (appPath) {
  console.log('Launching Messenger app from:', appPath);
  try {
    const argsPart = extraArgs.length ? ` --args ${extraArgs.join(' ')}` : '';
    execSync(`open "${appPath}"${argsPart}`, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
      },
    });
  } catch (e) {
    console.error('Failed to launch app:', e);
    process.exit(1);
  }
} else {
  console.error('Could not find built app bundle');
  process.exit(1);
}

