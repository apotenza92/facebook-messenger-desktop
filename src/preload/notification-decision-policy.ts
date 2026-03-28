type NotificationPayload = {
  title: string;
  body: string;
};

type NotificationCandidate = {
  href: string;
  title: string;
  body: string;
  muted: boolean;
  unread: boolean;
};

type NotificationMatchResult = {
  matchedHref?: string;
  confidence: number;
  ambiguous: boolean;
  muted: boolean;
  reason:
    | "matched"
    | "no-candidates"
    | "low-confidence"
    | "ambiguous-candidates"
    | "muted-conflict"
    | "observed-row-mismatch";
  ambiguityReason?: "placeholder-title";
  placeholderTitle?: string;
};

type ObservedSidebarNotificationDecision = NotificationMatchResult & {
  observedHref?: string;
  matchedObservedHref: boolean;
  shouldNotify: boolean;
};

type NotificationDeduper = {
  shouldSuppress: (href: string, nowMs?: number) => boolean;
};

type NotificationCallClassification = {
  isIncomingCall: boolean;
  reason: "incoming-call-pattern" | "non-incoming-call-status" | "not-call";
  matchedPattern?: string;
  usedTitleOnly?: boolean;
};

type NotificationDecisionPolicyApi = {
  resolveNativeNotificationTarget: (
    payload: NotificationPayload,
    unreadRows: NotificationCandidate[],
  ) => NotificationMatchResult;
  resolveObservedSidebarNotificationTarget?: (
    payload: NotificationPayload,
    observedHref: string | undefined,
    unreadRows: NotificationCandidate[],
  ) => ObservedSidebarNotificationDecision;
  createNotificationDeduper: (ttlMs?: number) => NotificationDeduper;
  isLikelyGlobalFacebookNotification: (payload: NotificationPayload) => boolean;
  isLikelySelfAuthoredMessagePreview: (payload: NotificationPayload) => boolean;
  shouldSuppressSelfAuthoredNotification: (
    payloads: Array<NotificationPayload | null | undefined>,
  ) => boolean;
  classifyCallNotification: (
    payload: NotificationPayload,
  ) => NotificationCallClassification;
};

const MIN_CONFIDENCE = 0.55;
const AMBIGUITY_DELTA = 0.14;
const MUTED_CONFLICT_SCORE_FLOOR = 0.2;
const TERSE_SENDER_BODY_PATTERNS: RegExp[] = [
  /^(?:[a-z0-9.'_-]+\s+)?sent (?:you )?a message$/i,
  /^(?:[a-z0-9.'_-]+\s+)?new message$/i,
  /^(?:[a-z0-9.'_-]+\s+)?sent (?:an? )?(?:photo|video|attachment|gif|sticker)$/i,
];

const PLACEHOLDER_NOTIFICATION_TITLE_PATTERNS: RegExp[] = [
  /^facebook user(?:\s+\d+)?$/i,
  /^new message$/i,
  /^new messages$/i,
  /^notification$/i,
  /^notifications$/i,
  /^new notification$/i,
  /^new notifications$/i,
  /^\d+\s+new messages?$/i,
  /^messenger notification$/i,
];

function normalizeText(value: string): string {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value).replace(/[^a-z0-9]+/g, " ");
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length >= 2);
}

function tokenOverlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  aSet.forEach((token) => {
    if (bSet.has(token)) {
      intersection += 1;
    }
  });

  const denominator = Math.max(aSet.size, bSet.size, 1);
  return intersection / denominator;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isTerseSenderTitlePayload(payload: NotificationPayload): boolean {
  const payloadBody = normalizeText(payload.body);
  if (!payloadBody) return true;
  return TERSE_SENDER_BODY_PATTERNS.some((pattern) =>
    pattern.test(payloadBody),
  );
}

function createMutedConflictResult(
  confidence: number,
  options: {
    ambiguityReason?: "placeholder-title";
    placeholderTitle?: string;
  } = {},
): NotificationMatchResult {
  return {
    confidence,
    ambiguous: true,
    muted: true,
    reason: "muted-conflict",
    ambiguityReason: options.ambiguityReason,
    placeholderTitle: options.placeholderTitle,
  };
}

function getPlaceholderNotificationTitle(
  payload: NotificationPayload,
): string | null {
  const normalizedTitle = normalizeText(payload.title);
  if (!normalizedTitle) return null;

  if (
    PLACEHOLDER_NOTIFICATION_TITLE_PATTERNS.some((pattern) =>
      pattern.test(normalizedTitle),
    )
  ) {
    return normalizedTitle;
  }

  return null;
}

function computeCandidateScore(
  payload: NotificationPayload,
  candidate: NotificationCandidate,
): number {
  const payloadTitle = normalizeText(payload.title);
  const payloadBody = normalizeText(payload.body);
  const candidateTitle = normalizeText(candidate.title);
  const candidateBody = normalizeText(candidate.body);

  const payloadTitleTokens = tokenize(payloadTitle);
  const payloadBodyTokens = tokenize(payloadBody);
  const candidateTitleTokens = tokenize(candidateTitle);
  const candidateBodyTokens = tokenize(candidateBody);

  let score = 0;

  if (payloadTitle && candidateTitle) {
    if (payloadTitle === candidateTitle) {
      score += 0.66;
    } else if (
      payloadTitle.includes(candidateTitle) ||
      candidateTitle.includes(payloadTitle)
    ) {
      score += 0.45;
    }
  }

  score += tokenOverlapRatio(payloadTitleTokens, candidateTitleTokens) * 0.22;
  score += tokenOverlapRatio(payloadBodyTokens, candidateBodyTokens) * 0.2;
  score += tokenOverlapRatio(payloadBodyTokens, candidateTitleTokens) * 0.12;

  if (
    payloadBody &&
    candidateTitle &&
    payloadTitle &&
    payloadTitle !== candidateTitle &&
    payloadBody.includes(candidateTitle)
  ) {
    score += 0.34;
  }

  if (candidateBody && payloadTitle && candidateBody.includes(payloadTitle)) {
    score += 0.14;
  }

  if (!candidate.unread) {
    score -= 0.2;
  }

  return clampScore(score);
}

function resolveNativeNotificationTarget(
  payload: NotificationPayload,
  unreadRows: NotificationCandidate[],
): NotificationMatchResult {
  if (!Array.isArray(unreadRows) || unreadRows.length === 0) {
    return {
      confidence: 0,
      ambiguous: true,
      muted: false,
      reason: "no-candidates",
    };
  }

  const scored = unreadRows
    .map((candidate) => ({
      candidate,
      score: computeCandidateScore(payload, candidate),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  const placeholderTitle = getPlaceholderNotificationTitle(payload);
  const hasMutedUnreadCandidate = unreadRows.some(
    (candidate) => candidate.muted,
  );

  if (!top || top.score < MIN_CONFIDENCE) {
    if (placeholderTitle && hasMutedUnreadCandidate) {
      return createMutedConflictResult(top?.score ?? 0, {
        ambiguityReason: "placeholder-title",
        placeholderTitle,
      });
    }

    return {
      confidence: top?.score ?? 0,
      ambiguous: true,
      muted: false,
      reason: "low-confidence",
    };
  }

  const payloadTitle = normalizeText(payload.title);
  const payloadBody = normalizeText(payload.body);
  const topTitle = normalizeText(top.candidate.title);
  const topLooksLikeSenderTitle =
    Boolean(payloadTitle) && Boolean(topTitle) && payloadTitle === topTitle;
  const terseSenderPayload =
    topLooksLikeSenderTitle && isTerseSenderTitlePayload(payload);

  for (const alternative of scored.slice(1)) {
    if (!alternative.candidate.muted || top.candidate.muted) continue;
    const alternativeTitle = normalizeText(alternative.candidate.title);
    const alternativeBody = normalizeText(alternative.candidate.body);
    if (!alternativeTitle || alternativeTitle === topTitle) continue;

    const explicitMutedGroupReference =
      payloadBody.includes(`in ${alternativeTitle}`) &&
      alternative.score >= MIN_CONFIDENCE - 0.1;
    const terseMutedGroupConflict =
      terseSenderPayload &&
      alternative.score >= MUTED_CONFLICT_SCORE_FLOOR &&
      Boolean(payloadTitle) &&
      alternativeBody.includes(payloadTitle);
    // If the muted group's sidebar preview contains the notification body verbatim,
    // the notification almost certainly originated from that muted group even when
    // the sender also has an unmuted 1:1 DM (which would otherwise win the score race).
    const mutedGroupPreviewContainsBody =
      payloadBody.length >= 6 &&
      alternativeBody.length > 0 &&
      alternativeBody.includes(payloadBody);

    if (
      explicitMutedGroupReference ||
      terseMutedGroupConflict ||
      mutedGroupPreviewContainsBody
    ) {
      return createMutedConflictResult(top.score);
    }
  }

  if (placeholderTitle && hasMutedUnreadCandidate) {
    const payloadBody = normalizeText(payload.body);
    const mutedPreviewOverlap = scored.some(
      (entry) =>
        entry.candidate.muted &&
        entry.score >= MUTED_CONFLICT_SCORE_FLOOR &&
        ((payloadBody.length >= 4 &&
          normalizeText(entry.candidate.body).includes(payloadBody)) ||
          tokenOverlapRatio(
            tokenize(payloadBody),
            tokenize(
              `${entry.candidate.title || ""} ${entry.candidate.body || ""}`,
            ),
          ) >= 0.5),
    );

    if (mutedPreviewOverlap) {
      return createMutedConflictResult(top.score, {
        ambiguityReason: "placeholder-title",
        placeholderTitle,
      });
    }
  }

  if (second) {
    const secondTitle = normalizeText(second.candidate.title);
    const bodyReferencesSecondGroup =
      Boolean(secondTitle) && payloadBody.includes(`in ${secondTitle}`);
    const bodyReferencesTopGroup =
      Boolean(topTitle) && payloadBody.includes(`in ${topTitle}`);

    // Sender-title payloads that explicitly reference a different group title
    // are treated as ambiguous to prevent muted-group leaks.
    if (
      bodyReferencesSecondGroup &&
      topTitle === payloadTitle &&
      second.score >= MIN_CONFIDENCE - 0.1
    ) {
      if (second.candidate.muted) {
        return createMutedConflictResult(top.score);
      }
      return {
        confidence: top.score,
        ambiguous: true,
        muted: false,
        reason: "ambiguous-candidates",
      };
    }

    if (
      bodyReferencesTopGroup &&
      secondTitle === payloadTitle &&
      second.score >= MIN_CONFIDENCE - 0.1
    ) {
      if (top.candidate.muted) {
        return createMutedConflictResult(top.score);
      }
      return {
        confidence: top.score,
        ambiguous: true,
        muted: false,
        reason: "ambiguous-candidates",
      };
    }
  }

  if (second && top.score - second.score < AMBIGUITY_DELTA) {
    if (top.candidate.muted || second.candidate.muted) {
      return createMutedConflictResult(top.score);
    }
    return {
      confidence: top.score,
      ambiguous: true,
      muted: false,
      reason: "ambiguous-candidates",
    };
  }

  return {
    matchedHref: top.candidate.href,
    confidence: top.score,
    ambiguous: false,
    muted: top.candidate.muted,
    reason: "matched",
  };
}

function resolveObservedSidebarNotificationTarget(
  payload: NotificationPayload,
  observedHref: string | undefined,
  unreadRows: NotificationCandidate[],
): ObservedSidebarNotificationDecision {
  const match = resolveNativeNotificationTarget(payload, unreadRows);
  const normalizedObservedHref = normalizeText(observedHref || "");
  const normalizedMatchedHref = normalizeText(match.matchedHref || "");
  const matchedObservedHref = normalizedObservedHref
    ? Boolean(normalizedMatchedHref) &&
      normalizedMatchedHref === normalizedObservedHref
    : Boolean(match.matchedHref);

  if (match.ambiguous || !match.matchedHref || match.muted) {
    return {
      ...match,
      observedHref: normalizedObservedHref || undefined,
      matchedObservedHref,
      shouldNotify: false,
    };
  }

  if (normalizedObservedHref && !matchedObservedHref) {
    return {
      matchedHref: match.matchedHref,
      confidence: match.confidence,
      ambiguous: true,
      muted: false,
      reason: "observed-row-mismatch",
      observedHref: normalizedObservedHref,
      matchedObservedHref: false,
      shouldNotify: false,
    };
  }

  return {
    ...match,
    observedHref: normalizedObservedHref || undefined,
    matchedObservedHref,
    shouldNotify: true,
  };
}

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
  /new notification/i,
  /new notifications/i,
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

function classifyCallNotification(
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

function isLikelyGlobalFacebookNotification(
  payload: NotificationPayload,
): boolean {
  const title = normalizeText(payload.title);
  const body = normalizeText(payload.body);

  if (!title && !body) return false;

  if (classifyCallNotification(payload).isIncomingCall) {
    return false;
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

  // Only suppress when we have both a Facebook-shell title and a strong
  // social/activity signal to avoid dropping real Messenger chat alerts.
  return titleIsFacebookShell && hasSocialSignal;
}

const SELF_AUTHORED_BODY_PATTERNS: RegExp[] = [
  /^you(?::|\s|$)/i,
  /^you sent\b/i,
  /^you replied\b/i,
  /^you reacted\b/i,
  /^you liked\b/i,
  /^you shared\b/i,
  /^you mentioned\b/i,
  /^you edited\b/i,
  /^you removed\b/i,
  /^you unsent\b/i,
  /^sent by you\b/i,
  // Messenger can surface the local composer preview as "Draft: …" when an
  // incoming message lands before the draft is sent. Treat that as self-authored
  // so we fail closed instead of leaking the unsent text via a desktop alert.
  /^draft:(?:\s|$)/i,
];

function isLikelySelfAuthoredMessagePreview(
  payload: NotificationPayload,
): boolean {
  const body = String(payload.body || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return false;

  return SELF_AUTHORED_BODY_PATTERNS.some((pattern) => pattern.test(body));
}

function shouldSuppressSelfAuthoredNotification(
  payloads: Array<NotificationPayload | null | undefined>,
): boolean {
  return payloads.some((payload) => {
    if (!payload) return false;
    return isLikelySelfAuthoredMessagePreview(payload);
  });
}

function createNotificationDeduper(ttlMs = 4000): NotificationDeduper {
  const ttl = Math.max(100, Math.floor(ttlMs));
  const seenByConversation = new Map<string, number>();

  return {
    shouldSuppress: (href: string, nowMs = Date.now()): boolean => {
      const key = normalizeText(href);
      if (!key) return false;

      const previous = seenByConversation.get(key);
      seenByConversation.set(key, nowMs);
      if (previous === undefined) return false;

      return nowMs - previous < ttl;
    },
  };
}

const policyApi: NotificationDecisionPolicyApi = {
  resolveNativeNotificationTarget,
  resolveObservedSidebarNotificationTarget,
  createNotificationDeduper,
  isLikelyGlobalFacebookNotification,
  isLikelySelfAuthoredMessagePreview,
  shouldSuppressSelfAuthoredNotification,
  classifyCallNotification,
};

(globalThis as any).__mdNotificationDecisionPolicy = policyApi;

try {
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = policyApi;
  }
} catch {
  // Running in browser context without CommonJS; global binding above is enough.
}
