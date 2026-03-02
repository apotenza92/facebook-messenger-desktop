export const INCOMING_CALL_KEY_TTL_MS = 45_000;
export const INCOMING_CALL_NO_KEY_COOLDOWN_MS = 10_000;
export const INCOMING_CALL_NO_KEY_JITTER_GUARD_MS = 400;
export const INCOMING_CALL_NO_KEY_MAP_KEY = "__no-key__";

export type IncomingCallIpcPayload = {
  dedupeKey?: string;
  caller?: string;
  source?: string;
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

export type IncomingCallWindowFocusTarget = {
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
};

export function normalizeIncomingCallDedupeKey(
  payload?: IncomingCallIpcPayload,
): string | null {
  if (typeof payload?.dedupeKey !== "string") return null;
  const trimmed = payload.dedupeKey.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 180);
}

export function applyIncomingCallWindowFocus(
  target: IncomingCallWindowFocusTarget | null | undefined,
): { focused: boolean; restoredFromMinimized: boolean } {
  if (!target) {
    return { focused: false, restoredFromMinimized: false };
  }

  const restoredFromMinimized = target.isMinimized();
  if (restoredFromMinimized) {
    target.restore();
  }

  target.show();
  target.focus();

  return { focused: true, restoredFromMinimized };
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
