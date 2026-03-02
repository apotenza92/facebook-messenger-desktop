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
    | "muted-conflict";
};

type NotificationDeduper = {
  shouldSuppress: (href: string, nowMs?: number) => boolean;
};

type NotificationCallClassification = {
  isIncomingCall: boolean;
  reason: "incoming-call-pattern" | "not-call";
  matchedPattern?: string;
};

type NotificationDecisionPolicyApi = {
  resolveNativeNotificationTarget: (
    payload: NotificationPayload,
    unreadRows: NotificationCandidate[],
  ) => NotificationMatchResult;
  createNotificationDeduper: (ttlMs?: number) => NotificationDeduper;
  isLikelyGlobalFacebookNotification: (payload: NotificationPayload) => boolean;
  classifyCallNotification: (
    payload: NotificationPayload,
  ) => NotificationCallClassification;
};

const MIN_CONFIDENCE = 0.55;
const AMBIGUITY_DELTA = 0.14;
const MUTED_CONFLICT_SCORE_FLOOR = 0.20;
const TERSE_SENDER_BODY_PATTERNS: RegExp[] = [
  /^(?:[a-z0-9.'_-]+\s+)?sent (?:you )?a message$/i,
  /^(?:[a-z0-9.'_-]+\s+)?new message$/i,
  /^(?:[a-z0-9.'_-]+\s+)?sent (?:an? )?(?:photo|video|attachment|gif|sticker)$/i,
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
  return TERSE_SENDER_BODY_PATTERNS.some((pattern) => pattern.test(payloadBody));
}

function createMutedConflictResult(confidence: number): NotificationMatchResult {
  return {
    confidence,
    ambiguous: true,
    muted: true,
    reason: "muted-conflict",
  };
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

  if (!top || top.score < MIN_CONFIDENCE) {
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
  const terseSenderPayload = topLooksLikeSenderTitle && isTerseSenderTitlePayload(payload);

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

    if (explicitMutedGroupReference || terseMutedGroupConflict || mutedGroupPreviewContainsBody) {
      return createMutedConflictResult(top.score);
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

const GLOBAL_SOCIAL_BODY_PATTERNS: RegExp[] = [
  /commented on your/i,
  /reacted to your/i,
  /liked your/i,
  /shared your/i,
  /mentioned you in/i,
  /tagged you/i,
  /friend request/i,
  /accepted your friend request/i,
  /new friend suggestion/i,
  /is live now/i,
  /posted in/i,
  /new post in/i,
  /invited you/i,
  /birthday/i,
  /new notification/i,
  /new notifications/i,
];

const CALL_BODY_PATTERNS: RegExp[] = [
  /calling you/i,
  /incoming (video |audio )?call/i,
  /is calling/i,
  /video call from/i,
  /audio call from/i,
  /wants to call/i,
];

function classifyCallNotification(
  payload: NotificationPayload,
): NotificationCallClassification {
  const combined = `${normalizeText(payload.title)} ${normalizeText(payload.body)}`.trim();
  if (!combined) {
    return { isIncomingCall: false, reason: "not-call" };
  }

  const matchedPattern = CALL_BODY_PATTERNS.find((pattern) => pattern.test(combined));
  if (!matchedPattern) {
    return { isIncomingCall: false, reason: "not-call" };
  }

  return {
    isIncomingCall: true,
    reason: "incoming-call-pattern",
    matchedPattern: matchedPattern.source,
  };
}

function isLikelyGlobalFacebookNotification(payload: NotificationPayload): boolean {
  const title = normalizeText(payload.title);
  const body = normalizeText(payload.body);

  if (!title && !body) return false;

  if (classifyCallNotification(payload).isIncomingCall) {
    return false;
  }

  const titleIsFacebookShell =
    title === "facebook" ||
    title.startsWith("facebook ") ||
    title === "meta" ||
    title.startsWith("meta ");

  const hasSocialSignal = GLOBAL_SOCIAL_BODY_PATTERNS.some((pattern) =>
    pattern.test(body),
  );

  // Only suppress when we have both a Facebook-shell title and a strong
  // social/activity signal to avoid dropping real Messenger chat alerts.
  return titleIsFacebookShell && hasSocialSignal;
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
  createNotificationDeduper,
  isLikelyGlobalFacebookNotification,
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
