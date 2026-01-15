const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * VM Configuration
 * Update hostnames/IPs and usernames as needed for your Parallels VMs
 */
const VM_CONFIG = {
  windows: {
    host: 'windows-vm.local',  // Windows VM IP (will update when available)
    user: 'parallels',          // Windows username
    password: 'YOUR_VM_PASSWORD'
  },
  ubuntu: {
    host: '10.211.55.12',       // Ubuntu VM IP
    user: 'parallels',          // Ubuntu username
    password: 'YOUR_VM_PASSWORD'
  },
  fedora: {
    host: '10.211.55.13',       // Fedora VM IP
    user: 'parallels',          // Fedora username
    password: 'YOUR_VM_PASSWORD'
  }
};

/**
 * Execute command in VM via SSH with password authentication
 * @param {string} vm - VM name ('windows', 'ubuntu', or 'fedora')
 * @param {string} command - Command to execute
 * @param {boolean} needsSudo - Whether command needs sudo privileges
 * @returns {string} Command output
 */
function execInVM(vm, command, needsSudo = false) {
  const config = VM_CONFIG[vm];

  if (!config) {
    throw new Error(`Unknown VM: ${vm}`);
  }

  // Escape single quotes in password for shell
  const escapedPassword = config.password.replace(/'/g, "'\\''");

  // Build the full command with sudo if needed
  let fullCommand = command;
  if (needsSudo) {
    // Use echo to pipe password to sudo -S
    fullCommand = `echo '${escapedPassword}' | sudo -S ${command}`;
  }

  // Use sshpass for non-interactive password authentication
  // Install with: brew install hudochenkov/sshpass/sshpass (macOS)
  const sshCommand = `sshpass -p '${escapedPassword}' ssh -o StrictHostKeyChecking=no ${config.user}@${config.host} "${fullCommand.replace(/"/g, '\\"')}"`;

  try {
    return execSync(sshCommand, { encoding: 'utf8' });
  } catch (err) {
    console.error(`Error executing command in ${vm} VM:`, err.message);
    throw err;
  }
}

/**
 * Copy file to VM via shared folder
 * @param {string} localPath - Local file path
 * @param {string} vmSharedPath - Path within shared folder
 */
function copyToVM(localPath, vmSharedPath) {
  const sharedFolder = '/Users/alex/Parallels/Shared/messenger-test';

  // Create shared folder if it doesn't exist
  if (!fs.existsSync(sharedFolder)) {
    fs.mkdirSync(sharedFolder, { recursive: true });
  }

  const destPath = path.join(sharedFolder, vmSharedPath);
  fs.copyFileSync(localPath, destPath);
  console.log(`Copied ${localPath} to shared folder: ${vmSharedPath}`);
}

/**
 * Take screenshot in VM
 * @param {string} vm - VM name
 * @param {string} outputPath - Local path to save screenshot
 */
async function screenshotVM(vm, outputPath) {
  const screenshotDir = path.dirname(outputPath);
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  if (vm === 'windows') {
    // Windows: Use PowerShell to take screenshot
    const remoteScreenshot = 'C:\\temp\\screenshot.png';
    execInVM('windows', `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::DoEvents(); $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size); $bitmap.Save('${remoteScreenshot}'); $graphics.Dispose(); $bitmap.Dispose()"`);

    // Copy screenshot back via shared folder
    // Note: Requires shared folder access from Windows VM
    console.log(`Screenshot saved on Windows VM: ${remoteScreenshot}`);

  } else {
    // Linux: Use scrot or imagemagick
    const remoteScreenshot = `/tmp/screenshot-${Date.now()}.png`;
    try {
      execInVM(vm, `scrot ${remoteScreenshot}`, false);
    } catch (err) {
      // Fallback to import (ImageMagick)
      execInVM(vm, `import -window root ${remoteScreenshot}`, false);
    }

    console.log(`Screenshot saved on ${vm} VM: ${remoteScreenshot}`);
  }
}

/**
 * Test SSH connectivity to a VM
 * @param {string} vm - VM name
 * @returns {boolean} True if connection successful
 */
function testVMConnection(vm) {
  try {
    const result = execInVM(vm, 'echo "VM connection test successful"');
    return result.includes('successful');
  } catch (err) {
    console.error(`Failed to connect to ${vm} VM:`, err.message);
    return false;
  }
}

/**
 * Get VM IP address (useful for first-time setup)
 * @param {string} vm - VM name
 * @returns {string} IP address
 */
function getVMIP(vm) {
  if (vm === 'windows') {
    const output = execInVM('windows', 'ipconfig');
    // Parse IPv4 address from ipconfig output
    const match = output.match(/IPv4 Address[.\s]+:\s+(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  } else {
    const output = execInVM(vm, 'hostname -I');
    return output.trim().split(' ')[0];
  }
}

/**
 * Sleep/delay utility
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after delay
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  VM_CONFIG,
  execInVM,
  copyToVM,
  screenshotVM,
  testVMConnection,
  getVMIP,
  sleep
};
