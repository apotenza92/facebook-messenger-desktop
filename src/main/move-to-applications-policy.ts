import * as path from "path";

export type MoveToApplicationsRequest = {
  platform: NodeJS.Platform;
  isDev: boolean;
  exePath: string;
  homeDir: string;
  alreadyPrompted: boolean;
};

export type MoveToApplicationsDecision =
  | {
      prompt: false;
      reason:
        | "not-macos"
        | "dev"
        | "installed"
        | "translocated"
        | "already-prompted";
    }
  | {
      prompt: true;
      appBundlePath: string;
      destinationPath: string;
    };

export function isInApplicationsFolder(
  exePath: string,
  homeDir: string,
): boolean {
  // Check both /Applications and ~/Applications
  return (
    exePath.startsWith("/Applications/") ||
    exePath.includes("/Applications/") ||
    exePath.startsWith(path.join(homeDir, "Applications/"))
  );
}

// macOS runs a quarantined app that Finder never moved from a read-only
// mirror under .../AppTranslocation/<id>/d/. The real bundle is elsewhere,
// often already in /Applications.
export function isTranslocatedPath(exePath: string): boolean {
  return exePath.includes("/AppTranslocation/");
}

export function decideMoveToApplicationsPrompt(
  request: MoveToApplicationsRequest,
): MoveToApplicationsDecision {
  if (request.platform !== "darwin") {
    return { prompt: false, reason: "not-macos" };
  }
  if (request.isDev) return { prompt: false, reason: "dev" };
  if (isInApplicationsFolder(request.exePath, request.homeDir)) {
    return { prompt: false, reason: "installed" };
  }
  // The mirror cannot be moved, and its real copy may be the one the prompt
  // would replace.
  if (isTranslocatedPath(request.exePath)) {
    return { prompt: false, reason: "translocated" };
  }
  if (request.alreadyPrompted) {
    return { prompt: false, reason: "already-prompted" };
  }

  // exe is inside Messenger.app/Contents/MacOS/Messenger, so go up 3 levels
  const appBundlePath = path.resolve(request.exePath, "../../..");
  return {
    prompt: true,
    appBundlePath,
    destinationPath: path.join("/Applications", path.basename(appBundlePath)),
  };
}
