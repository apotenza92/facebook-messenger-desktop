import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import {
  normalizeFingerprint,
  parseCodesignMetadata,
  resolvePriorSigningFingerprints,
  resolveMacReleaseContract,
  validateNotarizationRecord,
  validateSignatureMetadata,
} from "./macos-release-contract.mjs";
import {
  assembleMacRelease,
  mergeMacUpdateMetadata,
} from "./assemble-macos-release.mjs";
import { assembleWindowsRelease } from "./assemble-windows-release.mjs";
import {
  assemblePublicRelease,
  expectedPublicReleaseContract,
} from "./assemble-public-release.mjs";
import {
  compareReleaseTags,
  legacyMetadataNames,
  resolveLegacyBridgeChannels,
} from "./legacy-updater-bridge.mjs";
import {
  compareVersions,
  resolveLegacyUpdaterBaseline,
  validateChecksumEntry,
} from "./test-macos-updater-e2e.mjs";
import {
  createMacLaunchEnvironment,
  validateBlockmap,
  validateZipEntries,
} from "./verify-macos-package.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

function loadBuilderConfig(environment, args = []) {
  const configPath = join(repositoryRoot, "electron-builder.config.js");
  const previousArgv = process.argv;
  const names = [
    "CSC_NAME",
    "FORCE_BETA_BUILD",
    "MESSENGER_REQUIRE_RELEASE_SIGNING",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    process.argv = [previousArgv[0], previousArgv[1], ...args];
    for (const name of names) {
      if (environment[name] == null) delete process.env[name];
      else process.env[name] = environment[name];
    }
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  } finally {
    process.argv = previousArgv;
    delete require.cache[require.resolve(configPath)];
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function testContracts() {
  assert.deepEqual(resolveMacReleaseContract("stable", "arm64"), {
    appName: "Messenger.app",
    arch: "arm64",
    artifactName: "Messenger-macos-arm64.zip",
    blockmapName: "Messenger-macos-arm64.zip.blockmap",
    bundleId: "com.facebook.messenger.desktop",
    channel: "stable",
    executableName: "Messenger",
    metadataName: "latest-mac.yml",
    notarizationName: "notarization-stable-macos-arm64.json",
    packageName: "facebook-messenger-desktop",
    productName: "Messenger",
    updaterChannel: "latest",
  });
  assert.equal(
    resolveMacReleaseContract("beta", "x64").artifactName,
    "Messenger-Beta-macos-x64.zip",
  );
  assert.equal(
    resolveMacReleaseContract("beta", "x64").bundleId,
    "com.facebook.messenger.desktop.beta",
  );
  assert.throws(
    () => resolveMacReleaseContract("preview", "arm64"),
    /stable or beta/,
  );
  assert.throws(
    () => resolveMacReleaseContract("stable", "universal"),
    /arm64 or x64/,
  );
}

function testSigningValidation() {
  const fingerprint = "ab".repeat(32);
  assert.equal(
    normalizeFingerprint(fingerprint.match(/.{2}/g).join(":")),
    fingerprint.toUpperCase(),
  );
  assert.throws(() => normalizeFingerprint("abcd"), /SHA-256/);
  const priorFingerprint = "cd".repeat(32);
  assert.deepEqual(
    resolvePriorSigningFingerprints(fingerprint, priorFingerprint),
    [fingerprint.toUpperCase(), priorFingerprint.toUpperCase()],
  );
  assert.deepEqual(resolvePriorSigningFingerprints(fingerprint, fingerprint), [
    fingerprint.toUpperCase(),
  ]);
  const metadata = parseCodesignMetadata(
    [
      "Identifier=com.facebook.messenger.desktop",
      "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded",
      "Authority=Developer ID Application: Example (TEAM123456)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=TEAM123456",
      "Timestamp=22 Jul 2026 at 10:00:00",
      "CDHash=abcdef",
    ].join("\n"),
  );
  assert.doesNotThrow(() =>
    validateSignatureMetadata(
      metadata,
      {
        identity: "Developer ID Application: Example (TEAM123456)",
        teamId: "TEAM123456",
      },
      "Messenger.app",
    ),
  );
  assert.throws(
    () =>
      validateSignatureMetadata(
        metadata,
        {
          identity: "Developer ID Application: Other (TEAM123456)",
          teamId: "TEAM123456",
        },
        "Messenger.app",
      ),
    /signer/,
  );
  assert.doesNotThrow(() =>
    validateNotarizationRecord({
      submission: { id: "submission-id", status: "Accepted" },
      log: { jobId: "submission-id", status: "Accepted", issues: [] },
    }),
  );
  assert.throws(
    () =>
      validateNotarizationRecord({
        submission: { id: "submission-id", status: "Accepted" },
        log: { jobId: "different-id", status: "Accepted", issues: [] },
      }),
    /job ID/,
  );
}

function testLegacyUpdaterBaselines() {
  const baseline = resolveLegacyUpdaterBaseline("stable", "arm64", "v1.3.0", {
    name: "Messenger-macos-arm64.zip",
    digest:
      "sha256:8fe5bb11350e0153d875fb3b7d9e5a92e507cbfc4e69bbe67141179cc696836a",
  });
  assert.equal(baseline?.tag, "v1.3.0");
  assert.equal(
    resolveLegacyUpdaterBaseline("stable", "arm64", "v1.2.9", {
      name: "Messenger-macos-arm64.zip",
      digest: baseline ? `sha256:${baseline.sha256}` : "",
    }),
    null,
  );
  assert.throws(
    () =>
      resolveLegacyUpdaterBaseline("stable", "arm64", "v1.3.0", {
        name: "Messenger-macos-arm64.zip",
        digest: `sha256:${"00".repeat(32)}`,
      }),
    /source-pinned legacy baseline/,
  );
}

function testArchiveValidation() {
  const contract = resolveMacReleaseContract("stable", "arm64");
  assert.doesNotThrow(() =>
    validateZipEntries(
      [
        "Messenger.app/",
        "Messenger.app/Contents/",
        "Messenger.app/Contents/MacOS/",
        "Messenger.app/Contents/MacOS/Messenger",
      ].join("\n"),
      contract,
    ),
  );
  assert.throws(
    () => validateZipEntries("Messenger.app/../escape", contract),
    /traversal/,
  );
  assert.doesNotThrow(() =>
    validateBlockmap(
      {
        version: "2",
        files: [{ sizes: [4, 6], checksums: ["a", "b"] }],
      },
      10,
      "fixture.blockmap",
    ),
  );
  assert.throws(
    () =>
      validateBlockmap(
        {
          version: "2",
          files: [{ sizes: [4], checksums: ["a"] }],
        },
        10,
        "fixture.blockmap",
      ),
    /represents/,
  );
}

function testLaunchEnvironmentAllowlist() {
  const environment = createMacLaunchEnvironment(
    "/isolated/home",
    "/isolated/tmp",
  );
  assert.deepEqual(Object.keys(environment).sort(), [
    "HOME",
    "LANG",
    "LC_ALL",
    "MESSENGER_TEST_SKIP_STARTUP_PERMISSIONS",
    "PATH",
    "SKIP_SINGLE_INSTANCE_LOCK",
    "TMPDIR",
  ]);
  assert.equal(environment.HOME, "/isolated/home");
  assert.equal(environment.TMPDIR, "/isolated/tmp");
  assert.equal(environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
}

function testMetadataMerge() {
  const x64 = {
    arch: "x64",
    version: "1.2.3",
    size: 20,
    sha512: "x64-sha",
    metadata: {
      version: "1.2.3",
      files: [{ url: "Messenger-macos-x64.zip", size: 20, sha512: "x64-sha" }],
      releaseDate: "2026-07-22T10:00:00Z",
    },
  };
  const arm64 = {
    arch: "arm64",
    version: "1.2.3",
    size: 10,
    sha512: "arm-sha",
    metadata: {
      version: "1.2.3",
      files: [
        { url: "Messenger-macos-arm64.zip", size: 10, sha512: "arm-sha" },
      ],
      releaseDate: "2026-07-22T10:01:00Z",
    },
  };
  const merged = mergeMacUpdateMetadata([arm64, x64], "stable");
  assert.deepEqual(
    merged.files.map((file) => file.url),
    ["Messenger-macos-x64.zip", "Messenger-macos-arm64.zip"],
  );
  assert.equal(merged.path, "Messenger-macos-x64.zip");
  assert.equal(merged.sha512, "x64-sha");
  assert.equal(merged.releaseDate, "2026-07-22T10:01:00Z");
  assert.throws(
    () => mergeMacUpdateMetadata([arm64], "stable"),
    /Exactly one x64 and one arm64/,
  );
}

function testMetadataAssembly() {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "messenger-assemble-test-"),
  );
  const inputDirectory = join(temporaryDirectory, "input");
  const outputDirectory = join(temporaryDirectory, "output");
  const version = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  try {
    for (const arch of ["arm64", "x64"]) {
      const contract = resolveMacReleaseContract("beta", arch);
      const sourceDirectory = join(inputDirectory, `macos-input-${arch}`);
      mkdirSync(sourceDirectory, { recursive: true });
      const artifact = Buffer.from(`signed-${arch}-fixture`);
      const sha256 = createHash("sha256").update(artifact).digest("hex");
      const sha512 = createHash("sha512").update(artifact).digest("base64");
      writeFileSync(join(sourceDirectory, contract.artifactName), artifact);
      writeFileSync(
        join(sourceDirectory, contract.blockmapName),
        "fixture-blockmap",
      );
      writeFileSync(
        join(sourceDirectory, `${contract.artifactName}.sha256`),
        `${sha256}  ${contract.artifactName}\n`,
      );
      writeFileSync(
        join(sourceDirectory, contract.notarizationName),
        JSON.stringify({
          submission: { id: `fixture-${arch}`, status: "Accepted" },
          log: { jobId: `fixture-${arch}`, status: "Accepted", issues: [] },
        }),
      );
      writeFileSync(
        join(sourceDirectory, contract.metadataName),
        yaml.dump({
          version,
          files: [
            { url: contract.artifactName, sha512, size: artifact.length },
          ],
          path: contract.artifactName,
          sha512,
          releaseDate:
            arch === "x64" ? "2026-07-22T10:00:00Z" : "2026-07-22T10:01:00Z",
        }),
      );
    }
    assembleMacRelease({
      inputDirectory,
      outputDirectory,
      releaseChannel: "beta",
    });
    const metadata = yaml.load(
      readFileSync(join(outputDirectory, "beta-mac.yml"), "utf8"),
    );
    assert.deepEqual(
      metadata.files.map((file) => file.url),
      ["Messenger-Beta-macos-x64.zip", "Messenger-Beta-macos-arm64.zip"],
    );
    assert.equal(metadata.path, "Messenger-Beta-macos-x64.zip");
    assert.match(
      readFileSync(join(outputDirectory, "SHA256SUMS-macos.txt"), "utf8"),
      /Messenger-Beta-macos-arm64\.zip/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function testWindowsInstallerAssembly() {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "messenger-windows-assemble-test-"),
  );
  try {
    const inputDirectory = join(temporaryDirectory, "input");
    const outputDirectory = join(temporaryDirectory, "output");
    for (const arch of ["x64", "arm64"]) {
      const directory = join(inputDirectory, `windows-input-${arch}`);
      mkdirSync(directory, { recursive: true });
      const artifactName = `Messenger-Beta-windows-${arch}-setup.exe`;
      writeFileSync(join(directory, artifactName), `unsigned-${arch}`);
    }
    assembleWindowsRelease({
      inputDirectory,
      outputDirectory,
      releaseChannel: "beta",
    });
    assert.deepEqual(
      readdirSync(outputDirectory).sort(),
      [
        "Messenger-Beta-windows-x64-setup.exe",
        "Messenger-Beta-windows-arm64-setup.exe",
      ].sort(),
    );
    writeFileSync(
      join(inputDirectory, "windows-input-x64", "unexpected.exe"),
      "bad",
    );
    assert.throws(
      () =>
        assembleWindowsRelease({
          inputDirectory,
          outputDirectory,
          releaseChannel: "beta",
        }),
      /do not exactly match/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function testPublicReleaseAssembly() {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "messenger-public-assemble-test-"),
  );
  try {
    const inputDirectory = join(temporaryDirectory, "input");
    const outputDirectory = join(temporaryDirectory, "output");
    const contract = expectedPublicReleaseContract("beta");
    for (const [artifactName, entry] of Object.entries(contract)) {
      const directory = join(inputDirectory, artifactName);
      mkdirSync(directory, { recursive: true });
      for (const name of entry.source)
        writeFileSync(join(directory, name), `${artifactName}/${name}`);
    }
    const output = assemblePublicRelease({
      inputDirectory,
      outputDirectory,
      releaseChannel: "beta",
    });
    const expected = Object.values(contract)
      .flatMap((entry) => entry.publish)
      .sort();
    assert.deepEqual(output, expected);
    assert.equal(output.includes("SHA256SUMS-macos.txt"), false);
    assert.equal(
      output.some((name) => name.startsWith("notarization-")),
      false,
    );
    const stableInput = join(temporaryDirectory, "stable-input");
    const stableOutput = join(temporaryDirectory, "stable-output");
    const stableContract = expectedPublicReleaseContract("stable");
    for (const [artifactName, entry] of Object.entries(stableContract)) {
      const directory = join(stableInput, artifactName);
      mkdirSync(directory, { recursive: true });
      for (const name of entry.source)
        writeFileSync(join(directory, name), `${artifactName}/${name}`);
    }
    const stableAssets = assemblePublicRelease({
      inputDirectory: stableInput,
      outputDirectory: stableOutput,
      releaseChannel: "stable",
    });
    assert(stableAssets.includes("latest-mac.yml"));
    assert(stableAssets.includes("beta-mac.yml"));
    assert(stableAssets.includes("Messenger-windows-x64-setup.exe"));
    assert(stableAssets.includes("Messenger-Beta-windows-arm64-setup.exe"));
    assert.deepEqual(
      stableAssets.filter((name) => name.endsWith(".yml")).sort(),
      ["beta-mac.yml", "latest-mac.yml"],
      "Only signed macOS packages may publish electron-updater metadata",
    );
    assert.equal(new Set(stableAssets).size, stableAssets.length);
    writeFileSync(
      join(inputDirectory, "linux-build-arm64", "unexpected.tmp"),
      "bad",
    );
    assert.throws(
      () =>
        assemblePublicRelease({
          inputDirectory,
          outputDirectory,
          releaseChannel: "beta",
        }),
      /does not exactly match/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function testLegacyUpdaterBridge() {
  const asset = (name, marker = null) => ({
    browser_download_url: `https://example.invalid/${name}`,
    name,
    text:
      marker == null
        ? "version: 1.3.0\n"
        : `version: 1.3.1-beta.41\nmigrationBridge: ${marker}\n`,
  });
  const legacyRelease = (tag, channel, prerelease) => ({
    assets: legacyMetadataNames(channel).map((name) => asset(name)),
    draft: false,
    prerelease,
    tag_name: tag,
  });
  const readAsset = async (item) => item.text;

  assert(compareReleaseTags("v1.3.1-beta.40", "v1.3.1-beta.41") < 0);
  assert(compareReleaseTags("v1.3.1-beta.41", "v1.3.1") < 0);
  await assert.rejects(
    resolveLegacyBridgeChannels({
      approvals: {},
      currentTag: "v1.3.1-beta.41",
      readAsset,
      releaseChannel: "beta",
      releases: [legacyRelease("v1.3.1-beta.40", "beta", true)],
    }),
    /MESSENGER_LEGACY_UPDATER_BRIDGE_BETA_TAG/,
  );
  assert.deepEqual(
    await resolveLegacyBridgeChannels({
      approvals: { beta: "v1.3.1-beta.41" },
      currentTag: "v1.3.1-beta.41",
      readAsset,
      releaseChannel: "beta",
      releases: [legacyRelease("v1.3.1-beta.40", "beta", true)],
    }),
    ["beta"],
  );
  const completedBridge = {
    assets: legacyMetadataNames("beta").map((name) => asset(name, 1)),
    draft: false,
    prerelease: true,
    tag_name: "v1.3.1-beta.41",
  };
  assert.deepEqual(
    await resolveLegacyBridgeChannels({
      approvals: {},
      currentTag: "v1.3.1-beta.41",
      readAsset,
      releaseChannel: "beta",
      releases: [completedBridge],
    }),
    ["beta"],
    "An immutable-release rerun must reproduce the already-published bridge",
  );
  assert.deepEqual(
    await resolveLegacyBridgeChannels({
      approvals: { beta: "v1.3.1-beta.42" },
      currentTag: "v1.3.1-beta.42",
      readAsset,
      releaseChannel: "beta",
      releases: [
        legacyRelease("v1.3.1-beta.40", "beta", true),
        completedBridge,
      ],
    }),
    [],
    "A marked bridge must end the compatibility window even if an approval is advanced",
  );
  assert.deepEqual(
    await resolveLegacyBridgeChannels({
      approvals: { stable: "v1.3.1" },
      currentTag: "v1.3.1",
      readAsset,
      releaseChannel: "stable",
      releases: [legacyRelease("v1.3.0", "stable", false), completedBridge],
    }),
    ["stable"],
    "Stable may bridge after beta has already completed its one-release bridge",
  );
  const partial = legacyRelease("v1.3.1-beta.40", "beta", true);
  partial.assets.pop();
  await assert.rejects(
    resolveLegacyBridgeChannels({
      approvals: { beta: "v1.3.1-beta.41" },
      currentTag: "v1.3.1-beta.41",
      readAsset,
      releaseChannel: "beta",
      releases: [partial],
    }),
    /incomplete beta legacy updater contract/,
  );

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "messenger-legacy-bridge-test-"),
  );
  try {
    const inputDirectory = join(temporaryDirectory, "input");
    const outputDirectory = join(temporaryDirectory, "output");
    const bridgeChannels = ["stable", "beta"];
    const contract = expectedPublicReleaseContract("stable", bridgeChannels);
    const version = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ).version;
    for (const [artifactName, entry] of Object.entries(contract)) {
      const directory = join(inputDirectory, artifactName);
      mkdirSync(directory, { recursive: true });
      for (const name of entry.source) {
        const contents =
          name === "bridge-policy.json"
            ? JSON.stringify({ channels: bridgeChannels, version })
            : `${artifactName}/${name}`;
        writeFileSync(join(directory, name), contents);
      }
    }
    const output = assemblePublicRelease({
      inputDirectory,
      legacyBridgeChannels: bridgeChannels,
      outputDirectory,
      releaseChannel: "stable",
    });
    assert(output.includes("Messenger-windows-setup.exe"));
    assert(output.includes("Messenger-Beta-windows-setup.exe"));
    for (const channel of bridgeChannels) {
      for (const name of legacyMetadataNames(channel))
        assert(output.includes(name), `Missing bridge metadata ${name}`);
    }
    const windows = yaml.load(
      readFileSync(join(outputDirectory, "latest.yml"), "utf8"),
    );
    assert.equal(windows.migrationBridge, 1);
    assert.equal(windows.path, "Messenger-windows-setup.exe");
    assert.equal(windows.files.length, 1);
    const windowsContents = readFileSync(join(outputDirectory, windows.path));
    assert.equal(
      windows.sha512,
      createHash("sha512").update(windowsContents).digest("base64"),
    );
    const linuxArm = yaml.load(
      readFileSync(join(outputDirectory, "beta-linux-arm64.yml"), "utf8"),
    );
    assert.equal(linuxArm.migrationBridge, 1);
    assert.equal(
      linuxArm.path,
      "facebook-messenger-desktop-beta-arm64.AppImage",
    );
    assert.deepEqual(
      linuxArm.files.map((entry) => entry.url),
      [
        "facebook-messenger-desktop-beta-arm64.AppImage",
        "facebook-messenger-desktop-beta-arm64.deb",
        "facebook-messenger-desktop-beta-aarch64.rpm",
      ],
    );
    const policyPath = join(
      inputDirectory,
      "legacy-updater-bridge-build",
      "bridge-policy.json",
    );
    writeFileSync(policyPath, JSON.stringify({ channels: ["beta"], version }));
    assert.throws(
      () =>
        assemblePublicRelease({
          inputDirectory,
          legacyBridgeChannels: bridgeChannels,
          outputDirectory,
          releaseChannel: "stable",
        }),
      /policy does not match/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function testUpdaterTrustUtilities() {
  assert(compareVersions("v1.3.1-beta.40", "v1.3.1-beta.41") < 0);
  assert(compareVersions("v1.3.1-beta.41", "v1.3.1") < 0);
  assert(compareVersions("v1.3.1", "v1.3.0") > 0);
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "messenger-checksum-test-"),
  );
  try {
    const artifact = join(temporaryDirectory, "Messenger.zip");
    writeFileSync(artifact, "trusted fixture");
    const digest = createHash("sha256").update("trusted fixture").digest("hex");
    assert.equal(
      validateChecksumEntry(
        `${digest}  Messenger.zip\n`,
        "Messenger.zip",
        artifact,
      ),
      digest,
    );
    assert.throws(
      () =>
        validateChecksumEntry(
          `${digest} *Messenger.zip\n`,
          "Messenger.zip",
          artifact,
        ),
      /malformed/,
    );
    assert.throws(
      () =>
        validateChecksumEntry(
          `${"0".repeat(64)}  Messenger.zip\n`,
          "Messenger.zip",
          artifact,
        ),
      /does not authenticate/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function testBuilderContract() {
  assert.throws(
    () =>
      loadBuilderConfig({
        MESSENGER_REQUIRE_RELEASE_SIGNING: "true",
      }),
    /CSC_NAME is required/,
  );
  const unsigned = loadBuilderConfig({});
  assert.equal(unsigned.afterSign, "./scripts/notarize-macos.cjs");
  assert.equal(unsigned.forceCodeSigning, false);
  assert.equal(unsigned.mac.notarize, false);

  const signed = loadBuilderConfig({
    CSC_NAME: "Example (TEAM123456)",
    FORCE_BETA_BUILD: "true",
    MESSENGER_REQUIRE_RELEASE_SIGNING: "true",
  }, ["--mac"]);
  assert.equal(signed.forceCodeSigning, true);
  assert.equal(signed.mac.identity, "Example (TEAM123456)");
  assert.equal(signed.mac.hardenedRuntime, true);
  assert.equal(signed.mac.notarize, false);
  assert.equal(signed.appId, "com.facebook.messenger.desktop.beta");
  assert.equal(signed.productName, "Messenger Beta");
  assert.equal(signed.mac.artifactName, "Messenger-Beta-macos-${arch}.${ext}");
  assert.deepEqual(signed.publish, [
    {
      provider: "github",
      owner: "apotenza92",
      repo: "facebook-messenger-desktop",
      channel: "beta",
    },
  ]);
  assert.equal(
    loadBuilderConfig({}, ["--win"]).publish,
    undefined,
    "Windows packages must not embed or generate electron-updater publication metadata",
  );
  assert.equal(
    loadBuilderConfig({}, ["--linux"]).publish,
    undefined,
    "Linux packages must not embed or generate electron-updater publication metadata",
  );
}

function testWorkflowContract() {
  const workflow = readFileSync(
    join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const releaseScript = readFileSync(
    join(repositoryRoot, "scripts", "release.sh"),
    "utf8",
  );
  const jobSource = (source, jobId) => {
    const match = source.match(
      new RegExp(
        `^  ${jobId}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`,
        "m",
      ),
    );
    assert(match, `Workflow job ${jobId} is missing`);
    return match[1];
  };
  const validateRelease = jobSource(workflow, "validate-release");
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - "v\*"/m);
  assert.doesNotMatch(
    workflow,
    /^\s*(?:pull_request|pull_request_target|workflow_run|workflow_dispatch):/m,
  );
  assert.match(validateRelease, /Verify tag and main provenance/);
  assert.match(validateRelease, /test "\$TAG_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(validateRelease, /test "\$TAG_COMMIT" = "\$MAIN_COMMIT"/);
  assert(
    validateRelease.includes(
      "const prerelease = /^v\\d+\\.\\d+\\.\\d+-beta\\.[1-9]\\d*$/.test(tag);",
    ),
    "Hosted release grammar must accept only numbered beta prereleases",
  );
  assert.doesNotMatch(workflow, /contains\(github\.ref/);
  assert.doesNotMatch(workflow, /\balpha\b|\brc\b/);
  const releasePolicy = jobSource(workflow, "release-policy");
  assert.match(releasePolicy, /environment:\s*release-policy/);
  assert.match(releasePolicy, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(releasePolicy, /curl --fail/);
  assert.match(
    releasePolicy,
    /repos\/\$\{GITHUB_REPOSITORY\}\/immutable-releases/,
  );
  assert.match(releasePolicy, /X-GitHub-Api-Version: 2026-03-10/);
  assert.match(releasePolicy, /jq -e '\.enabled == true'/);
  assert.doesNotMatch(releasePolicy, /--request|-X\s|gh api/);
  assert.doesNotMatch(releasePolicy, /\$\{\{\s*github\.token\s*\}\}/);
  assert.doesNotMatch(
    releasePolicy,
    /\$\{\{\s*secrets\.(?!IMMUTABLE_RELEASES_READ_TOKEN)/,
  );
  assert.equal(
    (workflow.match(/secrets\.IMMUTABLE_RELEASES_READ_TOKEN/g) ?? []).length,
    1,
    "The immutable-release read token must be isolated to one policy step",
  );
  assert.match(
    jobSource(workflow, "release"),
    /needs:\s*\[[^\]]*release-policy/,
  );
  assert.match(
    jobSource(workflow, "release"),
    /environment:\s*\n\s+name:\s*\$\{\{ needs\.validate-release\.outputs\.release_environment \}\}/,
  );
  assert.equal(
    (
      workflow.match(
        /needs\.validate-release\.outputs\.release_environment/g,
      ) ?? []
    ).length,
    1,
    "Stable/beta publication approval must gate only the final release job",
  );
  assert.match(workflow, /environment:\s*release-signing/);
  assert.match(workflow, /runner:\s*macos-15\b/);
  assert.match(workflow, /runner:\s*macos-15-intel\b/);
  assert.match(workflow, /APPLE_SIGNING_CERTIFICATE_P12_BASE64/);
  assert.match(workflow, /APPLE_NOTARYTOOL_KEY_P8_BASE64/);
  assert.match(
    workflow,
    /APPLE_NOTARYTOOL_KEY_ID:\s*\$\{\{ vars\.APPLE_NOTARYTOOL_KEY_ID \}\}/,
  );
  assert.match(
    workflow,
    /APPLE_NOTARYTOOL_ISSUER_ID:\s*\$\{\{ vars\.APPLE_NOTARYTOOL_ISSUER_ID \}\}/,
  );
  assert.doesNotMatch(workflow, /secrets\.APPLE_NOTARYTOOL_KEY_ID/);
  assert.doesNotMatch(workflow, /secrets\.APPLE_NOTARYTOOL_ISSUER_ID/);
  assert.match(workflow, /APPLE_SIGNING_CERTIFICATE_SHA256/);
  assert.match(workflow, /APPLE_PRIOR_SIGNING_CERTIFICATE_SHA256/);
  assert.match(workflow, /stable-release/);
  assert.match(workflow, /beta-release/);
  assert.match(workflow, /environment:\s*winget-release/);
  assert.match(workflow, /runner:\s*windows-11-arm/);
  assert.match(workflow, /runner:\s*ubuntu-24\.04-arm/);
  assert.match(workflow, /macos-updater-e2e:/);
  assert.match(workflow, /MESSENGER_MAC_UPDATER_BOOTSTRAP_TAG/);
  assert.match(
    workflow,
    /prepare-homebrew-publication:[\s\S]*?runs-on:\s*macos-15[\s\S]*?brew audit --cask --strict[\s\S]*?brew install --cask[\s\S]*?xcrun stapler validate[\s\S]*?spctl --assess/,
  );
  assert.doesNotMatch(
    workflow,
    /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|CSC_LINK|CSC_KEY_PASSWORD/,
  );
  assert.doesNotMatch(workflow, /git clone https:\/\/x-access-token:/);
  assert.doesNotMatch(workflow, /merge-multiple:\s*true/);
  assert.doesNotMatch(workflow, /gh api --method DELETE/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
  assert.match(workflow, /Draft release contains unexpected asset/);
  assert.match(workflow, /MISSING_ASSETS/);
  assert.match(workflow, /cmp "artifacts\/release\/\$asset_name"/);
  assert.match(
    workflow,
    /environment:\s*\$\{\{ matrix\.channel \}\}-updater-verification/,
  );
  assert.match(workflow, /--skip-launch/);
  assert.match(
    workflow,
    /Verify and launch signed package without release credentials/,
  );
  assert.match(workflow, /test-windows-installer\.ps1/);
  assert.match(workflow, /Windows remains unsigned/);
  assert.match(workflow, /not trusted N-1 automatic updating/);
  const bridgeResolver = jobSource(workflow, "resolve-legacy-updater-bridge");
  assert.match(
    bridgeResolver,
    /MESSENGER_LEGACY_UPDATER_BRIDGE_BETA_TAG:\s*\$\{\{ vars\.MESSENGER_LEGACY_UPDATER_BRIDGE_BETA_TAG \}\}/,
  );
  assert.match(
    bridgeResolver,
    /MESSENGER_LEGACY_UPDATER_BRIDGE_STABLE_TAG:\s*\$\{\{ vars\.MESSENGER_LEGACY_UPDATER_BRIDGE_STABLE_TAG \}\}/,
  );
  assert.match(bridgeResolver, /legacy-updater-bridge\.mjs resolve/);
  const bridgeBuilder = jobSource(workflow, "build-windows-legacy-bridge");
  assert.match(bridgeBuilder, /--win nsis --x64 --arm64 --publish=never/);
  assert.match(bridgeBuilder, /-LegacyBridge/);
  assert.match(
    bridgeBuilder,
    /needs\.resolve-legacy-updater-bridge\.outputs\.enabled == 'true'/,
  );
  assert.match(
    jobSource(workflow, "release"),
    /--legacy-bridge-channels "\$\{\{ needs\.resolve-legacy-updater-bridge\.outputs\.channels \}\}"/,
  );
  assert.doesNotMatch(workflow, /release\/(?:latest|beta)\.yml/);
  assert.doesNotMatch(workflow, /release\/(?:latest|beta)-linux/);
  assert.match(workflow, /Assemble exact unsigned Windows installers/);
  assert.match(workflow, /Install, launch, and uninstall native DEB packages/);
  assert.match(workflow, /test-rpm-package\.sh/);
  assert.match(workflow, /test-issue53-linux-vm-smoke\.sh flatpak/);
  assert.match(workflow, /FLATPAK_GNUPGHOME/);
  assert.match(workflow, /rm -rf "\$GNUPGHOME"/);
  assert.match(
    workflow,
    /X64_FLATPAK="artifacts\/linux\/facebook-messenger-desktop-x86_64\.flatpak"/,
  );
  assert.doesNotMatch(workflow, /X64_FLATPAK=\$\(find/);
  assert.match(workflow, /Continuing the published OSTree repository/);
  assert.match(workflow, /ostree --repo="\$REPO_PATH" fsck/);
  assert.match(workflow, /messenger-flatpak-publication-/);
  assert.match(workflow, /Apply this exact signed OSTree repository manually/);
  assert.match(workflow, /include-hidden-files:\s*true/);
  assert.match(workflow, /Verify the unauthenticated public release boundary/);
  assert.match(workflow, /update-winget:/);
  assert.match(workflow, /runs-on:\s*windows-2025/);
  assert.match(workflow, /WINGET_CREATE_GITHUB_TOKEN/);
  assert.match(
    workflow,
    /microsoft\/winget-create\/releases\/download\/v1\.12\.8\.0\/wingetcreate\.exe/,
  );
  assert.match(
    workflow,
    /8BD738851B524885410112678E3771B341C5C716DE60FBBECB88AB0A363ED85D/,
  );
  assert.match(workflow, /create-winget-manifests\.mjs/);
  assert.match(workflow, /gh attestation verify \$path/);
  assert.doesNotMatch(workflow, /wingetcreate(?:\.exe)?[^\n]*--token/);
  assert(
    workflow.indexOf("Verify the unauthenticated public release boundary") <
      workflow.indexOf("update-winget:"),
    "WinGet submission must follow unauthenticated public release verification",
  );
  for (const storeJob of [
    "update-winget",
    "prepare-homebrew-publication",
    "prepare-homebrew-beta-publication",
    "prepare-flatpak-publication",
  ]) {
    assert.match(
      jobSource(workflow, storeJob),
      /needs:\s*\[[^\]]*release[^\]]*\]/,
      `${storeJob} must wait for the immutable public release boundary`,
    );
  }
  const homebrewCheckouts = workflow.match(
    /- name: Checkout Homebrew tap[\s\S]*?(?=\n\s+- name:)/g,
  );
  assert.equal(homebrewCheckouts?.length, 2);
  for (const checkout of homebrewCheckouts)
    assert.doesNotMatch(checkout, /HOMEBREW_TAP_TOKEN/);
  assert.match(workflow, /messenger-homebrew-publication-/);
  assert.match(workflow, /Apply these exact natively validated bytes manually/);
  const workflowDirectory = join(repositoryRoot, ".github", "workflows");
  const maintainedWorkflows = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(join(workflowDirectory, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(maintainedWorkflows, /\bgit (?:commit|push)\b/);
  assert.doesNotMatch(maintainedWorkflows, /HOMEBREW_TAP_TOKEN/);
  const ciWorkflow = readFileSync(join(workflowDirectory, "ci.yml"), "utf8");
  assert.match(ciWorkflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(
    ciWorkflow,
    /^\s*(?:push|pull_request|pull_request_target|workflow_run|schedule):/m,
    "CI must remain manual-only",
  );
  assert.doesNotMatch(
    maintainedWorkflows,
    /^\s*schedule:/m,
    "Maintained workflows must not run on a schedule",
  );
  assert.equal(
    existsSync(join(repositoryRoot, ".github", "dependabot.yml")),
    false,
    "Dependabot must remain disabled while unattended maintenance is paused",
  );
  assert.doesNotMatch(maintainedWorkflows, /https:\/\/x-access-token:/);
  for (const name of readdirSync(workflowDirectory).filter(
    (candidate) => candidate.endsWith(".yml") || candidate.endsWith(".yaml"),
  )) {
    const source = readFileSync(join(workflowDirectory, name), "utf8");
    if (!source.includes("secrets.")) continue;
    const eventSection = source.match(/^on:\n([\s\S]*?)(?=^[^\s])/m)?.[1] ?? "";
    const events = [...eventSection.matchAll(/^  ([A-Za-z0-9_-]+):/gm)].map(
      (match) => match[1],
    );
    const allowedEvents =
      name === "release.yml"
        ? new Set(["push"])
        : new Set(["workflow_dispatch"]);
    assert(events.length > 0, `${name} must declare an explicit trusted event`);
    for (const event of events) {
      assert(
        allowedEvents.has(event),
        `${name} exposes secrets to non-allowlisted event ${event}`,
      );
    }
    assert.doesNotMatch(
      source,
      /^\s*(?:pull_request|pull_request_target|workflow_run):/m,
      `${name} must not expose release or store secrets to untrusted events`,
    );
  }
  for (const line of maintainedWorkflows
    .split(/\r?\n/)
    .filter((candidate) => candidate.trim().startsWith("uses:"))) {
    assert.match(
      line,
      /@[a-f0-9]{40}(?:\s+#|\s*$)/,
      `Action is not pinned to a full commit: ${line.trim()}`,
    );
  }
  assert.match(releaseScript, /Type \\"yes do it\\" to continue/);
  assert.match(
    releaseScript,
    /\[ \"\$STABLE_CONFIRMATION\" != \"yes do it\" \]/,
  );
  assert.match(releaseScript, /git status --porcelain/);

  const snapPromotion = readFileSync(
    join(workflowDirectory, "snap-promote.yml"),
    "utf8",
  );
  assert.doesNotMatch(snapPromotion, /\bschedule:/);
  assert.match(snapPromotion, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(jobSource(snapPromotion, "plan"), /secrets\./);
  assert.match(
    jobSource(snapPromotion, "promote_beta"),
    /environment:\s*snap-beta-promotion/,
  );
  assert.match(
    jobSource(snapPromotion, "promote_stable"),
    /environment:\s*snap-stable-promotion/,
  );
  assert.match(
    jobSource(snapPromotion, "publish_arm64_rescue_edge"),
    /environment:\s*snap-edge-release/,
  );
  assert.doesNotMatch(
    jobSource(snapPromotion, "build_arm64_rescue"),
    /environment:|secrets\./,
  );
  const snapRescue = readFileSync(
    join(workflowDirectory, "snap-arm64-rescue.yml"),
    "utf8",
  );
  assert.match(snapRescue, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(
    jobSource(snapRescue, "build-arm64"),
    /environment:|secrets\./,
  );
  assert.match(
    jobSource(snapRescue, "publish-edge"),
    /environment:\s*snap-edge-release/,
  );
  assert.match(
    readFileSync(join(workflowDirectory, "snap-security-refresh.yml"), "utf8"),
    /environment:\s*snap-beta-promotion/,
  );

  const updaterHarness = readFileSync(
    join(repositoryRoot, "scripts", "test-macos-updater-e2e.mjs"),
    "utf8",
  );
  assert.match(updaterHarness, /validateChecksumEntry/);
  assert.match(updaterHarness, /"attestation",\s*"verify"/);
  assert.match(updaterHarness, /"--verify", "--deep", "--strict"/);
  assert.match(updaterHarness, /"stapler", "validate"/);
  assert.match(updaterHarness, /"spctl"/);
  assert.match(updaterHarness, /updated-runtime-started/);
  assert.match(updaterHarness, /manual-runtime-started/);
  assert.match(
    updaterHarness,
    /Bootstrap is forbidden because eligible prior release/,
  );
  assert(
    updaterHarness.indexOf("findPreviousEligibleRelease(") <
      updaterHarness.lastIndexOf("if (!previous)"),
    "Prior release resolution must precede bootstrap handling",
  );
  const updaterMain = updaterHarness.slice(
    updaterHarness.indexOf("export async function main()"),
  );
  const checksumIndex = updaterMain.indexOf("validateChecksumEntry(");
  const attestationIndex = updaterMain.indexOf('"attestation",');
  const priorTrustIndex = updaterMain.indexOf("verifyTrustedApp(");
  const hookIndex = updaterMain.indexOf("containsUpdaterE2EHook(");
  const launchIndex = updaterMain.indexOf("await launchScenario(");
  assert(
    checksumIndex < attestationIndex &&
      attestationIndex < priorTrustIndex &&
      priorTrustIndex < hookIndex &&
      hookIndex < launchIndex,
    "Checksum, attestation, strict trust, and hook eligibility must all precede launch",
  );
  const mainProcess = readFileSync(
    join(repositoryRoot, "src", "main", "main.ts"),
    "utf8",
  );
  assert.match(
    mainProcess,
    /MESSENGER_UPDATE_E2E_INSTALL[\s\S]*?autoUpdater\.quitAndInstall\(false, true\)/,
  );
  assert.match(mainProcess, /updater-e2e-marker\.json/);
  assert.match(mainProcess, /updated-runtime-started/);
  assert.match(mainProcess, /manual-runtime-started/);
  assert.doesNotMatch(mainProcess, /io\.github\.apotenza92\.messenger/);

  const downloadPage = readFileSync(
    join(repositoryRoot, "docs", "index.html"),
    "utf8",
  );
  assert.match(
    downloadPage,
    /arm64:[\s\S]*?flatpak:\s*\{[\s\S]*?disabled:\s*true,[\s\S]*?available for x64 Linux only/,
  );

  const packageVerifier = readFileSync(
    join(repositoryRoot, "scripts", "verify-macos-package.mjs"),
    "utf8",
  );
  assert.doesNotMatch(packageVerifier, /\.map\(realpathSync\)/);
  assert.match(
    packageVerifier,
    /map\(\(bundlePath\) => realpathSync\(bundlePath\)\)/,
  );
  assert.match(
    packageVerifier,
    /map\(\(filePath\) => realpathSync\(filePath\)\)/,
  );

  const maintainedReleaseSources = [
    ".github/workflows/release.yml",
    "electron-builder.config.js",
    "scripts/build-signed-macos.mjs",
    "scripts/notarize-macos.cjs",
    "scripts/verify-macos-package.mjs",
    "scripts/test-macos-updater-e2e.mjs",
  ]
    .map((fileName) => readFileSync(join(repositoryRoot, fileName), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    maintainedReleaseSources,
    /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|CSC_LINK|CSC_KEY_PASSWORD/,
    "Maintained release sources must not revive legacy Apple-ID or CSC_LINK signing",
  );
}

for (const test of [
  testContracts,
  testLegacyUpdaterBaselines,
  testSigningValidation,
  testArchiveValidation,
  testLaunchEnvironmentAllowlist,
  testMetadataMerge,
  testMetadataAssembly,
  testWindowsInstallerAssembly,
  testPublicReleaseAssembly,
  testLegacyUpdaterBridge,
  testUpdaterTrustUtilities,
  testBuilderContract,
  testWorkflowContract,
]) {
  await test();
  console.log(`✓ ${test.name}`);
}
console.log("✓ macOS release contract tests passed");
