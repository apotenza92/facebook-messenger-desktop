const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get build configuration from package.json version
const packageJson = require('../package.json');
const version = packageJson.version;
const isBeta = version.includes('-beta') || version.includes('-alpha') || version.includes('-rc');

/**
 * electron-builder afterPack hook
 * - Adds an instructional text file alongside the .app bundle for macOS
 * - Compiles and bundles the notification-helper Swift binary
 * - Wraps Linux executables so AppImage direct launches always pass --no-sandbox
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    wrapLinuxExecutable(context);
    return;
  }

  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appOutDir = context.appOutDir;
  const appDisplayName = isBeta ? 'Messenger Beta' : 'Messenger';
  
  // Create install instructions
  const fileName = `Drag ${appDisplayName} to Applications folder.txt`;
  const filePath = path.join(appOutDir, fileName);

  const content = `To install ${appDisplayName}:

1. Open your Applications folder (Cmd + Shift + A in Finder)
2. Drag "${appDisplayName}.app" from this folder into Applications
3. Eject or delete this folder
4. Launch ${appDisplayName} from Applications

${appDisplayName} works best when installed in your Applications folder.
Auto-updates and macOS integration require the app to be in Applications.
`;

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✓ Created install instructions: ${fileName}`);
  
  // Compile and bundle notification-helper for macOS
  await compileNotificationHelper(context);
};

function resolveLinuxExecutableName(context) {
  if (context.packager && context.packager.executableName) {
    return context.packager.executableName;
  }

  return isBeta
    ? 'facebook-messenger-desktop-beta'
    : 'facebook-messenger-desktop';
}

function wrapLinuxExecutable(context) {
  const executableName = resolveLinuxExecutableName(context);
  const executablePath = path.join(context.appOutDir, executableName);
  const wrappedExecutablePath = `${executablePath}.bin`;

  if (!fs.existsSync(executablePath)) {
    console.log(`⚠ Linux executable not found at ${executablePath}, skipping wrapper`);
    return;
  }

  if (!fs.existsSync(wrappedExecutablePath)) {
    fs.renameSync(executablePath, wrappedExecutablePath);
  }

  const wrapper = `#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for arg in "$@"; do
  if [ "$arg" = "--no-sandbox" ]; then
    exec "$DIR/${executableName}.bin" "$@"
  fi
done

exec "$DIR/${executableName}.bin" --no-sandbox "$@"
`;

  fs.writeFileSync(executablePath, wrapper, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(executablePath, 0o755);
  fs.chmodSync(wrappedExecutablePath, 0o755);
  console.log(`✓ Wrapped Linux executable with --no-sandbox launcher: ${executableName}`);
}

/**
 * Compile the Swift notification-helper as a mini app bundle
 * UNUserNotificationCenter requires an app bundle with Info.plist to work
 */
async function compileNotificationHelper(context) {
  const projectRoot = path.resolve(__dirname, '..');
  const swiftSource = path.join(projectRoot, 'scripts', 'notification-helper.swift');
  
  // Find the app bundle's Resources directory
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  
  // Create a mini app bundle for the helper
  const helperAppPath = path.join(resourcesPath, 'NotificationHelper.app');
  const helperContentsPath = path.join(helperAppPath, 'Contents');
  const helperMacOSPath = path.join(helperContentsPath, 'MacOS');
  const outputBinary = path.join(helperMacOSPath, 'NotificationHelper');
  
  // Check if source exists
  if (!fs.existsSync(swiftSource)) {
    console.log('⚠ notification-helper.swift not found, skipping compilation');
    return;
  }
  
  // Determine target architecture
  const arch = context.arch;
  let targetArch;
  if (arch === 1 || arch === 'x64') {
    targetArch = 'x86_64';
  } else if (arch === 3 || arch === 'arm64') {
    targetArch = 'arm64';
  } else {
    // Default to current machine's architecture
    targetArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  }
  
  console.log(`⏳ Compiling notification-helper for ${targetArch}...`);
  
  try {
    // Create the app bundle structure
    fs.mkdirSync(helperMacOSPath, { recursive: true });
    
    // Create Info.plist for the mini app bundle
    // This is required for UNUserNotificationCenter to work
    // Use beta bundle ID if building beta version
    const helperBundleId = isBeta
      ? 'com.facebook.messenger.desktop.beta.notification-helper'
      : 'com.facebook.messenger.desktop.notification-helper';
    
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>NotificationHelper</string>
    <key>CFBundleIdentifier</key>
    <string>${helperBundleId}</string>
    <key>CFBundleName</key>
    <string>NotificationHelper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSBackgroundOnly</key>
    <true/>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>`;
    
    fs.writeFileSync(path.join(helperContentsPath, 'Info.plist'), infoPlist);
    
    // Compile Swift source to native binary
    // -O for optimization, -target for architecture
    execSync(
      `swiftc -O -target ${targetArch}-apple-macosx11.0 -o "${outputBinary}" "${swiftSource}"`,
      { stdio: 'inherit' }
    );
    
    // Make it executable
    fs.chmodSync(outputBinary, 0o755);
    
    console.log(`✓ Compiled notification-helper for ${targetArch}`);
  } catch (error) {
    console.error('⚠ Failed to compile notification-helper:', error.message);
    console.log('  Notification permission checking will not be available');
  }
}
