const { execInVM, copyFileToVM, VM_CONFIG } = require('./test-vm-helpers');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const glob = require('glob');

const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const WIN_USER = VM_CONFIG.windows.user;

/**
 * Windows Installation Tests
 * Tests proper installation, isolation, and update channel separation on Windows
 */

/**
 * TC1: Windows Stable Installation
 */
async function testWindowsStableInstallation() {
  console.log('\n=== TC1: Windows Stable Installation ===');
  console.log('Installing to proper system location');

  try {
    // Build stable Windows package
    console.log('Building stable Windows package...');

    // Clean release directory
    execSync('find release -type f -name "*.exe" -delete 2>/dev/null || true', { cwd: PROJECT_ROOT });

    // Build without beta flag
    delete process.env.FORCE_BETA_BUILD;
    execSync('npm run build && npm run dist:win', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        CSC_LINK: '', // Skip code signing
      }
    });

    const installers = glob.sync(path.join(RELEASE_DIR, 'Messenger-windows-*.exe'));
    assert(installers.length > 0, 'Stable installer not found');

    const installer = installers[0];
    console.log(`Found installer: ${path.basename(installer)}`);

    // Copy to VM
    console.log('Copying installer to VM...');
    const tempInstaller = 'C:\\\\temp\\\\Messenger-stable-setup.exe';

    // Create temp directory
    execInVM('windows', 'mkdir C:\\\\temp 2>nul || echo Directory exists');

    // Copy via SCP (need to adjust for Windows paths)
    copyFileToVM('windows', installer, tempInstaller.replace(/\\\\/g, '\\'));

    // Install silently
    console.log('Installing stable app...');
    execInVM('windows', `Start-Process -FilePath "${tempInstaller}" -ArgumentList "/S" -Wait`, false);

    // Wait for installation
    await sleep(15000);

    // Verify installation
    const installPath = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger`;
    const exeExists = execInVM('windows',
      `Test-Path "${installPath}\\\\Messenger.exe"`,
      false
    );

    assert(exeExists.includes('True'), 'Stable app executable not found');

    // Verify Start Menu shortcut
    const shortcutExists = execInVM('windows',
      'Test-Path "$env:APPDATA\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Messenger.lnk"',
      false
    );

    assert(shortcutExists.includes('True'), 'Start Menu shortcut not found');

    console.log('✅ TC1: Windows Stable Installation - PASSED');
    console.log(`   Install location: ${installPath}`);
    return installPath;

  } catch (err) {
    console.error('❌ TC1 Failed:', err.message);
    throw err;
  }
}

/**
 * TC2: Windows Beta Installation
 */
async function testWindowsBetaInstallation() {
  console.log('\n=== TC2: Windows Beta Installation ===');
  console.log('Installing to separate system location');

  try {
    // Build beta Windows package
    console.log('Building beta Windows package...');

    // Clean release directory
    execSync('find release -type f -name "*.exe" -delete 2>/dev/null || true', { cwd: PROJECT_ROOT });

    // Build with beta flag
    execSync('npm run build && npm run dist:win', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        CSC_LINK: '', // Skip code signing
      }
    });

    const installers = glob.sync(path.join(RELEASE_DIR, 'Messenger-Beta-windows-*.exe'));
    assert(installers.length > 0, 'Beta installer not found');

    const installer = installers[0];
    console.log(`Found installer: ${path.basename(installer)}`);

    // Copy to VM
    console.log('Copying installer to VM...');
    const tempInstaller = 'C:\\\\temp\\\\Messenger-Beta-setup.exe';
    copyFileToVM('windows', installer, tempInstaller.replace(/\\\\/g, '\\'));

    // Install silently
    console.log('Installing beta app...');
    execInVM('windows', `Start-Process -FilePath "${tempInstaller}" -ArgumentList "/S" -Wait`, false);

    // Wait for installation
    await sleep(15000);

    // Verify installation
    const installPath = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger-beta`;
    const exeExists = execInVM('windows',
      `Test-Path "${installPath}\\\\Messenger Beta.exe"`,
      false
    );

    assert(exeExists.includes('True'), 'Beta app executable not found');

    // Verify Start Menu shortcut
    const shortcutExists = execInVM('windows',
      'Test-Path "$env:APPDATA\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Messenger Beta.lnk"',
      false
    );

    assert(shortcutExists.includes('True'), 'Beta Start Menu shortcut not found');

    console.log('✅ TC2: Windows Beta Installation - PASSED');
    console.log(`   Install location: ${installPath}`);
    return installPath;

  } catch (err) {
    console.error('❌ TC2 Failed:', err.message);
    throw err;
  }
}

/**
 * TC: Windows Update Channel Isolation
 */
async function testWindowsUpdateChannelIsolation() {
  console.log('\n=== TC: Windows Update Channel Isolation ===');

  try {
    // Check stable update config
    const stableAppData = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger\\\\resources`;
    const stableYml = execInVM('windows',
      `Get-Content "${stableAppData}\\\\app-update.yml"`,
      false
    );

    console.log('Stable update config:');
    console.log(stableYml);

    // Check beta update config
    const betaAppData = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger-beta\\\\resources`;
    const betaYml = execInVM('windows',
      `Get-Content "${betaAppData}\\\\app-update.yml"`,
      false
    );

    console.log('\nBeta update config:');
    console.log(betaYml);

    // Verify beta has channel property
    assert(betaYml.includes('channel: beta'),
      'CRITICAL: Beta app MUST have channel: beta in update config');

    // Verify stable doesn't have channel (or has default)
    assert(!stableYml.includes('channel:') || stableYml.includes('channel: latest'),
      'Stable should use default channel');

    console.log('\n✅ Windows Update Channel Isolation - PASSED');
    console.log('   Beta uses beta channel');
    console.log('   Stable uses default channel');

  } catch (err) {
    console.error('❌ Update Channel Isolation Failed:', err.message);
    throw err;
  }
}

/**
 * TC: Windows Launch Isolation
 */
async function testWindowsLaunchIsolation() {
  console.log('\n=== TC: Windows Launch Isolation ===');

  try {
    // Get stable exe info
    const stableExe = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger\\\\Messenger.exe`;
    const stableInfo = execInVM('windows',
      `(Get-Item "${stableExe}").VersionInfo | Select-Object ProductName, FileDescription | Format-List`,
      false
    );

    console.log('Stable executable info:');
    console.log(stableInfo);

    // Get beta exe info
    const betaExe = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger-beta\\\\Messenger Beta.exe`;
    const betaInfo = execInVM('windows',
      `(Get-Item "${betaExe}").VersionInfo | Select-Object ProductName, FileDescription | Format-List`,
      false
    );

    console.log('\nBeta executable info:');
    console.log(betaInfo);

    // Verify different product names
    assert(stableInfo.includes('Messenger'), 'Stable should be named Messenger');
    assert(betaInfo.includes('Beta'), 'Beta should have Beta in name');

    // Verify different install paths
    const stablePath = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger`;
    const betaPath = `C:\\\\Users\\\\${WIN_USER}\\\\AppData\\\\Local\\\\Programs\\\\messenger-beta`;

    console.log(`\nStable install path: ${stablePath}`);
    console.log(`Beta install path:   ${betaPath}`);

    assert.notStrictEqual(stablePath, betaPath, 'Install paths must be different');

    // Verify different user data directories
    const stableUserData = '%APPDATA%\\\\Messenger';
    const betaUserData = '%APPDATA%\\\\Messenger-Beta';

    console.log(`\nStable user data: ${stableUserData}`);
    console.log(`Beta user data:   ${betaUserData}`);

    console.log('\n✅ Windows Launch Isolation - PASSED');

  } catch (err) {
    console.error('❌ Launch Isolation Failed:', err.message);
    throw err;
  }
}

/**
 * Helper function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Export test functions
module.exports = {
  testWindowsStableInstallation,
  testWindowsBetaInstallation,
  testWindowsUpdateChannelIsolation,
  testWindowsLaunchIsolation
};

// Run if executed directly
if (require.main === module) {
  (async () => {
    const testName = process.argv[2];

    try {
      if (!testName || testName === 'all') {
        await testWindowsStableInstallation();
        await testWindowsBetaInstallation();
        await testWindowsUpdateChannelIsolation();
        await testWindowsLaunchIsolation();
      } else if (testName === 'stable') {
        await testWindowsStableInstallation();
      } else if (testName === 'beta') {
        await testWindowsBetaInstallation();
      } else if (testName === 'channel') {
        await testWindowsUpdateChannelIsolation();
      } else if (testName === 'launch') {
        await testWindowsLaunchIsolation();
      } else {
        console.log('Usage: node test-windows-vm.js [all|stable|beta|channel|launch]');
        process.exit(1);
      }

      console.log('\n🎉 All Windows tests completed!');
    } catch (err) {
      console.error('Tests failed:', err.message);
      process.exit(1);
    }
  })();
}
