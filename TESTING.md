# Beta/Stable Coexistence Testing Guide

This guide explains how to run automated tests to verify beta and stable versions can coexist on all platforms without conflicts.

## Overview

The test suite verifies:
- ✅ Apps install to correct system locations
- ✅ Bundle IDs / package names are different
- ✅ Icons are distinct (blue vs orange)
- ✅ Update channels are isolated (beta uses beta artifacts)
- ✅ Launch isolation (clicking beta opens beta, not stable)
- ✅ UserData/AppData directories are separate
- ✅ Uninstalling one doesn't affect the other

## Prerequisites

### 1. VM Setup

You need VMs running in Parallels for each platform:
- **macOS Tahoe** (`macos-tahoe.shared`) - Already configured ✅
- **Windows** (`windows-vm.local` or IP) - Optional
- **Ubuntu** (`10.211.55.12`) - Optional
- **Fedora** (`10.211.55.13`) - Optional

### 2. VM Requirements

Each VM must have:
- SSH server enabled
- User credentials configured in `scripts/test-vm-helpers.js`
- Network connectivity to host

**Current VM Configuration:**
```javascript
// scripts/test-vm-helpers.js
const VM_CONFIG = {
  macos: {
    host: 'macos-tahoe.shared',
    user: 'alex',
    password: '301192'
  },
  windows: {
    host: 'windows-vm.local',
    user: 'parallels',
    password: '301192'
  },
  ubuntu: {
    host: '10.211.55.12',
    user: 'parallels',
    password: '[CREDENTIAL - see .vm-credentials.json]'
  },
  fedora: {
    host: '10.211.55.13',
    user: 'parallels',
    password: '[CREDENTIAL - see .vm-credentials.json]'
  }
};
```

### 3. Host System Requirements

- Node.js installed
- `sshpass` installed: `brew install hudochenkov/sshpass/sshpass`
- All dependencies: `npm install`

## Running Tests

### Quick Start

**Run all available platform tests:**
```bash
node scripts/run-all-tests.js
```

This will automatically detect which VMs are available and run tests on them.

### Platform-Specific Tests

**macOS Only:**
```bash
node scripts/run-all-tests.js macos
```

**Windows Only:**
```bash
node scripts/run-all-tests.js windows
```

**Ubuntu Only:**
```bash
node scripts/run-all-tests.js ubuntu
```

**Fedora Only:**
```bash
node scripts/run-all-tests.js fedora
```

### Individual Test Scripts

Each platform has its own test script for granular control:

**macOS Tests:**
```bash
# Run all macOS tests
node scripts/test-macos-vm.js tc1        # Stable installation
node scripts/test-macos-vm.js tc2        # Beta installation
node scripts/test-macos-vm.js tc5        # Uninstallation isolation
node scripts/test-macos-vm.js tc13       # Icon verification

# Run isolation tests
node scripts/test-launch-isolation-vm.js all
node scripts/test-launch-isolation-vm.js launch    # Launch isolation
node scripts/test-launch-isolation-vm.js channel   # Update channel
node scripts/test-launch-isolation-vm.js cross-launch  # Cross-app prevention
```

**Windows Tests:**
```bash
node scripts/test-windows-vm.js all
node scripts/test-windows-vm.js stable   # Stable installation
node scripts/test-windows-vm.js beta     # Beta installation
node scripts/test-windows-vm.js channel  # Update channel
node scripts/test-windows-vm.js launch   # Launch isolation
```

**Linux Tests (Ubuntu/Fedora):**
```bash
# Ubuntu
node scripts/test-linux-vm.js ubuntu all
node scripts/test-linux-vm.js ubuntu stable
node scripts/test-linux-vm.js ubuntu beta
node scripts/test-linux-vm.js ubuntu channel
node scripts/test-linux-vm.js ubuntu launch
node scripts/test-linux-vm.js ubuntu uninstall

# Fedora
node scripts/test-linux-vm.js fedora all
node scripts/test-linux-vm.js fedora stable
node scripts/test-linux-vm.js fedora beta
```

## Test Details

### macOS Tests (7 tests)

1. **TC1: Stable Installation**
   - Downloads v1.2.2 from GitHub
   - Installs to `/Applications/Messenger.app`
   - Verifies bundle ID: `com.facebook.messenger.desktop`
   - Tests Spotlight integration

2. **TC2: Beta Installation**
   - Builds current beta version
   - Installs to `/Applications/Messenger Beta.app`
   - Verifies bundle ID: `com.facebook.messenger.desktop.beta`
   - Tests Spotlight integration

3. **TC5: Uninstallation Isolation**
   - Removes stable app
   - Verifies beta remains intact

4. **TC13a: Icon Verification**
   - Compares icon hashes
   - Ensures blue (stable) vs orange (beta)

5. **Launch Isolation**
   - Tests beta detection by version, path, and name
   - Verifies UserData directories differ

6. **Update Channel Isolation** 🚨 **Fixed!**
   - Verifies beta has `channel: beta`
   - Verifies stable uses default channel

7. **Cross-App Launch Prevention**
   - Confirms different bundle IDs prevent cross-launching

### Windows Tests (4 tests)

1. **Stable Installation**
   - Installs to `%LOCALAPPDATA%\Programs\messenger`
   - Verifies Start Menu shortcut: "Messenger"

2. **Beta Installation**
   - Installs to `%LOCALAPPDATA%\Programs\messenger-beta`
   - Verifies Start Menu shortcut: "Messenger Beta"

3. **Update Channel Isolation**
   - Checks `app-update.yml` in both apps
   - Verifies beta has `channel: beta`

4. **Launch Isolation**
   - Confirms different executable names
   - Verifies different AppData directories

### Linux Tests (5 tests each: Ubuntu & Fedora)

1. **Stable Installation**
   - Installs package: `facebook-messenger-desktop`
   - Executable: `/usr/bin/facebook-messenger-desktop`
   - Desktop file: `facebook-messenger-desktop.desktop`
   - Icon: `messenger.png`

2. **Beta Installation**
   - Installs package: `facebook-messenger-desktop-beta`
   - Executable: `/usr/bin/facebook-messenger-desktop-beta`
   - Desktop file: `facebook-messenger-desktop-beta.desktop`
   - Icon: `messenger-beta.png`

3. **Update Channel Isolation**
   - Verifies beta has `channel: beta`

4. **Launch Isolation**
   - Different executables and desktop files
   - Different config directories

5. **Uninstallation Isolation**
   - Removes stable package
   - Verifies beta package remains

## Building Packages for Testing

### macOS
```bash
# Beta (current version already has -beta)
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build && npm run dist:mac

# Stable (requires version without -beta)
# Edit package.json version first, then:
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build && npm run dist:mac
```

### Windows
```bash
# Beta
npm run build && npm run dist:win

# Stable
# Edit package.json version first, then:
npm run build && npm run dist:win
```

### Linux
```bash
# Ubuntu/Debian (.deb)
npm run build && npm run dist:linux -- --deb

# Fedora/RHEL (.rpm)
npm run build && npm run dist:linux -- --rpm
```

## Troubleshooting

### VM Connection Issues

**Problem:** `❌ VM not available`

**Solutions:**
1. Ensure VM is running in Parallels
2. Test SSH manually: `ssh alex@macos-tahoe.shared`
3. Check VM network settings (should use Shared Network)
4. Verify credentials in `scripts/test-vm-helpers.js`

### SSH Authentication Failures

**Problem:** `Permission denied` or `Too many authentication failures`

**Solutions:**
1. Wait 30 seconds between test runs (SSH rate limiting)
2. Clear SSH known_hosts: `ssh-keygen -R macos-tahoe.shared`
3. Test connection: `node -e "const {testVMConnection} = require('./scripts/test-vm-helpers'); console.log(testVMConnection('macos'));"`

### Build Failures

**Problem:** Signing errors during build

**Solution:**
Always use `CSC_IDENTITY_AUTO_DISCOVERY=false` for test builds:
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build && npm run dist:mac
```

### Package Not Found

**Problem:** Test can't find built package

**Solution:**
Check `release/` directory has the expected files:
```bash
ls -la release/
```

Expected patterns:
- macOS Beta: `Messenger-Beta-macos-{arch}.zip`
- macOS Stable: `Messenger-macos-{arch}.zip`
- Windows Beta: `Messenger-Beta-windows-{arch}.exe`
- Linux Beta: `facebook-messenger-desktop-beta_*.{deb|rpm}`

## Test Results

Test results are saved to:
- **TEST-RESULTS.md** - Detailed test report
- **test-screenshots/** - Visual verification (macOS only)

## Critical Fix Applied

### Update Channel Isolation Bug 🐛 → ✅ Fixed

**Problem:** Beta and stable apps used identical update configurations, causing:
- Beta apps could download stable artifacts
- Stable apps could download beta artifacts
- No channel isolation

**Fix:** Added channel differentiation in `electron-builder.config.js`:
```javascript
if (isBeta) {
  publishConfig.channel = 'beta';
}
```

**Result:**
- Beta `app-update.yml` now contains: `channel: beta`
- Stable `app-update.yml` uses default channel
- Perfect isolation! ✅

## Next Steps

After all tests pass:

1. **Review Results:**
   ```bash
   cat TEST-RESULTS.md
   ```

2. **Commit Changes:**
   ```bash
   git add electron-builder.config.js scripts/ TEST-RESULTS.md
   git commit -m "fix: add update channel isolation for beta builds"
   ```

3. **Create Release:**
   Follow your normal release process

4. **Publish Updates:**
   - Publish beta releases to GitHub with `beta` pre-release tag
   - Publish stable releases to GitHub as latest
   - Beta apps will only see beta releases
   - Stable apps will only see stable releases

## Support

For issues or questions:
- Check `scripts/test-vm-helpers.js` for VM configuration
- Review test output for specific error messages
- Ensure all prerequisites are met
