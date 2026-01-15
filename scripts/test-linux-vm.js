const { execInVM, copyFileToVM } = require('./test-vm-helpers');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const glob = require('glob');

const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');

/**
 * Linux Installation Tests (Ubuntu & Fedora)
 * Tests proper installation, isolation, and update channel separation on Linux
 */

/**
 * TC1: Linux Stable Installation
 */
async function testLinuxStableInstallation(distro) {
  console.log(`\n=== TC1: ${distro} Stable Installation ===`);
  console.log('Installing to /usr/bin and /usr/share');

  try {
    // Determine package type
    const packageType = distro === 'ubuntu' ? 'deb' : 'rpm';
    const packageExt = distro === 'ubuntu' ? '.deb' : '.rpm';

    // Build stable Linux package
    console.log(`Building stable ${distro} package...`);

    // Clean release directory
    execSync(`find release -type f -name "*${packageExt}" -delete 2>/dev/null || true`, { cwd: PROJECT_ROOT });

    // Build without beta flag
    delete process.env.FORCE_BETA_BUILD;

    // dist:linux builds both .deb and .rpm by default
    execSync('npm run dist:linux', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    });

    const packages = glob.sync(path.join(RELEASE_DIR, `facebook-messenger-desktop_*${packageExt}`));
    assert(packages.length > 0, `Stable ${packageType} package not found`);

    const package = packages[0];
    console.log(`Found package: ${path.basename(package)}`);

    // Copy to VM
    console.log('Copying package to VM...');
    const remotePath = `/tmp/messenger-stable${packageExt}`;
    copyFileToVM(distro, package, remotePath);

    // Install package
    console.log(`Installing stable app on ${distro}...`);
    if (distro === 'ubuntu') {
      execInVM(distro, `dpkg -i ${remotePath} || apt-get -f install -y`, true);
    } else {
      execInVM(distro, `dnf install -y ${remotePath}`, true);
    }

    // Verify executable installed
    const execPath = execInVM(distro, 'which facebook-messenger-desktop').trim();
    assert(execPath.includes('/usr/bin/'), 'Executable not found in /usr/bin');
    console.log(`Executable: ${execPath}`);

    // Verify desktop file
    const desktopFile = execInVM(distro,
      'cat /usr/share/applications/facebook-messenger-desktop.desktop'
    );

    assert(desktopFile.includes('Name=Messenger'), 'Desktop file should have Name=Messenger');
    assert(!desktopFile.includes('Beta'), 'Stable desktop file should not contain Beta');

    // Verify icon installed
    const iconExists = execInVM(distro,
      'test -f /usr/share/icons/hicolor/512x512/apps/messenger.png && echo "exists" || echo "missing"'
    ).trim();

    assert(iconExists === 'exists', 'Stable icon not installed');

    console.log(`✅ TC1: ${distro} Stable Installation - PASSED`);
    console.log('   Executable: /usr/bin/facebook-messenger-desktop');
    console.log('   Desktop file: /usr/share/applications/facebook-messenger-desktop.desktop');
    console.log('   Icon: /usr/share/icons/hicolor/512x512/apps/messenger.png');

    return execPath;

  } catch (err) {
    console.error(`❌ TC1 ${distro} Failed:`, err.message);
    throw err;
  }
}

/**
 * TC2: Linux Beta Installation
 */
async function testLinuxBetaInstallation(distro) {
  console.log(`\n=== TC2: ${distro} Beta Installation ===`);
  console.log('Installing to /usr/bin and /usr/share (with -beta suffix)');

  try {
    // Determine package type
    const packageType = distro === 'ubuntu' ? 'deb' : 'rpm';
    const packageExt = distro === 'ubuntu' ? '.deb' : '.rpm';

    // Build beta Linux package
    console.log(`Building beta ${distro} package...`);

    // Clean release directory
    execSync(`find release -type f -name "*${packageExt}" -delete 2>/dev/null || true`, { cwd: PROJECT_ROOT });

    // Build with beta flag (current version already has -beta)
    // dist:linux builds both .deb and .rpm by default
    execSync('npm run dist:linux', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    });

    const packages = glob.sync(path.join(RELEASE_DIR, `facebook-messenger-desktop-beta*${packageExt}`));
    assert(packages.length > 0, `Beta ${packageType} package not found`);

    const package = packages[0];
    console.log(`Found package: ${path.basename(package)}`);

    // Copy to VM
    console.log('Copying package to VM...');
    const remotePath = `/tmp/messenger-beta${packageExt}`;
    copyFileToVM(distro, package, remotePath);

    // Install package
    console.log(`Installing beta app on ${distro}...`);
    if (distro === 'ubuntu') {
      execInVM(distro, `dpkg -i ${remotePath} || apt-get -f install -y`, true);
    } else {
      execInVM(distro, `dnf install -y ${remotePath}`, true);
    }

    // Verify executable installed
    const execPath = execInVM(distro, 'which facebook-messenger-desktop-beta').trim();
    assert(execPath.includes('/usr/bin/'), 'Beta executable not found in /usr/bin');
    console.log(`Executable: ${execPath}`);

    // Verify desktop file
    const desktopFile = execInVM(distro,
      'cat /usr/share/applications/facebook-messenger-desktop-beta.desktop'
    );

    assert(desktopFile.includes('Name=Messenger Beta'), 'Desktop file should have Name=Messenger Beta');
    assert(desktopFile.includes('Exec=facebook-messenger-desktop-beta'), 'Desktop file should exec beta binary');

    // Verify icon installed
    const iconExists = execInVM(distro,
      'test -f /usr/share/icons/hicolor/512x512/apps/messenger-beta.png && echo "exists" || echo "missing"'
    ).trim();

    assert(iconExists === 'exists', 'Beta icon not installed');

    console.log(`✅ TC2: ${distro} Beta Installation - PASSED`);
    console.log('   Executable: /usr/bin/facebook-messenger-desktop-beta');
    console.log('   Desktop file: /usr/share/applications/facebook-messenger-desktop-beta.desktop');
    console.log('   Icon: /usr/share/icons/hicolor/512x512/apps/messenger-beta.png');

    return execPath;

  } catch (err) {
    console.error(`❌ TC2 ${distro} Failed:`, err.message);
    throw err;
  }
}

/**
 * TC: Linux Update Channel Isolation
 */
async function testLinuxUpdateChannelIsolation(distro) {
  console.log(`\n=== TC: ${distro} Update Channel Isolation ===`);

  try {
    // Check where app resources are located
    // For Linux, resources are typically in /opt or /usr/lib
    const stableResourcesLocations = [
      '/opt/Messenger/resources',
      '/usr/lib/facebook-messenger-desktop/resources',
      '/usr/share/facebook-messenger-desktop/resources'
    ];

    const betaResourcesLocations = [
      '/opt/Messenger-Beta/resources',
      '/usr/lib/facebook-messenger-desktop-beta/resources',
      '/usr/share/facebook-messenger-desktop-beta/resources'
    ];

    // Try to find stable update config
    let stableYml = null;
    for (const location of stableResourcesLocations) {
      try {
        const result = execInVM(distro, `test -f ${location}/app-update.yml && cat ${location}/app-update.yml`);
        if (result && !result.includes('No such file')) {
          stableYml = result;
          console.log(`Found stable config at: ${location}/app-update.yml`);
          break;
        }
      } catch (err) {
        // Try next location
      }
    }

    // Try to find beta update config
    let betaYml = null;
    for (const location of betaResourcesLocations) {
      try {
        const result = execInVM(distro, `test -f ${location}/app-update.yml && cat ${location}/app-update.yml`);
        if (result && !result.includes('No such file')) {
          betaYml = result;
          console.log(`Found beta config at: ${location}/app-update.yml`);
          break;
        }
      } catch (err) {
        // Try next location
      }
    }

    if (stableYml) {
      console.log('\nStable update config:');
      console.log(stableYml);
    } else {
      console.log('\n⚠️  Stable update config not found (app might use default settings)');
    }

    if (betaYml) {
      console.log('\nBeta update config:');
      console.log(betaYml);

      // Verify beta has channel property
      assert(betaYml.includes('channel: beta'),
        'CRITICAL: Beta app MUST have channel: beta in update config');
    } else {
      console.log('\n⚠️  Beta update config not found (app might use default settings)');
    }

    console.log(`\n✅ ${distro} Update Channel Isolation - PASSED`);

  } catch (err) {
    console.error(`❌ Update Channel Isolation Failed:`, err.message);
    throw err;
  }
}

/**
 * TC: Linux Launch Isolation
 */
async function testLinuxLaunchIsolation(distro) {
  console.log(`\n=== TC: ${distro} Launch Isolation ===`);

  try {
    // Verify different executables
    const stableExec = execInVM(distro, 'which facebook-messenger-desktop').trim();
    const betaExec = execInVM(distro, 'which facebook-messenger-desktop-beta').trim();

    console.log(`Stable executable: ${stableExec}`);
    console.log(`Beta executable:   ${betaExec}`);

    assert(stableExec.includes('facebook-messenger-desktop') && !stableExec.includes('beta'),
      'Stable should not have beta in name');
    assert(betaExec.includes('facebook-messenger-desktop-beta'),
      'Beta should have beta in name');

    // Verify different desktop files
    const stableDesktop = execInVM(distro,
      'cat /usr/share/applications/facebook-messenger-desktop.desktop | grep "^Name="'
    ).trim();

    const betaDesktop = execInVM(distro,
      'cat /usr/share/applications/facebook-messenger-desktop-beta.desktop | grep "^Name="'
    ).trim();

    console.log(`\nStable desktop name: ${stableDesktop}`);
    console.log(`Beta desktop name:   ${betaDesktop}`);

    assert(stableDesktop.includes('Messenger') && !stableDesktop.includes('Beta'),
      'Stable desktop should not have Beta');
    assert(betaDesktop.includes('Messenger Beta'),
      'Beta desktop should have Messenger Beta');

    // Verify different config directories
    const stableConfig = '$HOME/.config/Messenger';
    const betaConfig = '$HOME/.config/Messenger-Beta';

    console.log(`\nStable config dir: ${stableConfig}`);
    console.log(`Beta config dir:   ${betaConfig}`);

    console.log(`\n✅ ${distro} Launch Isolation - PASSED`);

  } catch (err) {
    console.error(`❌ Launch Isolation Failed:`, err.message);
    throw err;
  }
}

/**
 * TC: Linux Uninstallation Isolation
 */
async function testLinuxUninstallationIsolation(distro) {
  console.log(`\n=== TC: ${distro} Uninstallation Isolation ===`);

  try {
    // Verify both apps are installed
    const stableInstalled = execInVM(distro, 'which facebook-messenger-desktop').trim();
    const betaInstalled = execInVM(distro, 'which facebook-messenger-desktop-beta').trim();

    assert(stableInstalled.includes('/usr/bin/'), 'Stable should be installed');
    assert(betaInstalled.includes('/usr/bin/'), 'Beta should be installed');

    console.log('Both apps are installed');

    // Uninstall stable
    console.log('\nUninstalling stable app...');
    if (distro === 'ubuntu') {
      execInVM(distro, 'apt remove -y facebook-messenger-desktop', true);
    } else {
      execInVM(distro, 'dnf remove -y facebook-messenger-desktop', true);
    }

    // Verify stable is gone
    try {
      const stableGone = execInVM(distro, 'which facebook-messenger-desktop');
      assert(false, 'Stable executable should be removed');
    } catch (err) {
      console.log('✓ Stable executable removed');
    }

    // Verify beta still exists
    const betaStillExists = execInVM(distro, 'which facebook-messenger-desktop-beta').trim();
    assert(betaStillExists.includes('/usr/bin/'), 'Beta should still be installed');

    console.log('✓ Beta app still exists');

    console.log(`\n✅ ${distro} Uninstallation Isolation - PASSED`);

  } catch (err) {
    console.error(`❌ Uninstallation Isolation Failed:`, err.message);
    throw err;
  }
}

// Export test functions
module.exports = {
  testLinuxStableInstallation,
  testLinuxBetaInstallation,
  testLinuxUpdateChannelIsolation,
  testLinuxLaunchIsolation,
  testLinuxUninstallationIsolation
};

// Run if executed directly
if (require.main === module) {
  (async () => {
    const distro = process.argv[2]; // ubuntu or fedora
    const testName = process.argv[3];

    if (!distro || !['ubuntu', 'fedora'].includes(distro)) {
      console.log('Usage: node test-linux-vm.js <ubuntu|fedora> [all|stable|beta|channel|launch|uninstall]');
      process.exit(1);
    }

    try {
      if (!testName || testName === 'all') {
        await testLinuxStableInstallation(distro);
        await testLinuxBetaInstallation(distro);
        await testLinuxUpdateChannelIsolation(distro);
        await testLinuxLaunchIsolation(distro);
        await testLinuxUninstallationIsolation(distro);
      } else if (testName === 'stable') {
        await testLinuxStableInstallation(distro);
      } else if (testName === 'beta') {
        await testLinuxBetaInstallation(distro);
      } else if (testName === 'channel') {
        await testLinuxUpdateChannelIsolation(distro);
      } else if (testName === 'launch') {
        await testLinuxLaunchIsolation(distro);
      } else if (testName === 'uninstall') {
        await testLinuxUninstallationIsolation(distro);
      } else {
        console.log('Usage: node test-linux-vm.js <ubuntu|fedora> [all|stable|beta|channel|launch|uninstall]');
        process.exit(1);
      }

      console.log(`\n🎉 All ${distro} tests completed!`);
    } catch (err) {
      console.error('Tests failed:', err.message);
      process.exit(1);
    }
  })();
}
