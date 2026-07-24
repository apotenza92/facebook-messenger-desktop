import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveMacReleaseContract } from "./macos-release-contract.mjs";
import { expectedWindowsInputNames } from "./assemble-windows-release.mjs";
import {
  assembleLegacyUpdaterBridge,
  legacyMetadataNames,
  legacyWindowsInstallerName,
  parseBridgeChannels,
} from "./legacy-updater-bridge.mjs";

function fail(message) {
  throw new Error(message);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function linuxNames(channel, arch) {
  const beta = channel === "beta";
  const prefix = `facebook-messenger-desktop${beta ? "-beta" : ""}`;
  if (arch === "x64") {
    return [
      `${prefix}-x86_64.AppImage`,
      `${prefix}-amd64.deb`,
      `${prefix}-x86_64.rpm`,
      `${prefix}-x86_64.flatpak`,
    ];
  }
  return [
    `${prefix}-arm64.AppImage`,
    `${prefix}-arm64.deb`,
    `${prefix}-aarch64.rpm`,
  ];
}

export function expectedPublicReleaseContract(
  releaseChannel,
  legacyBridgeChannels = [],
) {
  if (!["stable", "beta"].includes(releaseChannel))
    fail(`Unsupported public release channel ${releaseChannel}`);
  const bridgeChannels = parseBridgeChannels(
    legacyBridgeChannels.join(","),
    releaseChannel,
  );
  const channels = releaseChannel === "stable" ? ["stable", "beta"] : ["beta"];
  const macPublic = [];
  const macInternal = ["SHA256SUMS-macos.txt"];
  for (const channel of channels) {
    for (const arch of ["x64", "arm64"]) {
      const contract = resolveMacReleaseContract(channel, arch);
      macPublic.push(contract.artifactName, contract.blockmapName);
      macInternal.push(
        `${contract.artifactName}.sha256`,
        contract.notarizationName,
      );
    }
    macPublic.push(resolveMacReleaseContract(channel, "x64").metadataName);
  }
  const windowsPublic = [
    ...new Set(
      ["x64", "arm64"].flatMap((arch) =>
        expectedWindowsInputNames(releaseChannel, arch),
      ),
    ),
  ];
  const linuxX64 = channels.flatMap((channel) => linuxNames(channel, "x64"));
  const linuxArm64 = channels.flatMap((channel) =>
    linuxNames(channel, "arm64"),
  );
  const contract = {
    "macos-build": {
      source: [...macPublic, ...macInternal].sort(),
      publish: macPublic.sort(),
    },
    "windows-build": {
      source: windowsPublic.sort(),
      publish: windowsPublic.sort(),
    },
    "linux-build-x64": {
      source: linuxX64.sort(),
      publish: linuxX64.sort(),
    },
    "linux-build-arm64": {
      source: linuxArm64.sort(),
      publish: linuxArm64.sort(),
    },
  };
  if (bridgeChannels.length > 0) {
    contract["legacy-updater-bridge-build"] = {
      source: [
        "bridge-policy.json",
        ...bridgeChannels.map(legacyWindowsInstallerName),
      ].sort(),
      publish: bridgeChannels.map(legacyWindowsInstallerName).sort(),
    };
  }
  return contract;
}

function assertExactDirectory(directory, expectedNames, label) {
  if (!existsSync(directory)) fail(`Missing release input ${label}`);
  const actualNames = readdirSync(directory).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    fail(
      `${label} input ${actualNames.join(", ") || "missing"} does not exactly match ${expectedNames.join(", ")}`,
    );
  for (const name of actualNames) {
    const entry = lstatSync(join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink())
      fail(`${label}/${name} must be a regular non-symlink file`);
  }
}

export function assemblePublicRelease({
  inputDirectory,
  legacyBridgeChannels = [],
  outputDirectory,
  releaseChannel,
}) {
  const bridgeChannels = parseBridgeChannels(
    legacyBridgeChannels.join(","),
    releaseChannel,
  );
  const contract = expectedPublicReleaseContract(
    releaseChannel,
    bridgeChannels,
  );
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const copied = new Set();
  for (const [artifactName, entry] of Object.entries(contract)) {
    const sourceDirectory = join(inputDirectory, artifactName);
    assertExactDirectory(sourceDirectory, entry.source, artifactName);
    for (const name of entry.publish) {
      if (copied.has(name)) fail(`Release input collision on ${name}`);
      const destination = join(outputDirectory, name);
      if (existsSync(destination)) fail(`Release output collision on ${name}`);
      copyFileSync(join(sourceDirectory, name), destination);
      copied.add(name);
    }
  }
  if (bridgeChannels.length > 0) {
    const policyPath = join(
      inputDirectory,
      "legacy-updater-bridge-build",
      "bridge-policy.json",
    );
    const policy = JSON.parse(
      readRegularFile(policyPath, "legacy updater bridge policy"),
    );
    const version = JSON.parse(
      readRegularFile(
        join(resolve(import.meta.dirname, ".."), "package.json"),
        "package metadata",
      ),
    ).version;
    if (
      policy.version !== version ||
      JSON.stringify([...policy.channels].sort()) !==
        JSON.stringify(bridgeChannels)
    ) {
      fail("Legacy updater bridge policy does not match this release");
    }
    assembleLegacyUpdaterBridge({
      channels: bridgeChannels,
      releaseDirectory: outputDirectory,
      version,
    });
  }
  const expectedPublic = Object.values(contract)
    .flatMap((entry) => entry.publish)
    .concat(bridgeChannels.flatMap(legacyMetadataNames))
    .sort();
  const actualPublic = readdirSync(outputDirectory).sort();
  if (JSON.stringify(actualPublic) !== JSON.stringify(expectedPublic))
    fail("Assembled public release does not match the exact asset contract");
  return actualPublic;
}

function readRegularFile(filePath, label) {
  if (!existsSync(filePath)) fail(`Missing ${label}`);
  const entry = lstatSync(filePath);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} must be a regular non-symlink file`);
  return readFileSync(filePath, "utf8");
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const output = assemblePublicRelease({
    inputDirectory: resolve(option("--input-dir") ?? "artifacts/inputs"),
    legacyBridgeChannels: parseBridgeChannels(
      option("--legacy-bridge-channels") ?? "",
      option("--release-channel"),
    ),
    outputDirectory: resolve(option("--output-dir") ?? "artifacts/release"),
    releaseChannel: option("--release-channel"),
  });
  console.log(`Assembled ${output.length} exact public release assets`);
}
