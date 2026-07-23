import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import {
  MESSENGER_APPLE_TEAM_ID,
  normalizeFingerprint,
  parseCodesignMetadata,
  resolvePriorSigningFingerprints,
  resolveMacReleaseContract,
  validateSignatureMetadata,
} from "./macos-release-contract.mjs";

const repository = "apotenza92/FacebookMessengerDesktop";
const legacyUpdaterBaselines = Object.freeze({
  "beta-arm64": Object.freeze({
    tag: "v1.3.1-beta.40",
    asset: "Messenger-Beta-macos-arm64.zip",
    sha256: "96c770dbe2b1df13a7ae458e4b2002452f49d20e957935699c8a75f6e0323eec",
  }),
  "beta-x64": Object.freeze({
    tag: "v1.3.1-beta.40",
    asset: "Messenger-Beta-macos-x64.zip",
    sha256: "7ad7ac036bc9e692ff136a05bb50760c1c5206e462b9166b2e073e7d36af58fe",
  }),
  "stable-arm64": Object.freeze({
    tag: "v1.3.0",
    asset: "Messenger-macos-arm64.zip",
    sha256: "8fe5bb11350e0153d875fb3b7d9e5a92e507cbfc4e69bbe67141179cc696836a",
  }),
  "stable-x64": Object.freeze({
    tag: "v1.3.0",
    asset: "Messenger-macos-x64.zip",
    sha256: "1fe27c9c6a4c8fba0a28ba4164938611cc64044285f5fd57ee1e4bde1ba7c7b0",
  }),
});
const require = createRequire(import.meta.url);
const { extractFile: extractAsarFile } = require("@electron/asar");

function fail(message) {
  throw new Error(message);
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0)
    fail(`${command} ${args.join(" ")} failed (${result.status}):\n${output}`);
  return output;
}

function hash(filePath, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(filePath)).digest(encoding);
}

function parseVersion(tag) {
  const match = String(tag).match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.([0-9A-Za-z.-]+))?)?$/,
  );
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? [match[4], ...(match[5] ?? "").split(".").filter(Boolean)] : [],
  };
}

export function compareVersions(leftTag, rightTag) {
  const left = parseVersion(leftTag);
  const right = parseVersion(rightTag);
  if (!left || !right) fail(`Cannot compare release versions ${leftTag} and ${rightTag}`);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  const order = { alpha: 0, beta: 1, rc: 2 };
  const channelDifference = order[left.prerelease[0]] - order[right.prerelease[0]];
  if (channelDifference) return channelDifference;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 1; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart == null || rightPart == null) return leftPart == null ? -1 : 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber != null && rightNumber != null && leftNumber !== rightNumber)
      return leftNumber - rightNumber;
    if (leftPart !== rightPart) return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function validateChecksumEntry(text, assetName, filePath) {
  const entries = String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})  ([^/\\\0]+)$/);
      if (!match) fail(`SHA256SUMS contains a malformed entry: ${line}`);
      return { digest: match[1], name: match[2] };
    });
  const matches = entries.filter((entry) => entry.name === assetName);
  if (matches.length !== 1)
    fail(`SHA256SUMS must contain exactly one entry for ${assetName}`);
  const actual = hash(filePath, "sha256", "hex");
  if (matches[0].digest !== actual)
    fail(`SHA256SUMS does not authenticate ${assetName}`);
  return actual;
}

export function resolveLegacyUpdaterBaseline(channel, arch, tag, asset) {
  const baseline = legacyUpdaterBaselines[`${channel}-${arch}`];
  if (!baseline || baseline.tag !== tag || baseline.asset !== asset?.name) return null;
  if (asset.digest !== `sha256:${baseline.sha256}`) {
    fail(`GitHub asset digest for ${tag}/${asset.name} does not match the source-pinned legacy baseline`);
  }
  return baseline;
}

async function download(url, destination, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/octet-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) fail(`Download failed (${response.status}): ${url}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()), {
    mode: 0o600,
  });
}

export async function findPreviousEligibleRelease(
  channel,
  arch,
  currentTag,
  token,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) fail(`GitHub release lookup failed (${response.status})`);
  const contract = resolveMacReleaseContract(channel, arch);
  const releases = (await response.json())
    .filter(
      (candidate) =>
        !candidate.draft &&
        compareVersions(candidate.tag_name, currentTag) < 0 &&
        (channel === "beta" || !candidate.prerelease),
    )
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  for (const release of releases) {
    const asset = release.assets.find(
      (candidate) => candidate.name === contract.artifactName,
    );
    const checksums = release.assets.find(
      (candidate) => candidate.name === "SHA256SUMS",
    );
    if (asset && checksums) return { asset, checksums, legacy: null, release };
    const legacy = asset
      ? resolveLegacyUpdaterBaseline(channel, arch, release.tag_name, asset)
      : null;
    if (asset && legacy) return { asset, checksums: null, legacy, release };
  }
  return null;
}

function readPlist(appPath, key) {
  return run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    join(appPath, "Contents", "Info.plist"),
  ]).trim();
}

export function verifyTrustedApp(appPath, contract, expectedVersion, expectations, certificateDirectory) {
  if (!existsSync(appPath)) fail(`Expected app is missing: ${appPath}`);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const metadata = parseCodesignMetadata(
    run("codesign", ["-d", "--verbose=4", appPath]),
  );
  validateSignatureMetadata(metadata, expectations, appPath);
  if (metadata.identifier !== contract.bundleId)
    fail(`${appPath} bundle signature identifier does not match ${contract.bundleId}`);

  const certificatePrefix = join(
    certificateDirectory,
    `${contract.channel}-${contract.arch}-${Date.now()}-certificate`,
  );
  run("codesign", [
    "-d",
    "--extract-certificates",
    certificatePrefix,
    appPath,
  ]);
  const leafCertificate = `${certificatePrefix}0`;
  if (!existsSync(leafCertificate)) fail(`codesign did not extract the leaf certificate for ${appPath}`);
  const fingerprintOutput = run("openssl", [
    "x509",
    "-inform",
    "DER",
    "-in",
    leafCertificate,
    "-noout",
    "-fingerprint",
    "-sha256",
  ]);
  const fingerprint = normalizeFingerprint(
    fingerprintOutput.split("=").at(-1),
  );
  if (!expectations.fingerprints.includes(fingerprint))
    fail(`${appPath} leaf certificate fingerprint ${fingerprint} is not explicitly trusted`);

  const executablePath = join(
    appPath,
    "Contents",
    "MacOS",
    contract.executableName,
  );
  const architectures = run("lipo", ["-archs", executablePath])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== contract.arch)
    fail(`${executablePath} is not exactly ${contract.arch}`);
  if (readPlist(appPath, "CFBundleIdentifier") !== contract.bundleId)
    fail(`${appPath} has an unexpected bundle identifier`);
  if (readPlist(appPath, "CFBundleShortVersionString") !== expectedVersion)
    fail(`${appPath} does not contain expected version ${expectedVersion}`);
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  return executablePath;
}

function containsUpdaterE2EHook(appPath) {
  const mainBundle = extractAsarFile(
    join(appPath, "Contents", "Resources", "app.asar"),
    "dist/main/main.js",
  ).toString("utf8");
  return (
    mainBundle.includes("MESSENGER_UPDATE_E2E_EXPECTED_VERSION") &&
    mainBundle.includes("updated-runtime-started")
  );
}

function writeMetadata(
  directory,
  contract,
  version,
  artifactPath,
  metadataHash = null,
  metadataSize = null,
) {
  const artifactName = basename(artifactPath);
  const digest = metadataHash ?? hash(artifactPath, "sha512", "base64");
  writeFileSync(
    join(directory, contract.metadataName),
    yaml.dump({
      version,
      files: [
        {
          url: artifactName,
          sha512: digest,
          size: metadataSize ?? statSync(artifactPath).size,
        },
      ],
      path: artifactName,
      sha512: digest,
      releaseDate: new Date().toISOString(),
    }),
  );
}

async function serve(directory) {
  const server = createServer((request, response) => {
    const name = basename(new URL(request.url, "http://127.0.0.1").pathname);
    const filePath = join(directory, name);
    if (!existsSync(filePath)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "content-type",
      extname(name) === ".yml" ? "text/yaml" : "application/zip",
    );
    response.end(readFileSync(filePath));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

function readEvents(resultPath) {
  if (!existsSync(resultPath)) return [];
  return readFileSync(resultPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForEvent(resultPath, event, child, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = readEvents(resultPath).find((entry) => entry.event === event);
    if (match) return match;
    const error = readEvents(resultPath).find((entry) => entry.event === "error");
    if (error && event !== "error") fail(`${event} failed: ${error.detail}`);
    if (child?.exitCode != null && event !== "updated-runtime-started")
      fail(`App exited before ${event} (${child.exitCode})`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail(`Timed out waiting for ${event}`);
}

function createLaunchEnvironment({
  feedUrl,
  home,
  install,
  manual,
  marker,
  resultPath,
  temporaryDirectory,
  version,
}) {
  return {
    HOME: home,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    MESSENGER_TEST_SKIP_STARTUP_PERMISSIONS: "true",
    MESSENGER_UPDATE_E2E: "1",
    MESSENGER_UPDATE_E2E_EXPECTED_VERSION: version,
    MESSENGER_UPDATE_E2E_FEED_URL: feedUrl,
    MESSENGER_UPDATE_E2E_INSTALL: install ? "1" : "0",
    MESSENGER_UPDATE_E2E_MANUAL_LAUNCH: manual ? "1" : "0",
    MESSENGER_UPDATE_E2E_MARKER: marker,
    MESSENGER_UPDATE_E2E_RESULT_PATH: resultPath,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SKIP_SINGLE_INSTANCE_LOCK: "true",
    TMPDIR: temporaryDirectory,
  };
}

function prepareUserData(home, contract) {
  const directory = join(
    home,
    "Library",
    "Application Support",
    contract.channel === "beta" ? "Messenger-Beta" : "Messenger",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "move-to-applications-prompted.json"),
    '{"prompted":true}\n',
  );
  writeFileSync(
    join(directory, "update-frequency.json"),
    '{"frequency":"never"}\n',
  );
}

async function launchScenario({
  appPath,
  contract,
  expectedEvent,
  feedDirectory,
  install,
  name,
  version,
  workspace,
}) {
  const resultPath = join(workspace, `${name}.jsonl`);
  const home = join(workspace, `${name}-home`);
  const temporaryDirectory = join(workspace, `${name}-tmp`);
  const marker = `messenger-updater-${name}-marker`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  prepareUserData(home, contract);
  const { server, url } = await serve(feedDirectory);
  const executablePath = join(
    appPath,
    "Contents",
    "MacOS",
    contract.executableName,
  );
  const environment = createLaunchEnvironment({
    feedUrl: url,
    home,
    install,
    manual: false,
    marker,
    resultPath,
    temporaryDirectory,
    version,
  });
  const child = spawn(executablePath, [], {
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  try {
    const result = await waitForEvent(resultPath, expectedEvent, child);
    return {
      child,
      environment,
      executablePath,
      home,
      marker,
      result,
      resultPath,
      temporaryDirectory,
    };
  } finally {
    server.close();
  }
}

function killVerifiedProcess(pid, executablePath) {
  if (!Number.isInteger(pid) || pid <= 1) fail(`Invalid process ID ${pid}`);
  const command = run("ps", ["-p", String(pid), "-o", "command="]).trim();
  if (!command.startsWith(executablePath))
    fail(`Refusing to kill PID ${pid}; command is ${command}`);
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    });
    if (probe.status !== 0 || /^Z/.test(probe.stdout.trim())) return;
    spawnSync("sleep", ["0.1"], { stdio: "ignore" });
  }
  process.kill(pid, "SIGKILL");
}

async function proveManualRelaunch(scenario, version) {
  const eventsBefore = readEvents(scenario.resultPath).length;
  const child = spawn(scenario.executablePath, [], {
    detached: true,
    env: {
      ...scenario.environment,
      MESSENGER_UPDATE_E2E_INSTALL: "0",
      MESSENGER_UPDATE_E2E_MANUAL_LAUNCH: "1",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const events = readEvents(scenario.resultPath).slice(eventsBefore);
    const result = events.find((entry) => entry.event === "manual-runtime-started");
    if (result) {
      if (result.detail.version !== version) fail("Manual relaunch used the wrong version");
      if (result.detail.marker !== scenario.marker) fail("Manual relaunch lost user data marker");
      if (result.detail.executablePath !== scenario.executablePath)
        fail("Manual relaunch used a different executable path");
      killVerifiedProcess(result.detail.pid, scenario.executablePath);
      return;
    }
    if (child.exitCode != null) fail(`Manual relaunch exited early (${child.exitCode})`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail("Manual relaunch did not start the updated runtime");
}

function copyPriorApp(baselineApp, destinationDirectory, contract) {
  mkdirSync(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, contract.appName);
  run("ditto", [baselineApp, destination]);
  return destination;
}

export async function main() {
  if (process.platform !== "darwin") fail("macOS updater E2E requires macOS");
  const channel = option("--channel");
  const arch = option("--arch", process.arch);
  const currentTag = option("--current-tag");
  const candidate = resolve(option("--candidate"));
  const bootstrapTag = option("--bootstrap-tag", "");
  if (!["stable", "beta"].includes(channel))
    fail("--channel must be stable or beta");
  if (!currentTag || !parseVersion(currentTag)) fail("--current-tag is required");
  if (!existsSync(candidate)) fail(`Candidate ZIP is missing: ${candidate}`);
  const contract = resolveMacReleaseContract(channel, arch);
  const currentFingerprint = normalizeFingerprint(
    process.env.APPLE_SIGNING_CERTIFICATE_SHA256,
  );
  const currentExpectations = {
    fingerprints: [currentFingerprint],
    identity: process.env.APPLE_SIGNING_IDENTITY,
    teamId: process.env.APPLE_TEAM_ID,
  };
  const priorExpectations = {
    ...currentExpectations,
    fingerprints: resolvePriorSigningFingerprints(
      currentFingerprint,
      process.env.APPLE_PRIOR_SIGNING_CERTIFICATE_SHA256,
    ),
  };
  if (
    currentExpectations.teamId !== MESSENGER_APPLE_TEAM_ID ||
    !currentExpectations.identity?.startsWith("Developer ID Application: ") ||
    !currentExpectations.identity.endsWith(`(${MESSENGER_APPLE_TEAM_ID})`)
  ) {
    fail("Strict Messenger Developer ID expectations are required");
  }

  const token = process.env.GITHUB_TOKEN;
  const previous = await findPreviousEligibleRelease(
    channel,
    arch,
    currentTag,
    token,
  );
  if (!previous) {
    if (bootstrapTag !== currentTag)
      fail(`No eligible prior ${channel} ${arch} release exists; protected bootstrap must exactly match ${currentTag}`);
    console.log(`Protected updater bootstrap accepted for ${currentTag}: no prior checksum-authenticated release exists`);
    return;
  }

  const workspace = mkdtempSync(join(tmpdir(), "messenger-updater-e2e-"));
  const certificateDirectory = join(workspace, "certificates");
  mkdirSync(certificateDirectory);
  try {
    const previousZip = join(workspace, previous.asset.name);
    const checksumPath = join(workspace, "SHA256SUMS");
    await download(previous.asset.url, previousZip, token);
    if (previous.legacy) {
      const actual = hash(previousZip, "sha256", "hex");
      if (actual !== previous.legacy.sha256) fail(`Legacy package ${previous.asset.name} does not match its source-pinned SHA-256`);
    } else {
      await download(previous.checksums.url, checksumPath, token);
      validateChecksumEntry(
        readFileSync(checksumPath, "utf8"),
        previous.asset.name,
        previousZip,
      );
      run("gh", [
        "attestation",
        "verify",
        previousZip,
        "--repo",
        repository,
      ]);
    }
    run("unzip", ["-tq", previousZip]);
    const baselineDirectory = join(workspace, "previous-baseline");
    mkdirSync(baselineDirectory);
    run("ditto", ["-x", "-k", previousZip, baselineDirectory]);
    const baselineApp = join(baselineDirectory, contract.appName);
    const previousVersion = previous.release.tag_name.replace(/^v/, "");
    verifyTrustedApp(
      baselineApp,
      contract,
      previousVersion,
      priorExpectations,
      certificateDirectory,
    );

    if (!containsUpdaterE2EHook(baselineApp)) {
      if (bootstrapTag !== currentTag)
        fail(`Prior release ${previous.release.tag_name} is trusted but predates the updater E2E hook; protected bootstrap must exactly match ${currentTag}`);
      console.log(`Protected updater bootstrap accepted for ${currentTag}: trusted prior ${previous.release.tag_name} predates the E2E hook`);
      return;
    }
    if (bootstrapTag === currentTag)
      fail(`Bootstrap is forbidden because eligible prior release ${previous.release.tag_name} exists`);

    const version = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ).version;
    const candidateDirectory = join(workspace, "candidate-baseline");
    mkdirSync(candidateDirectory);
    run("ditto", ["-x", "-k", candidate, candidateDirectory]);
    verifyTrustedApp(
      join(candidateDirectory, contract.appName),
      contract,
      version,
      currentExpectations,
      certificateDirectory,
    );

    const validFeed = join(workspace, "valid-feed");
    mkdirSync(validFeed);
    const validArtifact = join(validFeed, basename(candidate));
    copyFileSync(candidate, validArtifact);
    writeMetadata(validFeed, contract, version, validArtifact);
    const validApp = copyPriorApp(
      baselineApp,
      join(workspace, "valid-install"),
      contract,
    );
    verifyTrustedApp(
      validApp,
      contract,
      previousVersion,
      priorExpectations,
      certificateDirectory,
    );
    const valid = await launchScenario({
      appPath: validApp,
      contract,
      expectedEvent: "updated-runtime-started",
      feedDirectory: validFeed,
      install: true,
      name: "valid",
      version,
      workspace,
    });
    if (valid.result.detail.version !== version)
      fail("Automatic relaunch did not use the updated runtime version");
    if (valid.result.detail.executablePath !== valid.executablePath)
      fail("Updater did not relaunch the same installed executable path");
    if (valid.result.detail.marker !== valid.marker)
      fail("Automatic relaunch did not preserve the user-data marker");
    killVerifiedProcess(valid.result.detail.pid, valid.executablePath);
    verifyTrustedApp(
      validApp,
      contract,
      version,
      currentExpectations,
      certificateDirectory,
    );
    await proveManualRelaunch(valid, version);

    const corruptFeed = join(workspace, "corrupt-feed");
    mkdirSync(corruptFeed);
    const corruptArtifact = join(corruptFeed, basename(candidate));
    copyFileSync(candidate, corruptArtifact);
    const validHash = hash(candidate, "sha512", "base64");
    const validSize = statSync(candidate).size;
    appendFileSync(corruptArtifact, "corrupt");
    writeMetadata(
      corruptFeed,
      contract,
      version,
      corruptArtifact,
      validHash,
      validSize,
    );
    const corruptApp = copyPriorApp(
      baselineApp,
      join(workspace, "corrupt-install"),
      contract,
    );
    verifyTrustedApp(
      corruptApp,
      contract,
      previousVersion,
      priorExpectations,
      certificateDirectory,
    );
    const corrupt = await launchScenario({
      appPath: corruptApp,
      contract,
      expectedEvent: "error",
      feedDirectory: corruptFeed,
      install: false,
      name: "corrupt",
      version,
      workspace,
    });
    if (!/sha|checksum|size|integrity/i.test(String(corrupt.result.detail)))
      fail(`Corrupt package failed for an unexpected reason: ${corrupt.result.detail}`);
    killVerifiedProcess(corrupt.child.pid, corrupt.executablePath);

    const wrongFeed = join(workspace, "wrong-signature-feed");
    const wrongExtract = join(workspace, "wrong-signature-app");
    mkdirSync(wrongFeed);
    mkdirSync(wrongExtract);
    run("ditto", ["-x", "-k", candidate, wrongExtract]);
    run("codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      join(wrongExtract, contract.appName),
    ]);
    const wrongArtifact = join(wrongFeed, basename(candidate));
    run("ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      join(wrongExtract, contract.appName),
      wrongArtifact,
    ]);
    writeMetadata(wrongFeed, contract, version, wrongArtifact);
    const wrongApp = copyPriorApp(
      baselineApp,
      join(workspace, "wrong-signature-install"),
      contract,
    );
    verifyTrustedApp(
      wrongApp,
      contract,
      previousVersion,
      priorExpectations,
      certificateDirectory,
    );
    const wrong = await launchScenario({
      appPath: wrongApp,
      contract,
      expectedEvent: "error",
      feedDirectory: wrongFeed,
      install: false,
      name: "wrong-signature",
      version,
      workspace,
    });
    if (!/sign|code|authority|team/i.test(String(wrong.result.detail)))
      fail(`Wrong signature failed for an unexpected reason: ${wrong.result.detail}`);
    killVerifiedProcess(wrong.child.pid, wrong.executablePath);
    console.log(
      `macOS ${channel} ${arch} N-1 updater install E2E passed from ${previous.release.tag_name}`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) await main();
