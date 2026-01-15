# Beta/Stable Coexistence Testing Guide

This document describes the comprehensive test suite for verifying beta and stable app coexistence.

## Test Overview

**13 Test Cases** covering:
- Installation and uninstallation (TC1-TC5)
- Simultaneous operation and coexistence (TC6-TC9)
- Version upgrade paths (TC10-TC12)
- Icon verification across platforms (TC13)

## Prerequisites

### Required Software

1. **sshpass** (for VM automation):
   ```bash
   brew install hudochenkov/sshpass/sshpass
   ```

2. **Node.js dependencies** (already installed):
   - playwright
   - glob

3. **Parallels VMs** (configured):
   - Windows VM (with OpenSSH Server)
   - Ubuntu VM (with SSH server)
   - Fedora VM (with SSH server)

### VM Setup

#### 1. Find VM IP Addresses

In each VM, run:
```bash
# Linux VMs
hostname -I

# Windows VM
ipconfig
```

#### 2. Update VM Configuration

Edit `scripts/test-vm-helpers.js` and update the `VM_CONFIG` object with your VM hostnames/IPs:

```javascript
const VM_CONFIG = {
  windows: {
    host: '192.168.1.XXX',  // Your Windows VM IP
    user: 'your-username',   // Your Windows username
    password: '301192'
  },
  ubuntu: {
    host: '192.168.1.XXX',  // Your Ubuntu VM IP
    user: 'your-username',   // Your Ubuntu username
    password: '#p0t3nZ@'
  },
  fedora: {
    host: '192.168.1.XXX',  // Your Fedora VM IP
    user: 'your-username',   // Your Fedora username
    password: '#p0t3nZ@'
  }
};
```

#### 3. Test SSH Connectivity

```bash
# Test each VM
sshpass -p '301192' ssh testuser@windows-vm.local "echo 'Windows VM connected'"
sshpass -p '#p0t3nZ@' ssh testuser@ubuntu-vm.local "echo 'Ubuntu VM connected'"
sshpass -p '#p0t3nZ@' ssh testuser@fedora-vm.local "echo 'Fedora VM connected'"
```

#### 4. Configure Parallels Shared Folders

1. Open Parallels Desktop
2. For each VM: Configure → Sharing → Share Mac folders
3. Share custom folder: `/Users/alex/Parallels/Shared/messenger-test`
4. In VMs, shared folder will mount as:
   - **Windows**: `Z:\messenger-test\`
   - **Linux**: `/media/psf/messenger-test/`

## Running Tests

### Run All Tests

```bash
node scripts/run-all-tests.js
```

### Run Individual Test Suites

```bash
# Installation & uninstallation tests
node scripts/test-installation.js

# Coexistence tests
node scripts/test-coexistence.js

# Version upgrade tests
node scripts/test-version-upgrades.js

# Icon verification tests
node scripts/test-icon-verification.js
```

### Run Specific Platform Tests

```bash
# macOS only (runs on host)
node scripts/test-installation.js --platform=macos

# Windows only (requires VM)
node scripts/test-installation.js --platform=windows

# Ubuntu only (requires VM)
node scripts/test-installation.js --platform=ubuntu

# Fedora only (requires VM)
node scripts/test-installation.js --platform=fedora
```

## Test Cases

### TC1-TC5: Installation & Uninstallation
- **TC1**: macOS stable installation
- **TC2**: macOS beta installation
- **TC3**: Windows installation (stable & beta)
- **TC4**: Linux installation (Ubuntu & Fedora, stable & beta)
- **TC5**: Uninstallation isolation (removing one doesn't affect the other)

### TC6-TC9: Coexistence
- **TC6**: Both apps run simultaneously
- **TC7**: Beta app uses beta (orange) icons
- **TC8**: Update channel isolation
- **TC9**: Beta receives stable updates without interfering

### TC10-TC12: Version Upgrades
- **TC10**: Stable → stable upgrade (doesn't affect beta)
- **TC11**: Beta → beta upgrade
- **TC12**: Beta app: stable version → beta version upgrade

### TC13: Icon Verification
- **TC13a**: macOS icons (stable vs beta)
- **TC13b**: Windows icons and shortcuts
- **TC13c**: Ubuntu desktop files and icons
- **TC13d**: Fedora desktop files and icons

## Test Results

Tests output to:
- **Console**: Pass/fail status for each test
- **Screenshots**: `test-screenshots/` directory
- **Test artifacts**: `/tmp/messenger-test-*` directories (macOS)

## Safety Notes

- **macOS tests** use isolated `/tmp/` directories and won't affect real installations in `/Applications`
- **VM tests** install to actual system locations but are isolated in VMs
- Tests can be run repeatedly without affecting your host system
- Screenshots are captured for visual verification

## Troubleshooting

### VM Connection Errors

If you get SSH connection errors:

1. Verify VM is running
2. Check VM IP hasn't changed: `prl_vm_sdk getip <vm-name>`
3. Test SSH manually: `sshpass -p 'password' ssh user@vm-host "echo test"`
4. Ensure SSH server is running in VM

### Shared Folder Not Accessible

Linux VMs:
```bash
# Check if prl_fs module is loaded
lsmod | grep prl_fs

# Mount shared folder manually
sudo mount -t prl_fs none /media/psf
```

Windows VM:
- Ensure Parallels Tools are installed
- Check if Z: drive is mapped

### Build Errors

If builds fail:
```bash
# Clean and rebuild
npm run clean
npm run build
```

### Permission Errors in VMs

Ubuntu/Fedora:
```bash
# Ensure sudo works with password
echo 'password' | sudo -S ls /

# Check if user has sudo rights
groups | grep sudo
```

## CI Integration (Future)

Once tests are stable, they can be integrated into GitHub Actions:

```yaml
# .github/workflows/test-coexistence.yml
name: Coexistence Tests

on: [pull_request, push]

jobs:
  test:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: node scripts/run-all-tests.js
```

## Additional Resources

- [Electron Builder Documentation](https://www.electron.build/)
- [Playwright Electron Documentation](https://playwright.dev/docs/api/class-electron)
- [Parallels Command Line Reference](https://www.parallels.com/products/desktop/resources/)
