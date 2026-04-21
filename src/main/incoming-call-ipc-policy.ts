import {
  type IncomingCallEscalationDecision,
  type IncomingCallEvidence,
  buildIncomingCallEvidence,
  shouldEscalateIncomingCallEvidence,
} from "../shared/incoming-call-evidence";

export const INCOMING_CALL_KEY_TTL_MS = 12_000;
export const INCOMING_CALL_NO_KEY_COOLDOWN_MS = 10_000;
export const INCOMING_CALL_NO_KEY_JITTER_GUARD_MS = 400;
export const INCOMING_CALL_NO_KEY_MAP_KEY = "__no-key__";

export type IncomingCallIpcPayload = {
  dedupeKey?: string;
  caller?: string;
  source?: string;
  evidence?: IncomingCallEvidence;
  recoveryActive?: boolean;
};

export type IncomingCallNotificationDecisionReason =
  | "notify"
  | "same-key"
  | "no-key-cooldown"
  | "no-key-jitter-window";

export type IncomingCallNativeNotificationDecision = {
  shouldNotify: boolean;
  reason: IncomingCallNotificationDecisionReason;
  callKey: string | null;
  now: number;
};

export type IncomingCallSessionUpdateAction =
  | "ignore-placeholder-echo"
  | "show-improved-notification"
  | "refresh-active-session"
  | "none";

export type IncomingCallSessionUpdateDecision = {
  action: IncomingCallSessionUpdateAction;
  shouldRefreshReminder: boolean;
  shouldShowImprovedNotification: boolean;
  shouldUseActiveSessionBody: boolean;
};

export type IncomingCallFirstNotificationDelayDecision = {
  shouldDelay: boolean;
  reason: "callerless-first-signal" | "has-caller" | "active-session" | "not-first-display";
};

export type IncomingCallSignalEscalationDecision = IncomingCallEscalationDecision;

export type IncomingCallWindowFocusTarget = {
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
};

export function applyIncomingCallWindowFocus(
  target: IncomingCallWindowFocusTarget | null,
): {
  focused: boolean;
  restoredFromMinimized: boolean;
} {
  if (!target) {
    return {
      focused: false,
      restoredFromMinimized: false,
    };
  }

  const restoredFromMinimized = target.isMinimized();
  if (restoredFromMinimized) {
    target.restore();
  }

  target.show();
  target.focus();

  return {
    focused: true,
    restoredFromMinimized,
  };
}

export function normalizeIncomingCallDedupeKey(
  payload?: IncomingCallIpcPayload,
): string | null {
  if (typeof payload?.dedupeKey === "string") {
    const trimmed = payload.dedupeKey.trim();
    if (trimmed) {
      return trimmed.slice(0, 180);
    }
  }

  if (typeof payload?.evidence?.threadKey === "string") {
    const threadKey = payload.evidence.threadKey.trim();
    if (threadKey) {
      return `thread:${threadKey}`.slice(0, 180);
    }
  }

  return null;
}

export function decideIncomingCallSignalEscalation(
  payload?: IncomingCallIpcPayload,
): IncomingCallSignalEscalationDecision {
  const evidence = payload?.evidence
    ? payload.evidence
    : buildIncomingCallEvidence({
        source: payload?.source,
        caller: payload?.caller,
        dedupeKey: payload?.dedupeKey,
        recoveryActive: payload?.recoveryActive,
      });

  return shouldEscalateIncomingCallEvidence({
    evidence,
    recoveryActive: payload?.recoveryActive,
  });
}

export function decideIncomingCallNativeNotification(params: {
  payload?: IncomingCallIpcPayload;
  now: number;
  notificationByKey: Map<string, number>;
  lastNoKeyIncomingCallNotificationAt: number;
}): IncomingCallNativeNotificationDecision {
  const {
    payload,
    now,
    notificationByKey,
    lastNoKeyIncomingCallNotificationAt,
  } = params;

  const callKey = normalizeIncomingCallDedupeKey(payload);

  for (const [key, ts] of notificationByKey.entries()) {
    if (now - ts > INCOMING_CALL_KEY_TTL_MS) {
      notificationByKey.delete(key);
    }
  }

  if (
    callKey === null &&
    now - lastNoKeyIncomingCallNotificationAt <
      INCOMING_CALL_NO_KEY_JITTER_GUARD_MS
  ) {
    return {
      shouldNotify: false,
      reason: "no-key-jitter-window",
      callKey,
      now,
    };
  }

  if (callKey !== null) {
    const previousByKey = notificationByKey.get(callKey) ?? 0;
    if (now - previousByKey < INCOMING_CALL_KEY_TTL_MS) {
      return {
        shouldNotify: false,
        reason: "same-key",
        callKey,
        now,
      };
    }
  } else {
    const previousNoKey = notificationByKey.get(INCOMING_CALL_NO_KEY_MAP_KEY) ?? 0;
    if (now - previousNoKey < INCOMING_CALL_NO_KEY_COOLDOWN_MS) {
      return {
        shouldNotify: false,
        reason: "no-key-cooldown",
        callKey,
        now,
      };
    }
  }

  return {
    shouldNotify: true,
    reason: "notify",
    callKey,
    now,
  };
}

export function decideIncomingCallSessionUpdate(params: {
  sameActiveSession: boolean;
  normalizedCaller: string | null;
  notificationBody: string;
  activeNotificationBody: string | null;
  dedupeReason: IncomingCallNotificationDecisionReason;
}): IncomingCallSessionUpdateDecision {
  const {
    sameActiveSession,
    normalizedCaller,
    notificationBody,
    activeNotificationBody,
    dedupeReason,
  } = params;

  if (
    sameActiveSession &&
    normalizedCaller === null &&
    typeof activeNotificationBody === "string" &&
    activeNotificationBody.length > 0
  ) {
    return {
      action: "ignore-placeholder-echo",
      shouldRefreshReminder: true,
      shouldShowImprovedNotification: false,
      shouldUseActiveSessionBody: true,
    };
  }

  if (!sameActiveSession) {
    return {
      action: "none",
      shouldRefreshReminder: false,
      shouldShowImprovedNotification: false,
      shouldUseActiveSessionBody: false,
    };
  }

  if (
    dedupeReason === "same-key" &&
    normalizedCaller !== null &&
    typeof activeNotificationBody === "string" &&
    activeNotificationBody.length > 0 &&
    activeNotificationBody !== notificationBody
  ) {
    return {
      action: "show-improved-notification",
      shouldRefreshReminder: true,
      shouldShowImprovedNotification: true,
      shouldUseActiveSessionBody: false,
    };
  }

  return {
    action: "refresh-active-session",
    shouldRefreshReminder: true,
    shouldShowImprovedNotification: false,
    shouldUseActiveSessionBody: false,
  };
}

export function decideIncomingCallFirstNotificationDelay(params: {
  shouldNotify: boolean;
  sameActiveSession: boolean;
  normalizedCaller: string | null;
}): IncomingCallFirstNotificationDelayDecision {
  if (!params.shouldNotify) {
    return {
      shouldDelay: false,
      reason: "not-first-display",
    };
  }

  if (params.sameActiveSession) {
    return {
      shouldDelay: false,
      reason: "active-session",
    };
  }

  if (params.normalizedCaller !== null) {
    return {
      shouldDelay: false,
      reason: "has-caller",
    };
  }

  return {
    shouldDelay: true,
    reason: "callerless-first-signal",
  };
}
