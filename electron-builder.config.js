/**
 * electron-builder configuration
 * 
 * This configuration file allows beta and stable versions to be installed
 * side-by-side on all platforms by dynamically changing app identifiers.
 */

const packageJson = require('./package.json');
const version = packageJson.version;

// Detect if this is a beta/prerelease version
const isBeta = version.includes('-beta') || version.includes('-alpha') || version.includes('-rc');

// Detect target platform from command line args
const args = process.argv.join(' ');
const isLinuxBuild = args.includes('--linux');
const isWindowsBuild = args.includes('--win');
const isMacBuild = args.includes('--mac') || (!isLinuxBuild && !isWindowsBuild && process.platform === 'darwin');

console.log(`\nBuild Configuration for v${version}:`);
console.log(`  Type: ${isBeta ? 'BETA' : 'STABLE'}`);
console.log(`  App ID: ${isBeta ? 'com.facebook.messenger.desktop.beta' : 'com.facebook.messenger.desktop'}`);
console.log(`  Product Name: ${isBeta ? 'Messenger Beta' : 'Messenger'}`);
console.log(`  Target: ${isMacBuild ? 'macOS' : ''}${isWindowsBuild ? 'Windows' : ''}${isLinuxBuild ? 'Linux' : ''}`);
console.log('');

// Icon paths - beta uses orange icons from beta/ subdirectory
const iconPaths = {
  stable: {
    icns: 'assets/icons/icon.icns',
    ico: 'assets/icons/icon.ico',
    linux: 'assets/icons/linux',
  },
  beta: {
    icns: 'assets/icons/beta/icon.icns',
    ico: 'assets/icons/beta/icon.ico',
    linux: 'assets/icons/beta/linux',
  },
};

const icons = isBeta ? iconPaths.beta : iconPaths.stable;

// Build the files array based on target platform
const baseFiles = [
  'dist/**/*',
  'assets/icons/**/*',
  'assets/tray/**/*',
];

// Only include Windows-specific files for Windows builds
if (isWindowsBuild) {
  baseFiles.push('scripts/fix-windows-shortcuts.ps1');
}

// Base configuration (shared between stable and beta)
const baseConfig = {
  afterPack: './scripts/after-pack.js',
  publish: [
    {
      provider: 'github',
      owner: 'apotenza92',
      repo: 'FacebookMessengerDesktop',
    },
  ],
  directories: {
    output: 'release',
  },
  files: baseFiles,
  asar: true,
  compression: 'maximum',
};

// macOS configuration
const macConfig = {
  category: 'public.app-category.social-networking',
  target: 'zip',
  icon: icons.icns,
  entitlements: 'entitlements.mac.plist',
  entitlementsInherit: 'entitlements.mac.plist',
  notarize: {
    teamId: '27JL2VERNC',
  },
  extendInfo: {
    NSCameraUsageDescription: 'Messenger needs access to your camera for video calls.',
    NSMicrophoneUsageDescription: 'Messenger needs access to your microphone for audio and video calls.',
    NSScreenCaptureUsageDescription: 'Messenger needs access to screen recording to share your screen during calls.',
  },
};

// Windows configuration
const winConfig = {
  target: ['nsis'],
  icon: icons.ico,
};

const nsisConfig = {
  oneClick: true,
  perMachine: false,
  differentialPackage: false,
  deleteAppDataOnUninstall: true,
  include: 'scripts/uninstaller.nsh',
  installerIcon: icons.ico,
  uninstallerIcon: icons.ico,
};

// Linux configuration
const linuxConfig = {
  target: [
    { target: 'AppImage', arch: ['x64', 'arm64'] },
    { target: 'deb', arch: ['x64', 'arm64'] },
    { target: 'rpm', arch: ['x64', 'arm64'] },
    { target: 'flatpak', arch: ['x64'] },
  ],
  category: 'Network',
  icon: icons.linux,
};

const flatpakConfig = {
  runtimeVersion: '24.08',
  runtime: 'org.freedesktop.Platform',
  sdk: 'org.freedesktop.Sdk',
  base: 'org.electronjs.Electron2.BaseApp',
  baseVersion: '24.08',
  finishArgs: [
    '--socket=wayland',
    '--socket=fallback-x11',
    '--share=ipc',
    '--socket=pulseaudio',
    '--share=network',
    '--device=dri',
    '--device=all',
    '--talk-name=org.freedesktop.Notifications',
    '--talk-name=org.kde.StatusNotifierWatcher',
    '--filesystem=xdg-download',
  ],
};

// Stable-specific configuration
const stableConfig = {
  ...baseConfig,
  appId: 'com.facebook.messenger.desktop',
  productName: 'Messenger',
  // Only include asarUnpack for Linux builds (needed for icon post-install scripts)
  ...(isLinuxBuild && { asarUnpack: ['assets/icons/linux/**/*'] }),
  mac: {
    ...macConfig,
    artifactName: 'Messenger-macos-${arch}.${ext}',
  },
  win: {
    ...winConfig,
    artifactName: 'Messenger-windows-${arch}-setup.${ext}',
  },
  nsis: {
    ...nsisConfig,
    shortcutName: 'Messenger',
  },
  linux: {
    ...linuxConfig,
    executableName: 'facebook-messenger-desktop',
    desktop: {
      Name: 'Messenger',
      Comment: 'Unofficial desktop client for Facebook Messenger',
      Categories: 'Network;InstantMessaging;Chat;',
      StartupWMClass: 'Messenger',
      Icon: 'facebook-messenger-desktop',
    },
  },
  appImage: {
    artifactName: 'facebook-messenger-desktop-${arch}.${ext}',
  },
  deb: {
    packageName: 'facebook-messenger-desktop',
    artifactName: 'facebook-messenger-desktop-${arch}.${ext}',
    afterInstall: 'scripts/linux-after-install.sh',
    afterRemove: 'scripts/linux-after-remove.sh',
  },
  rpm: {
    packageName: 'facebook-messenger-desktop',
    artifactName: 'facebook-messenger-desktop-${arch}.${ext}',
    afterInstall: 'scripts/linux-after-install.sh',
    afterRemove: 'scripts/linux-after-remove.sh',
  },
  flatpak: {
    ...flatpakConfig,
    artifactName: 'facebook-messenger-desktop-${arch}.${ext}',
  },
};

// Beta-specific configuration (allows side-by-side installation with stable)
const betaConfig = {
  ...baseConfig,
  appId: 'com.facebook.messenger.desktop.beta',
  productName: 'Messenger Beta',
  // Only include asarUnpack for Linux builds (needed for icon post-install scripts)
  ...(isLinuxBuild && { asarUnpack: ['assets/icons/beta/linux/**/*'] }),
  mac: {
    ...macConfig,
    artifactName: 'Messenger-Beta-macos-${arch}.${ext}',
  },
  win: {
    ...winConfig,
    artifactName: 'Messenger-Beta-windows-${arch}-setup.${ext}',
  },
  nsis: {
    ...nsisConfig,
    shortcutName: 'Messenger Beta',
  },
  linux: {
    ...linuxConfig,
    executableName: 'facebook-messenger-desktop-beta',
    desktop: {
      Name: 'Messenger Beta',
      Comment: 'Unofficial desktop client for Facebook Messenger (Beta)',
      Categories: 'Network;InstantMessaging;Chat;',
      StartupWMClass: 'Messenger Beta',
      Icon: 'facebook-messenger-desktop-beta',
    },
  },
  appImage: {
    artifactName: 'facebook-messenger-desktop-beta-${arch}.${ext}',
  },
  deb: {
    packageName: 'facebook-messenger-desktop-beta',
    artifactName: 'facebook-messenger-desktop-beta-${arch}.${ext}',
    afterInstall: 'scripts/linux-after-install.sh',
    afterRemove: 'scripts/linux-after-remove.sh',
  },
  rpm: {
    packageName: 'facebook-messenger-desktop-beta',
    artifactName: 'facebook-messenger-desktop-beta-${arch}.${ext}',
    afterInstall: 'scripts/linux-after-install.sh',
    afterRemove: 'scripts/linux-after-remove.sh',
  },
  flatpak: {
    ...flatpakConfig,
    artifactName: 'facebook-messenger-desktop-beta-${arch}.${ext}',
  },
};

module.exports = isBeta ? betaConfig : stableConfig;
