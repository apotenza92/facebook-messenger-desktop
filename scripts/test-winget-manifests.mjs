import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { createWingetManifests } from "./create-winget-manifests.mjs";

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex").toUpperCase();
}

function load(filePath) {
  return yaml.load(readFileSync(filePath, "utf8"));
}

function fixture(channel) {
  const root = mkdtempSync(join(tmpdir(), "messenger-winget-"));
  const x64Name = `${channel === "beta" ? "Messenger-Beta" : "Messenger"}-windows-x64-setup.exe`;
  const arm64Name = `${channel === "beta" ? "Messenger-Beta" : "Messenger"}-windows-arm64-setup.exe`;
  const x64Installer = join(root, x64Name);
  const arm64Installer = join(root, arm64Name);
  writeFileSync(x64Installer, `${channel} x64 fixture`);
  writeFileSync(arm64Installer, `${channel} arm64 fixture`);
  const version = channel === "beta" ? "1.3.2-beta.1" : "1.3.2";
  return {
    root,
    outputDirectory: join(root, "manifests"),
    channel,
    version,
    releaseDate: "2026-07-22",
    x64Installer,
    x64Url: `https://github.com/apotenza92/facebook-messenger-desktop/releases/download/v${version}/${x64Name}`,
    arm64Installer,
    arm64Url: `https://github.com/apotenza92/facebook-messenger-desktop/releases/download/v${version}/${arm64Name}`,
  };
}

for (const channel of ["stable", "beta"]) {
  const options = fixture(channel);
  try {
    const result = createWingetManifests(options);
    const identifier =
      channel === "beta"
        ? "apotenza92.FacebookMessengerDesktopBeta"
        : "apotenza92.FacebookMessengerDesktop";
    assert.equal(result.identifier, identifier);
    assert.deepEqual(result.files, [
      `${identifier}.installer.yaml`,
      `${identifier}.locale.en-US.yaml`,
      `${identifier}.yaml`,
    ]);

    const installer = load(
      join(options.outputDirectory, `${identifier}.installer.yaml`),
    );
    assert.equal(installer.PackageIdentifier, identifier);
    assert.equal(installer.PackageVersion, options.version);
    assert.equal(installer.InstallerType, "nullsoft");
    assert.equal(installer.Scope, "user");
    assert.equal(installer.ReleaseDate, options.releaseDate);
    assert.deepEqual(
      installer.Installers.map((entry) => entry.Architecture),
      ["x64", "arm64"],
    );
    assert.equal(
      installer.Installers[0].InstallerSha256,
      digest(`${channel} x64 fixture`),
    );
    assert.equal(
      installer.Installers[1].InstallerSha256,
      digest(`${channel} arm64 fixture`),
    );

    const locale = load(
      join(options.outputDirectory, `${identifier}.locale.en-US.yaml`),
    );
    assert.equal(
      locale.PackageName,
      channel === "beta" ? "Messenger Beta" : "Messenger",
    );
    assert.match(locale.ShortDescription, /^An unofficial,/);
    assert.equal(
      locale.ReleaseNotesUrl,
      `https://github.com/apotenza92/facebook-messenger-desktop/releases/tag/v${options.version}`,
    );

    assert.throws(
      () => createWingetManifests(options),
      /output directory must be empty/,
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
}

{
  const options = fixture("stable");
  try {
    for (const version of [
      "1.3.2-alpha.1",
      "1.3.2-rc.1",
      "1.3.2-beta.0",
      "1.3.2-beta.01",
      "1.3.2-beta.1",
    ]) {
      assert.throws(
        () => createWingetManifests({ ...options, version }),
        /Unsupported stable WinGet package version/,
      );
    }
    const betaOptions = fixture("beta");
    try {
      for (const version of [
        "1.3.2",
        "1.3.2-alpha.1",
        "1.3.2-rc.1",
        "1.3.2-beta.0",
        "1.3.2-beta.01",
      ]) {
        assert.throws(
          () => createWingetManifests({ ...betaOptions, version }),
          /Unsupported beta WinGet package version/,
        );
      }
    } finally {
      rmSync(betaOptions.root, { recursive: true, force: true });
    }
    assert.throws(
      () =>
        createWingetManifests({
          ...options,
          x64Url: options.x64Url.replace("v1.3.2", "v1.3.1"),
        }),
      /immutable release asset/,
    );
    assert.throws(
      () => createWingetManifests({ ...options, releaseDate: "2026-02-30" }),
      /Release date is invalid/,
    );
    mkdirSync(options.outputDirectory, { recursive: true });
    assert.throws(
      () =>
        createWingetManifests({
          ...options,
          x64Installer: join(options.root, "missing.exe"),
        }),
      /Missing x64 installer/,
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
}

console.log("✓ WinGet manifest generation tests passed");
