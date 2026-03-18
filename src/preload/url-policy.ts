export const MESSAGES_MEDIA_VIEWER_PATH_PREFIXES = [
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

type WindowOpenAction =
  | "allow-child-window"
  | "reroute-main-view"
  | "download-media"
  | "open-external-browser";

function matchesRoutePrefix(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix ||
    pathname.startsWith(`${prefix}/`) ||
    pathname.startsWith(`${prefix}.`)
  );
}

function parseUrl(input: string): URL | null {
  try {
    if (input.startsWith("http://") || input.startsWith("https://")) {
      return new URL(input);
    }
    return new URL(input, "https://www.facebook.com");
  } catch {
    return null;
  }
}

function extractNestedUrlCandidate(parsed: URL): string | null {
  for (const key of ["u", "url", "href", "link", "next"]) {
    const value = parsed.searchParams.get(key);
    if (value) {
      return value;
    }
  }

  return null;
}

function isMessengerHost(hostname: string): boolean {
  return hostname === "messenger.com" || hostname === "www.messenger.com";
}

function isFacebookHost(hostname: string): boolean {
  return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
}

function isFacebookOrMessengerUrl(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed) return false;
  return isFacebookHost(parsed.hostname) || isMessengerHost(parsed.hostname);
}

function isMarketplaceUrl(input: string, depth = 0): boolean {
  if (depth > 2) return false;

  const parsed = parseUrl(input);
  if (!parsed) return false;

  if (
    isFacebookHost(parsed.hostname) &&
    parsed.pathname.toLowerCase().includes("/marketplace")
  ) {
    return true;
  }

  const nestedCandidate = extractNestedUrlCandidate(parsed);
  if (!nestedCandidate) return false;

  return isMarketplaceUrl(nestedCandidate, depth + 1);
}

function isMessagesRoute(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) return false;
  const pathname = parsed.pathname.toLowerCase();
  return pathname === "/messages" || pathname.startsWith("/messages/");
}

function isMessagesMediaViewerRoute(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) return false;

  const pathname = parsed.pathname.toLowerCase();
  return MESSAGES_MEDIA_VIEWER_PATH_PREFIXES.some((prefix) =>
    matchesRoutePrefix(pathname, prefix),
  );
}

function isLikelyCallPopupUrl(input: string): boolean {
  if (!input) return false;
  const lower = input.toLowerCase();
  if (lower === "about:blank") return true;

  return (
    lower.includes("call") ||
    lower.includes("videochat") ||
    lower.includes("webrtc") ||
    lower.includes("rtc") ||
    lower.includes("voip")
  );
}

function isFacebookMediaUrl(input: string): boolean {
  try {
    const hostname = new URL(input).hostname;
    return hostname.endsWith(".fbcdn.net");
  } catch {
    return false;
  }
}

function resolveWrappedNavigationTarget(
  input: string,
  depth = 0,
): string | null {
  if (depth > 2) return null;

  const parsed = parseUrl(input);
  if (!parsed || !isMessagesRoute(parsed.href)) {
    return null;
  }

  const nestedCandidate = extractNestedUrlCandidate(parsed);
  if (!nestedCandidate) return null;

  return (
    resolveWrappedNavigationTarget(nestedCandidate, depth + 1) ??
    nestedCandidate
  );
}

export function decideWindowOpenAction(input: string): WindowOpenAction {
  const resolvedInput = resolveWrappedNavigationTarget(input) ?? input;
  const isMessengerUrl = isFacebookOrMessengerUrl(resolvedInput);

  if (isMarketplaceUrl(resolvedInput)) {
    return "open-external-browser";
  }

  const shouldAllowChildWindow =
    resolvedInput === "about:blank" ||
    (isMessengerUrl && isLikelyCallPopupUrl(resolvedInput));
  if (shouldAllowChildWindow) {
    return "allow-child-window";
  }

  if (isMessengerUrl && isMessagesRoute(resolvedInput)) {
    return "reroute-main-view";
  }

  if (isMessengerUrl && isMessagesMediaViewerRoute(resolvedInput)) {
    return "reroute-main-view";
  }

  if (isFacebookMediaUrl(resolvedInput)) {
    return "download-media";
  }

  return "open-external-browser";
}
