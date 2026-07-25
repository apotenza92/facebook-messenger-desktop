export const MESSENGER_APPLE_TEAM_ID = "27JL2VERNC";

const channels = new Set(["stable", "beta"]);
const architectures = new Set(["arm64", "x64"]);

export function resolveMacReleaseContract(channel, arch) {
  if (!channels.has(channel)) {
    throw new Error(
      `Expected release channel stable or beta, received: ${channel}`,
    );
  }
  if (!architectures.has(arch)) {
    throw new Error(
      `Expected macOS architecture arm64 or x64, received: ${arch}`,
    );
  }

  const beta = channel === "beta";
  const productName = beta ? "Messenger Beta" : "Messenger";
  const artifactStem = `${beta ? "Messenger-Beta" : "Messenger"}-macos-${arch}`;
  return {
    appName: `${productName}.app`,
    arch,
    artifactName: `${artifactStem}.zip`,
    blockmapName: `${artifactStem}.zip.blockmap`,
    bundleId: beta
      ? "com.facebook.messenger.desktop.beta"
      : "com.facebook.messenger.desktop",
    channel,
    executableName: productName,
    metadataName: beta ? "beta-mac.yml" : "latest-mac.yml",
    notarizationName: `notarization-${channel}-macos-${arch}.json`,
    packageName: beta
      ? "facebook-messenger-desktop-beta"
      : "facebook-messenger-desktop",
    productName,
    updaterChannel: beta ? "beta" : "latest",
  };
}

export function normalizeFingerprint(value) {
  const fingerprint = String(value ?? "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(fingerprint)) {
    throw new Error(
      `Expected a SHA-256 certificate fingerprint, received: ${value}`,
    );
  }
  return fingerprint;
}

export function resolvePriorSigningFingerprints(currentValue, priorValue) {
  const fingerprints = [normalizeFingerprint(currentValue)];
  if (String(priorValue ?? "").trim()) {
    const prior = normalizeFingerprint(priorValue);
    if (!fingerprints.includes(prior)) fingerprints.push(prior);
  }
  return fingerprints;
}

export function parseCodesignMetadata(output) {
  const values = new Map();
  const authorities = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (line.startsWith("CodeDirectory ")) {
      values.set("CodeDirectory", line);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Authority") authorities.push(value);
    else if (!values.has(key)) values.set(key, value);
  }
  return {
    authorities,
    cdHash: values.get("CDHash") ?? null,
    flags: values.get("CodeDirectory") ?? "",
    identifier: values.get("Identifier") ?? null,
    teamIdentifier: values.get("TeamIdentifier") ?? null,
    timestamp: values.get("Timestamp") ?? null,
  };
}

export function validateSignatureMetadata(metadata, expectations, label) {
  if (metadata.authorities[0] !== expectations.identity) {
    throw new Error(
      `${label} signer ${metadata.authorities[0] ?? "missing"} does not match ${expectations.identity}`,
    );
  }
  if (metadata.teamIdentifier !== expectations.teamId) {
    throw new Error(
      `${label} team ${metadata.teamIdentifier ?? "missing"} does not match ${expectations.teamId}`,
    );
  }
  if (!metadata.flags.includes("runtime")) {
    throw new Error(
      `${label} does not have the hardened-runtime signature flag`,
    );
  }
  if (!metadata.timestamp) {
    throw new Error(`${label} does not have a secure signing timestamp`);
  }
  if (!metadata.cdHash) {
    throw new Error(`${label} does not expose a CDHash`);
  }
}

export function validateNotarizationRecord(record) {
  if (
    !record ||
    record.submission?.status !== "Accepted" ||
    typeof record.submission?.id !== "string"
  ) {
    throw new Error("Notarization submission was not accepted");
  }
  if (!record.log || record.log.status !== "Accepted") {
    throw new Error("Notarization log does not report Accepted status");
  }
  if (record.log.jobId && record.log.jobId !== record.submission.id) {
    throw new Error("Notarization log job ID does not match its submission");
  }
  const issues = Array.isArray(record.log.issues) ? record.log.issues : [];
  if (
    issues.some(
      (issue) => String(issue?.severity ?? "").toLowerCase() === "error",
    )
  ) {
    throw new Error("Notarization log contains error issues");
  }
  return record;
}
