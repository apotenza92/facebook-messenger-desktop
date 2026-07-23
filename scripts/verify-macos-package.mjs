import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import yaml from "js-yaml";
import {
  normalizeFingerprint,
  parseCodesignMetadata,
  resolveMacReleaseContract,
  validateNotarizationRecord,
  validateSignatureMetadata,
} from "./macos-release-contract.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { extractFile: extractAsarFile } = require("@electron/asar");
const machOMagic = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
const signedBundleExtensions = [
  ".app",
  ".framework",
  ".xpc",
  ".appex",
  ".bundle",
];
const allowedEntitlements = new Set([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.device.camera",
  "com.apple.security.device.audio-input",
]);

function fail(message) {
  throw new Error(message);
}
function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure)
    fail(
      `${command} ${args.join(" ")} failed (${result.status}):\n${output.trim()}`,
    );
  return { ...result, output };
}
function hashFile(filePath, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(filePath)).digest(encoding);
}

export function validateZipEntries(output, contract) {
  const entries = String(output).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) fail("Release ZIP contains no entries");
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) fail(`Release ZIP contains duplicate entry ${entry}`);
    seen.add(entry);
    if (entry.includes("\\") || entry.includes("\0") || entry.startsWith("/"))
      fail(`Release ZIP contains unsafe entry ${entry}`);
    const segments = entry.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".."))
      fail(`Release ZIP contains traversal entry ${entry}`);
    if (segments[0] !== contract.appName)
      fail(`Release ZIP contains unexpected top-level entry ${entry}`);
  }
  if (
    !seen.has(`${contract.appName}/Contents/MacOS/${contract.executableName}`)
  ) {
    fail(
      `Release ZIP is missing the main ${contract.executableName} executable`,
    );
  }
  return entries;
}

export function validateBlockmap(blockmap, artifactSize, label) {
  if (
    blockmap?.version !== "2" ||
    !Array.isArray(blockmap.files) ||
    blockmap.files.length === 0
  ) {
    fail(`${label} is not a non-empty blockmap v2 document`);
  }
  let representedBytes = 0;
  for (const file of blockmap.files) {
    if (
      !Array.isArray(file?.sizes) ||
      !Array.isArray(file?.checksums) ||
      file.sizes.length !== file.checksums.length
    ) {
      fail(`${label} contains an invalid file record`);
    }
    for (let index = 0; index < file.sizes.length; index += 1) {
      if (
        !Number.isInteger(file.sizes[index]) ||
        file.sizes[index] <= 0 ||
        typeof file.checksums[index] !== "string"
      ) {
        fail(`${label} contains an invalid block`);
      }
      representedBytes += file.sizes[index];
    }
  }
  if (representedBytes !== artifactSize)
    fail(
      `${label} represents ${representedBytes} bytes, expected ${artifactSize}`,
    );
}

function validateChecksum(artifactPath, required) {
  const checksumPath = `${artifactPath}.sha256`;
  if (!existsSync(checksumPath)) {
    if (required) fail(`Required checksum is missing: ${checksumPath}`);
    return;
  }
  const expected = `${hashFile(artifactPath, "sha256", "hex")}  ${basename(artifactPath)}`;
  if (readFileSync(checksumPath, "utf8").trim() !== expected)
    fail(`Checksum does not match ${basename(artifactPath)}`);
}

function validateUpdateMetadata(metadataPath, artifactPath, version) {
  const metadata = yaml.load(readFileSync(metadataPath, "utf8"));
  if (
    !metadata ||
    !Array.isArray(metadata.files) ||
    metadata.version !== version
  )
    fail(`${metadataPath} has invalid updater metadata`);
  const file = metadata.files.find(
    (entry) => entry?.url === basename(artifactPath),
  );
  if (!file)
    fail(`${metadataPath} does not reference ${basename(artifactPath)}`);
  if (
    file.size !== statSync(artifactPath).size ||
    file.sha512 !== hashFile(artifactPath, "sha512", "base64")
  ) {
    fail(`${metadataPath} does not match ${basename(artifactPath)}`);
  }
}

function isMachO(filePath) {
  if (!lstatSync(filePath).isFile()) return false;
  const descriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    return (
      readSync(descriptor, header, 0, 4, 0) === 4 &&
      machOMagic.has(header.toString("hex"))
    );
  } finally {
    closeSync(descriptor);
  }
}

function collectCodeObjects(appPath) {
  const bundles = [appPath];
  const machOFiles = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(filePath);
        if (isAbsolute(target))
          fail(
            `App contains absolute symlink ${relative(appPath, filePath)} -> ${target}`,
          );
        const relativeTarget = relative(
          appPath,
          resolve(dirname(filePath), target),
        );
        if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`))
          fail(
            `App contains escaping symlink ${relative(appPath, filePath)} -> ${target}`,
          );
      } else if (entry.isDirectory()) {
        if (
          signedBundleExtensions.some((extension) =>
            entry.name.endsWith(extension),
          )
        )
          bundles.push(filePath);
        visit(filePath);
      } else if (entry.isFile() && isMachO(filePath)) machOFiles.push(filePath);
    }
  }
  visit(appPath);
  return {
    bundles: [...new Set(bundles.map(realpathSync))].sort(),
    machOFiles: [...new Set(machOFiles.map(realpathSync))].sort(),
  };
}

function parseEntitlements(targetPath) {
  const result = run("codesign", [
    "-d",
    "--xml",
    "--entitlements",
    "-",
    targetPath,
  ]);
  const xmlStart = result.stdout.indexOf("<?xml");
  if (xmlStart < 0) return {};
  return JSON.parse(
    run("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: result.stdout.slice(xmlStart),
    }).stdout,
  );
}

function validateEntitlements(entitlements, label) {
  for (const [key, value] of Object.entries(entitlements)) {
    if (key === "com.apple.security.get-task-allow")
      fail(`${label} includes forbidden get-task-allow entitlement`);
    if (!allowedEntitlements.has(key) || value !== true)
      fail(`${label} includes unexpected entitlement ${key}`);
  }
}

function validateCertificate(
  targetPath,
  certificateDirectory,
  index,
  expectations,
  validateChain,
) {
  const prefix = join(certificateDirectory, `certificate-${index}-`);
  run("codesign", ["-d", `--extract-certificates=${prefix}`, targetPath]);
  const leafPath = `${prefix}0`;
  if (!existsSync(leafPath))
    fail(`codesign did not extract a leaf certificate for ${targetPath}`);
  if (
    normalizeFingerprint(hashFile(leafPath, "sha256", "hex")) !==
    expectations.fingerprint
  ) {
    fail(
      `${targetPath} leaf certificate does not match the configured fingerprint`,
    );
  }
  if (validateChain) {
    const intermediatePath = `${prefix}1`;
    const rootPath = `${prefix}2`;
    if (!existsSync(intermediatePath) || !existsSync(rootPath))
      fail(
        `${targetPath} does not embed the complete signing certificate chain`,
      );
    run("security", [
      "verify-cert",
      "-N",
      "-L",
      "-p",
      "codeSign",
      "-c",
      leafPath,
      "-c",
      intermediatePath,
      "-r",
      rootPath,
    ]);
  }
}

function validateCodeObject(targetPath, context, options = {}) {
  const label =
    relative(context.appPath, targetPath) || context.contract.appName;
  run("codesign", ["--verify", "--strict", "--verbose=2", targetPath]);
  validateSignatureMetadata(
    parseCodesignMetadata(run("codesign", ["-dvvv", targetPath]).output),
    context.expectations,
    label,
  );
  validateEntitlements(parseEntitlements(targetPath), label);
  validateCertificate(
    targetPath,
    context.certificateDirectory,
    context.certificateIndex++,
    context.expectations,
    options.validateChain === true,
  );
  if (options.machO) {
    const expected = context.contract.arch === "x64" ? "x86_64" : "arm64";
    const architectures = run("lipo", ["-archs", targetPath])
      .stdout.trim()
      .split(/\s+/)
      .filter(Boolean);
    if (architectures.length !== 1 || architectures[0] !== expected)
      fail(
        `${label} architectures ${architectures.join(", ") || "missing"} do not exactly match ${expected}`,
      );
  }
}

function readPlistValue(plistPath, key) {
  return run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]).stdout.trim();
}

function validateEmbeddedUpdater(appPath, contract, version) {
  const resourcesPath = join(appPath, "Contents", "Resources");
  const packageMetadata = JSON.parse(
    extractAsarFile(join(resourcesPath, "app.asar"), "package.json").toString(
      "utf8",
    ),
  );
  if (
    packageMetadata.name !== contract.packageName ||
    packageMetadata.version !== version
  ) {
    fail(
      `Packaged identity ${packageMetadata.name}@${packageMetadata.version} does not match ${contract.packageName}@${version}`,
    );
  }
  const updateConfig = yaml.load(
    readFileSync(join(resourcesPath, "app-update.yml"), "utf8"),
  );
  if (
    updateConfig?.provider !== "github" ||
    updateConfig.owner !== "apotenza92" ||
    updateConfig.repo !== "facebook-messenger-desktop"
  ) {
    fail(
      "Packaged updater does not use the maintained Messenger GitHub release provider",
    );
  }
  const actualChannel = updateConfig.channel ?? "latest";
  if (actualChannel !== contract.updaterChannel)
    fail(
      `Packaged updater channel ${actualChannel} does not match ${contract.updaterChannel}`,
    );
}

async function launchSmoke(executablePath, temporaryDirectory, contract) {
  const homeDirectory = join(temporaryDirectory, "home");
  const userDataDirectory = join(
    homeDirectory,
    "Library",
    "Application Support",
    contract.channel === "beta" ? "Messenger-Beta" : "Messenger",
  );
  mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(userDataDirectory, "move-to-applications-prompted.json"),
    '{"prompted":true}\n',
  );
  writeFileSync(
    join(userDataDirectory, "update-frequency.json"),
    '{"frequency":"never"}\n',
  );
  const launchTemporaryDirectory = join(temporaryDirectory, "tmp");
  mkdirSync(launchTemporaryDirectory, { mode: 0o700 });
  const child = spawn(executablePath, [], {
    detached: true,
    env: createMacLaunchEnvironment(homeDirectory, launchTemporaryDirectory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exited = await Promise.race([
    new Promise((resolveExit) =>
      child.once("exit", (code, signal) => resolveExit({ code, signal })),
    ),
    new Promise((resolveExit) => setTimeout(() => resolveExit(null), 5000)),
  ]);
  if (exited)
    fail(
      `Packaged app exited before the launch smoke completed (${JSON.stringify(exited)}):\n${output.slice(-4000)}`,
    );
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolveExit();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

export function createMacLaunchEnvironment(homeDirectory, temporaryDirectory) {
  return {
    HOME: homeDirectory,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    MESSENGER_TEST_SKIP_STARTUP_PERMISSIONS: "true",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SKIP_SINGLE_INSTANCE_LOCK: "true",
    TMPDIR: temporaryDirectory,
  };
}

export async function main() {
  const channel = readOption(
    "--channel",
    process.env.MESSENGER_RELEASE_CHANNEL ?? "stable",
  );
  const arch = readOption(
    "--arch",
    process.env.MESSENGER_RELEASE_ARCH ?? process.arch,
  );
  const contract = resolveMacReleaseContract(channel, arch);
  if (process.platform !== "darwin" || process.arch !== arch)
    fail(`macOS package verification requires a native ${arch} runner`);
  const releaseDirectory = resolve(
    readOption("--release-dir", join(repositoryRoot, "release")),
  );
  const requireChecksum = process.argv.includes("--require-checksum");
  const skipLaunch = process.argv.includes("--skip-launch");
  for (const name of [
    "APPLE_SIGNING_CERTIFICATE_SHA256",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
  ]) {
    if (!process.env[name]?.trim())
      fail(`Required verification environment variable is missing: ${name}`);
  }
  const expectations = {
    fingerprint: normalizeFingerprint(
      process.env.APPLE_SIGNING_CERTIFICATE_SHA256,
    ),
    identity: process.env.APPLE_SIGNING_IDENTITY,
    teamId: process.env.APPLE_TEAM_ID,
  };
  const version = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  const artifactPath = join(releaseDirectory, contract.artifactName);
  const blockmapPath = join(releaseDirectory, contract.blockmapName);
  const metadataPath = join(releaseDirectory, contract.metadataName);
  const notarizationPath = join(releaseDirectory, contract.notarizationName);
  for (const requiredPath of [
    artifactPath,
    blockmapPath,
    metadataPath,
    notarizationPath,
  ]) {
    if (!existsSync(requiredPath))
      fail(`Required macOS release output is missing: ${requiredPath}`);
  }
  run("unzip", ["-tq", artifactPath]);
  validateZipEntries(run("unzip", ["-Z1", artifactPath]).stdout, contract);
  validateChecksum(artifactPath, requireChecksum);
  validateBlockmap(
    JSON.parse(gunzipSync(readFileSync(blockmapPath)).toString("utf8")),
    statSync(artifactPath).size,
    basename(blockmapPath),
  );
  validateUpdateMetadata(metadataPath, artifactPath, version);
  validateNotarizationRecord(
    JSON.parse(readFileSync(notarizationPath, "utf8")),
  );

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "messenger-verify-"));
  const extractionDirectory = join(temporaryDirectory, "zip");
  const certificateDirectory = join(temporaryDirectory, "certificates");
  mkdirSync(extractionDirectory, { mode: 0o700 });
  mkdirSync(certificateDirectory, { mode: 0o700 });
  try {
    run("ditto", ["-x", "-k", artifactPath, extractionDirectory]);
    const topLevel = readdirSync(extractionDirectory);
    if (topLevel.length !== 1 || topLevel[0] !== contract.appName)
      fail(
        `ZIP extracted unexpected top-level entries: ${topLevel.join(", ")}`,
      );
    const appPath = realpathSync(join(extractionDirectory, contract.appName));
    const plistPath = join(appPath, "Contents", "Info.plist");
    const executablePath = join(
      appPath,
      "Contents",
      "MacOS",
      contract.executableName,
    );
    for (const [key, expected] of Object.entries({
      CFBundleIdentifier: contract.bundleId,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
      CFBundleExecutable: contract.executableName,
    })) {
      const actual = readPlistValue(plistPath, key);
      if (actual !== expected)
        fail(`${key} is ${actual}, expected ${expected}`);
    }
    validateEmbeddedUpdater(appPath, contract, version);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
    const codeObjects = collectCodeObjects(appPath);
    if (codeObjects.machOFiles.length === 0)
      fail("Packaged app contains no Mach-O files");
    const context = {
      appPath,
      certificateDirectory,
      certificateIndex: 0,
      contract,
      expectations,
    };
    for (const bundlePath of codeObjects.bundles)
      validateCodeObject(bundlePath, context, {
        validateChain: bundlePath === appPath,
      });
    for (const machOPath of codeObjects.machOFiles)
      validateCodeObject(machOPath, context, { machO: true });
    run("xcrun", ["stapler", "validate", appPath]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    if (!skipLaunch)
      await launchSmoke(executablePath, temporaryDirectory, contract);
    console.log(
      `macOS ${channel}/${arch} package verification passed (${codeObjects.machOFiles.length} Mach-O files, ${codeObjects.bundles.length} signed bundles).`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
