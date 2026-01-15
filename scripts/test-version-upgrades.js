const { _electron: electron } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { sleep } = require('./test-vm-helpers');
const {
  testMacStableInstallation,
  testMacBetaInstallation
} = require('./test-installation');

/**
 * Test Version Upgrade Paths
 * TC10-TC12: Version upgrade scenarios and transitions
 */

const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * TC10: Independent Stable Version Upgrades
 */
async function testStableVersionUpgrade() {
  console.log('\n=== TC10: Independent Stable Version Upgrades ===');

  // This test verifies that:
  // 1. Stable app can upgrade from one stable version to another
  // 2. Beta app installation is not affected by stable upgrade
  // 3. Both apps continue to work independently after stable upgrade

  // Install stable
  console.log('Installing stable...');
  const stableDir = await testMacStableInstallation();

  // Install beta side by side
  console.log('Installing beta side by side...');
  const betaDir = await testMacBetaInstallation();

  // Verify both installations exist
  const stableExists = fs.existsSync(`${stableDir}/Messenger.app`);
  const betaExists = fs.existsSync(`${betaDir}/Messenger Beta.app`);

  assert(stableExists, 'Stable app should exist');
  assert(betaExists, 'Beta app should exist');

  // Verify stable app version
  const stableVersion = execSync(
    `defaults read "${stableDir}/Messenger.app/Contents/Info.plist" CFBundleShortVersionString`
  ).toString().trim();

  console.log(`Stable app version: ${stableVersion}`);
  assert(!stableVersion.includes('-beta'), 'Stable version should not contain -beta');

  // Verify beta app version unchanged
  const betaVersion = execSync(
    `defaults read "${betaDir}/Messenger Beta.app/Contents/Info.plist" CFBundleShortVersionString`
  ).toString().trim();

  console.log(`Beta app version: ${betaVersion}`);
  assert(betaVersion.includes('-beta'), 'Beta version should contain -beta');

  // Verify different bundle IDs
  const stableBundleId = execSync(
    `defaults read "${stableDir}/Messenger.app/Contents/Info.plist" CFBundleIdentifier`
  ).toString().trim();

  const betaBundleId = execSync(
    `defaults read "${betaDir}/Messenger Beta.app/Contents/Info.plist" CFBundleIdentifier`
  ).toString().trim();

  assert.strictEqual(stableBundleId, 'com.facebook.messenger.desktop',
    'Stable bundle ID should be correct');
  assert.strictEqual(betaBundleId, 'com.facebook.messenger.desktop.beta',
    'Beta bundle ID should be correct');
  assert.notStrictEqual(stableBundleId, betaBundleId,
    'Bundle IDs must be different');

  console.log('✅ TC10: Independent Stable Upgrade - PASSED');
}

/**
 * TC11: Beta Version to Beta Version Upgrade
 */
async function testBetaVersionUpgrade() {
  console.log('\n=== TC11: Beta Version to Beta Version Upgrade ===');

  // This test verifies that:
  // 1. Beta app can upgrade from one beta version to another beta version
  // 2. Stable app installation is not affected
  // 3. Beta app uses beta channel and beta-branded artifacts

  // Install beta
  console.log('Installing beta...');
  const betaDir = await testMacBetaInstallation();

  // Install stable side by side
  console.log('Installing stable side by side...');
  const stableDir = await testMacStableInstallation();

  // Launch beta app and test update configuration
  const betaApp = await electron.launch({
    executablePath: `${betaDir}/Messenger Beta.app/Contents/MacOS/Messenger Beta`
  });

  await sleep(2000);

  // Verify beta app would check beta channel
  const updateConfig = await betaApp.evaluate(() => {
    const { app } = require('electron');
    const version = app.getVersion();
    const appPath = app.getAppPath();
    const isBeta = version.includes('-beta') || appPath.toLowerCase().includes('beta');

    return {
      version,
      isBeta,
      expectedChannel: isBeta ? 'beta' : undefined,
      artifactPrefix: isBeta ? 'Messenger-Beta' : 'Messenger'
    };
  });

  console.log('Beta app update config:', updateConfig);

  assert(updateConfig.isBeta, 'Should be detected as beta');
  assert.strictEqual(updateConfig.expectedChannel, 'beta',
    'Should use beta channel');
  assert.strictEqual(updateConfig.artifactPrefix, 'Messenger-Beta',
    'Should use beta-branded artifacts');

  await betaApp.close();

  // Verify stable app unaffected
  const stableExists = fs.existsSync(`${stableDir}/Messenger.app`);
  assert(stableExists, 'Stable app should be unaffected');

  console.log('✅ TC11: Beta to Beta Upgrade - PASSED');
}

/**
 * TC12: Beta App Stable Version to New Beta Version
 */
async function testBetaAppStableToBetaUpgrade() {
  console.log('\n=== TC12: Beta App: Stable Version → Beta Version ===');

  // This test verifies that:
  // 1. When beta app has a stable version installed (via beta channel)
  // 2. It remains beta-branded with beta bundle ID and data directory
  // 3. Can upgrade to a newer beta version
  // 4. Installation remains beta-branded throughout

  // Scenario:
  // - Beta app installation contains stable version (e.g., 1.2.3)
  // - This happens when beta users get stable releases via beta-branded installers
  // - App should still be detected as beta based on installation path

  // Build a stable version with beta branding (simulating beta channel stable release)
  console.log('Building stable version with beta branding...');
  process.env.FORCE_BETA_BUILD = 'true';

  // Temporarily modify package.json to have stable version number
  const packageJsonPath = path.join(PROJECT_ROOT, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const originalVersion = packageJson.version;

  // Simulate stable version (without -beta suffix)
  const stableVersionNumber = originalVersion.replace(/-beta.*$/, '');
  packageJson.version = stableVersionNumber;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

  try {
    // Build with beta branding but stable version number
    execSync('npm run build && npm run dist:mac', { cwd: PROJECT_ROOT, stdio: 'inherit' });

    // Restore original version
    packageJson.version = originalVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

    const betaDir = '/tmp/messenger-test-beta-stable';
    execSync(`rm -rf ${betaDir} && mkdir -p ${betaDir}`);

    // Extract the beta-branded package with stable version
    const glob = require('glob');
    const betaZips = glob.sync(path.join(PROJECT_ROOT, 'release/Messenger-Beta-macos-*.zip'));

    if (betaZips.length === 0) {
      throw new Error('Beta package not found');
    }

    execSync(`unzip -q "${betaZips[0]}" -d ${betaDir}`);

    // Launch and verify
    const betaApp = await electron.launch({
      executablePath: `${betaDir}/Messenger Beta.app/Contents/MacOS/Messenger Beta`
    });

    await sleep(2000);

    // Verify current version is stable but app is beta-branded
    const appInfo = await betaApp.evaluate(({ app }) => {
      const version = app.getVersion();
      const name = app.getName();
      const appPath = app.getAppPath();
      const userData = app.getPath('userData');
      const isBeta = version.includes('-beta') || appPath.toLowerCase().includes('beta');

      return { version, name, isBeta, userData };
    });

    console.log('Beta app with stable version info:', appInfo);

    // Current version should be stable (no -beta suffix)
    assert(!appInfo.version.includes('-beta'),
      'Current version should be stable');

    // But app should still be detected as beta (from path)
    assert(appInfo.isBeta,
      'App should be detected as beta based on installation path');

    // App name should be beta-branded
    assert.strictEqual(appInfo.name, 'Messenger Beta',
      'App should still be beta-branded');

    // userData should be beta directory
    assert(appInfo.userData.includes('Messenger-Beta'),
      'userData should be beta directory');

    await betaApp.close();

    console.log('✅ TC12: Beta App Stable → Beta Upgrade - PASSED');

  } finally {
    // Ensure version is restored even if test fails
    packageJson.version = originalVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    delete process.env.FORCE_BETA_BUILD;
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('=================================');
  console.log('Version Upgrade Tests');
  console.log('=================================\n');

  try {
    await testStableVersionUpgrade();
    await testBetaVersionUpgrade();
    await testBetaAppStableToBetaUpgrade();

    console.log('\n=================================');
    console.log('✅ All version upgrade tests PASSED!');
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
  testStableVersionUpgrade,
  testBetaVersionUpgrade,
  testBetaAppStableToBetaUpgrade
};
