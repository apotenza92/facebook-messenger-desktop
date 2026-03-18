const FACEBOOK_BASE_URL = "https://www.facebook.com";
export const MESSAGES_HOME_URL = `${FACEBOOK_BASE_URL}/messages/`;

const AUTH_PATH_PREFIXES = [
  "/login",
  "/checkpoint",
  "/recover",
  "/challenge",
  "/two_step_verification",
  "/two_step",
  "/two_factor",
  "/login/identify",
  "/login/device-based",
  "/dialog/oauth",
  "/v2.0/dialog",
  "/auth/",
  "/oauth/",
  "/cookie/",
  "/consent/",
  "/ajax/",
  "/api/",
  "/rti/",
  "/security/",
  "/trust",
  "/device",
  "/save-device",
  "/remember_browser",
  "/confirmemail",
  "/confirmphone",
  "/code_gen",
  "/help/",
  "/privacy",
  "/settings",
];

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

const WRAPPED_NAVIGATION_QUERY_KEYS = ["u", "url", "href", "link", "next"];
const WRAPPED_NAVIGATION_PATHNAMES = new Set(["/l.php"]);

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
    return new URL(input, FACEBOOK_BASE_URL);
  } catch {
    return null;
  }
}

function extractNestedUrlCandidate(parsed: URL): string | null {
  for (const key of WRAPPED_NAVIGATION_QUERY_KEYS) {
    const value = parsed.searchParams.get(key);
    if (value) {
      return value;
    }
  }

  return null;
}

function shouldResolveWrappedNavigationTarget(parsed: URL): boolean {
  const path = parsed.pathname.toLowerCase();
  return isMessagesRoute(parsed.href) || WRAPPED_NAVIGATION_PATHNAMES.has(path);
}

export function isMessengerHost(hostname: string): boolean {
  return hostname === "messenger.com" || hostname === "www.messenger.com";
}

export function isFacebookHost(hostname: string): boolean {
  return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
}

export function isFacebookOrMessengerUrl(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed) return false;
  return isFacebookHost(parsed.hostname) || isMessengerHost(parsed.hostname);
}

export function resolveWrappedNavigationTarget(
  input: string,
  depth = 0,
): string | null {
  if (depth > 2) return null;

  const parsed = parseUrl(input);
  if (!parsed || !shouldResolveWrappedNavigationTarget(parsed)) {
    return null;
  }

  const nestedCandidate = extractNestedUrlCandidate(parsed);
  if (!nestedCandidate) return null;

  return (
    resolveWrappedNavigationTarget(nestedCandidate, depth + 1) ??
    nestedCandidate
  );
}

export function isMarketplaceUrl(input: string, depth = 0): boolean {
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

export function isMessagesRoute(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) return false;
  const pathname = parsed.pathname.toLowerCase();
  return pathname === "/messages" || pathname.startsWith("/messages/");
}

export function isMessagesMediaViewerRoute(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) return false;

  const pathname = parsed.pathname.toLowerCase();
  return MESSAGES_MEDIA_VIEWER_PATH_PREFIXES.some((prefix) =>
    matchesRoutePrefix(pathname, prefix),
  );
}

export function isLikelyCallPopupUrl(input: string): boolean {
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

export function isFacebookMediaUrl(input: string): boolean {
  try {
    const hostname = new URL(input).hostname;
    return hostname.endsWith(".fbcdn.net");
  } catch {
    return false;
  }
}

export type WindowOpenAction =
  | "allow-child-window"
  | "reroute-main-view"
  | "download-media"
  | "open-external-browser";

export function isMessagesSurfaceRoute(input: string): boolean {
  return isMessagesRoute(input) || isMessagesMediaViewerRoute(input);
}

export function isFacebookHomePage(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) return false;
  return parsed.pathname === "/" || parsed.pathname === "";
}

export function isAuthOrCheckpointRoute(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) return false;

  const path = parsed.pathname.toLowerCase();
  const full = `${path}${parsed.search}`.toLowerCase();

  if (AUTH_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }

  return (
    full.includes("checkpoint") ||
    full.includes("two_step") ||
    full.includes("two_factor") ||
    full.includes("remember_browser") ||
    full.includes("login/identify") ||
    full.includes("login/device-based")
  );
}

function resolveAppNavigationTarget(input: string): string {
  return resolveWrappedNavigationTarget(input) ?? input;
}

export function shouldOpenInApp(input: string): boolean {
  const resolvedInput = resolveAppNavigationTarget(input);
  const parsed = parseUrl(resolvedInput);
  if (!parsed || !isFacebookHost(parsed.hostname)) {
    return false;
  }

  if (isMarketplaceUrl(resolvedInput)) {
    return false;
  }

  return (
    isMessagesRoute(resolvedInput) ||
    isMessagesMediaViewerRoute(resolvedInput) ||
    isAuthOrCheckpointRoute(resolvedInput) ||
    isFacebookHomePage(resolvedInput)
  );
}

export function decideWindowOpenAction(input: string): WindowOpenAction {
  const resolvedInput = resolveAppNavigationTarget(input);
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

export function shouldReloadToMessagesHome(input: string): boolean {
  const resolvedInput = resolveAppNavigationTarget(input);
  if (!isFacebookOrMessengerUrl(resolvedInput)) {
    return false;
  }

  return !(
    isMessagesSurfaceRoute(resolvedInput) ||
    isAuthOrCheckpointRoute(resolvedInput) ||
    isFacebookHomePage(resolvedInput)
  );
}

function normalizePathForMessages(pathname: string): string {
  const path = pathname || "/";
  if (path === "/messages" || path.startsWith("/messages/")) {
    return path;
  }

  if (path.startsWith("/t/") || path.startsWith("/e2ee/")) {
    return `/messages${path}`;
  }

  return "/messages/";
}

export function toMessagesUrl(input: string): string {
  const parsed = parseUrl(input);
  if (!parsed) {
    return MESSAGES_HOME_URL;
  }

  const normalizedPath = normalizePathForMessages(parsed.pathname);
  const search = parsed.search || "";
  const hash = parsed.hash || "";
  return `${FACEBOOK_BASE_URL}${normalizedPath}${search}${hash}`;
}
