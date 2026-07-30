#!/usr/bin/env node

const {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("@tufjs/canonical-json");

const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const ONLINE_ROLES = Object.freeze(["targets", "snapshot", "timestamp"]);
const EXPIRY_DAYS = Object.freeze({
  targets: 365,
  snapshot: 180,
  timestamp: 45,
});

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

function keyID(publicDescription) {
  return sha256(Buffer.from(canonicalize(publicDescription)));
}

function publicKeyFromDescription(description) {
  if (
    description?.keytype !== "ed25519" ||
    description?.scheme !== "ed25519" ||
    !/^[a-f0-9]{64}$/.test(description?.keyval?.public || "")
  ) {
    throw new Error("Messenger TUF root contains an unsupported public key.");
  }
  return createPublicKey({
    key: Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(description.keyval.public, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
}

function verifyEnvelope(envelope, root, roleName) {
  const role = root?.signed?.roles?.[roleName];
  if (!role || !Number.isSafeInteger(role.threshold) || role.threshold < 1) {
    throw new Error(`Messenger TUF root has no valid ${roleName} role.`);
  }
  const payload = Buffer.from(canonicalize(envelope?.signed));
  const valid = new Set();
  for (const signature of envelope?.signatures || []) {
    if (
      !role.keyids.includes(signature.keyid) ||
      valid.has(signature.keyid)
    ) {
      continue;
    }
    const description = root.signed.keys?.[signature.keyid];
    if (!description || !/^[a-f0-9]+$/.test(signature.sig || "")) continue;
    if (
      verify(
        null,
        payload,
        publicKeyFromDescription(description),
        Buffer.from(signature.sig, "hex"),
      )
    ) {
      valid.add(signature.keyid);
    }
  }
  if (valid.size < role.threshold) {
    throw new Error(
      `Messenger TUF ${roleName} metadata does not meet its signature threshold.`,
    );
  }
}

function requireRoot(root) {
  if (
    root?.signed?._type !== "root" ||
    root.signed.version !== 1 ||
    root.signed.spec_version !== "1.0.31"
  ) {
    throw new Error(
      "Messenger TUF root must be reviewed version 1 metadata.",
    );
  }
  verifyEnvelope(root, root, "root");
}

function roleSigner(root, roleName, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const description = publicKeyDescription(createPublicKey(privateKey));
  const signerKeyID = keyID(description);
  const role = root.signed.roles?.[roleName];
  if (
    role?.threshold !== 1 ||
    role.keyids.length !== 1 ||
    role.keyids[0] !== signerKeyID ||
    !root.signed.keys?.[signerKeyID]
  ) {
    throw new Error(
      `The supplied ${roleName} key does not match the reviewed Messenger TUF root.`,
    );
  }
  return { keyID: signerKeyID, privateKey };
}

function signedEnvelope(signed, signer) {
  return {
    signatures: [
      {
        keyid: signer.keyID,
        sig: sign(
          null,
          Buffer.from(canonicalize(signed)),
          signer.privateKey,
        ).toString("hex"),
      },
    ],
    signed,
  };
}

function expiresFrom(now, days) {
  return new Date(
    now.getTime() + days * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function readPrevious(previousMetadataDirectory, roleName, root) {
  if (!previousMetadataDirectory) return null;
  const filePath = path.join(previousMetadataDirectory, `${roleName}.json`);
  if (!fs.existsSync(filePath)) return null;
  const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    envelope?.signed?._type !== roleName ||
    !Number.isSafeInteger(envelope.signed.version) ||
    envelope.signed.version < 1
  ) {
    throw new Error(
      `Previous Messenger TUF ${roleName} metadata is invalid.`,
    );
  }
  verifyEnvelope(envelope, root, roleName);
  return envelope;
}

function writeFileExclusive(filePath, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes, { flag: "wx", mode });
}

function signUpdateRepository({
  now = new Date(),
  outputDirectory,
  previousMetadataDirectory,
  privateKeys,
  rootPath,
  targetName,
  targetPath,
}) {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Messenger TUF signing time is invalid.");
  }
  if (
    !targetName ||
    targetName !== path.posix.basename(targetName) ||
    targetName.includes("\\") ||
    targetName.includes("\0")
  ) {
    throw new Error(`Unsafe Messenger TUF target name: ${targetName}`);
  }
  if (fs.existsSync(outputDirectory)) {
    throw new Error(
      "Messenger TUF repository output must not already exist.",
    );
  }
  const rootBytes = fs.readFileSync(rootPath);
  const root = JSON.parse(rootBytes);
  requireRoot(root);
  const targetBytes = fs.readFileSync(targetPath);
  const signers = Object.fromEntries(
    ONLINE_ROLES.map((roleName) => [
      roleName,
      roleSigner(root, roleName, privateKeys[roleName]),
    ]),
  );
  const previous = Object.fromEntries(
    ONLINE_ROLES.map((roleName) => [
      roleName,
      readPrevious(previousMetadataDirectory, roleName, root),
    ]),
  );
  const versions = Object.fromEntries(
    ONLINE_ROLES.map((roleName) => [
      roleName,
      (previous[roleName]?.signed?.version || 0) + 1,
    ]),
  );

  const targets = signedEnvelope(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: versions.targets,
      expires: expiresFrom(now, EXPIRY_DAYS.targets),
      targets: {
        [targetName]: {
          length: targetBytes.length,
          hashes: { sha256: sha256(targetBytes) },
        },
      },
    },
    signers.targets,
  );
  const targetsBytes = Buffer.from(JSON.stringify(targets));
  const snapshot = signedEnvelope(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: versions.snapshot,
      expires: expiresFrom(now, EXPIRY_DAYS.snapshot),
      meta: {
        "targets.json": {
          version: versions.targets,
          length: targetsBytes.length,
          hashes: { sha256: sha256(targetsBytes) },
        },
      },
    },
    signers.snapshot,
  );
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const timestamp = signedEnvelope(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: versions.timestamp,
      expires: expiresFrom(now, EXPIRY_DAYS.timestamp),
      meta: {
        "snapshot.json": {
          version: versions.snapshot,
          length: snapshotBytes.length,
          hashes: { sha256: sha256(snapshotBytes) },
        },
      },
    },
    signers.timestamp,
  );
  const timestampBytes = Buffer.from(JSON.stringify(timestamp));

  const metadataDirectory = path.join(outputDirectory, "metadata");
  const targetsDirectory = path.join(outputDirectory, "targets");
  writeFileExclusive(path.join(metadataDirectory, "1.root.json"), rootBytes);
  writeFileExclusive(path.join(metadataDirectory, "root.json"), rootBytes);
  writeFileExclusive(
    path.join(metadataDirectory, "targets.json"),
    targetsBytes,
  );
  writeFileExclusive(
    path.join(metadataDirectory, "snapshot.json"),
    snapshotBytes,
  );
  writeFileExclusive(
    path.join(metadataDirectory, "timestamp.json"),
    timestampBytes,
  );
  writeFileExclusive(
    path.join(targetsDirectory, targetName),
    targetBytes,
  );

  const evidence = [
    "Messenger Desktop production TUF repository",
    `Root version: ${root.signed.version}`,
    `Root SHA-256: ${sha256(rootBytes)}`,
    `Target: ${targetName}`,
    `Target SHA-256: ${sha256(targetBytes)}`,
    ...ONLINE_ROLES.flatMap((roleName) => [
      `${roleName} version: ${versions[roleName]}`,
      `${roleName} expires: ${
        roleName === "targets"
          ? targets.signed.expires
          : roleName === "snapshot"
            ? snapshot.signed.expires
            : timestamp.signed.expires
      }`,
      `${roleName} key ID: ${signers[roleName].keyID}`,
    ]),
    "",
  ].join("\n");
  writeFileExclusive(
    path.join(outputDirectory, "EVIDENCE.txt"),
    evidence,
  );
  const checksummed = [
    "EVIDENCE.txt",
    "metadata/1.root.json",
    "metadata/root.json",
    "metadata/snapshot.json",
    "metadata/targets.json",
    "metadata/timestamp.json",
    `targets/${targetName}`,
  ];
  const checksums = checksummed
    .map(
      (name) =>
        `${sha256(fs.readFileSync(path.join(outputDirectory, name)))}  ${name}`,
    )
    .join("\n");
  writeFileExclusive(
    path.join(outputDirectory, "SHA256SUMS"),
    `${checksums}\n`,
  );
  return { root, targetName, versions };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const outputDirectory = option(argv, "--output");
  const previousMetadataDirectory = option(argv, "--previous-metadata");
  const rootPath = option(argv, "--root");
  const targetName = option(argv, "--target-name");
  const targetPath = option(argv, "--target");
  if (!outputDirectory || !rootPath || !targetName || !targetPath) {
    throw new Error(
      "Usage: sign-tuf-update-repository.cjs --root FILE --target FILE " +
        "--target-name NAME --output NEW_DIRECTORY [--previous-metadata DIRECTORY]",
    );
  }
  const privateKeys = Object.fromEntries(
    ONLINE_ROLES.map((roleName) => {
      const variable = `MESSENGER_TUF_${roleName.toUpperCase()}_PRIVATE_KEY_PEM`;
      if (!env[variable]) throw new Error(`Missing ${variable}.`);
      return [roleName, env[variable]];
    }),
  );
  const configuredNow = env.MESSENGER_TUF_METADATA_NOW
    ? new Date(env.MESSENGER_TUF_METADATA_NOW)
    : new Date();
  const result = signUpdateRepository({
    now: configuredNow,
    outputDirectory: path.resolve(outputDirectory),
    previousMetadataDirectory: previousMetadataDirectory
      ? path.resolve(previousMetadataDirectory)
      : null,
    privateKeys,
    rootPath: path.resolve(rootPath),
    targetName,
    targetPath: path.resolve(targetPath),
  });
  process.stdout.write(
    `Signed Messenger TUF ${result.targetName} at versions ` +
      `${ONLINE_ROLES.map((role) => `${role}=${result.versions[role]}`).join(", ")}.\n`,
  );
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
  EXPIRY_DAYS,
  ONLINE_ROLES,
  signUpdateRepository,
  verifyEnvelope,
};
