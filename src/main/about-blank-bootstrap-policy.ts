import { isFacebookHost, type WindowOpenAction } from "./url-policy";

export const ABOUT_BLANK_CHILD_BOOTSTRAP_MAX_NAVIGATIONS = 8;
export const ABOUT_BLANK_CHILD_BOOTSTRAP_WINDOW_MS = 30_000;

const TRUSTED_CHILD_BOOTSTRAP_INTERMEDIATE_PATH_PREFIXES = [
  "/ajax/",
  "/api/",
  "/dialog/",
  "/privacy/",
  "/messenger/",
  "/rtc/",
  "/videochat/",
  "/video_call/",
  "/call/",
] as const;

export type AllowedChildBootstrapSiteKey = "facebook.com" | "messenger.com";

function isThreadBootstrapRoute(input: string): boolean {
  try {
    const parsed = new URL(input);
    const pathname = parsed.pathname.toLowerCase();

    if (isFacebookHost(parsed.hostname)) {
      return /^\/messages\/(?:e2ee\/)?t\/[^/]+\/?$/.test(pathname);
    }

    if (
      parsed.hostname === "messenger.com" ||
      parsed.hostname.endsWith(".messenger.com")
    ) {
      return /^\/(?:e2ee\/)?t\/[^/]+\/?$/.test(pathname);
    }
  } catch {
    // Ignore parse failures and treat as non-bootstrap URL.
  }

  return false;
}

export function getAllowedChildBootstrapSiteKey(
  input: string,
): AllowedChildBootstrapSiteKey | null {
  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.toLowerCase();

    if (isFacebookHost(hostname)) {
      return "facebook.com";
    }

    if (hostname === "messenger.com" || hostname.endsWith(".messenger.com")) {
      return "messenger.com";
    }
  } catch {
    // Ignore parse failures and treat as non-bootstrap URL.
  }

  return null;
}

export function isTrustedAboutBlankBootstrapIntermediateUrl(
  input: string,
): boolean {
  const siteKey = getAllowedChildBootstrapSiteKey(input);
  if (!siteKey) return false;

  try {
    const path = new URL(input).pathname.toLowerCase();
    return TRUSTED_CHILD_BOOTSTRAP_INTERMEDIATE_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(prefix),
    );
  } catch {
    return false;
  }
}

export function shouldAllowAboutBlankChildBootstrapNavigation(
  navigationUrl: string,
  navigationAction: WindowOpenAction,
  bootstrapWindowStartedAt: number,
  bootstrapNavigationCount: number,
  hasSeenCallSafeBootstrapNavigation: boolean = false,
): {
  allowed: boolean;
  elapsedMs: number;
  siteKey: AllowedChildBootstrapSiteKey | null;
  allowedBy:
    | "call-safe-action"
    | "trusted-intermediate"
    | "post-call-thread-hop"
    | null;
} {
  const elapsedMs = Date.now() - bootstrapWindowStartedAt;
  const withinBootstrapWindow =
    elapsedMs <= ABOUT_BLANK_CHILD_BOOTSTRAP_WINDOW_MS;
  const withinBootstrapNavigationBudget =
    bootstrapNavigationCount < ABOUT_BLANK_CHILD_BOOTSTRAP_MAX_NAVIGATIONS;
  const siteKey = getAllowedChildBootstrapSiteKey(navigationUrl);
  const isAllowedBootstrapSite = siteKey !== null;

  const isCallSafeBootstrapAction = navigationAction === "allow-child-window";
  const isTrustedIntermediateHop =
    navigationAction === "open-external-browser" &&
    isTrustedAboutBlankBootstrapIntermediateUrl(navigationUrl);

  // Outgoing-call startup can briefly hop through a thread route after an
  // initial call-safe URL (for example /videochat -> /messages/t/:id -> call URL).
  // Keep this narrow: only during active about:blank bootstrap and only after
  // we've already seen at least one call-safe hop in this window.
  const isPostCallThreadHop =
    hasSeenCallSafeBootstrapNavigation &&
    (navigationAction === "reroute-main-view" ||
      navigationAction === "open-external-browser") &&
    isThreadBootstrapRoute(navigationUrl);

  const allowedBy = isCallSafeBootstrapAction
    ? "call-safe-action"
    : isTrustedIntermediateHop
      ? "trusted-intermediate"
      : isPostCallThreadHop
        ? "post-call-thread-hop"
        : null;

  return {
    allowed:
      withinBootstrapWindow &&
      withinBootstrapNavigationBudget &&
      isAllowedBootstrapSite &&
      allowedBy !== null,
    elapsedMs,
    siteKey,
    allowedBy,
  };
}
