#!/usr/bin/env node

/**
 * Post-build script to create DMG files (macOS only)
 * Usage: node scripts/build-dmg.js [--arm64 | --x64 | --all]
 */

const fs = require('fs');
const path = require('path');

// appdmg is macOS-only, gracefully skip on other platforms
let appdmg;
try {
  appdmg = require('appdmg');
} catch (e) {
  if (process.platform !== 'darwin') {
    console.log('Skipping DMG creation (appdmg only available on macOS)');
    process.exit(0);
  }
  throw e;
}

const releaseDir = path.join(__dirname, '../release');
const assetsDir = path.join(__dirname, '../assets');
const dmgIconPath = path.join(assetsDir, 'icons/dmg-icon.icns');

// Read version from package.json
const packageJson = require('../package.json');
const VERSION = packageJson.version;

// DMG settings
const WINDOW_WIDTH = 680;
const WINDOW_HEIGHT = 420;
const ICON_SIZE = 128;
const APP_X = 180;
const APP_Y = 220;
const APPS_X = 500;
const APPS_Y = 220;

// Architecture configs with clear folder names
const ARCH_CONFIG = {
  arm64: {
    folderName: 'mac-arm64',
    displayName: 'Apple Silicon (arm64)'
  },
  x64: {
    folderName: 'mac-x64',
    displayName: 'Intel (x64)'
  }
};

function buildDmg(arch) {
  return new Promise((resolve, reject) => {
    const config = ARCH_CONFIG[arch];
    if (!config) {
      console.error(`Unknown architecture: ${arch}`);
      reject(new Error(`Unknown architecture: ${arch}`));
      return;
    }

    // electron-builder uses 'mac-arm64' for arm64 and 'mac' for x64
    // We'll check both the clear name and electron-builder's default name
    const electronBuilderFolder = arch === 'arm64' ? 'mac-arm64' : 'mac';
    const clearFolder = config.folderName;
    
    let appPath = path.join(releaseDir, clearFolder, 'Messenger.app');
    
    // Fall back to electron-builder's default folder names
    if (!fs.existsSync(appPath)) {
      appPath = path.join(releaseDir, electronBuilderFolder, 'Messenger.app');
    }
    
    // Rename folder to clear name if using electron-builder default
    const electronBuilderPath = path.join(releaseDir, electronBuilderFolder);
    const clearPath = path.join(releaseDir, clearFolder);
    if (fs.existsSync(electronBuilderPath) && electronBuilderFolder !== clearFolder && !fs.existsSync(clearPath)) {
      fs.renameSync(electronBuilderPath, clearPath);
      appPath = path.join(clearPath, 'Messenger.app');
      console.log(`Renamed ${electronBuilderFolder}/ → ${clearFolder}/`);
    }

    const dmgName = `Messenger-${VERSION}-macos-${arch}.dmg`;
    const dmgPath = path.join(releaseDir, dmgName);

    // Check if app exists
    if (!fs.existsSync(appPath)) {
      console.log(`Skipping ${config.displayName}: app not found`);
      resolve();
      return;
    }

    console.log(`\nBuilding DMG for ${config.displayName}...`);

    // Remove old DMG if exists
    if (fs.existsSync(dmgPath)) {
      fs.unlinkSync(dmgPath);
    }

    // appdmg spec
    const spec = {
      title: 'Messenger',
      icon: dmgIconPath,
      'background-color': '#ffffff',
      'icon-size': ICON_SIZE,
      window: {
        size: {
          width: WINDOW_WIDTH,
          height: WINDOW_HEIGHT
        }
      },
      contents: [
        { x: APP_X, y: APP_Y, type: 'file', path: appPath },
        { x: APPS_X, y: APPS_Y, type: 'link', path: '/Applications' }
      ]
    };

    const specPath = path.join(releaseDir, `dmg-spec-${arch}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

    const dmg = appdmg({ source: specPath, target: dmgPath });

    dmg.on('progress', (info) => {
      if (info.type === 'step-begin') {
        process.stdout.write(`  ${info.title}...`);
      } else if (info.type === 'step-end') {
        process.stdout.write(' done\n');
      }
    });

    dmg.on('finish', () => {
      fs.unlinkSync(specPath);
      console.log(`✓ Created ${dmgName}`);
      resolve();
    });

    dmg.on('error', (err) => {
      console.error(`Failed to create DMG for ${arch}:`, err);
      reject(err);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  
  let buildArm64 = false;
  let buildX64 = false;

  if (args.includes('--all') || args.length === 0) {
    buildArm64 = true;
    buildX64 = true;
  } else {
    if (args.includes('--arm64')) buildArm64 = true;
    if (args.includes('--x64')) buildX64 = true;
  }

  console.log('Building DMGs...\n');

  try {
    if (buildArm64) await buildDmg('arm64');
    if (buildX64) await buildDmg('x64');
    console.log('\nDone!');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

main();
