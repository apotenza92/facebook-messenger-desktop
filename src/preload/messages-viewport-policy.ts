export type MessagesViewportMode = "chat" | "media" | "other";

type ResolveViewportModeInput = {
  urlPath: string;
  mediaOverlayVisible: boolean;
};

const MEDIA_ROUTE_PREFIXES = [
  "/messenger_media",
  "/messages/attachment_preview",
  "/messages/media_viewer",
  "/photo",
  "/photos",
  "/video",
  "/watch",
  "/reel",
  "/reels",
  "/story",
  "/stories",
];

function toPathname(input: string): string {
  if (!input) return "/";

  try {
    const parsed = input.startsWith("http://") || input.startsWith("https://")
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
  return MEDIA_ROUTE_PREFIXES.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      path.startsWith(`${prefix}.`),
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

export function shouldApplyMessagesCrop(input: ResolveViewportModeInput): boolean {
  return resolveViewportMode(input) === "chat";
}
