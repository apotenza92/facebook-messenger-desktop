const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ROLE_NAMES,
  createProductionTrust,
} = require("./create-tuf-production-trust.cjs");
const {
  signUpdateRepository,
  verifyEnvelope,
} = require("./sign-tuf-update-repository.cjs");
const { sealUpdateFeeds } = require("./seal-update-feeds.cjs");

const REVIEWED_ROOT_SHA256 =
  "6656f0dee4d52eb8d9c6e37c3799c4db39a90159edf185bff08018dc16d4be8a";

function temporaryDirectory(context, prefix) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() =>
    fs.rmSync(temporary, { recursive: true, force: true }),
  );
  return temporary;
}

function signingFixture(context) {
  const temporary = temporaryDirectory(context, "messenger-tuf-signing-");
  const privateKeyBundlePath = path.join(temporary, "private-keys.json");
  const rootPath = path.join(temporary, "root.json");
  createProductionTrust({ privateKeyBundlePath, rootPath });
  const privateBundle = JSON.parse(
    fs.readFileSync(privateKeyBundlePath, "utf8"),
  );
  return {
    privateKeys: Object.fromEntries(
      ["targets", "snapshot", "timestamp"].map((role) => [
        role,
        privateBundle.roles[role].private_key_pem,
      ]),
    ),
    rootPath,
    temporary,
  };
}

test("committed production root is the reviewed public trust anchor", () => {
  const rootPath = path.join(
    __dirname,
    "..",
    "build",
    "update-trust",
    "root.json",
  );
  const rootBytes = fs.readFileSync(rootPath);
  const root = JSON.parse(rootBytes);

  assert.equal(
    createHash("sha256").update(rootBytes).digest("hex"),
    REVIEWED_ROOT_SHA256,
  );
  assert.doesNotMatch(rootBytes.toString("utf8"), /PRIVATE KEY/);
  assert.deepEqual(
    Object.keys(root.signed.roles).sort(),
    [...ROLE_NAMES].sort(),
  );
  assert.equal(
    new Set(
      ROLE_NAMES.map((role) => root.signed.roles[role].keyids[0]),
    ).size,
    ROLE_NAMES.length,
  );
  verifyEnvelope(root, root, "root");
});

test("trust ceremony creates distinct role keys without overwriting", (context) => {
  const temporary = temporaryDirectory(
    context,
    "messenger-tuf-production-",
  );
  const privateKeyBundlePath = path.join(temporary, "private", "keys.json");
  const rootPath = path.join(temporary, "public", "root.json");
  const result = createProductionTrust({ privateKeyBundlePath, rootPath });
  const privateBundle = JSON.parse(
    fs.readFileSync(privateKeyBundlePath, "utf8"),
  );
  const root = JSON.parse(fs.readFileSync(rootPath, "utf8"));

  assert.equal(new Set(Object.values(result.keyIDs)).size, ROLE_NAMES.length);
  assert.equal(root.signed.version, 1);
  assert.ok(Date.parse(root.signed.expires) > Date.now());
  assert.equal(fs.statSync(privateKeyBundlePath).mode & 0o777, 0o600);
  for (const role of ROLE_NAMES) {
    assert.equal(privateBundle.roles[role].keyid, result.keyIDs[role]);
    assert.match(
      privateBundle.roles[role].private_key_pem,
      /^-----BEGIN PRIVATE KEY-----/,
    );
  }
  assert.throws(
    () => createProductionTrust({ privateKeyBundlePath, rootPath }),
    /must not already exist/,
  );
});

test("production signer creates verifiable metadata and increments versions", (context) => {
  const { privateKeys, rootPath, temporary } = signingFixture(context);
  const targetPath = path.join(temporary, "latest.yml");
  const first = path.join(temporary, "repository-v1");
  const second = path.join(temporary, "repository-v2");
  fs.writeFileSync(targetPath, "version: 1.0.0\n");
  signUpdateRepository({
    now: new Date("2026-07-30T00:00:00Z"),
    outputDirectory: first,
    previousMetadataDirectory: null,
    privateKeys,
    rootPath,
    targetName: "latest.yml",
    targetPath,
  });
  fs.writeFileSync(targetPath, "version: 1.0.1\n");
  const result = signUpdateRepository({
    now: new Date("2026-08-01T00:00:00Z"),
    outputDirectory: second,
    previousMetadataDirectory: path.join(first, "metadata"),
    privateKeys,
    rootPath,
    targetName: "latest.yml",
    targetPath,
  });
  assert.deepEqual(result.versions, {
    targets: 2,
    snapshot: 2,
    timestamp: 2,
  });
  const root = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  for (const role of ["targets", "snapshot", "timestamp"]) {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(second, "metadata", `${role}.json`), "utf8"),
    );
    verifyEnvelope(metadata, root, role);
  }
  assert.equal(
    fs.readFileSync(path.join(second, "targets", "latest.yml"), "utf8"),
    "version: 1.0.1\n",
  );
});

test("signer rejects tampered history and the wrong role key", (context) => {
  const { privateKeys, rootPath, temporary } = signingFixture(context);
  const targetPath = path.join(temporary, "latest.yml");
  const first = path.join(temporary, "repository-v1");
  fs.writeFileSync(targetPath, "version: 1.0.0\n");
  signUpdateRepository({
    outputDirectory: first,
    previousMetadataDirectory: null,
    privateKeys,
    rootPath,
    targetName: "latest.yml",
    targetPath,
  });
  const targetsPath = path.join(first, "metadata", "targets.json");
  const tampered = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  tampered.signed.version = 99;
  fs.writeFileSync(targetsPath, JSON.stringify(tampered));
  assert.throws(
    () =>
      signUpdateRepository({
        outputDirectory: path.join(temporary, "tampered"),
        previousMetadataDirectory: path.join(first, "metadata"),
        privateKeys,
        rootPath,
        targetName: "latest.yml",
        targetPath,
      }),
    /signature threshold/,
  );
  assert.throws(
    () =>
      signUpdateRepository({
        outputDirectory: path.join(temporary, "wrong-key"),
        previousMetadataDirectory: null,
        privateKeys: { ...privateKeys, targets: privateKeys.timestamp },
        rootPath,
        targetName: "latest.yml",
        targetPath,
      }),
    /targets key does not match/,
  );
});

test("feed sealer preserves channel boundaries and verified version history", (context) => {
  const { privateKeys, rootPath, temporary } = signingFixture(context);
  const inputRoot = path.join(temporary, "input");
  for (const arch of ["arm64", "x64"]) {
    const files = [
      ["darwin", "latest-mac.yml"],
      ["win32", "latest.yml"],
      [
        "linux",
        arch === "arm64"
          ? "latest-linux-arm64.yml"
          : "latest-linux.yml",
      ],
    ];
    for (const [platform, name] of files) {
      const directory = path.join(inputRoot, "beta", platform, arch);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, name),
        `version: 1.3.1-beta.45\narch: ${arch}\n`,
      );
    }
  }
  const first = path.join(temporary, "sealed-v1");
  const second = path.join(temporary, "sealed-v2");
  sealUpdateFeeds({
    inputRoot,
    now: new Date("2026-07-30T00:00:00Z"),
    outputRoot: first,
    previousRoot: null,
    privateKeys,
    releaseChannel: "beta",
    rootPath,
  });
  fs.writeFileSync(
    path.join(inputRoot, "beta", "win32", "x64", "latest.yml"),
    "version: 1.3.1-beta.46\narch: x64\n",
  );
  sealUpdateFeeds({
    inputRoot,
    now: new Date("2026-08-01T00:00:00Z"),
    outputRoot: second,
    previousRoot: first,
    privateKeys,
    releaseChannel: "beta",
    rootPath,
  });
  assert.equal(fs.existsSync(path.join(second, ".nojekyll")), true);
  assert.equal(fs.existsSync(path.join(second, "stable")), false);
  assert.equal(
    fs.readFileSync(
      path.join(second, "beta", "darwin", "arm64", "latest-mac.yml"),
      "utf8",
    ),
    "version: 1.3.1-beta.45\narch: arm64\n",
  );
  const root = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  for (const role of ["targets", "snapshot", "timestamp"]) {
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(
          second,
          "beta",
          "win32",
          "x64",
          "metadata",
          `${role}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(metadata.signed.version, 2);
    verifyEnvelope(metadata, root, role);
  }
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(second, "beta", "win32", "x64", "metadata", "root.json"),
      "utf8",
    ),
    /PRIVATE KEY/,
  );
  const third = path.join(temporary, "sealed-idempotent");
  sealUpdateFeeds({
    inputRoot,
    now: new Date("2026-08-02T00:00:00Z"),
    outputRoot: third,
    previousRoot: second,
    privateKeys,
    releaseChannel: "beta",
    rootPath,
  });
  assert.deepEqual(
    fs.readFileSync(
      path.join(second, "beta", "win32", "x64", "metadata", "timestamp.json"),
    ),
    fs.readFileSync(
      path.join(third, "beta", "win32", "x64", "metadata", "timestamp.json"),
    ),
  );
});
