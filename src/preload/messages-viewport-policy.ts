import {
  MESSAGES_MEDIA_VIEWER_PATH_PREFIXES,
} from "./url-policy";

export type MessagesViewportMode = "chat" | "media" | "other";

export type MessagesViewportStatePayload = {
  url: string;
  routeKind: MessagesViewportMode;
  headerHeight: number | null;
  shouldCrop: boolean;
};

type ResolveViewportModeInput = {
  urlPath: string;
  mediaOverlayVisible?: boolean;
};

const MEDIA_ROUTE_PREFIXES = [...MESSAGES_MEDIA_VIEWER_PATH_PREFIXES];

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

function normalizeViewportMeasurement(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 240) return 240;
  return rounded;
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
  const path = toPathname(input.urlPath);

  if (isMessagesMediaRoute(path)) {
    return "media";
  }

  if (isMessagesChatRoute(path)) {
    if (input.mediaOverlayVisible === true) {
      return "media";
    }
    return "chat";
  }

  return "other";
}

export function shouldApplyMessagesCrop(
  input: ResolveViewportModeInput,
): boolean {
  return resolveViewportMode(input) === "chat";
}

export function resolveMessagesViewportState(input: {
  url: string;
  urlPath: string;
  headerHeight?: number | null;
  mediaOverlayVisible?: boolean;
}): MessagesViewportStatePayload {
  return {
    url: input.url,
    routeKind: resolveViewportMode({
      urlPath: input.urlPath,
      mediaOverlayVisible: input.mediaOverlayVisible,
    }),
    headerHeight: normalizeViewportMeasurement(input.headerHeight),
    shouldCrop: shouldApplyMessagesCrop({
      urlPath: input.urlPath,
      mediaOverlayVisible: input.mediaOverlayVisible,
    }),
  };
}
