#!/usr/bin/env node

/**
 * Build and test Windows packages INSIDE the Windows VM
 * Uses prlctl exec to run commands - no SSH required
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VM_NAME = "Windows 11 ARM";
const VM_PROJECT_PATH = "C:\\\\Users\\\\alex\\\\messenger-test";

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  Windows Build & Test (Inside VM)              ║');
console.log('╚══════════════════════════════════════════════════╝\n');

function execInVM(command) {
  console.log(`[VM] ${command.substring(0, 80)}${command.length > 80 ? '...' : ''}`);
  const result = execSync(`prlctl exec "${VM_NAME}" cmd.exe "/C ${command}"`, {
    encoding: 'utf8',
    stdio: 'pipe'
  });
  return result;
}

function execPowerShellInVM(command) {
  console.log(`[VM-PS] ${command.substring(0, 80)}${command.length > 80 ? '...' : ''}`);
  const result = execSync(`prlctl exec "${VM_NAME}" powershell.exe "${command}"`, {
    encoding: 'utf8',
    stdio: 'pipe'
  });
  return result;
}

async function copyProjectToVM() {
  console.log('\n=== Copying Project to Windows VM ===\n');

  // Create project directory in VM
  console.log(`Creating directory: ${VM_PROJECT_PATH}`);
  try {
    execPowerShellInVM(`New-Item -ItemType Directory -Force -Path "${VM_PROJECT_PATH}"`);
  } catch (e) {
    // Directory might already exist
  }

  // Copy project files via shared folder
  console.log('Copying project files...');
  const sharedPath = '/Users/Shared/messenger-build';
  execSync(`rm -rf "${sharedPath}" && mkdir -p "${sharedPath}"`, { encoding: 'utf8' });

  // Copy necessary files (exclude node_modules, dist, release)
  const filesToCopy = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'electron-builder.config.js',
    'src',
    'scripts',
    'assets'
  ];

  for (const file of filesToCopy) {
    const sourcePath = path.join(PROJECT_ROOT, file);
    if (fs.existsSync(sourcePath)) {
      console.log(`  Copying ${file}...`);
      if (fs.statSync(sourcePath).isDirectory()) {
        execSync(`cp -r "${sourcePath}" "${sharedPath}/"`, { encoding: 'utf8' });
      } else {
        execSync(`cp "${sourcePath}" "${sharedPath}/"`, { encoding: 'utf8' });
      }
    }
  }

  // Copy from Mac shared folder to Windows
  console.log('Transferring files to Windows VM...');
  execPowerShellInVM(`Copy-Item -Path "\\\\\\\\Mac\\\\Home\\\\Shared\\\\messenger-build\\\\*" -Destination "${VM_PROJECT_PATH}" -Recurse -Force`);

  console.log('✅ Project copied to Windows VM');
}

async function buildInVM() {
  console.log('\n=== Building Windows Packages in VM ===\n');

  // Install dependencies
  console.log('Installing dependencies...');
  execInVM(`cd "${VM_PROJECT_PATH}" && npm install`);

  // Build beta version
  console.log('\nBuilding beta version...');
  execInVM(`cd "${VM_PROJECT_PATH}" && set IS_BETA=true && set CSC_LINK= && npm run build`);
  execInVM(`cd "${VM_PROJECT_PATH}" && set IS_BETA=true && set CSC_LINK= && npm run dist:win`);

  console.log('✅ Beta build complete');

  // List the built files
  console.log('\nBuilt files:');
  const files = execPowerShellInVM(`Get-ChildItem "${VM_PROJECT_PATH}\\\\release\\\\*.exe" | Select-Object -ExpandProperty Name`);
  console.log(files);
}

async function testBetaInstaller() {
  console.log('\n=== Testing Beta Installer ===\n');

  // Check update channel in the unpacked directory
  const updateYmlPath = `${VM_PROJECT_PATH}\\\\release\\\\win-arm64-unpacked\\\\resources\\\\app-update.yml`;

  console.log('Checking update channel configuration...');
  const updateYml = execPowerShellInVM(`Get-Content "${updateYmlPath}" -Raw`);
  console.log('\nBeta app-update.yml contents:');
  console.log(updateYml);

  if (!updateYml.includes('channel: beta')) {
    throw new Error('CRITICAL: Beta app MUST have channel: beta in update config');
  }

  console.log('✅ CRITICAL: Windows Beta has correct update channel isolation!');
}

async function main() {
  try {
    // Check VM is running
    const vmStatus = execSync(`prlctl list | grep "${VM_NAME}"`, { encoding: 'utf8' });
    if (!vmStatus.includes('running')) {
      console.log('Starting Windows VM...');
      execSync(`prlctl start "${VM_NAME}"`, { encoding: 'utf8' });
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    console.log('✅ Windows VM is running\n');

    await copyProjectToVM();
    await buildInVM();
    await testBetaInstaller();

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  ✅ WINDOWS BUILD & TEST PASSED!        ║');
    console.log('╚══════════════════════════════════════════╝\n');

    console.log('Summary:');
    console.log('  ✅ Project copied to Windows VM');
    console.log('  ✅ Beta package built inside VM');
    console.log('  ✅ Update channel isolation verified');

  } catch (error) {
    console.error('\n❌ Windows build/test FAILED:', error.message);
    if (error.stdout) console.error('STDOUT:', error.stdout);
    if (error.stderr) console.error('STDERR:', error.stderr);
    process.exit(1);
  }
}

main();
