type NotificationDisplayTitleInput = {
  title: string;
  alternateNames?: Array<string | null | undefined>;
  maxAlternateNames?: number;
};

type NotificationNameCacheEntryInput = {
  realName?: string | null;
  realNames?: Array<string | null | undefined>;
  updatedAt?: number | null;
};

type NotificationNameCache = Record<
  string,
  {
    realNames: string[];
    updatedAt: number;
  }
>;

type NotificationDisplayNameInspection = {
  normalizedLength: number;
  hasWordLikeSignal: boolean;
  generic: boolean;
  plausible: boolean;
};

type NotificationDisplayTitleInspection = {
  alternateCount: number;
  keptAlternateCount: number;
  rejectedAlternateCount: number;
  alternates: Array<
    NotificationDisplayNameInspection & {
      sameAsTitle: boolean;
      kept: boolean;
    }
  >;
};

function normalizeDisplayName(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDisplayKey(value: string | null | undefined): string {
  return normalizeDisplayName(value).toLowerCase();
}

function hasWordLikeDisplaySignal(value: string | null | undefined): boolean {
  const normalized = normalizeDisplayName(value);
  if (!normalized) return false;

  try {
    return /[\p{L}\p{N}]/u.test(normalized);
  } catch {
    return /[a-z0-9]/i.test(normalized);
  }
}

function inspectNotificationDisplayName(
  value: string | null | undefined,
): NotificationDisplayNameInspection {
  const normalized = normalizeDisplayName(value);
  const hasWordLikeSignal = hasWordLikeDisplaySignal(normalized);
  const generic = isGenericNotificationDisplayName(normalized);
  return {
    normalizedLength: normalized.length,
    hasWordLikeSignal,
    generic,
    plausible: normalized.length > 0 && hasWordLikeSignal && !generic,
  };
}

function isGenericNotificationDisplayName(
  value: string | null | undefined,
): boolean {
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
    /^profile(?: picture)?$/,
    /^picture$/,
  ].some((pattern) => pattern.test(normalized));
}

function isPlausibleNotificationDisplayName(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeDisplayName(value);
  if (!normalized) return false;
  if (!hasWordLikeDisplaySignal(normalized)) return false;
  if (isGenericNotificationDisplayName(normalized)) return false;
  return true;
}

function sanitizeNotificationAlternateNames(
  alternateNames: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const candidate of alternateNames) {
    const normalized = normalizeDisplayName(candidate);
    const key = normalizeDisplayKey(normalized);
    if (!normalized || !key) continue;
    if (!isPlausibleNotificationDisplayName(normalized)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function uniqueAlternateNames(
  title: string,
  alternateNames: Array<string | null | undefined>,
): string[] {
  const titleKey = normalizeDisplayKey(title);
  return sanitizeNotificationAlternateNames(alternateNames).filter(
    (candidate) => normalizeDisplayKey(candidate) !== titleKey,
  );
}

function sanitizeNotificationNameCache(
  cache: unknown,
  nowMs: number = Date.now(),
): NotificationNameCache {
  if (!cache || typeof cache !== "object") {
    return {};
  }

  const results: NotificationNameCache = {};
  for (const key of Object.keys(cache as Record<string, unknown>)) {
    const entry = (cache as Record<string, NotificationNameCacheEntryInput | null | undefined>)[key];
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const migratedRealNames = Array.isArray(entry.realNames)
      ? entry.realNames
      : typeof entry.realName === "string"
        ? [entry.realName]
        : [];
    const realNames = sanitizeNotificationAlternateNames(migratedRealNames);
    if (realNames.length === 0) {
      continue;
    }

    results[key] = {
      realNames,
      updatedAt:
        typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : nowMs,
    };
  }

  return results;
}

function inspectNotificationDisplayTitle(
  input: NotificationDisplayTitleInput,
): NotificationDisplayTitleInspection {
  const title = normalizeDisplayName(input.title);
  const titleKey = normalizeDisplayKey(title);
  const alternates = (input.alternateNames || []).map((candidate) => {
    const inspection = inspectNotificationDisplayName(candidate);
    const normalized = normalizeDisplayName(candidate);
    const sameAsTitle = !!normalized && normalizeDisplayKey(normalized) === titleKey;
    const kept = inspection.plausible && !sameAsTitle;
    return {
      ...inspection,
      sameAsTitle,
      kept,
    };
  });

  const keptAlternateCount = alternates.filter((alternate) => alternate.kept).length;
  return {
    alternateCount: alternates.length,
    keptAlternateCount,
    rejectedAlternateCount: alternates.length - keptAlternateCount,
    alternates,
  };
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
  hasWordLikeDisplaySignal,
  inspectNotificationDisplayName,
  inspectNotificationDisplayTitle,
  isGenericNotificationDisplayName,
  isPlausibleNotificationDisplayName,
  sanitizeNotificationAlternateNames,
  sanitizeNotificationNameCache,
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
