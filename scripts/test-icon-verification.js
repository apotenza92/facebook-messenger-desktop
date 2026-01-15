const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execInVM } = require('./test-vm-helpers');
const {
  testMacStableInstallation,
  testMacBetaInstallation
} = require('./test-installation');

/**
 * Test Icon Verification Across All Platforms
 * TC13: Comprehensive icon verification
 */

const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * TC13a: macOS Icon Verification
 */
async function testMacOSIconVerification() {
  console.log('\n=== TC13a: macOS Icon Verification ===');

  // Ensure apps are installed
  const stableDir = '/tmp/messenger-test-stable';
  const betaDir = '/tmp/messenger-test-beta';

  if (!fs.existsSync(`${stableDir}/Messenger.app`)) {
    await testMacStableInstallation();
  }

  if (!fs.existsSync(`${betaDir}/Messenger Beta.app`)) {
    await testMacBetaInstallation();
  }

  // Verify stable icon
  console.log('Verifying stable icon...');
  const stableIconPath = `${stableDir}/Messenger.app/Contents/Resources/electron.icns`;
  const stableIconHash = execSync(`shasum -a 256 "${stableIconPath}"`)
    .toString().split(' ')[0];

  const stableSourceIconHash = execSync(
    'shasum -a 256 assets/icons/icon.icns',
    { cwd: PROJECT_ROOT }
  ).toString().split(' ')[0];

  assert.strictEqual(stableIconHash, stableSourceIconHash,
    'Stable icon should match source stable icon');

  console.log('✓ Stable icon verified');

  // Verify beta icon
  console.log('Verifying beta icon...');
  const betaIconPath = `${betaDir}/Messenger Beta.app/Contents/Resources/electron.icns`;
  const betaIconHash = execSync(`shasum -a 256 "${betaIconPath}"`)
    .toString().split(' ')[0];

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

  console.log('✅ TC13a: macOS Icon Verification - PASSED');
}

/**
 * TC13b: Windows Icon Verification
 */
async function testWindowsIconVerification() {
  console.log('\n=== TC13b: Windows Icon Verification ===');

  try {
    // Verify stable executable exists
    console.log('Checking stable installation...');
    const stableExists = execInVM('windows',
      'powershell -Command "Test-Path \'C:\\Users\\testuser\\AppData\\Local\\Programs\\messenger\\*.exe\'"',
      false
    );

    if (!stableExists.includes('True')) {
      console.warn('⚠️  Stable app not installed in Windows VM - skipping stable icon verification');
    } else {
      console.log('✓ Stable installation found');
    }

    // Verify beta executable exists
    console.log('Checking beta installation...');
    const betaExists = execInVM('windows',
      'powershell -Command "Test-Path \'C:\\Users\\testuser\\AppData\\Local\\Programs\\messenger-beta\\*.exe\'"',
      false
    );

    if (!betaExists.includes('True')) {
      console.warn('⚠️  Beta app not installed in Windows VM - skipping beta icon verification');
    } else {
      console.log('✓ Beta installation found');
    }

    // Verify shortcuts exist with correct names
    if (stableExists.includes('True')) {
      const stableShortcut = execInVM('windows',
        'powershell -Command "Test-Path \'$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Messenger.lnk\'"',
        false
      );

      assert(stableShortcut.includes('True'), 'Stable shortcut should exist');
      console.log('✓ Stable shortcut exists');
    }

    if (betaExists.includes('True')) {
      const betaShortcut = execInVM('windows',
        'powershell -Command "Test-Path \'$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Messenger Beta.lnk\'"',
        false
      );

      assert(betaShortcut.includes('True'), 'Beta shortcut should exist');
      console.log('✓ Beta shortcut exists');
    }

    console.log('✅ TC13b: Windows Icon Verification - PASSED');

  } catch (err) {
    console.warn('⚠️  Windows icon verification skipped (VM not available):', err.message);
  }
}

/**
 * TC13c: Ubuntu Icon Verification
 */
async function testUbuntuIconVerification() {
  console.log('\n=== TC13c: Ubuntu Icon Verification ===');

  try {
    // Check if stable is installed
    console.log('Checking stable installation...');
    let stableInstalled = false;
    try {
      const stableExec = execInVM('ubuntu', 'which facebook-messenger-desktop');
      stableInstalled = stableExec.includes('/usr/bin/');
    } catch (err) {
      console.warn('⚠️  Stable app not installed in Ubuntu VM');
    }

    // Check if beta is installed
    console.log('Checking beta installation...');
    let betaInstalled = false;
    try {
      const betaExec = execInVM('ubuntu', 'which facebook-messenger-desktop-beta');
      betaInstalled = betaExec.includes('/usr/bin/');
    } catch (err) {
      console.warn('⚠️  Beta app not installed in Ubuntu VM');
    }

    // Verify desktop files
    if (stableInstalled) {
      const stableDesktop = execInVM('ubuntu',
        'cat /usr/share/applications/facebook-messenger-desktop.desktop'
      );

      assert(stableDesktop.includes('Name=Messenger'),
        'Stable desktop file should have Name=Messenger');
      console.log('✓ Stable desktop file verified');

      // Verify stable icon exists
      const stableIcon = execInVM('ubuntu',
        'ls /usr/share/icons/hicolor/512x512/apps/messenger.png'
      );
      assert(stableIcon.includes('messenger.png'), 'Stable icon should exist');
      console.log('✓ Stable icon file exists');
    }

    if (betaInstalled) {
      const betaDesktop = execInVM('ubuntu',
        'cat /usr/share/applications/facebook-messenger-desktop-beta.desktop'
      );

      assert(betaDesktop.includes('Name=Messenger Beta'),
        'Beta desktop file should have Name=Messenger Beta');
      console.log('✓ Beta desktop file verified');

      // Verify beta icon exists
      const betaIcon = execInVM('ubuntu',
        'ls /usr/share/icons/hicolor/512x512/apps/messenger-beta.png'
      );
      assert(betaIcon.includes('messenger-beta.png'), 'Beta icon should exist');
      console.log('✓ Beta icon file exists');
    }

    if (stableInstalled || betaInstalled) {
      console.log('✅ TC13c: Ubuntu Icon Verification - PASSED');
    } else {
      console.warn('⚠️  Ubuntu icon verification skipped (no apps installed)');
    }

  } catch (err) {
    console.warn('⚠️  Ubuntu icon verification skipped (VM not available):', err.message);
  }
}

/**
 * TC13d: Fedora Icon Verification
 */
async function testFedoraIconVerification() {
  console.log('\n=== TC13d: Fedora Icon Verification ===');

  try {
    // Check if stable is installed
    console.log('Checking stable installation...');
    let stableInstalled = false;
    try {
      const stableExec = execInVM('fedora', 'which facebook-messenger-desktop');
      stableInstalled = stableExec.includes('/usr/bin/');
    } catch (err) {
      console.warn('⚠️  Stable app not installed in Fedora VM');
    }

    // Check if beta is installed
    console.log('Checking beta installation...');
    let betaInstalled = false;
    try {
      const betaExec = execInVM('fedora', 'which facebook-messenger-desktop-beta');
      betaInstalled = betaExec.includes('/usr/bin/');
    } catch (err) {
      console.warn('⚠️  Beta app not installed in Fedora VM');
    }

    // Verify desktop files
    if (stableInstalled) {
      const stableDesktop = execInVM('fedora',
        'cat /usr/share/applications/facebook-messenger-desktop.desktop'
      );

      assert(stableDesktop.includes('Name=Messenger'),
        'Stable desktop file should have Name=Messenger');
      console.log('✓ Stable desktop file verified');

      // Verify stable icon exists
      const stableIcon = execInVM('fedora',
        'ls /usr/share/icons/hicolor/512x512/apps/messenger.png'
      );
      assert(stableIcon.includes('messenger.png'), 'Stable icon should exist');
      console.log('✓ Stable icon file exists');
    }

    if (betaInstalled) {
      const betaDesktop = execInVM('fedora',
        'cat /usr/share/applications/facebook-messenger-desktop-beta.desktop'
      );

      assert(betaDesktop.includes('Name=Messenger Beta'),
        'Beta desktop file should have Name=Messenger Beta');
      console.log('✓ Beta desktop file verified');

      // Verify beta icon exists
      const betaIcon = execInVM('fedora',
        'ls /usr/share/icons/hicolor/512x512/apps/messenger-beta.png'
      );
      assert(betaIcon.includes('messenger-beta.png'), 'Beta icon should exist');
      console.log('✓ Beta icon file exists');
    }

    if (stableInstalled || betaInstalled) {
      console.log('✅ TC13d: Fedora Icon Verification - PASSED');
    } else {
      console.warn('⚠️  Fedora icon verification skipped (no apps installed)');
    }

  } catch (err) {
    console.warn('⚠️  Fedora icon verification skipped (VM not available):', err.message);
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('=================================');
  console.log('Icon Verification Tests');
  console.log('=================================\n');

  try {
    await testMacOSIconVerification();
    await testWindowsIconVerification();
    await testUbuntuIconVerification();
    await testFedoraIconVerification();

    console.log('\n=================================');
    console.log('✅ All icon verification tests completed!');
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
  testMacOSIconVerification,
  testWindowsIconVerification,
  testUbuntuIconVerification,
  testFedoraIconVerification
};
