import { MESSAGES_MEDIA_VIEWER_PATH_PREFIXES } from "./url-policy";

export type MessagesViewportMode = "chat" | "media" | "other";

type ResolveViewportModeInput = {
  urlPath: string;
  mediaOverlayVisible: boolean;
};

const MEDIA_ROUTE_PREFIXES = [...MESSAGES_MEDIA_VIEWER_PATH_PREFIXES];

const MEDIA_LOADING_BANNER_ROUTE_PREFIXES = MEDIA_ROUTE_PREFIXES.filter(
  (prefix) =>
    prefix === "/messenger_media" ||
    prefix === "/messages/attachment_preview" ||
    prefix === "/messages/media_viewer" ||
    prefix === "/photo" ||
    prefix === "/photos",
);

function matchesRoutePrefix(path: string, prefix: string): boolean {
  return (
    path === prefix ||
    path.startsWith(`${prefix}/`) ||
    path.startsWith(`${prefix}.`)
  );
}

function toPathname(input: string): string {
  if (!input) return "/";

  try {
    const parsed =
      input.startsWith("http://") || input.startsWith("https://")
        ? new URL(input)
        : new URL(input, "https://www.facebook.com");
    return (parsed.pathname || "/").toLowerCase();
  } catch {
    const trimmed = (input.split(/[?#]/)[0] || "/").toLowerCase();
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
}

export function isMessagesMediaRoute(input: string): boolean {
  const path = toPathname(input);
  return MEDIA_ROUTE_PREFIXES.some((prefix) =>
    matchesRoutePrefix(path, prefix),
  );
}

export function isMessagesChatRoute(input: string): boolean {
  const path = toPathname(input);
  if (!(path === "/messages" || path.startsWith("/messages/"))) {
    return false;
  }

  return !isMessagesMediaRoute(path);
}

export function resolveViewportMode(
  input: ResolveViewportModeInput,
): MessagesViewportMode {
  if (isMessagesMediaRoute(input.urlPath)) {
    return "media";
  }

  if (isMessagesChatRoute(input.urlPath)) {
    return input.mediaOverlayVisible ? "media" : "chat";
  }

  return "other";
}

export function shouldApplyMessagesCrop(
  input: ResolveViewportModeInput,
): boolean {
  return resolveViewportMode(input) === "chat";
}

export function shouldHideMediaViewerBannerWhileLoading(input: {
  urlPath: string;
  hasDismissAction: boolean;
  hasDownloadAction: boolean;
  hasShareAction: boolean;
  hasNavigationAction: boolean;
}): boolean {
  const path = toPathname(input.urlPath);
  if (
    !MEDIA_LOADING_BANNER_ROUTE_PREFIXES.some((prefix) =>
      matchesRoutePrefix(path, prefix),
    )
  ) {
    return false;
  }

  return !(
    input.hasDismissAction ||
    input.hasDownloadAction ||
    input.hasShareAction ||
    input.hasNavigationAction
  );
}

export function shouldKeepMediaViewerBannerHiddenDuringLoadingWindow(input: {
  loadingWindowActive: boolean;
  routeBasedLoading: boolean;
  hintedOverlayLoading: boolean;
  hasMarkedCloseAction: boolean;
  hasMarkedDownloadAction: boolean;
  hasMarkedShareAction: boolean;
  hasVisibleNavigationAction: boolean;
}): boolean {
  if (!input.loadingWindowActive) {
    return false;
  }

  if (
    input.hasMarkedCloseAction ||
    input.hasMarkedDownloadAction ||
    input.hasMarkedShareAction ||
    input.hasVisibleNavigationAction
  ) {
    return false;
  }

  return input.routeBasedLoading || input.hintedOverlayLoading;
}

export function shouldTreatHintedMediaOverlayAsVisible(input: {
  dismissCount: number;
  hasDownloadAction: boolean;
  hasShareAction: boolean;
  hasNavigationAction: boolean;
  hasLargeMedia: boolean;
  hasPendingOpenHint: boolean;
}): boolean {
  if (!input.hasPendingOpenHint) {
    return false;
  }

  // Same-route E2EE media opens can briefly expose only a single dismiss/back
  // control before the large photo and download/share chrome become measurable.
  // Once an explicit user open hint exists, treat one visible dismiss control as
  // enough overlay chrome to bypass the chat crop earlier.
  const hasOverlayChrome =
    input.dismissCount >= 1 || input.hasLargeMedia || input.hasNavigationAction;
  if (!hasOverlayChrome) {
    return false;
  }

  return (
    input.hasDownloadAction ||
    input.hasShareAction ||
    input.hasNavigationAction ||
    hasOverlayChrome
  );
}

export function shouldTreatDetectedMediaOverlayAsVisible(input: {
  modeFromPath: MessagesViewportMode;
  threadSubtabRoute: boolean;
  hasDismissAction: boolean;
  dismissCount: number;
  hasDownloadAction: boolean;
  hasShareAction: boolean;
  hasNavigationAction: boolean;
  hasLargeMedia: boolean;
  hasPendingOpenHint: boolean;
}): boolean {
  if (input.modeFromPath === "media") {
    return true;
  }

  if (input.threadSubtabRoute || !input.hasDismissAction) {
    return false;
  }

  if (
    shouldTreatHintedMediaOverlayAsVisible({
      dismissCount: input.dismissCount,
      hasDownloadAction: input.hasDownloadAction,
      hasShareAction: input.hasShareAction,
      hasNavigationAction: input.hasNavigationAction,
      hasLargeMedia: input.hasLargeMedia,
      hasPendingOpenHint: input.hasPendingOpenHint,
    })
  ) {
    return true;
  }

  // Chat threads can expose share actions next to large inline media after
  // dismissing a viewer. Keep share-only detection stricter than download or
  // navigation so normal thread chrome cannot get stuck in media mode.
  return (
    (input.hasDismissAction && input.hasNavigationAction) ||
    (input.hasDownloadAction && input.hasLargeMedia) ||
    (input.hasShareAction && input.hasLargeMedia && input.dismissCount >= 2)
  );
}

export function resolveMediaViewerStateVisible(input: {
  mediaOverlayVisible: boolean;
  incomingCallOverlayVisible: boolean;
}): boolean {
  // The media-viewer-state IPC channel is consumed by main-process media routing
  // and must remain scoped to media overlays only.
  // Incoming-call overlays are tracked on a separate hint channel.
  return input.mediaOverlayVisible;
}
