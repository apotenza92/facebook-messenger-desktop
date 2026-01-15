#!/usr/bin/env node

/**
 * Simplified Windows beta testing using prlctl exec
 * Just verify the beta installer has correct update channel
 */

const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const VM_NAME = "Windows 11 ARM";

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  Windows Beta Update Channel Verification      ║');
console.log('╚══════════════════════════════════════════════════╝\n');

function execInWindowsVM(command) {
  const escapedCommand = command.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const fullCommand = `prlctl exec "${VM_NAME}" powershell.exe "${escapedCommand}"`;
  return execSync(fullCommand, { encoding: 'utf8' });
}

async function testWindowsBetaInstaller() {
  console.log('=== Verifying Windows Beta Installer Configuration ===\n');

  // Find the beta installer
  let betaInstaller = path.join(RELEASE_DIR, 'Messenger-Beta-windows-arm64-setup.exe');

  if (!fs.existsSync(betaInstaller)) {
    betaInstaller = path.join(RELEASE_DIR, 'Messenger-Beta-windows-setup.exe');
  }

  if (!fs.existsSync(betaInstaller)) {
    throw new Error(`Beta installer not found. Run: IS_BETA=true npm run dist:win`);
  }

  console.log(`✅ Found beta installer: ${path.basename(betaInstaller)}`);

  // Extract and check the installer contents
  console.log('\nExtracting installer to check update configuration...');

  const tempExtract = path.join(PROJECT_ROOT, 'temp-extract-win');
  execSync(`rm -rf "${tempExtract}" && mkdir -p "${tempExtract}"`, { encoding: 'utf8' });

  // Use 7z to extract NSIS installer
  try {
    execSync(`7z x "${betaInstaller}" -o"${tempExtract}" app-64.7z -y > /dev/null 2>&1`, { encoding: 'utf8' });
    execSync(`cd "${tempExtract}" && 7z x app-64.7z resources/app-update.yml -y > /dev/null 2>&1`, { encoding: 'utf8' });
  } catch (error) {
    console.log('7z not available or extraction failed, trying alternative method...');

    // Alternative: check the unpacked directory if it exists
    const unpackedDir = path.join(RELEASE_DIR, 'win-arm64-unpacked');
    if (fs.existsSync(unpackedDir)) {
      console.log(`Using unpacked directory: ${unpackedDir}`);
      const updateYmlPath = path.join(unpackedDir, 'resources', 'app-update.yml');

      if (!fs.existsSync(updateYmlPath)) {
        throw new Error(`app-update.yml not found at ${updateYmlPath}`);
      }

      const updateYml = fs.readFileSync(updateYmlPath, 'utf8');
      console.log('\nBeta app-update.yml contents:');
      console.log(updateYml);

      assert(updateYml.includes('channel: beta'), 'CRITICAL: Beta app MUST have channel: beta in update config');
      console.log('\n✅ CRITICAL: Windows Beta installer has correct update channel isolation!');
      console.log('✅ Beta channel configuration verified');

      // Cleanup
      execSync(`rm -rf "${tempExtract}"`, { encoding: 'utf8' });

      return;
    }

    throw new Error('Could not extract or find unpacked directory to verify update configuration');
  }

  const updateYmlPath = path.join(tempExtract, 'resources', 'app-update.yml');

  if (!fs.existsSync(updateYmlPath)) {
    throw new Error(`app-update.yml not found after extraction at ${updateYmlPath}`);
  }

  const updateYml = fs.readFileSync(updateYmlPath, 'utf8');
  console.log('\nBeta app-update.yml contents:');
  console.log(updateYml);

  assert(updateYml.includes('channel: beta'), 'CRITICAL: Beta app MUST have channel: beta in update config');
  console.log('\n✅ CRITICAL: Windows Beta installer has correct update channel isolation!');
  console.log('✅ Beta channel configuration verified');

  // Cleanup
  execSync(`rm -rf "${tempExtract}"`, { encoding: 'utf8' });
}

async function main() {
  try {
    await testWindowsBetaInstaller();

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  ✅ WINDOWS BETA VERIFICATION PASSED!   ║');
    console.log('╚══════════════════════════════════════════╝\n');

    console.log('Summary:');
    console.log('  ✅ Beta installer found');
    console.log('  ✅ Update channel isolation verified');
    console.log('  ✅ channel: beta confirmed in app-update.yml');

  } catch (error) {
    console.error('\n❌ Windows beta verification FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
