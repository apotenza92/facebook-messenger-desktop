const GENERIC_NOTIFICATION_IMAGE_ALT_PATTERNS = [
  /^icon for this message$/i,
  /^profile picture$/i,
  /^picture$/i,
  /^avatar$/i,
  /^open (?:photo|image|picture)$/i,
  /^original (?:photo|image|picture)$/i,
  /^seen by\b/i,
];

function normalizeNotificationText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapParenthesizedText(value: string): string {
  const match = value.match(/^\((.*)\)$/);
  return match ? normalizeNotificationText(match[1]) : value;
}

function normalizeNotificationImageAltText(
  value: string | null | undefined,
): string {
  const alt = normalizeNotificationText(value);
  if (!alt) {
    return "";
  }

  if (alt === "(Y)" || alt === "(y)") {
    return "👍";
  }

  const unwrappedAlt = unwrapParenthesizedText(alt);
  if (
    GENERIC_NOTIFICATION_IMAGE_ALT_PATTERNS.some((pattern) =>
      pattern.test(unwrappedAlt),
    )
  ) {
    return "";
  }

  return alt;
}

const notificationTextPolicy = {
  normalizeNotificationImageAltText,
};

(globalThis as any).__mdNotificationTextPolicy = notificationTextPolicy;

try {
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = notificationTextPolicy;
  }
} catch {
  // Running in browser context without CommonJS; global binding above is enough.
}
