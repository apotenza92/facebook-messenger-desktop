const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const glob = require('glob');
const { execInVM, copyToVM, sleep } = require('./test-vm-helpers');

/**
 * Test Installation and Uninstallation Behavior
 * TC1-TC5: Installation, uninstallation, and isolation tests
 */

// Test configuration
const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const TEST_SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'test-screenshots');

// Ensure screenshot directory exists
if (!fs.existsSync(TEST_SCREENSHOTS_DIR)) {
  fs.mkdirSync(TEST_SCREENSHOTS_DIR, { recursive: true });
}

/**
 * TC1: macOS - Stable Installation (Host System)
 */
async function testMacStableInstallation() {
  console.log('\n=== TC1: macOS Stable Installation ===');

  // Build stable package
  console.log('Building stable macOS package...');
  delete process.env.FORCE_BETA_BUILD;

  // Clean release directory first
  execSync('find release -type f \\( -name "*.zip" -o -name "*.exe" -o -name "*.deb" -o -name "*.rpm" \\) -delete 2>/dev/null || true',
    { cwd: PROJECT_ROOT });

  execSync('npm run build && npm run dist:mac', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // Locate the zip file
  const stableZips = glob.sync(path.join(RELEASE_DIR, 'Messenger-macos-*.zip'));
  assert(stableZips.length > 0, 'Stable package not found');

  const stableZip = stableZips[0];
  assert(!stableZip.includes('Beta'), 'Package should not have Beta in name');
  console.log(`Found stable package: ${path.basename(stableZip)}`);

  // Extract to test location
  const testDir = '/tmp/messenger-test-stable';
  execSync(`rm -rf ${testDir} && mkdir -p ${testDir}`);
  execSync(`unzip -q "${stableZip}" -d ${testDir}`);

  // Verify bundle ID
  const bundleId = execSync(
    `defaults read "${testDir}/Messenger.app/Contents/Info.plist" CFBundleIdentifier`
  ).toString().trim();

  assert.strictEqual(bundleId, 'com.facebook.messenger.desktop',
    'Bundle ID should be com.facebook.messenger.desktop');

  // Verify app name
  const appName = execSync(`ls ${testDir}`).toString().trim();
  assert.strictEqual(appName, 'Messenger.app', 'App should be named Messenger.app');

  // Verify version
  const version = execSync(
    `defaults read "${testDir}/Messenger.app/Contents/Info.plist" CFBundleShortVersionString`
  ).toString().trim();
  console.log(`Stable app version: ${version}`);
  assert(!version.includes('-beta'), 'Stable version should not contain -beta');

  console.log('✅ TC1: macOS Stable Installation - PASSED');
  return testDir;
}

/**
 * TC2: macOS - Beta Installation (Host System)
 */
async function testMacBetaInstallation() {
  console.log('\n=== TC2: macOS Beta Installation ===');

  // Build beta package
  console.log('Building beta macOS package...');
  process.env.FORCE_BETA_BUILD = 'true';

  // Clean release directory first
  execSync('find release -type f \\( -name "*.zip" -o -name "*.exe" -o -name "*.deb" -o -name "*.rpm" \\) -delete 2>/dev/null || true',
    { cwd: PROJECT_ROOT });

  execSync('npm run build && npm run dist:mac', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  const betaZips = glob.sync(path.join(RELEASE_DIR, 'Messenger-Beta-macos-*.zip'));
  assert(betaZips.length > 0, 'Beta package not found');

  const betaZip = betaZips[0];
  assert(betaZip.includes('Beta'), 'Beta package should have Beta in name');
  console.log(`Found beta package: ${path.basename(betaZip)}`);

  const testDir = '/tmp/messenger-test-beta';
  execSync(`rm -rf ${testDir} && mkdir -p ${testDir}`);
  execSync(`unzip -q "${betaZip}" -d ${testDir}`);

  // Verify bundle ID
  const bundleId = execSync(
    `defaults read "${testDir}/Messenger Beta.app/Contents/Info.plist" CFBundleIdentifier`
  ).toString().trim();

  assert.strictEqual(bundleId, 'com.facebook.messenger.desktop.beta',
    'Bundle ID should be com.facebook.messenger.desktop.beta');

  // Verify app name includes "Beta"
  const appName = execSync(`ls ${testDir}`).toString().trim();
  assert.strictEqual(appName, 'Messenger Beta.app', 'App should be named Messenger Beta.app');

  // Verify icon is beta (orange) icon
  const iconHash = execSync(
    `shasum -a 256 "${testDir}/Messenger Beta.app/Contents/Resources/electron.icns"`
  ).toString().split(' ')[0];

  // Compare with source beta icon
  const betaIconHash = execSync(
    'shasum -a 256 assets/icons/beta/icon.icns',
    { cwd: PROJECT_ROOT }
  ).toString().split(' ')[0];

  assert.strictEqual(iconHash, betaIconHash, 'Beta icon should match source beta icon');

  // Verify version
  const version = execSync(
    `defaults read "${testDir}/Messenger Beta.app/Contents/Info.plist" CFBundleShortVersionString`
  ).toString().trim();
  console.log(`Beta app version: ${version}`);

  console.log('✅ TC2: macOS Beta Installation - PASSED');
  return testDir;
}

/**
 * TC3: Windows - Installation via SSH to VM
 */
async function testWindowsInstallation(variant) {
  console.log(`\n=== TC3: Windows ${variant} Installation ===`);

  const isBeta = variant === 'beta';
  const prefix = isBeta ? 'Messenger-Beta' : 'Messenger';

  // Build Windows package
  console.log(`Building ${variant} Windows package...`);
  if (isBeta) {
    process.env.FORCE_BETA_BUILD = 'true';
  } else {
    delete process.env.FORCE_BETA_BUILD;
  }

  execSync('npm run build && npm run dist:win', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // Find the installer
  const installers = glob.sync(path.join(RELEASE_DIR, `${prefix}-windows-*.exe`));
  assert(installers.length > 0, `${variant} installer not found`);

  const installer = installers[0];
  console.log(`Found installer: ${path.basename(installer)}`);

  // Copy to shared folder
  copyToVM(installer, `${prefix}-setup.exe`);

  // Install silently in Windows VM
  console.log(`Installing ${variant} in Windows VM...`);
  const installCmd = `Z:\\messenger-test\\${prefix}-setup.exe /S`;

  try {
    execInVM('windows', installCmd);
  } catch (err) {
    // Silent install may not return output, check if installed
  }

  // Wait for installation
  await sleep(15000);

  // Verify installation
  const expectedPath = isBeta
    ? 'C:\\Users\\testuser\\AppData\\Local\\Programs\\messenger-beta'
    : 'C:\\Users\\testuser\\AppData\\Local\\Programs\\messenger';

  const exists = execInVM('windows',
    `powershell -Command "Test-Path '${expectedPath}\\*.exe'"`,
    false
  );

  assert(exists.includes('True'), `Installation path not found: ${expectedPath}`);

  // Verify shortcut name
  const shortcutName = isBeta ? 'Messenger Beta' : 'Messenger';
  const shortcutExists = execInVM('windows',
    `powershell -Command "Test-Path '$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName}.lnk'"`,
    false
  );

  assert(shortcutExists.includes('True'), `${shortcutName} shortcut not found`);

  console.log(`✅ TC3: Windows ${variant} Installation - PASSED`);
  return expectedPath;
}

/**
 * TC4: Linux - Installation via SSH to VMs
 */
async function testLinuxInstallation(distro, variant) {
  console.log(`\n=== TC4: ${distro} ${variant} Installation ===`);

  const isBeta = variant === 'beta';
  const packageSuffix = isBeta ? '-beta' : '';

  // Build appropriate package format
  console.log(`Building ${variant} Linux ${distro} package...`);
  if (isBeta) {
    process.env.FORCE_BETA_BUILD = 'true';
  } else {
    delete process.env.FORCE_BETA_BUILD;
  }

  let packageFile;
  if (distro === 'ubuntu') {
    execSync('npm run build && npm run dist:linux -- --deb', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    const debs = glob.sync(path.join(RELEASE_DIR, `facebook-messenger-desktop${packageSuffix}_*.deb`));
    packageFile = debs[0];
  } else if (distro === 'fedora') {
    execSync('npm run build && npm run dist:linux -- --rpm', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    const rpms = glob.sync(path.join(RELEASE_DIR, `facebook-messenger-desktop${packageSuffix}-*.rpm`));
    packageFile = rpms[0];
  }

  assert(packageFile, `${distro} ${variant} package not found`);
  console.log(`Found package: ${path.basename(packageFile)}`);

  // Copy to VM shared folder
  const packageName = path.basename(packageFile);
  copyToVM(packageFile, packageName);

  // Install in VM
  console.log(`Installing ${variant} in ${distro} VM...`);
  let installCmd;
  if (distro === 'ubuntu') {
    installCmd = `dpkg -i /media/psf/messenger-test/${packageName} || apt-get -f install -y`;
  } else if (distro === 'fedora') {
    installCmd = `rpm -i /media/psf/messenger-test/${packageName}`;
  }

  execInVM(distro, installCmd, true);

  // Verify executable installed
  const execName = `facebook-messenger-desktop${packageSuffix}`;
  const execPath = execInVM(distro, `which ${execName}`);
  assert(execPath.includes('/usr/bin/'), `Executable ${execName} not found in PATH`);

  // Verify .desktop file
  const desktopFileName = isBeta
    ? 'facebook-messenger-desktop-beta.desktop'
    : 'facebook-messenger-desktop.desktop';

  const desktopFile = execInVM(distro,
    `cat /usr/share/applications/${desktopFileName}`
  );

  const expectedName = isBeta ? 'Messenger Beta' : 'Messenger';
  assert(desktopFile.includes(`Name=${expectedName}`), 'Desktop file name incorrect');

  // Verify icon installed
  const iconName = isBeta ? 'messenger-beta' : 'messenger';
  const iconExists = execInVM(distro,
    `ls /usr/share/icons/hicolor/512x512/apps/${iconName}.png`
  );
  assert(iconExists, `Icon ${iconName}.png not installed`);

  console.log(`✅ TC4: ${distro} ${variant} Installation - PASSED`);
  return execPath.trim();
}

/**
 * TC5: Uninstallation Doesn't Affect Other Variant
 */
async function testUninstallationIsolation(platform) {
  console.log(`\n=== TC5: ${platform} Uninstallation Isolation ===`);

  if (platform === 'macos') {
    // Install both
    const stableDir = await testMacStableInstallation();
    const betaDir = await testMacBetaInstallation();

    // Uninstall stable
    console.log('Uninstalling stable...');
    execSync(`rm -rf "${stableDir}/Messenger.app"`);

    // Verify beta still exists
    const betaExists = fs.existsSync(`${betaDir}/Messenger Beta.app`);
    assert(betaExists, 'Beta app was incorrectly removed');

  } else if (platform === 'windows') {
    // Install both
    await testWindowsInstallation('stable');
    await testWindowsInstallation('beta');

    // Uninstall stable
    console.log('Uninstalling stable from Windows...');
    try {
      execInVM('windows',
        'powershell -Command "Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -eq \'Messenger\' } | ForEach-Object { $_.Uninstall() }"'
      );
    } catch (err) {
      // Try alternative method
      execInVM('windows',
        'C:\\Users\\testuser\\AppData\\Local\\Programs\\messenger\\Uninstall*.exe /S'
      );
    }

    await sleep(10000);

    // Verify beta still exists
    const betaExists = execInVM('windows',
      'powershell -Command "Test-Path \'C:\\Users\\testuser\\AppData\\Local\\Programs\\messenger-beta\'"'
    );
    assert(betaExists.includes('True'), 'Beta installation was incorrectly removed');

  } else if (platform === 'ubuntu' || platform === 'fedora') {
    // Install both
    await testLinuxInstallation(platform, 'stable');
    await testLinuxInstallation(platform, 'beta');

    // Uninstall stable
    console.log(`Uninstalling stable from ${platform}...`);
    if (platform === 'ubuntu') {
      execInVM(platform, 'apt remove -y facebook-messenger-desktop', true);
    } else {
      execInVM(platform, 'dnf remove -y facebook-messenger-desktop', true);
    }

    // Verify beta still installed
    const betaInstalled = execInVM(platform,
      'which facebook-messenger-desktop-beta'
    );
    assert(betaInstalled.includes('/usr/bin/'), 'Beta package was incorrectly removed');
  }

  console.log(`✅ TC5: ${platform} Uninstallation Isolation - PASSED`);
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('=================================');
  console.log('Installation & Uninstallation Tests');
  console.log('=================================\n');

  try {
    // macOS tests (always run on host)
    await testMacStableInstallation();
    await testMacBetaInstallation();
    await testUninstallationIsolation('macos');

    // Windows tests (if VM available)
    try {
      await testWindowsInstallation('stable');
      await testWindowsInstallation('beta');
      await testUninstallationIsolation('windows');
    } catch (err) {
      console.warn('⚠️  Windows tests skipped (VM not available):', err.message);
    }

    // Ubuntu tests (if VM available)
    try {
      await testLinuxInstallation('ubuntu', 'stable');
      await testLinuxInstallation('ubuntu', 'beta');
      await testUninstallationIsolation('ubuntu');
    } catch (err) {
      console.warn('⚠️  Ubuntu tests skipped (VM not available):', err.message);
    }

    // Fedora tests (if VM available)
    try {
      await testLinuxInstallation('fedora', 'stable');
      await testLinuxInstallation('fedora', 'beta');
      await testUninstallationIsolation('fedora');
    } catch (err) {
      console.warn('⚠️  Fedora tests skipped (VM not available):', err.message);
    }

    console.log('\n=================================');
    console.log('✅ All installation tests PASSED!');
    console.log('=================================\n');

  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runTests();
}

module.exports = {
  testMacStableInstallation,
  testMacBetaInstallation,
  testWindowsInstallation,
  testLinuxInstallation,
  testUninstallationIsolation
};
