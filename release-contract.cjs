const CHANNELS = new Set(["stable", "beta"]);
const PLATFORMS = new Set(["darwin", "win32", "linux"]);
const ARCHITECTURES = new Set(["arm64", "x64"]);
const MINIMUM_MACOS_VERSION = "12.0.0";

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

module.exports = {
  ARCHITECTURES,
  CHANNELS,
  DEFAULT_UPDATE_FEED_BASE_URL,
  MINIMUM_MACOS_VERSION,
  PLATFORMS,
  metadataFileName,
  releaseContract,
};
