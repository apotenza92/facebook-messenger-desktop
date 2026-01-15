#!/usr/bin/env node

/**
 * Simplified Ubuntu testing using pre-built .deb packages
 * Tests installation and basic isolation without rebuilding
 */

const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const { execInVM, copyFileToVM, testVMConnection } = require('./test-vm-helpers');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  Ubuntu Installation Test (Pre-built Packages)  ║');
console.log('╚══════════════════════════════════════════════════╝\n');

async function resumeVM() {
  console.log('Resuming Ubuntu VM...');
  try {
    execSync('prlctl resume "Ubuntu 24.04.3"', { encoding: 'utf8' });
    console.log('VM resumed successfully');

    // Wait for VM to be ready
    console.log('Waiting for VM to be ready...');
    await new Promise(resolve => setTimeout(resolve, 10000));
  } catch (error) {
    console.log('VM might already be running');
  }
}

async function testUbuntuBetaInstallation() {
  console.log('\n=== TC1: Ubuntu Beta Installation (.deb) ===\n');

  // Find the beta .deb package
  const debFile = path.join(RELEASE_DIR, 'facebook-messenger-desktop-beta-arm64.deb');
  console.log(`Using beta package: ${debFile}`);

  // Copy to VM
  console.log('Copying .deb package to Ubuntu VM...');
  copyFileToVM('ubuntu', debFile, '/tmp/messenger-beta.deb');

  // Uninstall any existing installations
  console.log('Cleaning up any existing installations...');
  try {
    execInVM('ubuntu', 'dpkg -r facebook-messenger-desktop-beta 2>/dev/null || true');
    execInVM('ubuntu', 'dpkg -r facebook-messenger-desktop 2>/dev/null || true');
  } catch (e) {
    // Ignore errors from packages not being installed
  }

  // Install beta package
  console.log('Installing beta .deb package...');
  execInVM('ubuntu', 'dpkg -i /tmp/messenger-beta.deb || true');

  // Fix dependencies if needed
  console.log('Installing any missing dependencies...');
  execInVM('ubuntu', 'apt-get install -f -y');
  console.log('✅ Beta package installed successfully');

  // Verify installation
  console.log('\nVerifying beta installation...');

  // Check binary exists
  const binaryPath = '/usr/bin/facebook-messenger-desktop-beta';
  const binaryExists = execInVM('ubuntu', `test -f ${binaryPath} && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(binaryExists, 'exists', `Beta binary should exist at ${binaryPath}`);
  console.log(`✅ Beta binary exists: ${binaryPath}`);

  // Check desktop file
  const desktopFile = '/usr/share/applications/facebook-messenger-desktop-beta.desktop';
  const desktopExists = execInVM('ubuntu', `test -f ${desktopFile} && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(desktopExists, 'exists', `Beta desktop file should exist at ${desktopFile}`);
  console.log(`✅ Beta desktop file exists: ${desktopFile}`);

  // Check app installation directory
  const appDir = '/opt/Messenger Beta';
  const appDirExists = execInVM('ubuntu', `test -d "${appDir}" && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(appDirExists, 'exists', `Beta app directory should exist at ${appDir}`);
  console.log(`✅ Beta app directory exists: ${appDir}`);

  // CRITICAL: Check update channel in app-update.yml
  console.log('\nChecking update channel configuration...');
  const updateYml = execInVM('ubuntu', `cat "${appDir}/resources/app-update.yml"`);
  console.log('app-update.yml contents:');
  console.log(updateYml);

  assert(updateYml.includes('channel: beta'), 'CRITICAL: Beta app MUST have channel: beta in update config');
  console.log('✅ CRITICAL: Beta app has correct update channel isolation!');

  console.log('\n✅ TC1: Ubuntu Beta Installation PASSED\n');
}

async function downloadAndTestStable() {
  console.log('\n=== TC2: Ubuntu Stable Installation (.deb) ===\n');

  // Download stable v1.2.2 release
  console.log('Downloading stable v1.2.2 release from GitHub...');
  const tempDir = '/tmp/messenger-stable-test';
  execSync(`rm -rf ${tempDir} && mkdir -p ${tempDir}`, { encoding: 'utf8' });

  try {
    execSync(`gh release download v1.2.2 --repo apotenza92/facebook-messenger-desktop --pattern "*arm64.deb" --dir ${tempDir} --clobber`, {
      encoding: 'utf8',
      stdio: 'inherit'
    });
  } catch (error) {
    console.log('Failed to download stable release. Checking what files are available...');
    const files = execSync(`gh release view v1.2.2 --repo apotenza92/facebook-messenger-desktop --json assets --jq '.assets[].name'`, { encoding: 'utf8' });
    console.log('Available files:\n', files);
    throw error;
  }

  const stableDebFile = execSync(`ls ${tempDir}/*.deb`, { encoding: 'utf8' }).trim();
  console.log(`Using stable package: ${stableDebFile}`);

  // Copy to VM
  console.log('Copying stable .deb package to Ubuntu VM...');
  copyFileToVM('ubuntu', stableDebFile, '/tmp/messenger-stable.deb');

  // Install stable package (beta should already be installed)
  console.log('Installing stable .deb package alongside beta...');
  execInVM('ubuntu', 'dpkg -i /tmp/messenger-stable.deb || true');

  // Fix dependencies if needed
  console.log('Installing any missing dependencies...');
  execInVM('ubuntu', 'apt-get install -f -y');
  console.log('✅ Stable package installed successfully');

  // Verify both are installed
  console.log('\nVerifying coexistence...');

  // Check stable binary
  const stableBinaryPath = '/usr/bin/facebook-messenger-desktop';
  const stableBinaryExists = execInVM('ubuntu', `test -f ${stableBinaryPath} && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(stableBinaryExists, 'exists', `Stable binary should exist at ${stableBinaryPath}`);
  console.log(`✅ Stable binary exists: ${stableBinaryPath}`);

  // Check beta binary still exists
  const betaBinaryPath = '/usr/bin/facebook-messenger-desktop-beta';
  const betaBinaryExists = execInVM('ubuntu', `test -f ${betaBinaryPath} && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(betaBinaryExists, 'exists', `Beta binary should still exist at ${betaBinaryPath}`);
  console.log(`✅ Beta binary still exists: ${betaBinaryPath}`);

  // Check stable app directory
  const stableAppDir = '/opt/Messenger';
  const stableAppDirExists = execInVM('ubuntu', `test -d "${stableAppDir}" && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(stableAppDirExists, 'exists', `Stable app directory should exist at ${stableAppDir}`);
  console.log(`✅ Stable app directory exists: ${stableAppDir}`);

  // Check beta app directory still exists
  const betaAppDir = '/opt/Messenger Beta';
  const betaAppDirExists = execInVM('ubuntu', `test -d "${betaAppDir}" && echo "exists" || echo "missing"`).trim();
  assert.strictEqual(betaAppDirExists, 'exists', `Beta app directory should still exist at ${betaAppDir}`);
  console.log(`✅ Beta app directory still exists: ${betaAppDir}`);

  // Check stable update configuration
  console.log('\nChecking stable update channel configuration...');
  const stableUpdateYml = execInVM('ubuntu', `cat "${stableAppDir}/resources/app-update.yml"`);
  console.log('Stable app-update.yml contents:');
  console.log(stableUpdateYml);

  assert(!stableUpdateYml.includes('channel: beta'), 'Stable app should NOT have channel: beta');
  console.log('✅ Stable app has correct update channel (default/stable)');

  console.log('\n✅ TC2: Ubuntu Stable Installation and Coexistence PASSED\n');

  // Cleanup
  execSync(`rm -rf ${tempDir}`, { encoding: 'utf8' });
}

async function main() {
  try {
    // Test VM connectivity
    console.log('Testing Ubuntu VM connectivity...');
    await testVMConnection('ubuntu');
    console.log('✅ Ubuntu VM is reachable\n');

    // Run tests
    await testUbuntuBetaInstallation();
    await downloadAndTestStable();

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  ✅ ALL UBUNTU TESTS PASSED!            ║');
    console.log('╚══════════════════════════════════════════╝\n');

    console.log('Summary:');
    console.log('  ✅ Beta installation verified');
    console.log('  ✅ Stable installation verified');
    console.log('  ✅ Beta/Stable coexistence confirmed');
    console.log('  ✅ Update channel isolation verified');
    console.log('  ✅ Separate binaries and directories confirmed');

  } catch (error) {
    console.error('\n❌ Ubuntu tests FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
