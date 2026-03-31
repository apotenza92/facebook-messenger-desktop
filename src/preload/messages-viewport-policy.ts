import {
  MESSAGES_MEDIA_VIEWER_PATH_PREFIXES,
} from "./url-policy";

export type MessagesViewportMode = "chat" | "media" | "other";

export type MessagesViewportStatePayload = {
  url: string;
  routeKind: MessagesViewportMode;
  headerHeight: number | null;
  cropHeight: number | null;
  shouldCrop: boolean;
};

type ResolveViewportModeInput = {
  urlPath: string;
  mediaOverlayVisible?: boolean;
  marketplaceThreadVisible?: boolean;
  marketplaceVisualCropHeight?: number | null;
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
  const marketplaceVisualCropHeight = normalizeViewportMeasurement(
    input.marketplaceVisualCropHeight,
  );
  if (
    marketplaceVisualCropHeight !== null &&
    marketplaceVisualCropHeight > 0
  ) {
    return true;
  }

  if (input.marketplaceThreadVisible === true) {
    return false;
  }

  return resolveViewportMode(input) === "chat";
}

export function resolveMessagesViewportState(input: {
  url: string;
  urlPath: string;
  headerHeight?: number | null;
  cropHeight?: number | null;
  mediaOverlayVisible?: boolean;
  marketplaceThreadVisible?: boolean;
  marketplaceVisualCropHeight?: number | null;
}): MessagesViewportStatePayload {
  return {
    url: input.url,
    routeKind: resolveViewportMode({
      urlPath: input.urlPath,
      mediaOverlayVisible: input.mediaOverlayVisible,
      marketplaceThreadVisible: input.marketplaceThreadVisible,
    }),
    headerHeight: normalizeViewportMeasurement(input.headerHeight),
    cropHeight: normalizeViewportMeasurement(
      input.cropHeight ?? input.marketplaceVisualCropHeight,
    ),
    shouldCrop: shouldApplyMessagesCrop({
      urlPath: input.urlPath,
      mediaOverlayVisible: input.mediaOverlayVisible,
      marketplaceThreadVisible: input.marketplaceThreadVisible,
      marketplaceVisualCropHeight:
        input.cropHeight ?? input.marketplaceVisualCropHeight,
    }),
  };
}
