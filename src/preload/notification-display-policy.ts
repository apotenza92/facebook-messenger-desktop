type NotificationDisplayTitleInput = {
  title: string;
  alternateNames?: Array<string | null | undefined>;
  maxAlternateNames?: number;
};

function normalizeDisplayName(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDisplayKey(value: string | null | undefined): string {
  return normalizeDisplayName(value).toLowerCase();
}

function isGenericNotificationDisplayName(value: string | null | undefined): boolean {
  const normalized = normalizeDisplayKey(value);
  if (!normalized) return true;

  return [
    /^facebook(?: user(?: \d+)?)?$/,
    /^messenger(?: notification)?$/,
    /^notifications?$/,
    /^new notifications?$/,
    /^\d+\s+new messages?$/,
    /^new messages?$/,
    /^incoming (?:audio|video )?call$/,
    /^(?:audio|video )?call$/,
    /^someone$/,
    /^unknown caller$/,
  ].some((pattern) => pattern.test(normalized));
}

function uniqueAlternateNames(
  title: string,
  alternateNames: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const titleKey = normalizeDisplayKey(title);
  const results: string[] = [];

  for (const candidate of alternateNames) {
    const normalized = normalizeDisplayName(candidate);
    const key = normalizeDisplayKey(normalized);
    if (!normalized || !key || key === titleKey) continue;
    if (isGenericNotificationDisplayName(normalized)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function formatNotificationDisplayTitle(
  input: NotificationDisplayTitleInput,
): string {
  const title = normalizeDisplayName(input.title);
  if (!title) return "";

  const alternates = uniqueAlternateNames(title, input.alternateNames || []);
  if (alternates.length === 0) {
    return title;
  }

  const maxAlternateNames = Math.max(
    1,
    Math.min(4, Math.round(input.maxAlternateNames || 2)),
  );
  const visibleAlternates = alternates.slice(0, maxAlternateNames);
  const hiddenCount = alternates.length - visibleAlternates.length;
  const suffix = hiddenCount > 0 ? ` +${hiddenCount}` : "";
  return `${title} (${visibleAlternates.join(", ")}${suffix})`;
}

const notificationDisplayPolicy = {
  isGenericNotificationDisplayName,
  formatNotificationDisplayTitle,
};

(globalThis as any).__mdNotificationDisplayPolicy = notificationDisplayPolicy;

try {
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = notificationDisplayPolicy;
  }
} catch {
  // Running in browser context without CommonJS; global binding above is enough.
}
