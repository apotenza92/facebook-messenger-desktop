export type NotificationPayload = {
  title: string;
  body: string;
};

export type NotificationCallClassification = {
  isIncomingCall: boolean;
  reason: "incoming-call-pattern" | "non-incoming-call-status" | "not-call";
  matchedPattern?: string;
  usedTitleOnly: boolean;
};

export type NotificationGroupManagementClassification = {
  isGroupManagement: boolean;
  reason:
    | "group-management-pattern"
    | "group-management-shell-title"
    | "not-group-management";
  matchedPattern?: string;
};

const GLOBAL_SOCIAL_BODY_PATTERNS: RegExp[] = [
  /commented on your/i,
  /replied to your/i,
  /replied to a comment/i,
  /reacted to your/i,
  /liked your/i,
  /shared your/i,
  /mentioned you in/i,
  /tagged you/i,
  /friend request/i,
  /sent you a friend request/i,
  /accepted your friend request/i,
  /followed you/i,
  /new friend suggestion/i,
  /is live now/i,
  /posted in/i,
  /new post in/i,
  /posted a new (?:photo|video|reel|story)/i,
  /invited you/i,
  /birthday/i,
  /suggested for you/i,
  /shared a memory/i,
  /updated (?:their|his|her) (?:profile|cover) photo/i,
  /updated (?:their|his|her) status/i,
  /added (?:a new )?story/i,
  /requested to (?:participate|join)/i,
  /requested membership/i,
  /membership request/i,
  /new notification/i,
  /new notifications/i,
];

const GROUP_MANAGEMENT_BODY_PATTERNS: RegExp[] = [
  /requested to join(?:[^.]{0,160})group/i,
  /requested to participate(?:[^.]{0,160})group/i,
  /requested membership/i,
  /membership request/i,
  /requested to participate for the first time/i,
  /group you(?:'|’)re managing/i,
  /group you are managing/i,
];

const CALL_BODY_PATTERNS: RegExp[] = [
  /calling you/i,
  /incoming (video |audio )?call/i,
  /is calling/i,
  /video call from/i,
  /audio call from/i,
  /wants to (video )?call/i,
  /wants to call/i,
];

const NON_INCOMING_CALL_PATTERNS: RegExp[] = [
  /ongoing call/i,
  /\byou started (?:an? )?(?:video |audio )?call\b/i,
  /\bstarted (?:an? )?(?:video |audio )?call\b/i,
  /\b(?:video |audio )?call (?:has )?started\b/i,
  /\bjoined (?:the )?(?:video |audio )?call\b/i,
  /\bjoin(?:ed|ing)? (?:the )?(?:video |audio )?call\b/i,
  /\bcall ended\b/i,
  /\bmissed (?:video |audio )?call\b/i,
  /\bcall cancel(?:ed|led)\b/i,
  /\banswered (?:on|with) another device\b/i,
  /\banswered elsewhere\b/i,
];

function normalizeText(value: string): string {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function classifyCallNotification(
  payload: NotificationPayload,
): NotificationCallClassification {
  const title = normalizeText(payload.title);
  const body = normalizeText(payload.body);
  const combined = `${title} ${body}`.trim();
  if (!combined) {
    return { isIncomingCall: false, reason: "not-call", usedTitleOnly: false };
  }

  const excludedPattern = NON_INCOMING_CALL_PATTERNS.find((pattern) =>
    pattern.test(combined),
  );
  if (excludedPattern) {
    return {
      isIncomingCall: false,
      reason: "non-incoming-call-status",
      matchedPattern: excludedPattern.source,
      usedTitleOnly: false,
    };
  }

  const bodyPattern = CALL_BODY_PATTERNS.find((pattern) => pattern.test(body));
  if (bodyPattern) {
    return {
      isIncomingCall: true,
      reason: "incoming-call-pattern",
      matchedPattern: bodyPattern.source,
      usedTitleOnly: false,
    };
  }

  const titlePattern = CALL_BODY_PATTERNS.find((pattern) =>
    pattern.test(title),
  );
  if (titlePattern) {
    return {
      isIncomingCall: true,
      reason: "incoming-call-pattern",
      matchedPattern: titlePattern.source,
      usedTitleOnly: true,
    };
  }

  return { isIncomingCall: false, reason: "not-call", usedTitleOnly: false };
}

export function classifyGroupManagementNotification(
  payload: NotificationPayload,
): NotificationGroupManagementClassification {
  const title = normalizeText(payload.title);
  const body = normalizeText(payload.body);
  const combined = `${title} ${body}`.trim();

  if (!combined) {
    return {
      isGroupManagement: false,
      reason: "not-group-management",
    };
  }

  const bodyPattern = GROUP_MANAGEMENT_BODY_PATTERNS.find((pattern) =>
    pattern.test(body),
  );
  if (bodyPattern) {
    return {
      isGroupManagement: true,
      reason: "group-management-pattern",
      matchedPattern: bodyPattern.source,
    };
  }

  const titleIsFacebookShell =
    title === "facebook" ||
    title.startsWith("facebook ") ||
    /^facebook user(?:\b|$)/.test(title) ||
    title === "meta" ||
    title.startsWith("meta ") ||
    title === "notification" ||
    title === "notifications" ||
    title === "new notification" ||
    title === "new notifications";
  if (
    titleIsFacebookShell &&
    /requested to (?:join|participate)|membership request|requested membership/i.test(
      combined,
    )
  ) {
    return {
      isGroupManagement: true,
      reason: "group-management-shell-title",
    };
  }

  return {
    isGroupManagement: false,
    reason: "not-group-management",
  };
}

export function isLikelyGlobalFacebookNotification(
  payload: NotificationPayload,
): boolean {
  const title = normalizeText(payload.title);
  const body = normalizeText(payload.body);

  if (!title && !body) return false;

  if (classifyCallNotification(payload).isIncomingCall) {
    return false;
  }

  if (classifyGroupManagementNotification(payload).isGroupManagement) {
    return true;
  }

  const titleIsFacebookShell =
    title === "facebook" ||
    title.startsWith("facebook ") ||
    /^facebook user(?:\b|$)/.test(title) ||
    title === "meta" ||
    title.startsWith("meta ") ||
    title === "notification" ||
    title === "notifications" ||
    title === "new notification" ||
    title === "new notifications" ||
    title === "new message" ||
    title === "new messages" ||
    /^\d+\s+new messages?$/.test(title);

  const hasSocialSignal = GLOBAL_SOCIAL_BODY_PATTERNS.some((pattern) =>
    pattern.test(body),
  );

  return titleIsFacebookShell && hasSocialSignal;
}

const notificationActivityPolicyApi = {
  classifyCallNotification,
  classifyGroupManagementNotification,
  isLikelyGlobalFacebookNotification,
};

(globalThis as typeof globalThis & {
  __mdNotificationActivityPolicy?: typeof notificationActivityPolicyApi;
}).__mdNotificationActivityPolicy = notificationActivityPolicyApi;

try {
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = notificationActivityPolicyApi;
  }
} catch {
  // Running in browser context without CommonJS; global binding above is enough.
}
