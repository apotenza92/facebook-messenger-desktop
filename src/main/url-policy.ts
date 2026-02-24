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

const MESSAGES_MEDIA_VIEWER_PATH_PREFIXES = [
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
  return MESSAGES_MEDIA_VIEWER_PATH_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      pathname.startsWith(`${prefix}/`) ||
      pathname.startsWith(`${prefix}.`),
  );
}

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

export function shouldOpenInApp(input: string): boolean {
  const parsed = parseUrl(input);
  if (!parsed || !isFacebookHost(parsed.hostname)) {
    return false;
  }

  // Preserve existing behavior: marketplace is better opened externally.
  if (parsed.pathname.toLowerCase().includes("/marketplace")) {
    return false;
  }

  return (
    isMessagesRoute(parsed.href) ||
    isAuthOrCheckpointRoute(parsed.href) ||
    isFacebookHomePage(parsed.href)
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
