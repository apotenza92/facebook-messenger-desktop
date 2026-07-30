#!/usr/bin/env node

const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("@tufjs/canonical-json");

const ROLE_NAMES = Object.freeze(["root", "targets", "snapshot", "timestamp"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicKeyDescription(publicKey) {
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  return {
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: { public: publicDer.subarray(-32).toString("hex") },
  };
}

function generateRoleKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDescription = publicKeyDescription(publicKey);
  return {
    keyID: sha256(Buffer.from(canonicalize(publicDescription))),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicDescription,
  };
}

function signMetadata(signed, keyID, privateKey) {
  return {
    signatures: [
      {
        keyid: keyID,
        sig: sign(
          null,
          Buffer.from(canonicalize(signed)),
          privateKey,
        ).toString("hex"),
      },
    ],
    signed,
  };
}

function createProductionTrust({
  privateKeyBundlePath,
  rootPath,
  rootExpires = "2036-01-01T00:00:00Z",
}) {
  if (fs.existsSync(privateKeyBundlePath) || fs.existsSync(rootPath)) {
    throw new Error("Production TUF trust outputs must not already exist.");
  }
  if (
    !Number.isFinite(Date.parse(rootExpires)) ||
    Date.parse(rootExpires) <= Date.now()
  ) {
    throw new Error(
      "The production TUF root expiry must be a future ISO-8601 timestamp.",
    );
  }

  const keys = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, generateRoleKey()]),
  );
  const rootSigned = {
    _type: "root",
    spec_version: "1.0.31",
    version: 1,
    expires: rootExpires,
    consistent_snapshot: false,
    keys: Object.fromEntries(
      ROLE_NAMES.map((role) => [
        keys[role].keyID,
        keys[role].publicDescription,
      ]),
    ),
    roles: Object.fromEntries(
      ROLE_NAMES.map((role) => [
        role,
        { keyids: [keys[role].keyID], threshold: 1 },
      ]),
    ),
  };
  const root = signMetadata(
    rootSigned,
    keys.root.keyID,
    keys.root.privateKey,
  );
  const rootBytes = Buffer.from(`${JSON.stringify(root)}\n`);
  const privateBundle = {
    purpose: "Messenger Desktop production TUF signing keys",
    root_version: 1,
    root_sha256: sha256(rootBytes),
    roles: Object.fromEntries(
      ROLE_NAMES.map((role) => [
        role,
        {
          keyid: keys[role].keyID,
          private_key_pem: keys[role].privateKey,
        },
      ]),
    ),
  };

  fs.mkdirSync(path.dirname(rootPath), { recursive: true });
  fs.mkdirSync(path.dirname(privateKeyBundlePath), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(rootPath, rootBytes, { flag: "wx", mode: 0o644 });
  fs.writeFileSync(
    privateKeyBundlePath,
    `${JSON.stringify(privateBundle, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    keyIDs: Object.fromEntries(
      ROLE_NAMES.map((role) => [role, keys[role].keyID]),
    ),
    root,
    rootSha256: privateBundle.root_sha256,
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2)) {
  const privateKeyBundlePath = option(argv, "--private-key-bundle");
  const rootPath = option(argv, "--root");
  if (!privateKeyBundlePath || !rootPath) {
    throw new Error(
      "Usage: create-tuf-production-trust.cjs " +
        "--root <new-public-file> --private-key-bundle <new-private-file>",
    );
  }
  const result = createProductionTrust({
    privateKeyBundlePath: path.resolve(privateKeyBundlePath),
    rootPath: path.resolve(rootPath),
  });
  process.stdout.write(`Created Messenger TUF root ${result.rootSha256}.\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ROLE_NAMES,
  createProductionTrust,
  publicKeyDescription,
};
