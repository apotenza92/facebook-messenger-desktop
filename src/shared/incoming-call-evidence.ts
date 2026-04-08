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
  /\b(?:video |audio )?call (?:has )?started\b/i,
  /\bjoined (?:the )?(?:video |audio )?call\b/i,
  /\bjoin(?:ed|ing)? (?:the )?(?:video |audio )?call\b/i,
  /\bcall ended\b/i,
  /\bmissed (?:video |audio )?call\b/i,
  /\bcall cancel(?:ed|led)\b/i,
  /\banswered (?:on|with) another device\b/i,
  /\banswered elsewhere\b/i,
];

const GENERIC_INCOMING_CALL_LABELS = new Set([
  "profile",
  "profile picture",
  "picture",
  "incoming call",
  "video call",
  "audio call",
  "call",
  "caller",
  "unknown caller",
  "messenger",
  "facebook",
  "someone",
]);

function normalizeText(value: string): string {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeRepeatedIncomingCallWords(input: string): string {
  const words = input.split(" ").filter(Boolean);
  if (words.length < 2) return input;

  const compact: string[] = [];
  for (const word of words) {
    if (
      compact.length === 0 ||
      compact[compact.length - 1].toLowerCase() !== word.toLowerCase()
    ) {
      compact.push(word);
    }
  }

  if (compact.length % 2 === 0) {
    const half = compact.length / 2;
    const firstHalf = compact.slice(0, half).join(" ").toLowerCase();
    const secondHalf = compact.slice(half).join(" ").toLowerCase();
    if (firstHalf === secondHalf) {
      return compact.slice(0, half).join(" ");
    }
  }

  return compact.join(" ");
}

export function isGenericIncomingCallLabel(raw: unknown): boolean {
  const normalized = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  if (GENERIC_INCOMING_CALL_LABELS.has(normalized)) return true;
  if (/^profile picture(?: of)?$/.test(normalized)) return true;

  const tokens = new Set(normalized.split(" ").filter(Boolean));
  return (
    (tokens.has("profile") && tokens.has("picture")) ||
    (tokens.has("incoming") && tokens.has("call")) ||
    (tokens.has("call") && tokens.has("picture")) ||
    (tokens.has("call") && tokens.has("profile"))
  );
}

export function normalizeIncomingCallCaller(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  let cleaned = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[|•·]+/g, " ")
    .replace(
      /\b(?:is\s+calling\s+you|is\s+calling|calling\s+you|on\s+messenger)\b/gi,
      " ",
    )
    .replace(
      /\b(incoming|video|audio|call|from|end-to-end encrypted|decline|accept|join|ignore|cancel|on|messenger|facebook)\b/gi,
      " ",
    )
    .replace(/^[:\-\s]+|[:\-\s]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return null;
  }

  const repeatedChunk = cleaned.match(/^(.{2,60}?)\1+$/i);
  if (repeatedChunk?.[1]) {
    cleaned = repeatedChunk[1].trim();
  }

  const repeatedPhrase = cleaned.match(/^(.{2,60}?)\s+\1$/i);
  if (repeatedPhrase?.[1]) {
    cleaned = repeatedPhrase[1].trim();
  }

  const deduped = dedupeRepeatedIncomingCallWords(cleaned)
    .replace(/\s+/g, " ")
    .trim();
  if (!deduped || isGenericIncomingCallLabel(deduped)) {
    return null;
  }

  return deduped.split(" ").filter(Boolean).slice(0, 4).join(" ").slice(0, 80);
}

export function buildIncomingCallNotificationBody(params: {
  caller?: unknown;
  fallbackCaller?: unknown;
  body?: unknown;
}): string {
  const caller =
    normalizeIncomingCallCaller(params.caller) ??
    normalizeIncomingCallCaller(params.fallbackCaller) ??
    normalizeIncomingCallCaller(params.body);

  return caller
    ? `${caller} is calling you on Messenger`
    : "Someone is calling you on Messenger";
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
