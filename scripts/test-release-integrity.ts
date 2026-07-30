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
  const feedSetup = main.slice(
    main.indexOf("async function configureUpdateFeed"),
    main.indexOf("async function closeVerifiedUpdateFeed"),
  );
  assert.match(feedSetup, /await createTufVerifiedUpdateFeed\(/);
  assert(
    feedSetup.indexOf("await createTufVerifiedUpdateFeed(") <
      feedSetup.lastIndexOf("autoUpdater.setFeedURL"),
    "TUF must authenticate non-macOS metadata before electron-updater sees it",
  );
  assert.match(feedSetup, /embeddedRootPath:[\s\S]*?update-trust[\s\S]*?root\.json/);
  assert.match(feedSetup, /disableWebInstaller/);

  const updateCheck = main.slice(
    main.indexOf("async function checkForUpdates"),
    main.indexOf("function openGitHubPage"),
  );
  assert(
    updateCheck.indexOf("await verifiedUpdateFeed?.refresh()") <
      updateCheck.indexOf("await autoUpdater.checkForUpdates()"),
    "TUF refresh must complete before electron-updater checks metadata",
  );

  const updateDialog = main.slice(
    main.indexOf("async function showUpdateAvailableDialog"),
    main.indexOf("async function showUpdateReadyDialog"),
  );
  assert.match(updateDialog, /await downloadUpdateWithProgress\(version\)/);
  assert.doesNotMatch(updateDialog, /downloadLinuxPackage|installLinuxPackage/);
  assert.doesNotMatch(updateDialog, /downloadWindowsUpdate|shell\.openPath/);
  assert.doesNotMatch(main, /sudo -S|zenity --password|kdialog --password/);

  const readyDialog = main.slice(
    main.indexOf("async function showUpdateReadyDialog"),
    main.indexOf("function setupAutoUpdater"),
  );
  assert(
    readyDialog.indexOf("await closeVerifiedUpdateFeed()") <
      readyDialog.indexOf("autoUpdater.quitAndInstall"),
    "the loopback feed must close before installation begins",
  );
}

function testUpdaterChangelogContract(): void {
  const root = path.resolve(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "src", "main", "main.ts"), "utf8");
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const changelogFlow = main.slice(
    main.indexOf("function fetchChangelogFromGitHub"),
    main.indexOf("function openGitHubPage"),
  );
  const updateDialog = main.slice(
    main.indexOf("async function showCustomUpdateDialog"),
    main.indexOf("async function showUpdateReadyDialog"),
  );
  assert.match(
    changelogFlow,
    /raw\.githubusercontent\.com\/apotenza92\/facebook-messenger-desktop\/main\/CHANGELOG\.md/,
    "update dialogs must load the maintained changelog",
  );
  assert.match(
    changelogFlow,
    /entry\.version === newVersion/,
    "update dialogs must select the exact target release entry",
  );
  assert.match(
    updateDialog,
    /await getChangelogForUpdate\(/,
    "the update-available flow must wait for release notes",
  );
  assert.match(
    updateDialog,
    /What's New/,
    "the update dialog must present release notes to users",
  );
  assert.match(
    main,
    /console\.log\("\[Update Frequency\] Using default setting: daily"\);\s+return "daily";/,
    "automatic update checks must retain the documented daily default",
  );
  assert.match(
    main,
    /if \(shouldCheckForUpdates\(\)\) \{\s+performUpdateCheck\(\);\s+\}/,
    "startup must evaluate whether an automatic update check is due",
  );
  assert.match(
    main,
    /startUpdateCheckSchedule\(\);/,
    "long-running sessions must retain periodic update checks",
  );
  assert.match(
    workflow,
    /Prepare release notes[\s\S]*?CHANGELOG\.md[\s\S]*?--notes-file release_notes\.txt/,
    "GitHub release notes must come from the same maintained changelog",
  );
}

for (const test of [
  testPackageManagerIdentities,
  testReleaseChecksumValidation,
  testUpdaterAuthenticationOrder,
  testUpdaterChangelogContract,
]) {
  test();
  console.log(`✓ ${test.name}`);
}
