export type IncomingCallEvidenceSource =
  | "dom-explicit"
  | "dom-soft"
  | "periodic-scan"
  | "native-notification";

export type IncomingCallEvidenceConfidence = "high" | "medium" | "low";

export type IncomingCallEvidence = {
  source: IncomingCallEvidenceSource;
  confidence: IncomingCallEvidenceConfidence;
  caller?: string;
  dedupeKey?: string;
  hasVisibleControls: boolean;
  matchedPattern?: string;
  capturedAt: number;
  recoveryActive?: boolean;
  threadKey?: string;
};

export type IncomingCallTextClassification = {
  isIncomingCall: boolean;
  reason: "incoming-call-pattern" | "non-incoming-call-status" | "not-call";
  matchedPattern?: string;
  usedTitleOnly: boolean;
};

export type IncomingCallEscalationDecision = {
  shouldEscalate: boolean;
  reason:
    | "escalate"
    | "low-confidence-evidence"
    | "recovery-requires-explicit-dom";
  evidence: IncomingCallEvidence;
};

export const INCOMING_CALL_CORROBORATION_WINDOW_MS = 8_000;

export const INCOMING_CALL_TEXT_PATTERNS: RegExp[] = [
  /calling you/i,
  /incoming (?:video |audio )?call/i,
  /is calling/i,
  /video call from/i,
  /audio call from/i,
  /wants to (?:video )?call/i,
  /wants to call/i,
];

export const NON_INCOMING_CALL_PATTERNS: RegExp[] = [
  /ongoing call/i,
  /\byou started (?:an? )?(?:video |audio )?call\b/i,
  /\bstarted (?:an? )?(?:video |audio )?call\b/i,
  /\bjoined (?:the )?(?:video |audio )?call\b/i,
  /\bcall ended\b/i,
  /\bmissed (?:video |audio )?call\b/i,
  /\bcall cancel(?:ed|led)\b/i,
  /\banswered (?:on|with) another device\b/i,
  /\banswered elsewhere\b/i,
];

function normalizeText(value: string): string {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function classifyIncomingCallText(payload: {
  title?: string;
  body?: string;
}): IncomingCallTextClassification {
  const title = normalizeText(payload.title || "");
  const body = normalizeText(payload.body || "");
  const combined = `${title} ${body}`.trim();

  if (!combined) {
    return {
      isIncomingCall: false,
      reason: "not-call",
      usedTitleOnly: false,
    };
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

  const bodyMatch = INCOMING_CALL_TEXT_PATTERNS.find((pattern) =>
    pattern.test(body),
  );
  if (bodyMatch) {
    return {
      isIncomingCall: true,
      reason: "incoming-call-pattern",
      matchedPattern: bodyMatch.source,
      usedTitleOnly: false,
    };
  }

  const titleMatch = INCOMING_CALL_TEXT_PATTERNS.find((pattern) =>
    pattern.test(title),
  );
  if (titleMatch) {
    return {
      isIncomingCall: true,
      reason: "incoming-call-pattern",
      matchedPattern: titleMatch.source,
      usedTitleOnly: true,
    };
  }

  return {
    isIncomingCall: false,
    reason: "not-call",
    usedTitleOnly: false,
  };
}

export function normalizeIncomingCallEvidenceSource(
  rawSource?: string,
): IncomingCallEvidenceSource {
  const source = String(rawSource || "").trim().toLowerCase();
  if (source === "periodic-scan") return "periodic-scan";
  if (source === "dom-soft") return "dom-soft";
  if (source === "native-notification" || source.startsWith("notification:")) {
    return "native-notification";
  }
  return "dom-explicit";
}

export function buildIncomingCallEvidence(params: {
  source?: string;
  confidence?: IncomingCallEvidenceConfidence;
  caller?: string;
  dedupeKey?: string;
  hasVisibleControls?: boolean;
  matchedPattern?: string;
  capturedAt?: number;
  recoveryActive?: boolean;
  threadKey?: string;
}): IncomingCallEvidence {
  const source = normalizeIncomingCallEvidenceSource(params.source);
  const hasVisibleControls = params.hasVisibleControls === true;

  let confidence = params.confidence;
  if (!confidence) {
    if (source === "dom-explicit") {
      confidence = "high";
    } else if (source === "dom-soft") {
      confidence = "medium";
    } else if (source === "periodic-scan") {
      confidence = params.caller ? "medium" : "low";
    } else {
      confidence = "low";
    }
  }

  return {
    source,
    confidence,
    caller:
      typeof params.caller === "string" && params.caller.trim().length > 0
        ? params.caller.trim()
        : undefined,
    dedupeKey:
      typeof params.dedupeKey === "string" && params.dedupeKey.trim().length > 0
        ? params.dedupeKey.trim()
        : undefined,
    hasVisibleControls,
    matchedPattern:
      typeof params.matchedPattern === "string" &&
      params.matchedPattern.trim().length > 0
        ? params.matchedPattern.trim()
        : undefined,
    capturedAt:
      typeof params.capturedAt === "number" && Number.isFinite(params.capturedAt)
        ? params.capturedAt
        : Date.now(),
    recoveryActive: params.recoveryActive === true,
    threadKey:
      typeof params.threadKey === "string" && params.threadKey.trim().length > 0
        ? params.threadKey.trim()
        : undefined,
  };
}

export function shouldEscalateIncomingCallEvidence(params: {
  evidence: IncomingCallEvidence;
  recoveryActive?: boolean;
}): IncomingCallEscalationDecision {
  const { evidence } = params;
  const recoveryActive = params.recoveryActive === true || evidence.recoveryActive === true;

  if (recoveryActive && evidence.source !== "dom-explicit") {
    return {
      shouldEscalate: false,
      reason: "recovery-requires-explicit-dom",
      evidence,
    };
  }

  if (evidence.confidence === "low") {
    return {
      shouldEscalate: false,
      reason: "low-confidence-evidence",
      evidence,
    };
  }

  return {
    shouldEscalate: true,
    reason: "escalate",
    evidence,
  };
}
