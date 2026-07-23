export type ReleaseChannel = "stable" | "beta";

export type PackageManagerContract = {
  flatpakAppId: string;
  homebrewCask: string;
  linuxPackageName: string;
  snapChannel: ReleaseChannel;
  snapPackageName: string;
  wingetId: string;
};

export function resolvePackageManagerContract(
  channel: ReleaseChannel,
): PackageManagerContract {
  const beta = channel === "beta";
  return {
    flatpakAppId: beta
      ? "com.facebook.messenger.desktop.beta"
      : "com.facebook.messenger.desktop",
    homebrewCask: beta
      ? "apotenza92/tap/facebook-messenger-desktop@beta"
      : "apotenza92/tap/facebook-messenger-desktop",
    linuxPackageName: beta
      ? "facebook-messenger-desktop-beta"
      : "facebook-messenger-desktop",
    snapChannel: channel,
    snapPackageName: "facebook-messenger-desktop",
    wingetId: beta
      ? "apotenza92.FacebookMessengerDesktopBeta"
      : "apotenza92.FacebookMessengerDesktop",
  };
}
