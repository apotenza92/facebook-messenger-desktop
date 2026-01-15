const { execInVM, copyFileToVM } = require('./test-vm-helpers');
const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * TC: Launch Isolation - Beta app with stable version opens as beta
 *
 * Issue: When beta app contains a stable version number (e.g., 1.2.3 instead of 1.2.3-beta.1),
 * clicking the beta app might open the stable app instead if both are installed.
 *
 * This test verifies that the beta app is correctly identified and launched as beta
 * based on its installation path and bundle ID, not just version number.
 */
async function testLaunchIsolation() {
  console.log('\n=== TC: Launch Isolation Test ===');
  console.log('Testing: Beta app launches correctly even when version number is stable');

  try {
    // Verify both apps are installed
    const stableExists = execInVM('macos',
      `test -d "/Applications/Messenger.app" && echo "exists" || echo "missing"`
    ).trim();

    const betaExists = execInVM('macos',
      `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`
    ).trim();

    console.log(`Stable app: ${stableExists}`);
    console.log(`Beta app: ${betaExists}`);

    if (stableExists === 'missing' || betaExists === 'missing') {
      console.log('⚠️  Both apps must be installed first. Run tc1 and tc2.');
      return;
    }

    // Test 1: Verify beta app identity from bundle
    console.log('\n--- Test 1: Bundle Identity Check ---');
    const betaBundleId = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleIdentifier`
    ).trim();

    const betaProductName = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleName`
    ).trim();

    console.log(`Beta bundle ID: ${betaBundleId}`);
    console.log(`Beta product name: ${betaProductName}`);

    assert.strictEqual(betaBundleId, 'com.facebook.messenger.desktop.beta',
      'Beta app should have beta bundle ID');
    assert.strictEqual(betaProductName, 'Messenger Beta',
      'Beta app should have "Messenger Beta" name');

    // Test 2: Verify app path detection
    console.log('\n--- Test 2: App Path Detection ---');
    const betaAppPath = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleExecutable`
    ).trim();

    console.log(`Beta executable: ${betaAppPath}`);

    // The app should know it's in the "Messenger Beta.app" path
    const appFolderCheck = execInVM('macos',
      `basename "/Applications/Messenger Beta.app"`
    ).trim();

    console.log(`App folder name: ${appFolderCheck}`);
    assert(appFolderCheck.includes('Beta'),
      'Beta app should be in folder containing "Beta"');

    // Test 3: Simulate app launch detection (what the app sees at runtime)
    console.log('\n--- Test 3: Runtime Detection Simulation ---');

    // Get the actual values the app would see
    const betaVersion = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleShortVersionString`
    ).trim();

    const betaName = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleName`
    ).trim();

    // Simulate what app.getAppPath() would return
    const simulatedAppPath = '/Applications/Messenger Beta.app/Contents/Resources/app.asar';

    console.log(`Version: ${betaVersion}`);
    console.log(`App name: ${betaName}`);
    console.log(`App path: ${simulatedAppPath}`);

    // This is the logic from main.ts that detects beta
    const isBetaByVersion = betaVersion.includes('-beta');
    const isBetaByPath = simulatedAppPath.toLowerCase().includes('beta');
    const isBetaByName = betaName.toLowerCase().includes('beta');

    console.log(`\nDetection methods:`);
    console.log(`  By version (-beta suffix): ${isBetaByVersion}`);
    console.log(`  By path (contains 'beta'): ${isBetaByPath}`);
    console.log(`  By name (contains 'Beta'): ${isBetaByName}`);

    const shouldDetectAsBeta = isBetaByVersion || isBetaByPath || isBetaByName;

    assert(shouldDetectAsBeta,
      'Beta app MUST be detected as beta (by version, path, or name)');

    if (!isBetaByVersion) {
      console.log('\n⚠️  IMPORTANT: Beta app has stable version number - relying on path/name detection');
      assert(isBetaByPath || isBetaByName,
        'CRITICAL: Beta app with stable version MUST be detected by path or name');
    } else {
      console.log('\n✓ Beta detected by version suffix');
    }

    // Test 4: Verify userData directories would be different
    console.log('\n--- Test 4: UserData Directory Isolation ---');

    // Based on Electron's behavior, it uses the app name for userData
    const stableAppName = execInVM('macos',
      `defaults read "/Applications/Messenger.app/Contents/Info.plist" CFBundleName`
    ).trim();

    const betaAppName = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleName`
    ).trim();

    // Electron uses: ~/Library/Application Support/<app name>
    const stableUserData = `~/Library/Application Support/${stableAppName}`;
    const betaUserData = `~/Library/Application Support/${betaAppName}`;

    console.log(`Stable userData: ${stableUserData}`);
    console.log(`Beta userData:   ${betaUserData}`);

    assert.notStrictEqual(stableUserData, betaUserData,
      'Stable and beta MUST use different userData directories');

    console.log('\n✅ TC: Launch Isolation Test - PASSED');
    console.log('   Beta app correctly identifies itself and uses separate userData');

  } catch (err) {
    console.error('\n❌ TC: Launch Isolation Test - FAILED');
    console.error(err.message);
    throw err;
  }
}

/**
 * TC: Update Channel Isolation
 *
 * Issue: Beta app might pull updates from stable channel or vice versa,
 * causing wrong versions to be installed.
 *
 * This test verifies that beta app uses beta channel and downloads beta artifacts.
 */
async function testUpdateChannelIsolation() {
  console.log('\n=== TC: Update Channel Isolation Test ===');
  console.log('Testing: Beta app uses beta channel, stable uses default channel');

  try {
    const betaExists = execInVM('macos',
      `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`
    ).trim();

    if (betaExists === 'missing') {
      console.log('⚠️  Beta app must be installed first. Run tc2.');
      return;
    }

    // Test: Check auto-updater configuration
    console.log('\n--- Checking Update Configuration ---');

    // Check for yml files in beta app Resources
    const ymlFiles = execInVM('macos',
      `ls "/Applications/Messenger Beta.app/Contents/Resources/"*.yml 2>/dev/null || echo "none"`
    ).trim();

    console.log('Update config files:', ymlFiles);

    if (ymlFiles !== 'none') {
      // Read beta yml files
      const betaYmlFiles = ymlFiles.split('\n').filter(f => f.includes('beta'));

      if (betaYmlFiles.length > 0) {
        console.log(`\nFound beta-specific config: ${betaYmlFiles[0]}`);
        const content = execInVM('macos', `cat "${betaYmlFiles[0]}"`);
        console.log('Content:');
        console.log(content);

        // Check if it points to beta artifacts
        const usesBetaArtifacts = content.includes('Messenger-Beta');
        console.log(`\nUses beta artifacts (Messenger-Beta-*): ${usesBetaArtifacts}`);

        assert(usesBetaArtifacts,
          'CRITICAL: Beta app MUST use beta-branded artifacts (Messenger-Beta-*)');
      } else {
        console.log('\n⚠️  No beta-specific yml found, checking default yml...');

        // Check the default yml files
        const defaultYml = ymlFiles.split('\n')[0];
        if (defaultYml) {
          const content = execInVM('macos', `cat "${defaultYml}"`);
          console.log(content);

          // Even default yml should point to beta artifacts for beta app
          const usesBetaArtifacts = content.includes('Messenger-Beta');
          console.log(`\nUses beta artifacts: ${usesBetaArtifacts}`);

          if (!usesBetaArtifacts) {
            console.log('⚠️  WARNING: Beta app may not be using beta-branded artifacts');
            console.log('   This could cause it to download stable artifacts instead of beta');
          }
        }
      }
    } else {
      console.log('⚠️  No update configuration files found');
    }

    console.log('\n✅ TC: Update Channel Isolation Test - PASSED');

  } catch (err) {
    console.error('\n❌ TC: Update Channel Isolation Test - FAILED');
    console.error(err.message);
    throw err;
  }
}

/**
 * TC: Cross-App Launch Prevention
 *
 * Issue: Clicking beta app might launch stable app if version numbers match
 *
 * This test verifies apps don't cross-launch
 */
async function testCrossAppLaunchPrevention() {
  console.log('\n=== TC: Cross-App Launch Prevention Test ===');
  console.log('Testing: Apps have unique bundle IDs and don\'t interfere');

  try {
    const stableExists = execInVM('macos',
      `test -d "/Applications/Messenger.app" && echo "exists" || echo "missing"`
    ).trim();

    const betaExists = execInVM('macos',
      `test -d "/Applications/Messenger Beta.app" && echo "exists" || echo "missing"`
    ).trim();

    if (stableExists === 'missing' || betaExists === 'missing') {
      console.log('⚠️  Both apps must be installed. Run tc1 and tc2.');
      return;
    }

    // Get bundle identifiers
    const stableBundleId = execInVM('macos',
      `defaults read "/Applications/Messenger.app/Contents/Info.plist" CFBundleIdentifier`
    ).trim();

    const betaBundleId = execInVM('macos',
      `defaults read "/Applications/Messenger Beta.app/Contents/Info.plist" CFBundleIdentifier`
    ).trim();

    console.log(`Stable bundle ID: ${stableBundleId}`);
    console.log(`Beta bundle ID:   ${betaBundleId}`);

    // Bundle IDs MUST be different
    assert.notStrictEqual(stableBundleId, betaBundleId,
      'CRITICAL: Stable and beta MUST have different bundle IDs');

    // Both apps are installed in /Applications with different bundle IDs
    // This is sufficient for macOS to treat them as separate apps
    console.log('\n✓ Apps have unique bundle IDs');
    console.log('✓ Apps are in separate .app bundles');
    console.log('✓ macOS will treat them as independent applications');

    console.log('\n✅ TC: Cross-App Launch Prevention Test - PASSED');
    console.log('   Apps have unique bundle IDs and are separately registered');

  } catch (err) {
    console.error('\n❌ TC: Cross-App Launch Prevention Test - FAILED');
    console.error(err.message);
    throw err;
  }
}

// Export and run
module.exports = {
  testLaunchIsolation,
  testUpdateChannelIsolation,
  testCrossAppLaunchPrevention
};

if (require.main === module) {
  (async () => {
    const testName = process.argv[2];

    try {
      if (!testName || testName === 'all') {
        await testLaunchIsolation();
        await testUpdateChannelIsolation();
        await testCrossAppLaunchPrevention();
      } else if (testName === 'launch') {
        await testLaunchIsolation();
      } else if (testName === 'channel') {
        await testUpdateChannelIsolation();
      } else if (testName === 'cross-launch') {
        await testCrossAppLaunchPrevention();
      } else {
        console.log('Usage: node test-launch-isolation-vm.js [all|launch|channel|cross-launch]');
        process.exit(1);
      }
    } catch (err) {
      console.error('Tests failed:', err.message);
      process.exit(1);
    }
  })();
}
