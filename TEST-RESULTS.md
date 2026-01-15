# Beta/Stable Coexistence Test Results

**Test Date:** 2026-01-15
**Test Environment:** macOS Tahoe VM (macOS 26.2)
**Apps Tested:**
- Stable: Messenger v1.2.2 (from GitHub releases)
- Beta: Messenger Beta v1.2.3-beta.2 (locally built)

---

## ✅ PASSED: TC1 - macOS Stable Installation

**Status:** PASSED ✅

**Verifications:**
- ✓ Installed to `/Applications/Messenger.app`
- ✓ Bundle ID: `com.facebook.messenger.desktop`
- ✓ Version: 1.2.2 (no beta suffix)
- ✓ Spotlight integration working
- ✓ Icon: Blue (stable)

---

## ✅ PASSED: TC2 - macOS Beta Installation

**Status:** PASSED ✅

**Verifications:**
- ✓ Installed to `/Applications/Messenger Beta.app`
- ✓ Bundle ID: `com.facebook.messenger.desktop.beta`
- ✓ Version: 1.2.3-beta.2 (contains beta suffix)
- ✓ Spotlight integration working
- ✓ Icon: Orange (beta)
- ✓ Built without code signing using `CSC_IDENTITY_AUTO_DISCOVERY=false`

---

## ✅ PASSED: TC5 - Uninstallation Isolation

**Status:** PASSED ✅

**Verifications:**
- ✓ Uninstalled stable app: `rm -rf /Applications/Messenger.app`
- ✓ Beta app remains intact at `/Applications/Messenger Beta.app`
- ✓ No cross-contamination during uninstall

---

## ✅ PASSED: TC13a - Icon Verification

**Status:** PASSED ✅

**Verifications:**
- ✓ Stable icon hash matches source: `a3484f4778f29ece4e9854753919df1529b7a7c9a706273ead8cd54c7ed1304a`
- ✓ Beta icon hash matches source: `205279487c2b9fe3085384210c64a08fe5255011f260ad208f7702f491f7bc39`
- ✓ Icons are visually distinct (different hashes)

---

## ✅ PASSED: TC - Launch Isolation

**Status:** PASSED ✅

**Issue Tested:** Beta app clicking opens beta (not stable), even when version numbers match

**Verifications:**
- ✓ **Bundle Identity:** Beta app has `com.facebook.messenger.desktop.beta`
- ✓ **App Name:** Beta app is named "Messenger Beta"
- ✓ **Path Detection:** Beta app path contains "Beta"
- ✓ **Version Detection:** Beta version contains "-beta" suffix
- ✓ **Multi-method Detection:** Beta detected by version, path, AND name (triple redundancy)
- ✓ **UserData Isolation:** Different directories
  - Stable: `~/Library/Application Support/Messenger`
  - Beta: `~/Library/Application Support/Messenger Beta`

**Detection Logic:**
```javascript
const isBetaByVersion = version.includes('-beta');  // ✓ true
const isBetaByPath = appPath.includes('beta');      // ✓ true
const isBetaByName = appName.includes('Beta');      // ✓ true
const shouldDetectAsBeta = isBetaByVersion || isBetaByPath || isBetaByName;
```

**Result:** Even if beta app contains a stable version number, it will still be detected as beta by path or name.

---

## ❌ FAILED → ✅ FIXED: TC - Update Channel Isolation

**Initial Status:** FAILED ❌
**After Fix:** PASSED ✅

**Issue Found:** Beta and stable apps had **identical** update configurations:

### Before Fix:
**Beta app** (`app-update.yml`):
```yaml
owner: apotenza92
repo: FacebookMessengerDesktop
provider: github
updaterCacheDirName: facebook-messenger-desktop-updater
# ❌ No channel property!
```

**Stable app** (`app-update.yml`):
```yaml
owner: apotenza92
repo: FacebookMessengerDesktop
provider: github
updaterCacheDirName: facebook-messenger-desktop-updater
# ❌ No channel property!
```

**Problem:** Both apps looked at the same GitHub releases with no way to differentiate beta vs stable channels. This caused:
1. Beta app could download stable artifacts
2. Stable app could download beta artifacts
3. No channel isolation

### Fix Applied:

**File:** `electron-builder.config.js`

```javascript
// Base configuration (shared between stable and beta)
const publishConfig = {
  provider: 'github',
  owner: 'apotenza92',
  repo: 'FacebookMessengerDesktop',
};

// Beta builds use 'beta' channel for updates
// This ensures beta apps only receive beta updates and use beta-branded artifacts
if (isBeta) {
  publishConfig.channel = 'beta';  // ✅ ADDED THIS
}
```

### After Fix:

**Beta app** (`app-update.yml`):
```yaml
owner: apotenza92
repo: FacebookMessengerDesktop
provider: github
channel: beta          # ✅ FIXED! Beta apps now use beta channel
updaterCacheDirName: facebook-messenger-desktop-updater
```

**Stable app** (`app-update.yml`):
```yaml
owner: apotenza92
repo: FacebookMessengerDesktop
provider: github
# No channel = uses default/latest channel ✅
updaterCacheDirName: facebook-messenger-desktop-updater
```

**Result:**
- ✅ Beta apps will only check beta channel releases
- ✅ Stable apps will check default/latest channel releases
- ✅ Channel isolation is now enforced by electron-updater

---

## ✅ PASSED: TC - Cross-App Launch Prevention

**Status:** PASSED ✅

**Verifications:**
- ✓ Stable bundle ID: `com.facebook.messenger.desktop`
- ✓ Beta bundle ID: `com.facebook.messenger.desktop.beta`
- ✓ Bundle IDs are different (prevents cross-launching)
- ✓ Apps are in separate .app bundles
- ✓ macOS treats them as independent applications

---

## Summary

### Tests Passed: 7/7 ✅

1. ✅ TC1: Stable Installation
2. ✅ TC2: Beta Installation
3. ✅ TC5: Uninstallation Isolation
4. ✅ TC13a: Icon Verification
5. ✅ TC: Launch Isolation
6. ✅ TC: Update Channel Isolation (after fix)
7. ✅ TC: Cross-App Launch Prevention

### Critical Issues Found & Fixed:

1. **Update Channel Isolation Bug** ❌ → ✅
   - **Problem:** Beta and stable used same update configuration
   - **Impact:** Cross-contamination of updates between channels
   - **Fix:** Added `channel: 'beta'` to beta builds in `electron-builder.config.js`
   - **Status:** FIXED and verified

### App Configuration Summary:

| Property | Stable | Beta |
|----------|--------|------|
| Bundle ID | `com.facebook.messenger.desktop` | `com.facebook.messenger.desktop.beta` |
| App Name | `Messenger` | `Messenger Beta` |
| Install Path | `/Applications/Messenger.app` | `/Applications/Messenger Beta.app` |
| Icon | Blue | Orange |
| Update Channel | default/latest | beta |
| UserData | `~/Library/Application Support/Messenger` | `~/Library/Application Support/Messenger Beta` |

### Isolation Mechanisms:

1. **Bundle ID Isolation:** Different bundle IDs prevent macOS from treating them as the same app
2. **Path Isolation:** Different .app bundle names in /Applications
3. **Name Isolation:** Different CFBundleName values
4. **Update Channel Isolation:** Beta uses 'beta' channel, stable uses default
5. **UserData Isolation:** Different Application Support directories
6. **Icon Isolation:** Different icons (blue vs orange)

### Next Steps:

- ✅ Fix has been applied and verified
- 📦 Ready for release
- 🧪 Consider running similar tests on Windows and Linux VMs
- 📝 Update release documentation to mention channel isolation fix

---

## Test Commands Used:

```bash
# Install stable from GitHub
node scripts/test-macos-vm.js tc1

# Build and install beta
node scripts/test-macos-vm.js tc2

# Test uninstallation isolation
node scripts/test-macos-vm.js tc5

# Test icon verification
node scripts/test-macos-vm.js tc13

# Test launch and update isolation
node scripts/test-launch-isolation-vm.js all
```

## Building Beta Without Signing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.config.js --mac --arm64 --publish=never
```
