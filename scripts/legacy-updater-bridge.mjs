import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const CHANNELS = new Set(["stable", "beta"]);
const BRIDGE_MARKER = 1;

function fail(message) {
  throw new Error(message);
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function assertChannel(channel) {
  if (!CHANNELS.has(channel))
    fail(`Unsupported legacy updater channel ${channel}`);
}

function parseVersion(tag) {
  const match = String(tag).match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.([1-9]\d*))?$/,
  );
  if (!match) fail(`Unsupported Messenger release version ${tag}`);
  return {
    beta: match[4] == null ? null : Number(match[4]),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareReleaseTags(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.beta === b.beta) return 0;
  if (a.beta == null) return 1;
  if (b.beta == null) return -1;
  return a.beta < b.beta ? -1 : 1;
}

export function releaseChannels(releaseChannel) {
  assertChannel(releaseChannel);
  return releaseChannel === "stable" ? ["stable", "beta"] : ["beta"];
}

export function parseBridgeChannels(value, releaseChannel) {
  const allowed = new Set(releaseChannels(releaseChannel));
  const channels = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (new Set(channels).size !== channels.length)
    fail("Legacy updater bridge channels must be unique");
  for (const channel of channels) {
    assertChannel(channel);
    if (!allowed.has(channel))
      fail(`${releaseChannel} releases cannot bridge the ${channel} channel`);
  }
  return channels.sort();
}

export function legacyMetadataNames(channel) {
  assertChannel(channel);
  const prefix = channel === "beta" ? "beta" : "latest";
  return [`${prefix}.yml`, `${prefix}-linux.yml`, `${prefix}-linux-arm64.yml`];
}

export function legacyWindowsInstallerName(channel) {
  assertChannel(channel);
  return `${channel === "beta" ? "Messenger-Beta" : "Messenger"}-windows-setup.exe`;
}

function linuxPackageNames(channel, arch) {
  assertChannel(channel);
  const prefix = `facebook-messenger-desktop${channel === "beta" ? "-beta" : ""}`;
  if (arch === "x64") {
    return [
      `${prefix}-x86_64.AppImage`,
      `${prefix}-amd64.deb`,
      `${prefix}-x86_64.rpm`,
    ];
  }
  if (arch === "arm64") {
    return [
      `${prefix}-arm64.AppImage`,
      `${prefix}-arm64.deb`,
      `${prefix}-aarch64.rpm`,
    ];
  }
  fail(`Unsupported legacy Linux architecture ${arch}`);
}

function fileEntry(filePath) {
  if (!existsSync(filePath))
    fail(`Missing legacy updater bridge input ${filePath}`);
  const entry = lstatSync(filePath);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`Legacy updater bridge input must be a regular file: ${filePath}`);
  return {
    sha512: createHash("sha512")
      .update(readFileSync(filePath))
      .digest("base64"),
    size: statSync(filePath).size,
    url: basename(filePath),
  };
}

function metadata(entry, version, files = [entry]) {
  return {
    version,
    files,
    path: entry.url,
    sha512: entry.sha512,
    migrationBridge: BRIDGE_MARKER,
  };
}

export function assembleLegacyUpdaterBridge({
  channels,
  releaseDirectory,
  version,
}) {
  parseVersion(version);
  const outputNames = [];
  for (const channel of channels) {
    assertChannel(channel);
    const windows = fileEntry(
      join(releaseDirectory, legacyWindowsInstallerName(channel)),
    );
    const windowsName = legacyMetadataNames(channel)[0];
    writeFileSync(
      join(releaseDirectory, windowsName),
      yaml.dump(metadata(windows, version), { lineWidth: -1, noRefs: true }),
      { mode: 0o644 },
    );
    outputNames.push(windowsName);

    for (const arch of ["x64", "arm64"]) {
      const files = linuxPackageNames(channel, arch).map((name) =>
        fileEntry(join(releaseDirectory, name)),
      );
      const appImage = files.find((entry) => entry.url.endsWith(".AppImage"));
      if (!appImage) fail(`Missing ${channel} ${arch} AppImage bridge input`);
      const metadataName = legacyMetadataNames(channel)[arch === "x64" ? 1 : 2];
      writeFileSync(
        join(releaseDirectory, metadataName),
        yaml.dump(metadata(appImage, version, files), {
          lineWidth: -1,
          noRefs: true,
        }),
        { mode: 0o644 },
      );
      outputNames.push(metadataName);
    }
  }
  return outputNames.sort();
}

function assetNames(release) {
  return new Set((release.assets ?? []).map((asset) => asset.name));
}

function latestEligibleRelease(releases, channel, currentTag) {
  return releases
    .filter(
      (release) =>
        !release.draft &&
        (channel === "beta" || !release.prerelease) &&
        compareReleaseTags(release.tag_name, currentTag) < 0,
    )
    .sort((left, right) =>
      compareReleaseTags(right.tag_name, left.tag_name),
    )[0];
}

async function bridgeState(release, channel, readAsset) {
  const requiredNames = legacyMetadataNames(channel);
  const names = assetNames(release);
  const present = requiredNames.filter((name) => names.has(name));
  if (present.length === 0) return "absent";
  if (present.length !== requiredNames.length) {
    fail(
      `Release ${release.tag_name} has an incomplete ${channel} legacy updater contract`,
    );
  }
  const windowsAsset = (release.assets ?? []).find(
    (asset) => asset.name === requiredNames[0],
  );
  const metadata = yaml.load(await readAsset(windowsAsset));
  return metadata?.migrationBridge === BRIDGE_MARKER
    ? "completed-bridge"
    : "legacy";
}

export async function resolveLegacyBridgeChannels({
  approvals,
  currentTag,
  readAsset,
  releaseChannel,
  releases,
}) {
  parseVersion(currentTag);
  const result = [];
  for (const channel of releaseChannels(releaseChannel)) {
    const current = releases.find((release) => release.tag_name === currentTag);
    if (current) {
      const currentState = await bridgeState(current, channel, readAsset);
      if (currentState === "completed-bridge") {
        result.push(channel);
        continue;
      }
      if (currentState === "legacy")
        fail(
          `Current release ${currentTag} has unmarked legacy updater metadata`,
        );
      if (!current.draft) continue;
    }
    const previous = latestEligibleRelease(releases, channel, currentTag);
    if (!previous) continue;
    const previousState = await bridgeState(previous, channel, readAsset);
    if (previousState === "absent" || previousState === "completed-bridge")
      continue;
    if (approvals[channel] !== currentTag) {
      const variable =
        channel === "beta"
          ? "MESSENGER_LEGACY_UPDATER_BRIDGE_BETA_TAG"
          : "MESSENGER_LEGACY_UPDATER_BRIDGE_STABLE_TAG";
      fail(
        `The first ${channel} migration release must set ${variable} to exact tag ${currentTag}`,
      );
    }
    result.push(channel);
  }
  return result.sort();
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "messenger-legacy-updater-bridge",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok)
    fail(`GitHub release lookup failed with HTTP ${response.status}`);
  return response.json();
}

async function resolveFromGitHub() {
  const repository = option("--repository", process.env.GITHUB_REPOSITORY);
  const currentTag = option("--current-tag", process.env.GITHUB_REF_NAME);
  const releaseChannel = option(
    "--release-channel",
    process.env.MESSENGER_RELEASE_CHANNEL,
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""))
    fail(`Invalid GitHub repository ${repository}`);
  const token = process.env.GITHUB_TOKEN;
  const releases = await fetchJson(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    token,
  );
  const channels = await resolveLegacyBridgeChannels({
    approvals: {
      beta: process.env.MESSENGER_LEGACY_UPDATER_BRIDGE_BETA_TAG,
      stable: process.env.MESSENGER_LEGACY_UPDATER_BRIDGE_STABLE_TAG,
    },
    currentTag,
    readAsset: async (asset) => {
      if (!asset?.browser_download_url)
        fail("Prior legacy updater metadata has no public download URL");
      const response = await fetch(asset.browser_download_url, {
        headers: { "User-Agent": "messenger-legacy-updater-bridge" },
        redirect: "follow",
      });
      if (!response.ok)
        fail(
          `Legacy updater metadata download failed with HTTP ${response.status}`,
        );
      return response.text();
    },
    releaseChannel,
    releases,
  });
  const csv = channels.join(",");
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `channels=${csv}\nenabled=${channels.length > 0}\n`,
      { flag: "a" },
    );
  }
  console.log(
    channels.length > 0
      ? `Approved one-release legacy updater bridge for ${csv}`
      : "No legacy updater bridge is required",
  );
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const command = process.argv[2];
  if (command !== "resolve")
    fail(`Unsupported legacy bridge command ${command}`);
  await resolveFromGitHub();
}
