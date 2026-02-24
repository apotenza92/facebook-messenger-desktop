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
    | "ambiguous-candidates";
};

type NotificationDeduper = {
  shouldSuppress: (href: string, nowMs?: number) => boolean;
};

type NotificationDecisionPolicyApi = {
  resolveNativeNotificationTarget: (
    payload: NotificationPayload,
    unreadRows: NotificationCandidate[],
  ) => NotificationMatchResult;
  createNotificationDeduper: (ttlMs?: number) => NotificationDeduper;
};

const MIN_CONFIDENCE = 0.55;
const AMBIGUITY_DELTA = 0.14;

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
  const payloadTitle = normalizeText(payload.title);
  const payloadBody = normalizeText(payload.body);

  if (!top || top.score < MIN_CONFIDENCE) {
    return {
      confidence: top?.score ?? 0,
      ambiguous: true,
      muted: false,
      reason: "low-confidence",
    };
  }

  if (second) {
    const topTitle = normalizeText(top.candidate.title);
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
      return {
        confidence: top.score,
        ambiguous: true,
        muted: false,
        reason: "ambiguous-candidates",
      };
    }
  }

  if (second && top.score - second.score < AMBIGUITY_DELTA) {
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
};

(globalThis as any).__mdNotificationDecisionPolicy = policyApi;

try {
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = policyApi;
  }
} catch {
  // Running in browser context without CommonJS; global binding above is enough.
}
