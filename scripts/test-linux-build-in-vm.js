#!/usr/bin/env node

/**
 * Build and test Linux packages INSIDE the Linux VMs
 * Uses SSH to run commands and rsync to copy files
 */

const { execSync } = require('child_process');
const path = require('path');
const { execInVM, copyFileToVM, VM_CONFIG } = require('./test-vm-helpers');

const PROJECT_ROOT = path.resolve(__dirname, '..');

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  Linux Build & Test (Inside VMs)               ║');
console.log('╚══════════════════════════════════════════════════╝\n');

async function copyProjectToVM(vm) {
  console.log(`\n=== Copying Project to ${vm} VM ===\n`);

  const config = VM_CONFIG[vm];
  const remotePath = '/home/parallels/messenger-test';

  // Create directory on VM
  console.log(`Creating directory: ${remotePath}`);
  execInVM(vm, `rm -rf ${remotePath} && mkdir -p ${remotePath}`);

  // Use rsync to copy project (exclude node_modules, dist, release)
  console.log('Copying project files via rsync...');
  const escapedPassword = config.password.replace(/'/g, "'\\''");

  const rsyncCommand = `rsync -av --exclude='node_modules' --exclude='dist' --exclude='release' --exclude='.git' ` +
    `-e "sshpass -p '${escapedPassword}' ssh -o StrictHostKeyChecking=no" ` +
    `"${PROJECT_ROOT}/" ${config.user}@${config.host}:${remotePath}/`;

  execSync(rsyncCommand, { encoding: 'utf8', stdio: 'inherit' });

  console.log(`✅ Project copied to ${vm} VM`);
}

async function buildInVM(vm, buildBeta = true) {
  console.log(`\n=== Building ${buildBeta ? 'Beta' : 'Stable'} Package in ${vm} VM ===\n`);

  const remotePath = '/home/parallels/messenger-test';

  // Install dependencies if needed
  console.log('Installing dependencies...');
  execInVM(vm, `cd ${remotePath} && npm install`, false);

  // Build
  console.log(`\nBuilding ${buildBeta ? 'beta' : 'stable'} version...`);
  const envVars = buildBeta ? 'IS_BETA=true ' : '';
  execInVM(vm, `cd ${remotePath} && ${envVars}npm run build`, false);
  execInVM(vm, `cd ${remotePath} && ${envVars}npm run dist:linux`, false);

  console.log(`✅ ${buildBeta ? 'Beta' : 'Stable'} build complete`);

  // List the built files
  console.log('\nBuilt files:');
  const files = execInVM(vm, `ls -lh ${remotePath}/release/*.{deb,rpm,AppImage} 2>/dev/null || echo "No packages found"`);
  console.log(files);
}

async function testPackageInVM(vm, isBeta = true) {
  console.log(`\n=== Testing ${isBeta ? 'Beta' : 'Stable'} Package in ${vm} VM ===\n`);

  const remotePath = '/home/parallels/messenger-test';
  const packageName = isBeta ? 'facebook-messenger-desktop-beta' : 'facebook-messenger-desktop';
  const appName = isBeta ? 'Messenger Beta' : 'Messenger';

  // Find the package file
  const debPattern = isBeta ? 'facebook-messenger-desktop-beta-*.deb' : 'facebook-messenger-desktop-[0-9]*.deb';
  const debFile = execInVM(vm, `ls ${remotePath}/release/${debPattern} 2>/dev/null | head -1`).trim();

  if (!debFile) {
    throw new Error(`No ${isBeta ? 'beta' : 'stable'} .deb package found`);
  }

  console.log(`Found package: ${debFile}`);

  // Uninstall any existing installation
  console.log('Cleaning up existing installations...');
  try {
    execInVM(vm, `dpkg -r ${packageName} 2>/dev/null || true`);
  } catch (e) {
    // Ignore
  }

  // Install the package
  console.log(`Installing ${isBeta ? 'beta' : 'stable'} package...`);
  execInVM(vm, `dpkg -i ${debFile} || true`);
  execInVM(vm, `apt-get install -f -y`);

  console.log(`✅ ${isBeta ? 'Beta' : 'Stable'} package installed`);

  // Verify installation
  console.log('\nVerifying installation...');

  const binaryPath = `/usr/bin/${packageName}`;
  const binaryExists = execInVM(vm, `test -f ${binaryPath} && echo "exists" || echo "missing"`).trim();
  if (binaryExists !== 'exists') {
    throw new Error(`Binary not found at ${binaryPath}`);
  }
  console.log(`✅ Binary exists: ${binaryPath}`);

  const appDir = `/opt/${appName}`;
  const appDirExists = execInVM(vm, `test -d "${appDir}" && echo "exists" || echo "missing"`).trim();
  if (appDirExists !== 'exists') {
    throw new Error(`App directory not found at ${appDir}`);
  }
  console.log(`✅ App directory exists: ${appDir}`);

  // Check update channel
  console.log('\nChecking update channel configuration...');
  const updateYml = execInVM(vm, `cat "${appDir}/resources/app-update.yml"`);
  console.log('app-update.yml contents:');
  console.log(updateYml);

  if (isBeta) {
    if (!updateYml.includes('channel: beta')) {
      throw new Error('CRITICAL: Beta app MUST have channel: beta');
    }
    console.log('✅ CRITICAL: Beta has correct update channel isolation!');
  } else {
    if (updateYml.includes('channel: beta')) {
      throw new Error('Stable app should NOT have channel: beta');
    }
    console.log('✅ Stable has correct update channel (default)');
  }
}

async function testVM(vm) {
  console.log(`\n\n╔${'='.repeat(50)}╗`);
  console.log(`║  Testing ${vm.toUpperCase().padEnd(42)} ║`);
  console.log(`╚${'='.repeat(50)}╝`);

  try {
    // Resume VM if needed
    console.log(`\nChecking ${vm} VM status...`);
    const vmList = execSync('prlctl list -a', { encoding: 'utf8' });
    const vmName = vm === 'ubuntu' ? 'Ubuntu 24.04.3 ARM64' : 'Fedora 42 ARM64';
    const vmLine = vmList.split('\n').find(line => line.includes(vmName));

    if (!vmLine || vmLine.includes('suspended')) {
      console.log(`Resuming ${vm} VM...`);
      execSync(`prlctl resume "${vmName}"`, { encoding: 'utf8' });
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    console.log(`✅ ${vm} VM is running`);

    await copyProjectToVM(vm);
    await buildInVM(vm, true); // Build beta
    await testPackageInVM(vm, true); // Test beta

    console.log(`\n✅ ${vm.toUpperCase()} TESTS PASSED!\n`);

    // Suspend VM
    console.log(`Suspending ${vm} VM to save resources...`);
    execSync(`prlctl suspend "${vmName}"`, { encoding: 'utf8' });

    return { vm, status: 'PASSED' };

  } catch (error) {
    console.error(`\n❌ ${vm.toUpperCase()} TESTS FAILED:`, error.message);
    return { vm, status: 'FAILED', error: error.message };
  }
}

async function main() {
  const platform = process.argv[2] || 'ubuntu';

  if (platform === 'all') {
    console.log('Testing all Linux platforms sequentially...\n');
    const results = [];
    results.push(await testVM('ubuntu'));
    results.push(await testVM('fedora'));

    console.log('\n\n╔══════════════════════════════════════════╗');
    console.log('║  LINUX TESTING SUMMARY                  ║');
    console.log('╚══════════════════════════════════════════╝\n');

    for (const result of results) {
      const status = result.status === 'PASSED' ? '✅' : '❌';
      console.log(`  ${status} ${result.vm.toUpperCase()}: ${result.status}`);
    }

  } else {
    await testVM(platform);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
