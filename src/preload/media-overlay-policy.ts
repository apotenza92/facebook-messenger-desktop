import { type MessagesViewportMode } from "./messages-viewport-policy";

export type MediaOverlaySignals = {
  path: string;
  modeFromPath: MessagesViewportMode;
  threadSubtabRoute: boolean;
  hasDismissAction: boolean;
  dismissCount: number;
  hasDownloadAction: boolean;
  downloadCount: number;
  hasShareAction: boolean;
  shareCount: number;
  hasNavigationAction: boolean;
  navigationCount: number;
  hasLargeMedia: boolean;
};

export function evaluateMediaOverlayVisible(
  signals: MediaOverlaySignals,
): boolean {
  if (signals.modeFromPath === "media") {
    return true;
  }

  if (signals.threadSubtabRoute || !signals.hasDismissAction) {
    return false;
  }

  return (
    (signals.hasDismissAction && signals.hasNavigationAction) ||
    (signals.hasDownloadAction && signals.hasLargeMedia)
  );
}
