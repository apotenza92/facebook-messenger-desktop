const CHANNELS = new Set(["stable", "beta"]);
const PLATFORMS = new Set(["darwin", "win32", "linux"]);
const ARCHITECTURES = new Set(["arm64", "x64"]);
const MINIMUM_MACOS_VERSION = "12.0.0";
const EXPLICIT_BETA_UPDATER_PREDECESSORS = Object.freeze({
  "1.4.1-beta.1": "1.4.0",
});
const EXPLICIT_STABLE_UPDATER_PREDECESSORS = Object.freeze({
  "1.4.2": "1.4.0",
});

const DEFAULT_UPDATE_FEED_BASE_URL =
  "https://raw.githubusercontent.com/apotenza92/facebook-messenger-desktop/updates";

function requireChoice(label, value, choices) {
  if (!choices.has(value)) {
    throw new Error(
      `${label} must be one of ${[...choices].join(", ")}; received ${value}.`,
    );
  }
}

function releaseContract({
  channel,
  platform,
  arch,
  feedBaseUrl = DEFAULT_UPDATE_FEED_BASE_URL,
}) {
  requireChoice("channel", channel, CHANNELS);
  requireChoice("platform", platform, PLATFORMS);
  requireChoice("architecture", arch, ARCHITECTURES);

  const normalizedFeedBaseUrl = String(feedBaseUrl).replace(/\/$/, "");
  const beta = channel === "beta";

  return {
    appId: beta
      ? "com.facebook.messenger.desktop.beta"
      : "com.facebook.messenger.desktop",
    arch,
    channel,
    feedBaseUrl: normalizedFeedBaseUrl,
    feedUrl: `${normalizedFeedBaseUrl}/${channel}/${platform}/${arch}`,
    packageName: beta
      ? "facebook-messenger-desktop-beta"
      : "facebook-messenger-desktop",
    platform,
    productName: beta ? "Messenger Beta" : "Messenger",
  };
}

function metadataFileName(platform, arch) {
  requireChoice("platform", platform, PLATFORMS);
  requireChoice("architecture", arch, ARCHITECTURES);
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

function resolveNonMacUpdaterPredecessor(version) {
  const normalizedVersion = String(version || "").trim();
  const betaMatch = normalizedVersion.match(
    /^(\d+)\.(\d+)\.(\d+)-beta\.([1-9]\d*)$/,
  );
  if (betaMatch) {
    const betaNumber = Number(betaMatch[4]);
    if (betaNumber > 1) {
      return `${betaMatch[1]}.${betaMatch[2]}.${betaMatch[3]}-beta.${betaNumber - 1}`;
    }

    const explicit = EXPLICIT_BETA_UPDATER_PREDECESSORS[normalizedVersion];
    if (!explicit) {
      throw new Error(
        `The updater gate requires an explicit predecessor for ${normalizedVersion}.`,
      );
    }
    return explicit;
  }

  const stableMatch = normalizedVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!stableMatch) {
    throw new Error(
      `Updater predecessor version must be stable or beta; received ${normalizedVersion}.`,
    );
  }

  const major = Number(stableMatch[1]);
  const minor = Number(stableMatch[2]);
  const patch = Number(stableMatch[3]);
  const explicit = EXPLICIT_STABLE_UPDATER_PREDECESSORS[normalizedVersion];
  if (explicit) return explicit;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error("The updater gate cannot derive a predecessor for 0.0.0.");
}

module.exports = {
  ARCHITECTURES,
  CHANNELS,
  DEFAULT_UPDATE_FEED_BASE_URL,
  EXPLICIT_BETA_UPDATER_PREDECESSORS,
  EXPLICIT_STABLE_UPDATER_PREDECESSORS,
  MINIMUM_MACOS_VERSION,
  PLATFORMS,
  metadataFileName,
  releaseContract,
  resolveNonMacUpdaterPredecessor,
};
