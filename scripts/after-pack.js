const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * electron-builder afterPack hook
 * - Adds an instructional text file alongside the .app bundle for macOS
 * - Compiles and bundles the notification-helper Swift binary
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appOutDir = context.appOutDir;
  
  // Create install instructions
  const fileName = 'Drag Messenger to Applications folder.txt';
  const filePath = path.join(appOutDir, fileName);

  const content = `To install Messenger:

1. Open your Applications folder (Cmd + Shift + A in Finder)
2. Drag "Messenger.app" from this folder into Applications
3. Eject or delete this folder
4. Launch Messenger from Applications

Messenger works best when installed in your Applications folder.
Auto-updates and macOS integration require the app to be in Applications.
`;

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✓ Created install instructions: ${fileName}`);
  
  // Compile and bundle notification-helper for macOS
  await compileNotificationHelper(context);
};

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
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>NotificationHelper</string>
    <key>CFBundleIdentifier</key>
    <string>com.facebook.messenger.desktop.notification-helper</string>
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

