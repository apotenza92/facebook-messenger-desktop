import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import {
  MESSENGER_APPLE_TEAM_ID,
  normalizeFingerprint,
  resolveMacReleaseContract,
} from "./macos-release-contract.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const channel = readOption(
  "--channel",
  process.env.MESSENGER_RELEASE_CHANNEL ?? "stable",
);
const arch = readOption(
  "--arch",
  process.env.MESSENGER_RELEASE_ARCH ?? process.arch,
);
const contract = resolveMacReleaseContract(channel, arch);
const releaseDirectory = resolve(
  readOption("--release-dir", join(repositoryRoot, "release")),
);
const skipBuild = process.argv.includes("--skip-build");
const skipLaunch = process.argv.includes("--skip-launch");
const nativeArch = process.arch === "x64" ? "x64" : process.arch;
if (process.platform !== "darwin" || nativeArch !== arch) {
  throw new Error(
    `Signed ${arch} releases require a native ${arch} macOS runner; received ${process.platform}/${process.arch}.`,
  );
}

const requiredEnvironment = [
  "APPLE_NOTARYTOOL_ISSUER_ID",
  "APPLE_NOTARYTOOL_KEY_ID",
  "APPLE_NOTARYTOOL_KEY_P8_BASE64",
  "APPLE_SIGNING_CERTIFICATE_P12_BASE64",
  "APPLE_SIGNING_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_CERTIFICATE_SHA256",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
];
const credentials = Object.fromEntries(
  requiredEnvironment.map((name) => {
    const value = process.env[name]?.trim();
    if (!value)
      throw new Error(
        `Required release environment variable is missing: ${name}`,
      );
    return [name, value];
  }),
);
const expectedFingerprint = normalizeFingerprint(
  credentials.APPLE_SIGNING_CERTIFICATE_SHA256,
);
if (credentials.APPLE_TEAM_ID !== MESSENGER_APPLE_TEAM_ID) {
  throw new Error(
    `APPLE_TEAM_ID must be the configured Messenger team ${MESSENGER_APPLE_TEAM_ID}.`,
  );
}
if (
  !credentials.APPLE_SIGNING_IDENTITY.startsWith(
    "Developer ID Application: ",
  ) ||
  !credentials.APPLE_SIGNING_IDENTITY.endsWith(`(${credentials.APPLE_TEAM_ID})`)
) {
  throw new Error(
    "APPLE_SIGNING_IDENTITY must be the exact Developer ID Application identity for APPLE_TEAM_ID.",
  );
}
for (const name of [
  "APPLE_NOTARYTOOL_KEY_P8_BASE64",
  "APPLE_SIGNING_CERTIFICATE_P12_BASE64",
  "APPLE_SIGNING_CERTIFICATE_PASSWORD",
])
  delete process.env[name];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture
      ? ["ignore", "pipe", "pipe"]
      : ["inherit", "inherit", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = options.capture
      ? `\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})${output}`,
    );
  }
  return result;
}

function decodeBase64(value, label) {
  let encoded = value.trim();
  if (encoded.startsWith("'") && encoded.endsWith("'"))
    encoded = encoded.slice(1, -1);
  const dataUrlSeparator = encoded.indexOf(";base64,");
  if (dataUrlSeparator >= 0)
    encoded = encoded.slice(dataUrlSeparator + ";base64,".length);
  const decoded = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
  if (decoded.length === 0)
    throw new Error(`${label} did not decode to any data.`);
  return decoded;
}

function parseKeychainList(output) {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function resolveDeveloperDirectory() {
  const configured = process.env.DEVELOPER_DIR?.trim();
  if (configured) {
    if (!existsSync(configured))
      throw new Error(
        `Configured Xcode developer directory does not exist: ${configured}`,
      );
    return configured;
  }
  const candidate = [
    "/Applications/Xcode.app/Contents/Developer",
    "/Applications/Xcode-beta.app/Contents/Developer",
  ].find(existsSync);
  if (!candidate)
    throw new Error(
      "A complete Xcode installation is required for notarization.",
    );
  return candidate;
}

function validateImportedCertificate(keychainPath) {
  const identityResult = run(
    "security",
    ["find-identity", "-v", "-p", "codesigning", keychainPath],
    { capture: true },
  );
  if (
    !identityResult.stdout.includes(`"${credentials.APPLE_SIGNING_IDENTITY}"`)
  ) {
    throw new Error(
      `Expected signing identity is unavailable: ${credentials.APPLE_SIGNING_IDENTITY}`,
    );
  }
  const certificateResult = run(
    "security",
    [
      "find-certificate",
      "-a",
      "-c",
      credentials.APPLE_SIGNING_IDENTITY,
      "-Z",
      keychainPath,
    ],
    { capture: true },
  );
  const fingerprints = [
    ...certificateResult.stdout.matchAll(/SHA-256 hash:\s*([A-Fa-f0-9]+)/g),
  ].map((match) => normalizeFingerprint(match[1]));
  if (!fingerprints.includes(expectedFingerprint)) {
    throw new Error(
      `Imported certificate fingerprints ${fingerprints.join(", ") || "missing"} do not include ${expectedFingerprint}`,
    );
  }
}

function writeChecksum(filePath) {
  const hash = run("shasum", ["-a", "256", filePath], { capture: true })
    .stdout.trim()
    .split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error(`Unable to calculate SHA-256 for ${filePath}`);
  writeFileSync(`${filePath}.sha256`, `${hash}  ${basename(filePath)}\n`, {
    mode: 0o644,
  });
}

if (!skipBuild) run("npm", ["run", "build"]);

const signingDirectory = mkdtempSync(join(tmpdir(), "messenger-signing-"));
chmodSync(signingDirectory, 0o700);
const keychainPath = join(signingDirectory, "signing.keychain-db");
const originalP12Path = join(signingDirectory, "original.p12");
const passwordPath = join(signingDirectory, "p12-password");
const combinedPemPath = join(signingDirectory, "combined.pem");
const importP12Path = join(signingDirectory, "import.p12");
const apiKeyPath = join(signingDirectory, "AuthKey.p8");
const keychainPassword = randomBytes(24).toString("hex");
const importPassword = randomBytes(24).toString("hex");
let originalKeychains = [];
let keychainCreated = false;
let cleaningUp = false;

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  if (originalKeychains.length > 0) {
    spawnSync(
      "security",
      ["list-keychains", "-d", "user", "-s", ...originalKeychains],
      { stdio: "ignore" },
    );
  }
  if (keychainCreated)
    spawnSync("security", ["delete-keychain", keychainPath], {
      stdio: "ignore",
    });
  rmSync(signingDirectory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  writeFileSync(
    originalP12Path,
    decodeBase64(
      credentials.APPLE_SIGNING_CERTIFICATE_P12_BASE64,
      "Signing certificate",
    ),
    { mode: 0o600 },
  );
  writeFileSync(passwordPath, credentials.APPLE_SIGNING_CERTIFICATE_PASSWORD, {
    mode: 0o600,
  });
  const p8Value = credentials.APPLE_NOTARYTOOL_KEY_P8_BASE64;
  writeFileSync(
    apiKeyPath,
    p8Value.includes("BEGIN PRIVATE KEY")
      ? p8Value
      : decodeBase64(p8Value, "App Store Connect private key"),
    { mode: 0o600 },
  );

  run("openssl", [
    "pkcs12",
    "-legacy",
    "-in",
    originalP12Path,
    "-passin",
    `file:${passwordPath}`,
    "-nodes",
    "-out",
    combinedPemPath,
  ]);
  run("openssl", [
    "pkcs12",
    "-legacy",
    "-export",
    "-in",
    combinedPemPath,
    "-passout",
    `pass:${importPassword}`,
    "-out",
    importP12Path,
    "-name",
    "Messenger Developer ID",
  ]);

  originalKeychains = parseKeychainList(
    run("security", ["list-keychains", "-d", "user"], { capture: true }).stdout,
  );
  run("security", ["create-keychain", "-p", keychainPassword, keychainPath]);
  keychainCreated = true;
  run("security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
  run("security", ["unlock-keychain", "-p", keychainPassword, keychainPath]);
  run("security", [
    "import",
    importP12Path,
    "-k",
    keychainPath,
    "-P",
    importPassword,
    "-T",
    "/usr/bin/codesign",
  ]);
  run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    keychainPassword,
    keychainPath,
  ]);
  run("security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    keychainPath,
    ...originalKeychains,
  ]);
  validateImportedCertificate(keychainPath);

  const builderEnvironment = {
    ...process.env,
    APPLE_API_ISSUER: credentials.APPLE_NOTARYTOOL_ISSUER_ID,
    APPLE_API_KEY: apiKeyPath,
    APPLE_API_KEY_ID: credentials.APPLE_NOTARYTOOL_KEY_ID,
    APPLE_SIGNING_CERTIFICATE_SHA256: expectedFingerprint,
    APPLE_SIGNING_IDENTITY: credentials.APPLE_SIGNING_IDENTITY,
    APPLE_TEAM_ID: credentials.APPLE_TEAM_ID,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CSC_KEYCHAIN: keychainPath,
    CSC_NAME: credentials.APPLE_SIGNING_IDENTITY.replace(
      /^Developer ID Application:\s*/,
      "",
    ),
    DEVELOPER_DIR: resolveDeveloperDirectory(),
    FORCE_BETA_BUILD: channel === "beta" ? "true" : "false",
    MESSENGER_RELEASE_ARCH: arch,
    MESSENGER_RELEASE_CHANNEL: channel,
    MESSENGER_REQUIRE_RELEASE_SIGNING: "true",
  };

  for (const fileName of [
    contract.artifactName,
    contract.blockmapName,
    contract.notarizationName,
    `${contract.artifactName}.sha256`,
  ]) {
    rmSync(join(releaseDirectory, fileName), { force: true });
  }
  run(
    "npx",
    [
      "--no-install",
      "electron-builder",
      "--config",
      "electron-builder.config.js",
      "--mac",
      "zip",
      `--${arch}`,
      "--publish=never",
    ],
    { env: builderEnvironment },
  );

  const artifactPath = join(releaseDirectory, contract.artifactName);
  writeChecksum(artifactPath);
  run(
    "node",
    [
      "scripts/verify-macos-package.mjs",
      "--channel",
      channel,
      "--arch",
      arch,
      "--release-dir",
      releaseDirectory,
      "--require-checksum",
      ...(skipLaunch ? ["--skip-launch"] : []),
    ],
    { env: builderEnvironment },
  );
} finally {
  cleanup();
}
