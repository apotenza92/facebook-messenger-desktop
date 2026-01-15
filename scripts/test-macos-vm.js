const { execInVM, copyToVM, copyFileToVM, sleep } = require('./test-vm-helpers');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const glob = require('glob');

const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');

/**
 * TC1: macOS Stable Installation (in VM)
 */
async function testMacStableInstallationVM() {
  console.log('\n=== TC1: macOS Stable Installation (VM) ===');
  console.log('NOTE: Using stable release v1.2.2 from GitHub');
  console.log('Installing to /Applications for proper system integration');

  try {
    // Download stable release on host
    console.log('Downloading stable v1.2.2 on host...');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const tempDir = '/tmp/messenger-download-stable';
    execSync(`rm -rf ${tempDir} && mkdir -p ${tempDir}`);

    execSync(
      `gh release download v1.2.2 --repo apotenza92/facebook-messenger-desktop --pattern "Messenger-macos-${arch}.zip" --dir ${tempDir} --clobber`,
      { stdio: 'inherit' }
    );

    // Clean up any existing installation on VM
    console.log('Removing any existing stable installation...');
    execInVM('macos', `rm -rf /Applications/Messenger.app`);

    // Create temp extraction directory
    const tempExtractDir = '/tmp/messenger-install-stable';
    execInVM('macos', `rm -rf ${tempExtractDir} && mkdir -p ${tempExtractDir}`);

    // Copy package to VM via SCP
    console.log('Copying stable package to VM...');
    copyFileToVM('macos', path.join(tempDir, `Messenger-macos-${arch}.zip`), `${tempExtractDir}/Messenger-stable.zip`);

    // Extract and install to /Applications
    console.log('Installing to /Applications...');
    execInVM('macos', `cd ${tempExtractDir} && unzip -q Messenger-stable.zip && mv Messenger.app /Applications/ && rm Messenger-stable.zip`);

    // Verify bundle ID
    const bundleId = execInVM('macos',
      `defaults read "/Applications/Messenger.app/Contents/Info.plist" CFBundleIdentifier`
    ).trim();

    assert.strictEqual(bundleId, 'com.facebook.messenger.desktop',
      'Bundle ID should be com.facebook.messenger.desktop');

    // Verify app is in Applications
    const appExists = execInVM('macos', `test -d /Applications/Messenger.app && echo "exists" || echo "missing"`).trim();
    assert.strictEqual(appExists, 'exists', 'App should be in /Applications');

    // Verify version
    const version = execInVM('macos',
      `defaults read "/Applications/Messenger.app/Contents/Info.plist" CFBundleShortVersionString`
    ).trim();

    console.log(`Stable app version: ${version}`);
    assert(!version.includes('-beta'), 'Stable version should not contain -beta');

    // Verify Spotlight can find it
    console.log('Verifying Spotlight integration...');
    const spotlightResult = execInVM('macos', `mdfind "kMDItemFSName == 'Messenger.app'" | head -1`).trim();
    assert(spotlightResult.includes('/Applications/Messenger.app'), 'Spotlight should find the app');

    console.log('✅ TC1: macOS Stable Installation (VM) - PASSED');
    console.log('   App location: /Applications/Messenger.app');
    return '/Applications/Messenger.app';

  } catch (err) {
    console.error('❌ TC1 Failed:', err.message);
    throw err;
  }
}

/**
 * TC2: macOS Beta Installation (in VM)
 */
async function testMacBetaInstallationVM() {
  console.log('\n=== TC2: macOS Beta Installation (VM) ===');
  console.log('Installing to /Applications for proper system integration');

  try {
    // Build beta package on host
    console.log('Building beta macOS package on host (without signing)...');

    // Clean release directory first
    execSync('find release -type f \\( -name "*.zip" -o -name "*.exe" -o -name "*.deb" -o -name "*.rpm" \\) -delete 2>/dev/null || true',
      { cwd: PROJECT_ROOT });

    // Build without signing or notarization
    execSync('npm run build && npm run dist:mac', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        APPLE_ID: '',
        APPLE_ID_PASSWORD: ''
      }
    });

    const betaZips = glob.sync(path.join(RELEASE_DIR, 'Messenger-Beta-macos-*.zip'));
    assert(betaZips.length > 0, 'Beta package not found');

    const betaZip = betaZips[0];
    console.log(`Found beta package: ${path.basename(betaZip)}`);

    // Clean up any existing installation on VM
    console.log('Removing any existing beta installation...');
    execInVM('macos', `rm -rf "/Applications/Messenger Beta.app"`);

    // Create temp extraction directory
    const tempExtractDir = '/tmp/messenger-install-beta';
    execInVM('macos', `rm -rf ${tempExtractDir} && mkdir -p ${tempExtractDir}`);

    // Copy package to VM via SCP
    console.log('Copying beta package to VM...');
    copyFileToVM('macos', betaZip, `${tempExtractDir}/Messenger-Beta.zip`);

    // Extract and install to /Applications
    console.log('Installing to /Applications...');
    execInVM('macos', `cd ${tempExtractDir} && unzip -q Messenger-Beta.zip && mv "Messenger Beta.app" /Applications/ && rm Messenger-Beta.zip`);

    // Verify bundle ID
    const bundleId = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleIdentifier`
    ).trim();

    assert.strictEqual(bundleId, 'com.facebook.messenger.desktop.beta',
      'Bundle ID should be com.facebook.messenger.desktop.beta');

    // Verify app is in Applications
    const appExists = execInVM('macos', `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`).trim();
    assert.strictEqual(appExists, 'exists', 'App should be in /Applications');

    // Verify icon is beta icon
    const iconHash = execInVM('macos',
      `shasum -a 256 "/Applications/Messenger Beta.app/Contents/Resources/icon.icns"`
    ).split(' ')[0];

    // Get beta icon hash from host
    const betaIconHash = execSync(
      'shasum -a 256 assets/icons/beta/icon.icns',
      { cwd: PROJECT_ROOT }
    ).toString().split(' ')[0];

    assert.strictEqual(iconHash, betaIconHash, 'Beta icon should match source beta icon');

    // Verify version
    const version = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleShortVersionString`
    ).trim();

    console.log(`Beta app version: ${version}`);

    // Verify Spotlight can find it
    console.log('Verifying Spotlight integration...');
    const spotlightResult = execInVM('macos', `mdfind "kMDItemFSName == 'Messenger Beta.app'" | head -1`).trim();
    assert(spotlightResult.includes('/Applications/Messenger Beta.app'), 'Spotlight should find the beta app');

    console.log('✅ TC2: macOS Beta Installation (VM) - PASSED');
    console.log('   App location: /Applications/Messenger Beta.app');
    return '/Applications/Messenger Beta.app';

  } catch (err) {
    console.error('❌ TC2 Failed:', err.message);
    throw err;
  }
}

/**
 * TC5: Uninstallation Isolation (in VM)
 */
async function testUninstallationIsolationVM() {
  console.log('\n=== TC5: macOS Uninstallation Isolation (VM) ===');

  try {
    // Check if stable exists, if not install it
    const stableExists = execInVM('macos', `test -d "/Applications/Messenger.app" && echo "exists" || echo "missing"`).trim();
    if (stableExists === 'missing') {
      console.log('Stable app not found, installing...');
      await testMacStableInstallationVM();
    }

    // Check if beta exists, if not install it
    const betaExists = execInVM('macos', `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`).trim();
    if (betaExists === 'missing') {
      console.log('Beta app not found, installing...');
      await testMacBetaInstallationVM();
    }

    // Uninstall stable
    console.log('Uninstalling stable app from /Applications...');
    execInVM('macos', `rm -rf "/Applications/Messenger.app"`);

    // Verify stable is gone
    const stableGone = execInVM('macos', `test -d "/Applications/Messenger.app" && echo "exists" || echo "missing"`).trim();
    assert.strictEqual(stableGone, 'missing', 'Stable app should be removed');

    // Verify beta still exists
    const betaStillExists = execInVM('macos', `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`).trim();
    assert.strictEqual(betaStillExists, 'exists', 'Beta app should still exist after uninstalling stable');

    console.log('✅ TC5: macOS Uninstallation Isolation (VM) - PASSED');

  } catch (err) {
    console.error('❌ TC5 Failed:', err.message);
    throw err;
  }
}

/**
 * TC13a: macOS Icon Verification (in VM)
 */
async function testMacOSIconVerificationVM() {
  console.log('\n=== TC13a: macOS Icon Verification (VM) ===');

  try {
    // Ensure both apps are installed
    const stableExists = execInVM('macos', `test -d "/Applications/Messenger.app" && echo "exists" || echo "missing"`).trim();
    if (stableExists === 'missing') {
      await testMacStableInstallationVM();
    }

    const betaExists = execInVM('macos', `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`).trim();
    if (betaExists === 'missing') {
      await testMacBetaInstallationVM();
    }

    // Verify stable icon
    console.log('Verifying stable icon...');
    const stableIconHash = execInVM('macos',
      `shasum -a 256 "/Applications/Messenger.app/Contents/Resources/icon.icns"`
    ).split(' ')[0];

    const stableSourceIconHash = execSync(
      'shasum -a 256 assets/icons/icon.icns',
      { cwd: PROJECT_ROOT }
    ).toString().split(' ')[0];

    assert.strictEqual(stableIconHash, stableSourceIconHash,
      'Stable icon should match source stable icon');
    console.log('✓ Stable icon verified');

    // Verify beta icon
    console.log('Verifying beta icon...');
    const betaIconHash = execInVM('macos',
      `shasum -a 256 "/Applications/Messenger Beta.app/Contents/Resources/icon.icns"`
    ).split(' ')[0];

    const betaSourceIconHash = execSync(
      'shasum -a 256 assets/icons/beta/icon.icns',
      { cwd: PROJECT_ROOT }
    ).toString().split(' ')[0];

    assert.strictEqual(betaIconHash, betaSourceIconHash,
      'Beta icon should match source beta icon');
    console.log('✓ Beta icon verified');

    // Verify icons are different
    assert.notStrictEqual(stableIconHash, betaIconHash,
      'Stable and beta icons must be different');
    console.log('✓ Icons are visually distinct');

    console.log('✅ TC13a: macOS Icon Verification (VM) - PASSED');

  } catch (err) {
    console.error('❌ TC13a Failed:', err.message);
    throw err;
  }
}

// Export test functions
module.exports = {
  testMacStableInstallationVM,
  testMacBetaInstallationVM,
  testUninstallationIsolationVM,
  testMacOSIconVerificationVM
};

// Run if executed directly
if (require.main === module) {
  (async () => {
    const testName = process.argv[2];

    if (!testName) {
      console.log('Usage: node test-macos-vm.js <test-name>');
      console.log('Available tests:');
      console.log('  tc1  - testMacStableInstallationVM');
      console.log('  tc2  - testMacBetaInstallationVM');
      console.log('  tc5  - testUninstallationIsolationVM');
      console.log('  tc13 - testMacOSIconVerificationVM');
      process.exit(1);
    }

    try {
      switch (testName.toLowerCase()) {
        case 'tc1':
          await testMacStableInstallationVM();
          break;
        case 'tc2':
          await testMacBetaInstallationVM();
          break;
        case 'tc5':
          await testUninstallationIsolationVM();
          break;
        case 'tc13':
          await testMacOSIconVerificationVM();
          break;
        default:
          console.error(`Unknown test: ${testName}`);
          process.exit(1);
      }
    } catch (err) {
      console.error('Test failed:', err.message);
      process.exit(1);
    }
  })();
}
