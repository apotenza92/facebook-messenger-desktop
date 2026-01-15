#!/usr/bin/env node

/**
 * Windows testing using prlctl exec (no SSH required)
 * Tests installation and basic isolation using Parallels CLI
 */

const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const VM_NAME = "Windows 11 ARM";

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  Windows Installation Test (prlctl exec)        ║');
console.log('╚══════════════════════════════════════════════════╝\n');

function execInWindowsVM(command) {
  const fullCommand = `prlctl exec "${VM_NAME}" powershell.exe "${command.replace(/"/g, '\\"')}"`;
  return execSync(fullCommand, { encoding: 'utf8' });
}

function copyFileToWindowsVM(localPath, remotePath) {
  // Copy file using shared folder
  console.log(`Copying ${path.basename(localPath)} to Windows VM...`);

  // Create a temp shared location
  const sharedPath = '/Users/Shared/messenger-test';
  execSync(`mkdir -p "${sharedPath}"`, { encoding: 'utf8' });

  // Copy to shared location
  execSync(`cp "${localPath}" "${sharedPath}/"`, { encoding: 'utf8' });

  // Create temp directory on Windows
  execInWindowsVM('New-Item -ItemType Directory -Force -Path C:\\\\temp');

  // Copy from Mac shared folder to Windows temp via PowerShell
  // The shared folder is accessible from Windows at \\psf\Home\Shared
  const filename = path.basename(localPath);
  execInWindowsVM(`Copy-Item "\\\\\\\\psf\\\\Home\\\\Shared\\\\messenger-test\\\\${filename}" "${remotePath}"`);

  console.log(`✅ Copied to: ${remotePath}`);
}

async function testWindowsBetaInstallation() {
  console.log('\n=== TC1: Windows Beta Installation ===\n');

  // Find the beta installer (use the arm64 version since we're on ARM)
  let betaInstaller = path.join(RELEASE_DIR, 'Messenger-Beta-windows-arm64-setup.exe');

  if (!fs.existsSync(betaInstaller)) {
    // Try the combined installer
    betaInstaller = path.join(RELEASE_DIR, 'Messenger-Beta-windows-setup.exe');
  }

  if (!fs.existsSync(betaInstaller)) {
    throw new Error(`Beta installer not found. Run: IS_BETA=true npm run dist:win`);
  }

  console.log(`Using beta installer: ${betaInstaller}`);

  // Copy installer to VM
  const tempInstaller = 'C:\\temp\\Messenger-Beta-Setup.exe';
  copyFileToWindowsVM(betaInstaller, tempInstaller);

  // Uninstall any existing installations
  console.log('Cleaning up any existing installations...');
  try {
    execInWindowsVM('Get-Package "Messenger*" | Uninstall-Package -Force -ErrorAction SilentlyContinue');
  } catch (e) {
    // Ignore errors
  }

  // Install beta silently
  console.log('Installing beta package...');
  execInWindowsVM(`Start-Process -FilePath "${tempInstaller}" -ArgumentList "/S" -Wait -NoNewWindow`);
  console.log('✅ Beta package installed successfully');

  // Verify installation
  console.log('\nVerifying beta installation...');

  const betaPath = `${process.env.LOCALAPPDATA || '$env:LOCALAPPDATA'}\\Programs\\messenger-beta`;

  // Check if installation directory exists
  const betaDirCheck = execInWindowsVM(`Test-Path "${betaPath}"`).trim();
  assert.strictEqual(betaDirCheck, 'True', `Beta directory should exist at ${betaPath}`);
  console.log(`✅ Beta directory exists: ${betaPath}`);

  // Check app-update.yml for channel
  console.log('\nChecking update channel configuration...');
  const updateYml = execInWindowsVM(`Get-Content "${betaPath}\\resources\\app-update.yml" -Raw`);
  console.log('Beta app-update.yml contents:');
  console.log(updateYml);

  assert(updateYml.includes('channel: beta'), 'CRITICAL: Beta app MUST have channel: beta in update config');
  console.log('✅ CRITICAL: Beta app has correct update channel isolation!');

  console.log('\n✅ TC1: Windows Beta Installation PASSED\n');
}

async function testWindowsStableInstallation() {
  console.log('\n=== TC2: Windows Stable Installation ===\n');

  // Download stable v1.2.2 release
  console.log('Downloading stable v1.2.2 release from GitHub...');
  const tempDir = '/tmp/messenger-stable-test-win';
  execSync(`rm -rf ${tempDir} && mkdir -p ${tempDir}`, { encoding: 'utf8' });

  try {
    execSync(`gh release download v1.2.2 --repo apotenza92/facebook-messenger-desktop --pattern "*Setup.exe" --dir ${tempDir} --clobber`, {
      encoding: 'utf8',
      stdio: 'inherit'
    });
  } catch (error) {
    console.log('Failed to download stable release. Checking what files are available...');
    const files = execSync(`gh release view v1.2.2 --repo apotenza92/facebook-messenger-desktop --json assets --jq '.assets[].name'`, { encoding: 'utf8' });
    console.log('Available files:\n', files);
    throw error;
  }

  const stableInstaller = execSync(`ls ${tempDir}/*.exe | grep -v Beta`, { encoding: 'utf8' }).trim();
  console.log(`Using stable installer: ${stableInstaller}`);

  // Copy to VM
  const tempStableInstaller = 'C:\\temp\\Messenger-Stable-Setup.exe';
  copyFileToWindowsVM(stableInstaller, tempStableInstaller);

  // Install stable package (beta should already be installed)
  console.log('Installing stable package alongside beta...');
  execInWindowsVM(`Start-Process -FilePath "${tempStableInstaller}" -ArgumentList "/S" -Wait -NoNewWindow`);
  console.log('✅ Stable package installed successfully');

  // Verify coexistence
  console.log('\nVerifying coexistence...');

  const stablePath = `${process.env.LOCALAPPDATA || '$env:LOCALAPPDATA'}\\Programs\\messenger`;
  const betaPath = `${process.env.LOCALAPPDATA || '$env:LOCALAPPDATA'}\\Programs\\messenger-beta`;

  // Check both directories exist
  const stableDirCheck = execInWindowsVM(`Test-Path "${stablePath}"`).trim();
  assert.strictEqual(stableDirCheck, 'True', `Stable directory should exist at ${stablePath}`);
  console.log(`✅ Stable directory exists: ${stablePath}`);

  const betaDirCheck = execInWindowsVM(`Test-Path "${betaPath}"`).trim();
  assert.strictEqual(betaDirCheck, 'True', `Beta directory should still exist at ${betaPath}`);
  console.log(`✅ Beta directory still exists: ${betaPath}`);

  // Check stable update configuration
  console.log('\nChecking stable update channel configuration...');
  const stableUpdateYml = execInWindowsVM(`Get-Content "${stablePath}\\resources\\app-update.yml" -Raw`);
  console.log('Stable app-update.yml contents:');
  console.log(stableUpdateYml);

  assert(!stableUpdateYml.includes('channel: beta'), 'Stable app should NOT have channel: beta');
  console.log('✅ Stable app has correct update channel (default/stable)');

  console.log('\n✅ TC2: Windows Stable Installation and Coexistence PASSED\n');

  // Cleanup
  execSync(`rm -rf ${tempDir}`, { encoding: 'utf8' });
}

async function main() {
  try {
    // Check VM is running
    const vmStatus = execSync(`prlctl list -a | grep "${VM_NAME}"`, { encoding: 'utf8' });
    if (!vmStatus.includes('running')) {
      console.log('Resuming Windows VM...');
      execSync(`prlctl resume "${VM_NAME}"`, { encoding: 'utf8' });
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
    console.log('✅ Windows VM is running\n');

    // Run tests
    await testWindowsBetaInstallation();
    await testWindowsStableInstallation();

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  ✅ ALL WINDOWS TESTS PASSED!           ║');
    console.log('╚══════════════════════════════════════════╝\n');

    console.log('Summary:');
    console.log('  ✅ Beta installation verified');
    console.log('  ✅ Stable installation verified');
    console.log('  ✅ Beta/Stable coexistence confirmed');
    console.log('  ✅ Update channel isolation verified');
    console.log('  ✅ Separate directories confirmed');

  } catch (error) {
    console.error('\n❌ Windows tests FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
