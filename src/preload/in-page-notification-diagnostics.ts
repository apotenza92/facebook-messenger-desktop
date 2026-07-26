export type InPageNotificationLinkCategory =
  | "messenger-thread"
  | "messages-surface"
  | "facebook-notifications"
  | "group-admin"
  | "group"
  | "facebook-other"
  | "external"
  | "invalid";

export type InPageNotificationActionCategory =
  | "dismiss"
  | "review"
  | "approve"
  | "decline"
  | "open"
  | "other";

const LINK_CATEGORIES: InPageNotificationLinkCategory[] = [
  "messenger-thread",
  "messages-surface",
  "facebook-notifications",
  "group-admin",
  "group",
  "facebook-other",
  "external",
  "invalid",
];

const ACTION_CATEGORIES: InPageNotificationActionCategory[] = [
  "dismiss",
  "review",
  "approve",
  "decline",
  "open",
  "other",
];

function isMetaMessagingHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "facebook.com" ||
    normalized.endsWith(".facebook.com") ||
    normalized === "messenger.com" ||
    normalized.endsWith(".messenger.com")
  );
}

function classifyLinkCategory(
  rawHref: string | null | undefined,
  baseUrl: string,
): InPageNotificationLinkCategory {
  if (!rawHref) return "invalid";

  let parsed: URL;
  try {
    parsed = new URL(rawHref, baseUrl);
  } catch {
    return "invalid";
  }

  if (!isMetaMessagingHostname(parsed.hostname)) {
    return "external";
  }

  const pathname = parsed.pathname.toLowerCase().replace(/\/+/g, "/");
  if (
    pathname.startsWith("/messages/t/") ||
    pathname.startsWith("/messages/e2ee/t/") ||
    pathname.startsWith("/t/") ||
    pathname.startsWith("/e2ee/t/")
  ) {
    return "messenger-thread";
  }
  if (pathname === "/messages" || pathname.startsWith("/messages/")) {
    return "messages-surface";
  }
  if (pathname === "/notifications" || pathname.startsWith("/notifications/")) {
    return "facebook-notifications";
  }
  if (
    pathname.startsWith("/groups/") &&
    /\/(?:admin|admin_activities|manage|member_requests|membership_questions|moderation|participant_requests|pending_posts)(?:\/|$)/.test(
      pathname,
    )
  ) {
    return "group-admin";
  }
  if (pathname.startsWith("/groups/")) {
    return "group";
  }
  return "facebook-other";
}

function summarizeLinkCategories(
  hrefs: Array<string | null | undefined>,
  baseUrl: string,
): {
  total: number;
  truncated: boolean;
  categories: Record<InPageNotificationLinkCategory, number>;
  hasMessengerThreadProof: boolean;
  hasGroupAdminRoute: boolean;
  hasGlobalFacebookRoute: boolean;
} {
  const categories = Object.fromEntries(
    LINK_CATEGORIES.map((category) => [category, 0]),
  ) as Record<InPageNotificationLinkCategory, number>;
  const boundedHrefs = hrefs.slice(0, 40);

  for (const href of boundedHrefs) {
    categories[classifyLinkCategory(href, baseUrl)] += 1;
  }

  return {
    total: boundedHrefs.length,
    truncated: hrefs.length > boundedHrefs.length,
    categories,
    hasMessengerThreadProof: categories["messenger-thread"] > 0,
    hasGroupAdminRoute: categories["group-admin"] > 0,
    hasGlobalFacebookRoute:
      categories["facebook-notifications"] > 0 ||
      categories["group-admin"] > 0 ||
      categories.group > 0,
  };
}

function classifyActionCategory(
  rawLabel: string | null | undefined,
): InPageNotificationActionCategory {
  const label = String(rawLabel || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!label) return "other";
  if (/\b(?:close|dismiss|hide)\b/.test(label)) return "dismiss";
  if (/\b(?:review|manage|moderate)\b/.test(label)) return "review";
  if (/\b(?:approve|accept|allow)\b/.test(label)) return "approve";
  if (/\b(?:decline|deny|reject|remove)\b/.test(label)) return "decline";
  if (/\b(?:open|view|see)\b/.test(label)) return "open";
  return "other";
}

function summarizeActionCategories(labels: Array<string | null | undefined>): {
  total: number;
  truncated: boolean;
  categories: Record<InPageNotificationActionCategory, number>;
} {
  const categories = Object.fromEntries(
    ACTION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<InPageNotificationActionCategory, number>;
  const boundedLabels = labels.slice(0, 40);

  for (const label of boundedLabels) {
    categories[classifyActionCategory(label)] += 1;
  }

  return {
    total: boundedLabels.length,
    truncated: labels.length > boundedLabels.length,
    categories,
  };
}

function sanitizeAttributeNames(attributeNames: string[]): string[] {
  return Array.from(
    new Set(
      attributeNames
        .map((name) =>
          String(name || "")
            .toLowerCase()
            .trim(),
        )
        .filter((name) =>
          /^(?:aria-[a-z0-9-]{1,40}|data-[a-z0-9_-]{1,40}|hidden|role|tabindex)$/.test(
            name,
          ),
        ),
    ),
  )
    .sort()
    .slice(0, 24);
}

function hashStructuralTokens(tokens: string[]): string {
  let hash = 0x811c9dc5;
  const bounded = tokens.slice(0, 500).join("\u001f");
  for (let index = 0; index < bounded.length; index += 1) {
    hash ^= bounded.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isPrivacySafeDiagnosticPayload(value: unknown): boolean {
  const forbiddenKeys = new Set([
    "arialabel",
    "attributevalues",
    "body",
    "class",
    "classname",
    "href",
    "id",
    "labels",
    "raw",
    "shelltext",
    "text",
    "title",
    "url",
  ]);
  const visited = new WeakSet<object>();

  const inspect = (candidate: unknown): boolean => {
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      return true;
    }
    if (typeof candidate !== "object") {
      return false;
    }
    if (visited.has(candidate)) {
      return false;
    }
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      return candidate.every(inspect);
    }

    return Object.entries(candidate).every(
      ([key, nested]) =>
        !forbiddenKeys.has(key.toLowerCase()) && inspect(nested),
    );
  };

  return inspect(value);
}

function bucketCount(value: number): "0" | "1" | "2-4" | "5-12" | "13+" {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value === 1) return "1";
  if (value <= 4) return "2-4";
  if (value <= 12) return "5-12";
  return "13+";
}

function bucketTextLength(
  value: number,
): "0" | "1-40" | "41-120" | "121-400" | "401+" {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value <= 40) return "1-40";
  if (value <= 120) return "41-120";
  if (value <= 400) return "121-400";
  return "401+";
}

function bucketDimension(
  value: number,
): "0" | "1-31" | "32-95" | "96-255" | "256-639" | "640+" {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 32) return "1-31";
  if (value < 96) return "32-95";
  if (value < 256) return "96-255";
  if (value < 640) return "256-639";
  return "640+";
}

function classifyViewportRegion(input: {
  left: number;
  top: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}): {
  horizontal: "left" | "center" | "right" | "offscreen";
  vertical: "top" | "middle" | "bottom" | "offscreen";
} {
  const centerX = input.left + input.width / 2;
  const centerY = input.top + input.height / 2;
  const offscreen =
    input.width <= 0 ||
    input.height <= 0 ||
    centerX < 0 ||
    centerY < 0 ||
    centerX > input.viewportWidth ||
    centerY > input.viewportHeight;
  if (offscreen) {
    return { horizontal: "offscreen", vertical: "offscreen" };
  }

  const horizontal =
    centerX < input.viewportWidth / 3
      ? "left"
      : centerX > (input.viewportWidth * 2) / 3
        ? "right"
        : "center";
  const vertical =
    centerY < input.viewportHeight / 3
      ? "top"
      : centerY > (input.viewportHeight * 2) / 3
        ? "bottom"
        : "middle";
  return { horizontal, vertical };
}

const inPageNotificationDiagnostics = {
  classifyLinkCategory,
  summarizeLinkCategories,
  classifyActionCategory,
  summarizeActionCategories,
  sanitizeAttributeNames,
  hashStructuralTokens,
  isPrivacySafeDiagnosticPayload,
  bucketCount,
  bucketTextLength,
  bucketDimension,
  classifyViewportRegion,
};

(
  globalThis as typeof globalThis & {
    __mdInPageNotificationDiagnostics?: typeof inPageNotificationDiagnostics;
  }
).__mdInPageNotificationDiagnostics = inPageNotificationDiagnostics;

try {
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = inPageNotificationDiagnostics;
  }
} catch {
  // Running in browser context without CommonJS; global binding above is enough.
}
