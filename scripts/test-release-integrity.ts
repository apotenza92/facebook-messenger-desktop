import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePackageManagerContract } from "../src/main/package-manager-contract";
import { verifyReleaseAssetChecksum } from "../src/main/release-integrity";

function testPackageManagerIdentities(): void {
  assert.deepEqual(resolvePackageManagerContract("stable"), {
    flatpakAppId: "com.facebook.messenger.desktop",
    homebrewCask: "apotenza92/tap/facebook-messenger-desktop",
    linuxPackageName: "facebook-messenger-desktop",
    snapChannel: "stable",
    snapPackageName: "facebook-messenger-desktop",
    wingetId: "apotenza92.FacebookMessengerDesktop",
  });
  assert.deepEqual(resolvePackageManagerContract("beta"), {
    flatpakAppId: "com.facebook.messenger.desktop.beta",
    homebrewCask: "apotenza92/tap/facebook-messenger-desktop@beta",
    linuxPackageName: "facebook-messenger-desktop-beta",
    snapChannel: "beta",
    snapPackageName: "facebook-messenger-desktop",
    wingetId: "apotenza92.FacebookMessengerDesktopBeta",
  });
}

function testReleaseChecksumValidation(): void {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "messenger-release-integrity-"),
  );
  const assetName = "Messenger-windows-x64-setup.exe";
  const assetPath = path.join(directory, assetName);
  try {
    fs.writeFileSync(assetPath, "trusted fixture\n", { mode: 0o600 });
    const digest = createHash("sha256")
      .update(fs.readFileSync(assetPath))
      .digest("hex");
    const valid = `${digest}  ${assetName}\n`;
    assert.equal(
      verifyReleaseAssetChecksum(valid, assetName, assetPath),
      digest,
    );
    assert.throws(
      () =>
        verifyReleaseAssetChecksum(
          `${"0".repeat(64)}  ${assetName}\n`,
          assetName,
          assetPath,
        ),
      /does not authenticate/,
    );
    assert.throws(
      () => verifyReleaseAssetChecksum(valid, "missing.deb", assetPath),
      /exactly one entry/,
    );
    assert.throws(
      () => verifyReleaseAssetChecksum(`${valid}${valid}`, assetName, assetPath),
      /exactly one entry/,
    );
    assert.throws(
      () =>
        verifyReleaseAssetChecksum(
          `${valid}not-a-checksum\n`,
          assetName,
          assetPath,
        ),
      /malformed entry/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function testUpdaterAuthenticationOrder(): void {
  const main = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "main", "main.ts"),
    "utf8",
  );
  const windowsDownload = main.slice(
    main.indexOf("async function downloadWindowsUpdate"),
    main.indexOf("async function checkAndFixShortcutsAfterUpdate"),
  );
  const linuxDownload = main.slice(
    main.indexOf("async function downloadLinuxPackage"),
    main.indexOf("async function installLinuxPackage"),
  );
  for (const source of [windowsDownload, linuxDownload]) {
    assert(source.includes("await authenticateDownloadedReleaseAsset("));
    assert(
      source.indexOf("await new Promise<void>") <
        source.indexOf("await authenticateDownloadedReleaseAsset("),
      "download must complete before checksum authentication",
    );
  }
  assert(
    linuxDownload.includes('packageType: "AppImage" | "deb" | "rpm"'),
    "Direct Linux AppImage updates must use the checksum-authenticated downloader",
  );

  const releaseDiscovery = main.slice(
    main.indexOf("async function checkForUpdates"),
    main.indexOf("function openGitHubPage"),
  );
  assert.match(
    releaseDiscovery,
    /if \(process\.platform !== "darwin"\) \{\s+await showUpdateAvailableDialog\(targetRelease\.version\);\s+return;\s+\}/,
    "Windows and Linux must use GitHub release discovery without electron-updater metadata",
  );
  assert(
    releaseDiscovery.indexOf('if (process.platform !== "darwin")') <
      releaseDiscovery.indexOf("autoUpdater.setFeedURL"),
    "The non-macOS manual update path must return before electron-updater feed setup",
  );

  const updateDialog = main.slice(
    main.indexOf("async function showUpdateAvailableDialog"),
  );
  assert(
    updateDialog.indexOf("await downloadLinuxPackage(") <
      updateDialog.indexOf("await installLinuxPackage("),
    "Linux checksum-authenticated download must precede elevated installation",
  );
  assert(
    updateDialog.indexOf("await downloadWindowsUpdate(") <
      updateDialog.indexOf("shell.openPath(filePath)"),
    "Windows checksum-authenticated download must precede execution",
  );
}

for (const test of [
  testPackageManagerIdentities,
  testReleaseChecksumValidation,
  testUpdaterAuthenticationOrder,
]) {
  test();
  console.log(`✓ ${test.name}`);
}
