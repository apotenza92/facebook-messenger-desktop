// Notification injection script - injected into page context after load
// Uses DUAL detection: MutationObserver + Title-based (inspired by Caprine)
// Both run in parallel for maximum reliability regardless of window size

((window, notification) => {
  // Prevent double injection
  if ((window as any).__messengerDesktopInjected) {
    console.log("[Notif Dual] Already injected, skipping");
    return;
  }
  (window as any).__messengerDesktopInjected = true;

  const DEBUG = true;
  const notifications = new Map<number, any>();
  type PowerStateEvent = "suspend" | "resume" | "lock-screen" | "unlock-screen";
  type NotificationCandidate = {
    href: string;
    title: string;
    body: string;
    searchText?: string;
    muted: boolean;
    unread: boolean;
  };
  type NotificationMatchResult = {
    matchedHref?: string;
    confidence: number;
    ambiguous: boolean;
    muted: boolean;
    reason: string;
    debug?: Record<string, unknown>;
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
    reason: string;
    matchedPattern?: string;
    usedTitleOnly?: boolean;
  };
  type NotificationDecisionPolicyApi = {
    resolveNativeNotificationTarget: (
      payload: { title: string; body: string },
      unreadRows: NotificationCandidate[],
    ) => NotificationMatchResult;
    resolveObservedSidebarNotificationTarget?: (
      payload: { title: string; body: string },
      observedHref: string | undefined,
      unreadRows: NotificationCandidate[],
    ) => ObservedSidebarNotificationDecision;
    createNotificationDeduper: (ttlMs?: number) => NotificationDeduper;
    isLikelyGlobalFacebookNotification: (payload: {
      title: string;
      body: string;
    }) => boolean;
    isLikelySelfAuthoredMessagePreview: (payload: {
      title: string;
      body: string;
    }) => boolean;
    shouldSuppressSelfAuthoredNotification?: (
      payloads: Array<{ title: string; body: string } | null | undefined>,
    ) => boolean;
    classifyCallNotification: (payload: {
      title: string;
      body: string;
    }) => NotificationCallClassification;
  };

  type IncomingCallSignalPayload = {
    dedupeKey?: string;
    caller?: string;
    source?: string;
    recoveryActive?: boolean;
    evidence?: IncomingCallEvidence;
  };

  type IncomingCallEvidenceSource =
    | "dom-explicit"
    | "dom-soft"
    | "periodic-scan"
    | "native-notification";
  type IncomingCallEvidenceConfidence = "high" | "medium" | "low";
  type IncomingCallEvidence = {
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

  const normalizeIncomingCallKey = (raw: string): string =>
    String(raw)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 :/_\-.]/g, "")
      .trim()
      .slice(0, 180);

  const extractIncomingCallerName = (text: string): string | undefined => {
    const normalized = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return undefined;

    const withWordBreaks = normalized.replace(/([a-z])([A-Z])/g, "$1 $2");

    const patterns = [
      /\b([^\n]{1,120}?)\s+is calling\b/i,
      /\bincoming\s+(?:video\s+|audio\s+)?call\s+from\s+([^\n]{1,120}?)(?:\.|$)/i,
      /\b([^\n]{1,120}?)\s+wants to\s+(?:video\s+)?call\b/i,
    ];

    const dedupeRepeatedWords = (input: string): string => {
      const words = input.split(" ").filter(Boolean);
      if (words.length < 2) return input;

      // Collapse adjacent duplicate words.
      const compact: string[] = [];
      for (const word of words) {
        if (
          compact.length === 0 ||
          compact[compact.length - 1].toLowerCase() !== word.toLowerCase()
        ) {
          compact.push(word);
        }
      }

      // Collapse repeated full name halves: "Michael Potenza Michael Potenza".
      if (compact.length % 2 === 0) {
        const half = compact.length / 2;
        const firstHalf = compact.slice(0, half).join(" ").toLowerCase();
        const secondHalf = compact.slice(half).join(" ").toLowerCase();
        if (firstHalf === secondHalf) {
          return compact.slice(0, half).join(" ");
        }
      }

      return compact.join(" ");
    };

    const sanitize = (input: string): string => {
      let value = String(input)
        .replace(/[|•·]+/g, " ")
        .replace(
          /\b(incoming|video|audio|call|from|end-to-end encrypted|decline|accept|join|ignore|cancel|messenger|facebook)\b/gi,
          " ",
        )
        .replace(/^[:\-\s]+|[:\-\s]+$/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Collapse immediate repeated chunks (e.g. "Michael PotenzaMichael Potenza")
      const repeatedChunk = value.match(/^(.{2,60}?)\1+$/i);
      if (repeatedChunk?.[1]) {
        value = repeatedChunk[1].trim();
      }

      // Collapse repeated phrase with separator (e.g. "Michael Potenza Michael Potenza")
      const repeatedPhrase = value.match(/^(.{2,60}?)\s+\1$/i);
      if (repeatedPhrase?.[1]) {
        value = repeatedPhrase[1].trim();
      }

      value = dedupeRepeatedWords(value);
      return value;
    };

    const isGenericCallerLabel = (input: string): boolean => {
      const normalizedInput = String(input || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!normalizedInput) return true;

      const genericLabels = new Set([
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

      if (genericLabels.has(normalizedInput)) {
        return true;
      }

      if (/^profile picture(?: of)?$/.test(normalizedInput)) {
        return true;
      }

      return false;
    };

    for (const sourceText of [withWordBreaks, normalized]) {
      for (const pattern of patterns) {
        const match = sourceText.match(pattern);
        const candidate = sanitize(match?.[1] || "");
        if (candidate.length >= 2 && !isGenericCallerLabel(candidate)) {
          const words = candidate.split(" ").filter(Boolean);
          return words.slice(0, 4).join(" ").slice(0, 80);
        }
      }

      let fallbackMatch: RegExpMatchArray | null = null;
      try {
        fallbackMatch = sourceText.match(
          /\b([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,3})\b/u,
        );
      } catch {
        fallbackMatch = sourceText.match(
          /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/,
        );
      }
      const fallbackCandidate = sanitize(fallbackMatch?.[1] || "");
      if (
        fallbackCandidate.length >= 2 &&
        !isGenericCallerLabel(fallbackCandidate)
      ) {
        return fallbackCandidate.slice(0, 80);
      }
    }

    return undefined;
  };

  const emitIncomingCallDebug = (
    event: string,
    payload?: Record<string, unknown>,
  ) => {
    try {
      window.postMessage(
        {
          type: "electron-incoming-call-debug",
          data: {
            timestamp: Date.now(),
            event,
            ...payload,
          },
        },
        "*",
      );
    } catch {
      // Ignore postMessage failures.
    }
  };

  const signalIncomingCall = (payload: IncomingCallSignalPayload = {}) => {
    log(
      "=== INCOMING CALL DETECTED - Bringing window to foreground ===",
      payload,
    );
    emitIncomingCallDebug("incoming-call-signal", {
      caller: payload.caller,
      dedupeKey: payload.dedupeKey,
      source: payload.source,
      confidence: payload.evidence?.confidence,
      hasVisibleControls: payload.evidence?.hasVisibleControls,
      matchedPattern: payload.evidence?.matchedPattern,
      recoveryActive: payload.recoveryActive === true,
      url: window.location.href,
    });
    window.postMessage({ type: "electron-incoming-call", data: payload }, "*");
  };

  const signalIncomingCallEnded = (reason: string) => {
    log("=== INCOMING CALL ENDED/DECLINED DETECTED ===", { reason });
    window.postMessage(
      { type: "electron-incoming-call-ended", data: { reason } },
      "*",
    );
  };

  // Selectors for Messenger's DOM structure (these may need updates as Messenger changes)
  const selectors = {
    // The navigation area containing the chat list
    sidebar: '[role="navigation"]:has([role="grid"])',
    // Alternative: the grid directly
    chatsGrid: '[role="grid"][aria-label="Chats"]',
    // Individual conversation row container
    conversationRow: '[role="row"], [role="listitem"]',
    // Link element within a conversation (contains href for deduplication)
    conversationLink: '[role="link"], a[href*="/t/"], a[href*="/e2ee/t/"]',
    // Text content elements in conversation preview
    conversationText: '[dir="auto"]',
    // The unread indicator (blue dot next to unread conversations)
    unreadIndicator:
      '[aria-label*="Mark as read" i], [aria-label*="Mark as Read"], [aria-label*="mark as read"], [aria-label*="Unread message" i]',
  };

  const log = (message: string, payload?: any) => {
    if (!DEBUG) return;
    try {
      console.log(`[Notif Dual] ${message}`, payload || "");
      window.postMessage(
        {
          type: "electron-fallback-log",
          data: { event: message, payload },
        },
        "*",
      );
    } catch {
      /* intentionally empty */
    }
  };

  const summarizeNotificationOptions = (
    options?: NotificationOptions,
  ): Record<string, unknown> => {
    const raw = options && typeof options === "object" ? options : {};
    const optionKeys = Object.keys(raw).sort();
    const extendedRaw = raw as NotificationOptions & {
      data?: unknown;
      actions?: unknown;
      renotify?: boolean;
      timestamp?: number;
      image?: string;
    };
    const dataValue = extendedRaw.data;
    const actionValue = extendedRaw.actions;

    const summarizeString = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const normalized = value.replace(/\s+/g, " ").trim();
      if (!normalized) return undefined;
      return normalized.slice(0, 240);
    };

    const summary: Record<string, unknown> = {
      optionKeys,
      tag: summarizeString((raw as NotificationOptions).tag),
      lang: summarizeString((raw as NotificationOptions).lang),
      dir:
        typeof (raw as NotificationOptions).dir === "string"
          ? (raw as NotificationOptions).dir
          : undefined,
      silent:
        typeof (raw as NotificationOptions).silent === "boolean"
          ? (raw as NotificationOptions).silent
          : undefined,
      renotify:
        typeof extendedRaw.renotify === "boolean"
          ? extendedRaw.renotify
          : undefined,
      requireInteraction:
        typeof (raw as NotificationOptions).requireInteraction === "boolean"
          ? (raw as NotificationOptions).requireInteraction
          : undefined,
      timestamp:
        typeof extendedRaw.timestamp === "number"
          ? extendedRaw.timestamp
          : undefined,
      badge: summarizeString((raw as NotificationOptions).badge),
      icon: summarizeString((raw as NotificationOptions).icon),
      image: summarizeString(extendedRaw.image),
      hasData: dataValue !== undefined,
      dataType:
        dataValue === null
          ? "null"
          : Array.isArray(dataValue)
            ? "array"
            : typeof dataValue,
      dataKeys:
        dataValue && typeof dataValue === "object" && !Array.isArray(dataValue)
          ? Object.keys(dataValue as Record<string, unknown>).sort().slice(0, 30)
          : undefined,
      dataPreview:
        typeof dataValue === "string"
          ? summarizeString(dataValue)
          : dataValue && typeof dataValue === "object"
            ? JSON.stringify(dataValue, (_key, value) => {
                if (typeof value === "string") {
                  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
                }
                return value;
              }).slice(0, 400)
            : dataValue,
      actionsSummary: Array.isArray(actionValue)
        ? actionValue.slice(0, 5).map((action) => {
            if (!action || typeof action !== "object") return String(action);
            return {
              action:
                typeof (action as { action?: unknown }).action === "string"
                  ? (action as { action?: string }).action
                  : undefined,
              title:
                typeof (action as { title?: unknown }).title === "string"
                  ? (action as { title?: string }).title
                  : undefined,
            };
          })
        : undefined,
    };

    return Object.fromEntries(
      Object.entries(summary).filter(([, value]) => value !== undefined),
    );
  };

  const INCOMING_CALL_RECOVERY_SETTLING_MS = 10_000;
  const INCOMING_CALL_CORROBORATION_WINDOW_MS = 8_000;
  let incomingCallRecoveryUntil = 0;
  let sawOfflineSinceLastOnline = false;
  let lastCorroboratedIncomingCallEvidence: IncomingCallEvidence | null = null;

  const isIncomingCallRecoveryActive = (now = Date.now()): boolean =>
    now < incomingCallRecoveryUntil;

  const startIncomingCallRecoveryWindow = (
    reason: string,
    durationMs = INCOMING_CALL_RECOVERY_SETTLING_MS,
  ): void => {
    const now = Date.now();
    incomingCallRecoveryUntil = Math.max(
      incomingCallRecoveryUntil,
      now + Math.max(1000, Math.floor(durationMs)),
    );
    emitIncomingCallDebug("incoming-call-recovery-started", {
      reason,
      recoveryUntil: incomingCallRecoveryUntil,
      url: window.location.href,
    });
  };

  const buildIncomingCallEvidence = (params: {
    source: IncomingCallEvidenceSource;
    caller?: string;
    dedupeKey?: string;
    hasVisibleControls?: boolean;
    matchedPattern?: string;
    confidence?: IncomingCallEvidenceConfidence;
    capturedAt?: number;
    threadKey?: string;
  }): IncomingCallEvidence => {
    const capturedAt =
      typeof params.capturedAt === "number" &&
      Number.isFinite(params.capturedAt)
        ? params.capturedAt
        : Date.now();
    const recoveryActive = isIncomingCallRecoveryActive(capturedAt);

    let confidence = params.confidence;
    if (!confidence) {
      if (params.source === "dom-explicit") {
        confidence = "high";
      } else if (params.source === "dom-soft") {
        confidence = "medium";
      } else if (params.source === "periodic-scan") {
        confidence = params.caller ? "medium" : "low";
      } else {
        confidence = "low";
      }
    }

    return {
      source: params.source,
      confidence,
      caller:
        typeof params.caller === "string" && params.caller.trim().length > 0
          ? params.caller.trim()
          : undefined,
      dedupeKey:
        typeof params.dedupeKey === "string" &&
        params.dedupeKey.trim().length > 0
          ? params.dedupeKey.trim()
          : undefined,
      hasVisibleControls: params.hasVisibleControls === true,
      matchedPattern:
        typeof params.matchedPattern === "string" &&
        params.matchedPattern.trim().length > 0
          ? params.matchedPattern.trim()
          : undefined,
      capturedAt,
      recoveryActive,
      threadKey:
        typeof params.threadKey === "string" &&
        params.threadKey.trim().length > 0
          ? params.threadKey.trim()
          : undefined,
    };
  };

  const shouldPromoteIncomingCallEvidence = (
    evidence: IncomingCallEvidence,
  ): { shouldPromote: boolean; reason: string } => {
    if (evidence.recoveryActive && evidence.source !== "dom-explicit") {
      return { shouldPromote: false, reason: "recovery-requires-explicit-dom" };
    }

    if (evidence.confidence === "low") {
      return { shouldPromote: false, reason: "low-confidence-evidence" };
    }

    return { shouldPromote: true, reason: "promote" };
  };

  const rememberIncomingCallEvidence = (
    evidence: IncomingCallEvidence,
  ): void => {
    if (evidence.confidence === "low") {
      return;
    }

    lastCorroboratedIncomingCallEvidence = evidence;
    emitIncomingCallDebug("incoming-call-evidence-recorded", {
      evidenceSource: evidence.source,
      confidence: evidence.confidence,
      caller: evidence.caller,
      dedupeKey: evidence.dedupeKey,
      hasVisibleControls: evidence.hasVisibleControls,
      matchedPattern: evidence.matchedPattern,
      recoveryActive: evidence.recoveryActive === true,
      url: window.location.href,
    });
  };

  const getRecentCorroboratedIncomingCallEvidence = (
    params: { dedupeKey?: string; caller?: string; now?: number } = {},
  ): IncomingCallEvidence | null => {
    const now =
      typeof params.now === "number" && Number.isFinite(params.now)
        ? params.now
        : Date.now();
    const evidence = lastCorroboratedIncomingCallEvidence;
    if (!evidence) return null;
    if (now - evidence.capturedAt > INCOMING_CALL_CORROBORATION_WINDOW_MS) {
      return null;
    }

    const dedupeKey = String(params.dedupeKey || "").trim();
    const caller = String(params.caller || "")
      .trim()
      .toLowerCase();
    const evidenceCaller = String(evidence.caller || "")
      .trim()
      .toLowerCase();

    if (dedupeKey && evidence.dedupeKey && dedupeKey === evidence.dedupeKey) {
      return evidence;
    }

    if (caller && evidenceCaller && caller === evidenceCaller) {
      return evidence;
    }

    if (!dedupeKey && !caller) {
      return evidence;
    }

    return null;
  };

  const getNotificationDecisionPolicy =
    (): NotificationDecisionPolicyApi | null => {
      const policy = (window as any).__mdNotificationDecisionPolicy;
      if (
        policy &&
        typeof policy.resolveNativeNotificationTarget === "function" &&
        typeof policy.createNotificationDeduper === "function" &&
        typeof policy.isLikelyGlobalFacebookNotification === "function" &&
        typeof policy.classifyCallNotification === "function"
      ) {
        return policy as NotificationDecisionPolicyApi;
      }
      return null;
    };

  const classifyCallPayload = (
    title: string,
    body: string,
  ): NotificationCallClassification => {
    const policy = getNotificationDecisionPolicy();
    if (!policy) {
      return { isIncomingCall: false, reason: "policy-unavailable" };
    }

    return policy.classifyCallNotification({
      title: String(title),
      body: String(body),
    });
  };

  const normalizeCallDedupeKey = (title: string, body: string): string => {
    const normalized = `${title} ${body}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    return `native:call:${normalized}`;
  };

  // ============================================================================
  // SHARED STATE - used by both MutationObserver and Title-based detection
  // ============================================================================

  // Track notified conversations by href - stores the last message body we notified for
  // Records are cleared when:
  // 1. The conversation is marked as read (via clearReadConversationRecords)
  // 2. The app restarts (Map is in-memory only)
  // No time-based expiry needed - memory usage is negligible (~400 bytes per conversation)
  // Fixes issue #13: users getting repeated notifications for weeks-old unread messages.
  const notifiedConversations = new Map<string, { body: string }>();
  const conversationNotificationDeduper =
    getNotificationDecisionPolicy()?.createNotificationDeduper(4000) ?? null;

  const normalizeConversationKey = (raw: string): string => {
    if (raw.startsWith("native:")) {
      return raw;
    }

    try {
      const url =
        raw.startsWith("http://") || raw.startsWith("https://")
          ? new URL(raw)
          : new URL(raw, window.location.origin);
      const trimmedPath = (url.pathname || "/").replace(/\/+$/, "") || "/";
      const canonicalPath = trimmedPath
        .replace(/^\/messages\/e2ee\/t\//, "/t/")
        .replace(/^\/messages\/t\//, "/t/")
        .replace(/^\/e2ee\/t\//, "/t/");
      return canonicalPath;
    } catch {
      const withoutHashOrQuery = raw.split(/[?#]/)[0] || "/";
      const trimmed = withoutHashOrQuery.replace(/\/+$/, "") || "/";
      return trimmed
        .replace(/^\/messages\/e2ee\/t\//, "/t/")
        .replace(/^\/messages\/t\//, "/t/")
        .replace(/^\/e2ee\/t\//, "/t/");
    }
  };

  const buildIncomingCallDedupeKey = (rawRoute?: string): string => {
    const route = normalizeConversationKey(
      typeof rawRoute === "string" && rawRoute.trim().length > 0
        ? rawRoute
        : window.location.pathname || "/",
    );
    return normalizeIncomingCallKey(`call:${route}`);
  };

  // Clear notification records for conversations that are no longer unread
  // This allows new notifications to be sent when new messages arrive in the same conversation
  const clearReadConversationRecords = () => {
    const sidebar = findSidebarElement();
    if (!sidebar) return;

    const rows = sidebar.querySelectorAll(selectors.conversationRow);
    const unreadHrefs = new Set<string>();
    // Collect all currently unread conversation hrefs
    rows.forEach((row) => {
      if (isConversationUnread(row)) {
        const linkEl =
          row.querySelector(selectors.conversationLink) ||
          row.closest(selectors.conversationLink);
        const href = linkEl?.getAttribute("href");
        if (href) {
          unreadHrefs.add(normalizeConversationKey(href));
        }
      }
    });

    // Remove records for conversations that are no longer unread
    for (const key of notifiedConversations.keys()) {
      // Check href-based keys against unread hrefs
      if (!unreadHrefs.has(key)) {
        log("Clearing notification record for read conversation", {
          href: key,
        });
        notifiedConversations.delete(key);
      }
    }
  };

  // Check if we've already notified for this exact message
  const hasAlreadyNotified = (href: string, body: string): boolean => {
    const key = normalizeConversationKey(href);
    const existing = notifiedConversations.get(key);
    if (!existing) return false;
    // Already notified for this exact message content
    return existing.body === body;
  };

  const isMessagesNotificationRoute = (): boolean => {
    try {
      const pathname = window.location.pathname.toLowerCase();
      return (
        pathname === "/messages" ||
        pathname.startsWith("/messages/") ||
        pathname.startsWith("/t/") ||
        pathname.startsWith("/e2ee/t/")
      );
    } catch {
      return false;
    }
  };

  const canSendNotification = (): boolean => {
    // Keep notifications scoped to message surfaces only.
    return isMessagesNotificationRoute();
  };

  const recordNotification = (href: string, body: string) => {
    const key = normalizeConversationKey(href);
    notifiedConversations.set(key, { body });
  };

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  // Generate text from a node, handling emojis
  const generateStringFromNode = (
    element: Element | null,
  ): string | undefined => {
    if (!element) return undefined;
    const cloneElement = element.cloneNode(true) as Element;
    const images = Array.from(cloneElement.querySelectorAll("img"));
    for (const image of images) {
      let emojiString = image.alt;
      if (emojiString === "(Y)" || emojiString === "(y)") {
        emojiString = "👍";
      }
      image.parentElement?.replaceWith(
        document.createTextNode(emojiString || ""),
      );
    }
    return cloneElement.textContent?.trim() || undefined;
  };

  // Send notification via bridge or postMessage
  const sendNotification = (
    title: string,
    body: string,
    source: string,
    icon?: string,
    href?: string,
  ) => {
    log(`=== SENDING NOTIFICATION [${source}] ===`, {
      title,
      body: body.slice(0, 50),
      href,
    });

    const notificationData = {
      title: String(title),
      body: String(body),
      id: Date.now() + Math.random(),
      icon,
      silent: false,
      href, // Include conversation URL for click-to-navigate
    };

    if ((window as any).__electronNotificationBridge) {
      try {
        (window as any).__electronNotificationBridge(notificationData);
        log("Notification sent via bridge");
      } catch (err) {
        log("Bridge call failed", { error: String(err) });
      }
    } else {
      log("Bridge not available, using postMessage");
      window.postMessage({ type: "notification", data: notificationData }, "*");
    }
  };

  // Check if window is focused (notifications should be skipped if focused)
  const isWindowFocused = (): boolean => {
    return document.hasFocus() && document.visibilityState === "visible";
  };

  const normalizePath = (path: string): string => {
    return normalizeConversationKey(path);
  };

  const isCurrentConversation = (href: string): boolean => {
    const currentPath = normalizePath(window.location.pathname);
    const targetPath = normalizePath(href);
    return currentPath === targetPath;
  };

  // ============================================================================
  // CONVERSATION EXTRACTION
  // ============================================================================

  // Extract the relative timestamp from a conversation element (e.g., "5m", "2h", "3d", "1w")
  // Returns null if no timestamp is found (meaning message just arrived)
  const extractTimestamp = (conversationEl: Element): string | null => {
    const textElements = conversationEl.querySelectorAll(
      selectors.conversationText,
    );
    for (const el of Array.from(textElements)) {
      const text = el.textContent?.trim() || "";
      // Match relative timestamps: 1m, 5m, 2h, 3d, 1w, etc.
      if (/^\d+[mhdw]$/.test(text)) {
        return text;
      }
      // Also check for "Just now" or "now" text
      if (/^just now$/i.test(text) || text.toLowerCase() === "now") {
        return "now";
      }
    }
    return null;
  };

  // Check if a message is fresh enough to warrant a notification
  // Messages with NO timestamp, "now"/"just now", or "1m" should trigger notifications
  // This prevents notifications for old messages that appear when scrolling or after app restart
  const isMessageFresh = (conversationEl: Element): boolean => {
    const timestamp = extractTimestamp(conversationEl);
    // Notify if no timestamp (brand new), "now"/"just now", or within 1 minute
    const isFresh =
      timestamp === null || timestamp === "now" || timestamp === "1m";
    if (!isFresh) {
      log("Message not fresh - has timestamp", { timestamp });
    }
    return isFresh;
  };

  // Check if a conversation element has an unread indicator
  const isConversationUnread = (conversationEl: Element): boolean => {
    // PRIMARY CHECK: Look for "Unread message:" text in the conversation
    // This is how Messenger marks unread conversations in the DOM
    const textContent = conversationEl.textContent || "";
    if (textContent.includes("Unread message:")) {
      return true;
    }

    // Check aria-label patterns (strictly "Unread message" to avoid false positives)
    const ariaLabel = (
      conversationEl.getAttribute("aria-label") || ""
    ).toLowerCase();
    if (ariaLabel.includes("unread message")) {
      return true;
    }

    // Look for the "Mark as Read" button which indicates unread
    const markAsRead = conversationEl.querySelector(selectors.unreadIndicator);
    if (markAsRead) {
      return true;
    }

    // Child unread indicator (strict variant)
    const childUnreadIndicator = conversationEl.querySelector(
      '[aria-label*="Unread message" i]',
    );
    if (childUnreadIndicator) {
      return true;
    }

    return false;
  };

  type MuteAnalysis = {
    isMuted: boolean;
    method: "legacy-path" | "svg-use" | "a11y-label" | "none";
    matchedPathSnippet?: string;
    matchedHref?: string;
    matchedPhrase?: string;
  };

  const collectConversationMetadataTexts = (conversationEl: Element): string[] => {
    const texts: string[] = [];
    const seen = new Set<string>();

    const pushText = (value: string | null | undefined) => {
      const text = String(value || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;

      const normalized = text.toLowerCase();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      texts.push(text);
    };

    pushText(conversationEl.getAttribute("aria-label"));
    pushText(conversationEl.getAttribute("title"));
    pushText(conversationEl.getAttribute("data-tooltip-content"));
    pushText(conversationEl.getAttribute("data-tooltip"));

    const metaNodes = conversationEl.querySelectorAll(
      "[aria-label], [title], [data-tooltip-content], [data-tooltip], img[alt]",
    );
    metaNodes.forEach((node) => {
      pushText(node.getAttribute("aria-label"));
      pushText(node.getAttribute("title"));
      pushText(node.getAttribute("data-tooltip-content"));
      pushText(node.getAttribute("data-tooltip"));
      if (node instanceof HTMLImageElement) {
        pushText(node.alt);
      }
    });

    return texts;
  };

  const analyzeMuteSignals = (conversationEl: Element): MuteAnalysis => {
    const paths = Array.from(conversationEl.querySelectorAll("svg path"));
    for (const path of paths) {
      const d = path.getAttribute("d") || "";
      if (
        d.startsWith("M9.244 24.99") ||
        d.includes("L26.867 7.366") ||
        d.startsWith("M29.676 7.746") ||
        d.includes("L6.293 28.29") ||
        d.startsWith("M2.5 6c0-.322") ||
        d.includes("8.296 8.296A3.001 3.001 0 0 1 5 12.5")
      ) {
        return {
          isMuted: true,
          method: "legacy-path",
          matchedPathSnippet: d.slice(0, 140),
        };
      }
    }

    const iconUseNodes = Array.from(conversationEl.querySelectorAll("svg use"));
    for (const useNode of iconUseNodes) {
      const href = (
        useNode.getAttribute("href") ||
        useNode.getAttribute("xlink:href") ||
        ""
      ).toLowerCase();
      if (
        href.includes("mute") ||
        href.includes("muted") ||
        href.includes("notification_off") ||
        (href.includes("bell") && href.includes("slash"))
      ) {
        return {
          isMuted: true,
          method: "svg-use",
          matchedHref: href,
        };
      }
    }

    const labelSources = [
      String(conversationEl.textContent || "").toLowerCase(),
      ...collectConversationMetadataTexts(conversationEl).map((text) =>
        text.toLowerCase(),
      ),
    ];

    const mutePhrases = [
      "muted",
      "notifications are off",
      "notifications off",
      "notification off",
      "unmute",
      "turn on notifications",
      "turn notifications on",
    ];

    const matchedPhrase = labelSources.find((text) =>
      mutePhrases.some((phrase) => text.includes(phrase)),
    );

    if (matchedPhrase) {
      return {
        isMuted: true,
        method: "a11y-label",
        matchedPhrase,
      };
    }

    return {
      isMuted: false,
      method: "none",
    };
  };

  // Detect whether a conversation is muted
  // Keep this heuristic broad because Facebook frequently changes sidebar icon markup.
  const isConversationMuted = (conversationEl: Element): boolean => {
    const analysis = analyzeMuteSignals(conversationEl);
    if (!analysis.isMuted) return false;

    log("Muted detected", {
      method: analysis.method,
      matchedPathSnippet: analysis.matchedPathSnippet,
      matchedHref: analysis.matchedHref,
      matchedPhrase: analysis.matchedPhrase,
    });

    return true;
  };

  // Extract conversation info from a conversation element
  const extractConversationInfo = (
    conversationEl: Element,
    verbose = false,
  ): { title: string; body: string; href: string; icon?: string } | null => {
    // Find the link element to get the href (used for deduplication)
    const linkEl =
      conversationEl.querySelector(selectors.conversationLink) ||
      conversationEl.closest(selectors.conversationLink);
    const href = linkEl?.getAttribute("href");

    if (!href) {
      return null;
    }

    // Find all text elements
    const textElements = conversationEl.querySelectorAll(
      selectors.conversationText,
    );

    if (textElements.length < 1) {
      return null;
    }

    const texts: string[] = [];
    textElements.forEach((el) => {
      const text = generateStringFromNode(el);
      if (text && text.length > 0) {
        // Filter out timestamps and metadata
        if (
          !/^\d+[mhdw]$/.test(text) &&
          text !== "·" &&
          text !== "Unread message:"
        ) {
          texts.push(text);
        }
      }
    });

    const title = texts[0] || "";
    const body = texts[1] || "New message";

    if (!title) {
      return null;
    }

    // Try to get the avatar icon
    const imgEl = conversationEl.querySelector("img");
    const icon = imgEl?.src;

    if (verbose) {
      log("extractConversationInfo", { title, body: body.slice(0, 30), href });
    }

    return { title, body, href, icon };
  };

  const extractConversationSearchText = (conversationEl: Element): string =>
    collectConversationMetadataTexts(conversationEl).join(" ");

  const collectSidebarConversationSnapshot = (sidebar: Element) => {
    const rows = Array.from(
      sidebar.querySelectorAll(selectors.conversationRow),
    );
    const rowByHref = new Map<string, Element>();
    const conversationCandidates: NotificationCandidate[] = [];

    for (const row of rows) {
      const info = extractConversationInfo(row);
      if (!info) continue;

      const normalizedHref = normalizeConversationKey(info.href);
      rowByHref.set(normalizedHref, row);
      conversationCandidates.push({
        href: normalizedHref,
        title: info.title,
        body: info.body,
        searchText: extractConversationSearchText(row),
        muted: isConversationMuted(row),
        unread: isConversationUnread(row),
      });
    }

    return {
      rowByHref,
      conversationCandidates,
    };
  };

  // Find sidebar or chat grid element
  const findSidebarElement = (): Element | null => {
    // Try primary selector
    const sidebar = document.querySelector(selectors.sidebar);
    if (sidebar) return sidebar;

    // Try finding grid and getting its navigation parent
    const grid = document.querySelector(selectors.chatsGrid);
    if (grid) {
      const navParent = grid.closest('[role="navigation"]');
      if (navParent) return navParent;
      return grid; // Use grid directly if no nav parent
    }

    return null;
  };

  // ============================================================================
  // NATIVE NOTIFICATION INTERCEPTION
  // ============================================================================

  // Handle events sent from the browser process (via preload)
  window.addEventListener("message", ({ data }: MessageEvent) => {
    if (!data || typeof data !== "object") return;

    const { type, data: eventData } = data as { type: string; data: any };

    if (type === "notification-callback") {
      const { callbackName, id } = eventData;
      const notification = notifications.get(id);
      if (!notification) return;

      if (notification[callbackName]) {
        notification[callbackName]();
      }

      if (callbackName === "onclose") {
        notifications.delete(id);
      }
      return;
    }

    if (type === "electron-power-state") {
      const state = eventData?.state as PowerStateEvent | undefined;
      if (!state) return;

      log("Power state change received", {
        state,
        timestamp: eventData?.timestamp,
      });

      if (state === "resume" || state === "unlock-screen") {
        startIncomingCallRecoveryWindow(state);
        startSettlingPeriod({
          reason: state,
          durationMs: RESUME_SETTLING_MS,
          includeFresh: false,
        });
      } else {
        isSettling = true;
      }
      return;
    }
  });

  window.addEventListener("offline", () => {
    sawOfflineSinceLastOnline = true;
    emitIncomingCallDebug("network-offline", { url: window.location.href });
  });

  window.addEventListener("online", () => {
    emitIncomingCallDebug("network-online", {
      url: window.location.href,
      hadPriorOffline: sawOfflineSinceLastOnline,
    });

    if (sawOfflineSinceLastOnline) {
      startIncomingCallRecoveryWindow("online");
      startSettlingPeriod({
        reason: "online-recovery",
        durationMs: RESUME_SETTLING_MS,
        includeFresh: false,
      });
      sawOfflineSinceLastOnline = false;
    }
  });

  let counter = 1;

  // Augmented Notification class that forwards to Electron
  const augmentedNotification = Object.assign(
    class {
      private readonly _id: number;

      constructor(title: string, options?: NotificationOptions) {
        // Handle React props in title and body
        let { body } = options || {};
        const bodyProperties = (body as any)?.props;
        body = bodyProperties
          ? bodyProperties.content?.[0]
          : options?.body || "";

        const titleProperties = (title as any)?.props;
        title = titleProperties ? titleProperties.content?.[0] : title || "";

        this._id = counter++;
        notifications.set(this._id, this as any);

        log("=== NATIVE NOTIFICATION INTERCEPTED ===", {
          id: this._id,
          title,
          body,
        });
        log(
          "Native notification raw options",
          summarizeNotificationOptions(options),
        );

        const policy = getNotificationDecisionPolicy();
        if (!policy) {
          // Fail-closed if policy script is unavailable to avoid muted leaks.
          log("Native notification policy unavailable - suppressing", {
            title,
          });
          return;
        }

        const nativePayload = {
          title: String(title),
          body: String(body),
        };
        const callClassification =
          policy.classifyCallNotification(nativePayload);
        if (callClassification.isIncomingCall) {
          const now = Date.now();
          const routeKey = normalizeConversationKey(
            window.location.pathname || "/",
          );
          const dedupeKey = buildIncomingCallDedupeKey(routeKey);
          const caller = extractIncomingCallerName(
            `${nativePayload.title} ${nativePayload.body}`,
          );
          const corroboration = getRecentCorroboratedIncomingCallEvidence({
            dedupeKey,
            caller,
            now,
          });
          const evidence = buildIncomingCallEvidence({
            source: "native-notification",
            caller,
            dedupeKey,
            matchedPattern: callClassification.matchedPattern,
            confidence: corroboration ? "medium" : "low",
            capturedAt: now,
            threadKey: routeKey,
          });
          const promotion = shouldPromoteIncomingCallEvidence(evidence);

          emitIncomingCallDebug("incoming-call-native-notification", {
            title: nativePayload.title,
            matchedPattern: callClassification.matchedPattern,
            caller,
            dedupeKey,
            confidence: evidence.confidence,
            recoveryActive: evidence.recoveryActive === true,
            corroboratedBy: corroboration?.source,
            url: window.location.href,
          });

          if (!promotion.shouldPromote) {
            log(
              "Native call notification suppressed - no corroborated call UI evidence",
              {
                title,
                reason: promotion.reason,
                dedupeKey,
              },
            );
            emitIncomingCallDebug(
              "incoming-call-native-notification-suppressed",
              {
                reason: promotion.reason,
                dedupeKey,
                confidence: evidence.confidence,
                recoveryActive: evidence.recoveryActive === true,
                url: window.location.href,
              },
            );
            return;
          }

          const bodyStr = String(body).slice(0, 100);
          const nativeDedupeKey = normalizeCallDedupeKey(
            nativePayload.title,
            nativePayload.body,
          );
          if (hasAlreadyNotified(nativeDedupeKey, bodyStr)) {
            log("Native call notification deduplicated", {
              title,
              dedupeKey: nativeDedupeKey,
            });
            return;
          }
          if (
            conversationNotificationDeduper?.shouldSuppress(nativeDedupeKey)
          ) {
            log("Native call notification suppressed by TTL deduper", {
              title,
              dedupeKey: nativeDedupeKey,
            });
            return;
          }

          recordNotification(nativeDedupeKey, bodyStr);
          log("Native notification corroborated by recent call UI evidence", {
            title,
            reason: callClassification.reason,
            matchedPattern: callClassification.matchedPattern,
            corroboratedBy: corroboration?.source,
          });
          signalIncomingCall({
            dedupeKey,
            caller,
            source: "native-notification",
            recoveryActive: evidence.recoveryActive,
            evidence,
          });
          return;
        }

        // CRITICAL: Suppress non-call notifications during settling period AND initial startup
        // Messenger often fires batched notifications for old messages when the app loads
        const timeSinceStart = Date.now() - appStartTime;
        if (isSettling || timeSinceStart < NATIVE_NOTIFICATION_SUPPRESS_MS) {
          log("Native notification suppressed - app still settling", {
            isSettling,
            timeSinceStart,
            threshold: NATIVE_NOTIFICATION_SUPPRESS_MS,
          });
          return;
        }

        if (!canSendNotification()) {
          log("Native notification skipped outside messages route", { title });
          return;
        }

        if (policy.isLikelyGlobalFacebookNotification(nativePayload)) {
          log(
            "Native notification suppressed - non-message Facebook activity",
            {
              title,
              body,
            },
          );
          return;
        }

        const bodyStr = String(body).slice(0, 100);
        const sidebar = findSidebarElement();
        if (!sidebar) {
          log("Native notification skipped - sidebar unavailable", { title });
          return;
        }

        const { rowByHref, conversationCandidates } =
          collectSidebarConversationSnapshot(sidebar);

        const match = policy.resolveNativeNotificationTarget(
          { title: String(title), body: String(body) },
          conversationCandidates,
        );
        log("Native notification match", match);

        if (match.ambiguous || !match.matchedHref) {
          log("Native notification ambiguous - suppressing", {
            title,
            confidence: match.confidence,
            reason: match.reason,
          });
          return;
        }

        if (match.muted) {
          log("Native notification for muted conversation - skipping", {
            title,
            href: match.matchedHref,
          });
          return;
        }

        const normalizedHref = normalizeConversationKey(match.matchedHref);
        const matchedRow = rowByHref.get(normalizedHref);
        if (!matchedRow) {
          log("Native notification match had no unread row - suppressing", {
            title,
            href: normalizedHref,
          });
          return;
        }

        const matchedInfo = extractConversationInfo(matchedRow);
        const selfAuthoredNotification =
          typeof policy.shouldSuppressSelfAuthoredNotification === "function"
            ? policy.shouldSuppressSelfAuthoredNotification([
                nativePayload,
                matchedInfo
                  ? { title: matchedInfo.title, body: matchedInfo.body }
                  : null,
              ])
            : Boolean(
                matchedInfo &&
                typeof policy.isLikelySelfAuthoredMessagePreview ===
                  "function" &&
                policy.isLikelySelfAuthoredMessagePreview({
                  title: matchedInfo.title,
                  body: matchedInfo.body,
                }),
              );
        if (selfAuthoredNotification) {
          log("Native notification suppressed - self-authored preview", {
            title,
            href: normalizedHref,
            body: matchedInfo?.body,
          });
          return;
        }

        if (!isConversationUnread(matchedRow)) {
          log("Native notification matched read conversation - suppressing", {
            title,
            href: normalizedHref,
          });
          return;
        }

        if (!isMessageFresh(matchedRow)) {
          log(
            "Native notification for old message - skipping (has timestamp)",
            {
              title,
              href: normalizedHref,
            },
          );
          return;
        }

        if (hasAlreadyNotified(normalizedHref, bodyStr)) {
          log("Native notification deduplicated", { href: normalizedHref });
          return;
        }

        if (conversationNotificationDeduper?.shouldSuppress(normalizedHref)) {
          log("Native notification suppressed by TTL deduper", {
            title,
            href: normalizedHref,
          });
          return;
        }

        recordNotification(normalizedHref, bodyStr);
        sendNotification(
          formatNotificationConversationTitle({
            title: matchedInfo?.title || String(title),
            href: normalizedHref,
            alternateTitle: String(title),
          }),
          String(body),
          "NATIVE",
          options?.icon as string,
          normalizedHref,
        );
      }

      close(): void {}

      addEventListener(event: string, listener: EventListener | null): void {
        if (!listener) return;
        if (!(this as any).listeners) {
          (this as any).listeners = new Map();
        }
        if (!(this as any).listeners.has(event)) {
          (this as any).listeners.set(event, []);
        }
        (this as any).listeners.get(event).push(listener);
      }

      removeEventListener(event: string, listener: EventListener | null): void {
        if (!listener || !(this as any).listeners) return;
        const listeners = (this as any).listeners.get(event);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index > -1) {
            listeners.splice(index, 1);
          }
        }
      }

      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve("granted");
      }

      static get permission(): NotificationPermission {
        return "granted";
      }

      static set permission(_value: NotificationPermission) {
        // no-op
      }
    },
    notification,
  );

  // ============================================================================
  // DETECTION METHOD 1: MutationObserver on sidebar
  // ============================================================================
  // Re-enabled: on facebook.com/messages the native Notification constructor
  // pipeline is often not invoked, so MutationObserver is required for
  // notification delivery. Keep strict unread/mute/fresh checks to avoid
  // false positives.
  const ENABLE_MUTATION_OBSERVER_NOTIFICATIONS = true;

  // Track whether we're in the initial settling period (no notifications during this time)
  // This applies to BOTH MutationObserver and native notification interception
  let isSettling = true;
  // Track the current sidebar element to detect navigation changes
  let currentSidebarElement: Element | null = null;
  // Track app startup time - used to suppress old notifications
  const appStartTime = Date.now();
  // How long after app start to suppress native notifications (longer than settling period)
  // This accounts for Messenger batching old notification delivery on load
  const NATIVE_NOTIFICATION_SUPPRESS_MS = 8000;
  const RESUME_SETTLING_MS = 8000;
  let settlingToken = 0;
  let settlingTimeoutId: number | null = null;

  const startSettlingPeriod = (options: {
    reason: string;
    sidebar?: Element | null;
    durationMs: number;
    includeFresh?: boolean;
    rescan?: boolean;
  }): void => {
    const {
      reason,
      sidebar = findSidebarElement(),
      durationMs,
      includeFresh = true,
      rescan = true,
    } = options;

    settlingToken += 1;
    const token = settlingToken;

    if (settlingTimeoutId !== null) {
      clearTimeout(settlingTimeoutId);
      settlingTimeoutId = null;
    }

    isSettling = true;

    if (sidebar) {
      currentSidebarElement = sidebar;
      recordExistingConversations(sidebar, { includeFresh, reason });
    }

    settlingTimeoutId = window.setTimeout(() => {
      if (token !== settlingToken) {
        return;
      }

      if (rescan && currentSidebarElement) {
        recordExistingConversations(currentSidebarElement, {
          includeFresh,
          reason,
        });
      }

      isSettling = false;
      settlingTimeoutId = null;
      log(`Settling period ended (${reason})`);
    }, durationMs);
  };

  type RecordExistingOptions = {
    includeFresh?: boolean;
    reason?: string;
  };

  // Scan and record all currently visible unread conversations (to avoid notifying on initial load)
  const recordExistingConversations = (
    sidebar: Element,
    options: RecordExistingOptions = {},
  ) => {
    const { includeFresh = true, reason } = options;
    const rows = sidebar.querySelectorAll(selectors.conversationRow);
    let recordedCount = 0;

    rows.forEach((row) => {
      if (isConversationUnread(row)) {
        if (!includeFresh && isMessageFresh(row)) {
          return;
        }
        const info = extractConversationInfo(row);
        if (info) {
          // Mark as already notified so we don't send notifications for these
          recordNotification(info.href, info.body);
          recordedCount++;
        }
      }
    });

    const freshnessLabel = includeFresh ? "" : " (excluding fresh)";
    const reasonLabel = reason ? ` after ${reason}` : "";
    log(
      `Recorded ${recordedCount} existing unread conversations${freshnessLabel}${reasonLabel}`,
    );
  };

  const setupMutationObserver = () => {
    log("Setting up MutationObserver detection...");

    const processMutations = (mutationsList: MutationRecord[]) => {
      if (mutationsList.length === 0) return;

      // Skip if MutationObserver notifications are disabled
      if (!ENABLE_MUTATION_OBSERVER_NOTIFICATIONS) {
        return;
      }

      // Don't send notifications during the settling period
      if (isSettling) {
        log("Skipping notifications - still in settling period");
        return;
      }

      // Global rate limit
      if (!canSendNotification()) {
        return;
      }

      clearReadConversationRecords();

      const alreadyProcessed = new Set<string>();

      // Process mutations in reverse order (newest first)
      for (const mutation of [...mutationsList].reverse()) {
        let target = mutation.target as Element;
        if (target.nodeType === Node.TEXT_NODE) {
          target = target.parentElement as Element;
        }
        if (!target) continue;

        // Walk up to find the conversation row
        const conversationRow = target.closest(selectors.conversationRow);
        if (!conversationRow) continue;

        // Extract info to get href for deduplication
        const info = extractConversationInfo(conversationRow);
        if (!info) continue;

        const normalizedObservedHref = normalizeConversationKey(info.href);

        // Skip if already processed in this batch
        if (alreadyProcessed.has(normalizedObservedHref)) continue;
        alreadyProcessed.add(normalizedObservedHref);

        // Skip if this is the currently open conversation while window is focused
        if (
          isCurrentConversation(normalizedObservedHref) &&
          isWindowFocused()
        ) {
          continue;
        }

        // Check if this conversation is unread before doing more expensive snapshot work
        if (!isConversationUnread(conversationRow)) {
          continue;
        }

        const policy = getNotificationDecisionPolicy();
        if (
          !policy ||
          typeof policy.resolveObservedSidebarNotificationTarget !== "function"
        ) {
          log("Mutation notification policy unavailable - suppressing", {
            title: info.title,
            href: normalizedObservedHref,
          });
          continue;
        }

        const sidebar = currentSidebarElement || findSidebarElement();
        if (!sidebar) {
          log("Skipping mutation notification - sidebar unavailable", {
            title: info.title,
            href: normalizedObservedHref,
          });
          continue;
        }

        const { rowByHref, conversationCandidates } =
          collectSidebarConversationSnapshot(sidebar);
        const decision = policy.resolveObservedSidebarNotificationTarget(
          {
            title: info.title,
            body: info.body,
          },
          normalizedObservedHref,
          conversationCandidates,
        );
        log("Mutation notification decision", decision.debug || {
          observedTitle: info.title,
          observedBody: info.body,
          observedHref: normalizedObservedHref,
          matchedHref: decision.matchedHref,
          matchedObservedHref: decision.matchedObservedHref,
          confidence: decision.confidence,
          muted: decision.muted,
          finalReason: decision.reason,
        });

        if (!decision.shouldNotify || !decision.matchedHref) {
          log("Mutation notification suppressed by policy", {
            title: info.title,
            href: normalizedObservedHref,
            matchedHref: decision.matchedHref,
            matchedObservedHref: decision.matchedObservedHref,
            confidence: decision.confidence,
            muted: decision.muted,
            reason: decision.reason,
          });
          continue;
        }

        const normalizedMatchedHref = normalizeConversationKey(
          decision.matchedHref,
        );
        const matchedRow = rowByHref.get(normalizedMatchedHref);
        if (!matchedRow) {
          log("Mutation notification matched row missing - suppressing", {
            title: info.title,
            href: normalizedMatchedHref,
          });
          continue;
        }

        const matchedInfo = extractConversationInfo(matchedRow) || info;

        const selfAuthoredNotification =
          typeof policy.shouldSuppressSelfAuthoredNotification === "function"
            ? policy.shouldSuppressSelfAuthoredNotification([
                { title: info.title, body: info.body },
                { title: matchedInfo.title, body: matchedInfo.body },
              ])
            : typeof policy.isLikelySelfAuthoredMessagePreview === "function" &&
              policy.isLikelySelfAuthoredMessagePreview({
                title: matchedInfo.title,
                body: matchedInfo.body,
              });

        if (selfAuthoredNotification) {
          log("Skipping mutation notification for self-authored preview", {
            title: matchedInfo.title,
            href: normalizedMatchedHref,
            body: matchedInfo.body,
          });
          continue;
        }

        if (!isConversationUnread(matchedRow)) {
          log("Mutation notification matched read conversation - suppressing", {
            title: matchedInfo.title,
            href: normalizedMatchedHref,
          });
          continue;
        }

        if (isConversationMuted(matchedRow)) {
          log(
            "Skipping mutation notification for muted conversation after policy",
            {
              title: matchedInfo.title,
              href: normalizedMatchedHref,
            },
          );
          continue;
        }

        // CRITICAL: Skip if message is not fresh (has a timestamp like "5m", "2h", "3d", "1w")
        // This is the primary fix for issue #13 - only notify for messages that JUST arrived
        // Old messages that appear when scrolling or after app restart will have timestamps
        if (!isMessageFresh(matchedRow)) {
          log("Skipping notification - message has timestamp, not brand new", {
            title: matchedInfo.title,
            href: normalizedMatchedHref,
          });
          continue;
        }

        // Check if we've already notified for this exact message
        if (hasAlreadyNotified(normalizedMatchedHref, matchedInfo.body)) {
          continue;
        }

        if (
          conversationNotificationDeduper?.shouldSuppress(normalizedMatchedHref)
        ) {
          log("Mutation notification suppressed by TTL deduper", {
            title: matchedInfo.title,
            href: normalizedMatchedHref,
          });
          continue;
        }

        recordNotification(normalizedMatchedHref, matchedInfo.body);
        log("Sending notification from MutationObserver", {
          title: matchedInfo.title,
          body: matchedInfo.body.slice(0, 50),
          href: normalizedMatchedHref,
          observedHref: normalizedObservedHref,
          confidence: decision.confidence,
          reason: decision.reason,
        });

        sendNotification(
          formatNotificationConversationTitle({
            title: matchedInfo.title,
            href: normalizedMatchedHref,
          }),
          matchedInfo.body,
          "MUTATION",
          matchedInfo.icon,
          normalizedMatchedHref,
        );
        // Only send one notification per mutation batch
        break;
      }
    };

    // Handle navigation changes - when sidebar changes, we need to re-settle
    const handleNavigationChange = () => {
      const sidebar = findSidebarElement();

      // Check if sidebar has changed (navigation to different section)
      if (sidebar && sidebar !== currentSidebarElement) {
        log("Navigation detected - sidebar changed, entering settling period");
        startSettlingPeriod({
          reason: "navigation",
          sidebar,
          durationMs: 3000,
        });
      }
    };

    // Watch for URL changes (SPA navigation)
    let lastUrl = window.location.href;
    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        log("URL changed", { from: lastUrl, to: window.location.href });
        lastUrl = window.location.href;
        // Give the page time to render, then handle navigation
        setTimeout(handleNavigationChange, 1000);
      }
    });

    urlObserver.observe(document.body, { childList: true, subtree: true });

    // Wait for sidebar to be available, then observe
    const startObserving = () => {
      const sidebar = findSidebarElement();

      if (sidebar) {
        log("MutationObserver: Found sidebar, starting observation", {
          tagName: sidebar.tagName,
        });
        currentSidebarElement = sidebar;

        // CRITICAL: Record all existing conversations BEFORE enabling notifications
        // This prevents notifications for messages that were already there on load
        recordExistingConversations(sidebar);

        const observer = new MutationObserver(processMutations);
        observer.observe(sidebar, {
          characterData: true,
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["src", "alt", "aria-label", "class"],
        });

        // End the settling period after giving the page time to fully load
        // This accounts for lazy-loaded conversations and dynamic content
        startSettlingPeriod({
          reason: "startup",
          sidebar,
          durationMs: 5000,
        });

        log("MutationObserver: Active (in settling period)");
      } else {
        log("MutationObserver: Sidebar not found, will retry...");
        // Retry in a few seconds
        setTimeout(startObserving, 3000);
      }
    };

    // Start after page settles
    setTimeout(startObserving, 2000);
  };

  // ============================================================================
  // FOCUS/VISIBILITY HANDLERS
  // ============================================================================

  // When the window regains focus, clear notification records for conversations
  // that have been read. This allows new notifications to be sent for new messages.
  const handleWindowFocus = () => {
    log("Window focused - clearing read conversation records");
    // Small delay to allow Messenger's UI to update the read status
    setTimeout(() => {
      clearReadConversationRecords();
    }, 500);
  };

  window.addEventListener("focus", handleWindowFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      handleWindowFocus();
    }
  });

  // ============================================================================
  // CHAT READ DETECTION
  // ============================================================================
  // Detect when messages are read in the currently active chat
  // and trigger a badge/unread count recount

  // Debounce badge recount requests to avoid excessive updates
  let badgeRecountTimeout: number | null = null;
  const requestBadgeRecount = () => {
    if (badgeRecountTimeout !== null) {
      clearTimeout(badgeRecountTimeout);
    }
    badgeRecountTimeout = window.setTimeout(() => {
      log("Requesting badge recount due to chat activity");
      window.postMessage({ type: "electron-recount-badge" }, "*");
      badgeRecountTimeout = null;
    }, 300); // Wait 300ms to batch multiple changes
  };

  // Listen for Enter key to detect message sending (which marks messages as read)
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Enter key pressed (likely sending a message)
        // Wait for the UI to update, then request badge recount
        setTimeout(requestBadgeRecount, 100);
      }
    },
    true,
  ); // Use capture phase to detect before Messenger handles it

  // Also monitor sidebar for unread status changes (messages marked as read)
  const setupReadDetectionObserver = () => {
    const sidebar = findSidebarElement();
    if (!sidebar) {
      setTimeout(setupReadDetectionObserver, 1000);
      return;
    }

    // Observe the sidebar for changes to unread indicators
    const readObserver = new MutationObserver((mutations) => {
      // Check if any mutations might indicate messages were marked as read
      let mightHaveCleared = false;

      for (const mutation of mutations) {
        // Check for attribute changes (aria-label updates)
        if (
          mutation.type === "attributes" &&
          mutation.attributeName?.includes("aria")
        ) {
          mightHaveCleared = true;
          break;
        }
        // Check for text content changes in conversation rows
        if (mutation.type === "characterData") {
          const text = mutation.target.textContent || "";
          // If "Unread message:" text is being removed, it means the chat was marked as read
          if (!text.includes("Unread message:")) {
            mightHaveCleared = true;
            break;
          }
        }
      }

      if (mightHaveCleared) {
        requestBadgeRecount();
      }
    });

    readObserver.observe(sidebar, {
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "class"],
    });

    log("Read detection observer active");
  };

  // Start read detection after a delay to ensure sidebar is available
  setTimeout(setupReadDetectionObserver, 3000);

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  // Override window.Notification
  Object.assign(window, { Notification: augmentedNotification });

  try {
    Object.defineProperty(window, "Notification", {
      value: augmentedNotification,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    log("Notification API overridden successfully");
  } catch (_e) {
    log("Using fallback Notification override method");
  }

  // Start MutationObserver detection
  log("Starting MutationObserver notification detection...");
  setupMutationObserver();

  // ============================================================================
  // INCOMING CALL POPUP DETECTION
  // ============================================================================
  // Messenger shows an in-page popup for incoming calls with Answer/Decline buttons.
  // We observe DOM changes to detect when this popup appears and bring window to foreground.

  const setupCallPopupObserver = () => {
    log("Setting up call popup detection...");

    // Track if we've already signaled for the current call to avoid repeated signals
    let lastCallSignalTime = 0;
    const CALL_SIGNAL_DEBOUNCE_MS = 5000; // Don't signal more than once every 5 seconds
    // Throttle attribute-mutation checks — class changes fire constantly in React apps
    let lastAttributeScanTime = 0;
    const ATTRIBUTE_SCAN_THROTTLE_MS = 500;
    // Skip isCallPopupElement subtree-walks on large containers (direct child limit)
    const MAX_CALL_POPUP_CHILD_COUNT = 200;
    let hasActiveIncomingCallUi = false;
    let lastIncomingCallUiSeenAt = 0;
    let missingIncomingCallUiSince: number | null = null;
    let confirmedVisibleIncomingCallUi = false;
    const CALL_END_GRACE_MS = 6000;
    const CALL_END_CONFIRMATION_MS = 2000;

    const incomingCallAnswerSelectors = [
      '[aria-label*="Answer" i]',
      '[aria-label="Accept" i]',
      '[aria-label*="Accept call" i]',
      '[aria-label*="Join call" i]',
      '[aria-label*="Accept video call" i]',
      '[aria-label*="Accept audio call" i]',
    ];

    const incomingCallDeclineSelectors = [
      '[aria-label*="Decline" i]',
      '[aria-label*="Ignore call" i]',
      '[aria-label*="Decline call" i]',
    ];

    const incomingCallJoinSelectors = [
      '[aria-label*="Join call" i]',
      '[aria-label*="Join video" i]',
      '[aria-label*="Join audio" i]',
    ];

    const incomingCallSoftSignalSelectors = [
      '[data-testid*="incoming"]',
      '[data-testid*="call"]',
      '[aria-label*="calling" i]',
      '[aria-label*="incoming call" i]',
      '[aria-label*="video call" i]',
      '[aria-label*="audio call" i]',
    ];

    const incomingCallSignalContainerSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[role="banner"]',
      '[data-testid*="incoming"]',
      '[data-testid*="call"]',
    ];

    const incomingCallSidebarExclusionSelectors = [
      '[role="navigation"]',
      '[role="grid"][aria-label*="Chats" i]',
      '[aria-label="Chats" i]',
    ];

    // Selectors and patterns that indicate an incoming call popup.
    // Use CSS Selectors Level 4 case-insensitive flag (supported in Chromium 49+).
    // Messenger's call UI typically contains:
    // - "Answer" or "Accept" button
    // - "Decline" or "Ignore" button
    // - Video/audio call icons
    // - Caller's profile picture with calling animation
    const callPopupSelectors = [
      // Buttons with call-related aria-labels (case-insensitive)
      '[aria-label*="Answer" i]',
      '[aria-label="Accept" i]',
      '[aria-label*="Decline" i]',
      '[aria-label*="Accept call" i]',
      '[aria-label*="Ignore call" i]',
      '[aria-label*="Accept video call" i]',
      '[aria-label*="Accept audio call" i]',
      '[aria-label*="Join call" i]',
      '[aria-label*="Join video" i]',
      '[aria-label*="Join audio" i]',
      // data-testid patterns (kept narrow to avoid matching unrelated quiz/event UI)
      '[data-testid*="incoming"]',
      '[data-testid*="call"]',
    ];

    const nonIncomingCallTextPatterns = [
      /\bongoing call\b/i,
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

    const markIncomingCallUiVisible = (now: number): void => {
      hasActiveIncomingCallUi = true;
      confirmedVisibleIncomingCallUi = true;
      lastIncomingCallUiSeenAt = now;
      missingIncomingCallUiSince = null;
    };

    const isSidebarCallStatusElement = (el: Element): boolean => {
      return (
        incomingCallSidebarExclusionSelectors.some(
          (selector) => el.closest(selector) !== null,
        ) || /\bongoing call\b/i.test(String(el.textContent || ""))
      );
    };

    const queryVisibleElements = (selectors: string[]): Element[] => {
      const results: Element[] = [];
      const seen = new Set<Element>();

      for (const selector of selectors) {
        let matches: NodeListOf<Element>;
        try {
          matches = document.querySelectorAll(selector);
        } catch {
          continue;
        }

        for (const match of Array.from(matches)) {
          if (
            seen.has(match) ||
            !isAriaVisible(match) ||
            isSidebarCallStatusElement(match)
          ) {
            continue;
          }
          seen.add(match);
          results.push(match);
        }
      }

      return results;
    };

    const queryVisibleContainers = (): Element[] =>
      queryVisibleElements(incomingCallSignalContainerSelectors);

    const findVisiblePatternMatch = (
      containers: Element[],
    ): { matchedPattern?: string; caller?: string; textSignal: boolean } => {
      for (const candidate of containers) {
        const text = String(candidate.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text || text.length > 400) {
          continue;
        }

        if (nonIncomingCallTextPatterns.some((pattern) => pattern.test(text))) {
          continue;
        }

        const classification = classifyCallPayload("", text);
        if (classification.isIncomingCall && !classification.usedTitleOnly) {
          return {
            textSignal: true,
            matchedPattern: classification.matchedPattern,
            caller: extractIncomingCallerName(text),
          };
        }
      }

      return { textSignal: false };
    };

    const getVisibleIncomingCallUiState = (): {
      source?: IncomingCallEvidenceSource;
      caller?: string;
      matchedPattern?: string;
      hasVisibleControls: boolean;
      hasVisibleContainer: boolean;
      selectorSignal: boolean;
      textSignal: boolean;
      titleSignal: boolean;
    } => {
      const visibleContainers = queryVisibleContainers();
      const hasVisibleContainer = visibleContainers.length > 0;
      const answerVisible =
        queryVisibleElements(incomingCallAnswerSelectors).length > 0;
      const declineVisible =
        queryVisibleElements(incomingCallDeclineSelectors).length > 0;
      const joinVisible =
        queryVisibleElements(incomingCallJoinSelectors).length > 0;
      const hasVisibleControls =
        (answerVisible && declineVisible) || (answerVisible && joinVisible);
      const visibleSoftSignals = queryVisibleElements(
        incomingCallSoftSignalSelectors,
      );
      const selectorSignal =
        hasVisibleContainer &&
        visibleSoftSignals.some((el) =>
          visibleContainers.some(
            (container) =>
              container === el ||
              container.contains(el) ||
              el.contains(container),
          ),
        );
      const textMatch = findVisiblePatternMatch(visibleContainers);
      const textSignal = textMatch.textSignal;
      const titleClassification = classifyCallPayload(document.title || "", "");
      const titleSignal =
        hasVisibleContainer &&
        titleClassification.isIncomingCall &&
        titleClassification.usedTitleOnly === true &&
        (selectorSignal || textSignal || hasVisibleControls);
      const caller =
        textMatch.caller ||
        (hasVisibleContainer
          ? extractIncomingCallerName(document.title || "")
          : undefined);

      if (hasVisibleControls) {
        return {
          source: "dom-explicit",
          caller,
          matchedPattern:
            textMatch.matchedPattern || titleClassification.matchedPattern,
          hasVisibleControls,
          hasVisibleContainer,
          selectorSignal,
          textSignal,
          titleSignal,
        };
      }

      if (
        hasVisibleContainer &&
        (selectorSignal || textSignal || titleSignal)
      ) {
        return {
          source: "dom-soft",
          caller,
          matchedPattern:
            textMatch.matchedPattern || titleClassification.matchedPattern,
          hasVisibleControls,
          hasVisibleContainer,
          selectorSignal,
          textSignal,
          titleSignal,
        };
      }

      return {
        hasVisibleControls,
        hasVisibleContainer,
        selectorSignal,
        textSignal,
        titleSignal,
      };
    };

    const buildIncomingCallPayload = (
      source: IncomingCallEvidenceSource,
      params: {
        caller?: string;
        matchedPattern?: string;
        hasVisibleControls: boolean;
        capturedAt?: number;
      },
    ): IncomingCallSignalPayload => {
      const route = normalizeConversationKey(window.location.pathname || "/");
      const dedupeKey = buildIncomingCallDedupeKey(route);
      const evidence = buildIncomingCallEvidence({
        source,
        caller: params.caller,
        dedupeKey,
        hasVisibleControls: params.hasVisibleControls,
        matchedPattern: params.matchedPattern,
        capturedAt: params.capturedAt,
        threadKey: route,
      });

      return {
        dedupeKey,
        caller: evidence.caller,
        source: evidence.source,
        recoveryActive: evidence.recoveryActive,
        evidence,
      };
    };

    const extractIncomingCallerFromVisibleUi = (): string | undefined => {
      const uiState = getVisibleIncomingCallUiState();
      return uiState.caller;
    };

    const hasVisibleIncomingCallUi = (): boolean =>
      Boolean(getVisibleIncomingCallUiState().source);

    const normalizeOverlayHintText = (value: string | null | undefined): string =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const isComposerOverlayElement = (element: Element | null): boolean => {
      if (!(element instanceof Element)) {
        return false;
      }

      const overlayRoot =
        element.matches?.(
          [
            "[role='dialog']",
            "[role='menu']",
            "[role='listbox']",
            "[role='grid']",
            "[aria-modal='true']",
            "[data-testid*='popover']",
            "[data-testid*='emoji']",
          ].join(", "),
        )
          ? element
          : element.closest(
              [
                "[role='dialog']",
                "[role='menu']",
                "[role='listbox']",
                "[role='grid']",
                "[aria-modal='true']",
                "[data-testid*='popover']",
                "[data-testid*='emoji']",
              ].join(", "),
            );
      if (!(overlayRoot instanceof Element)) {
        return false;
      }

      const label = normalizeOverlayHintText(
        `${overlayRoot.getAttribute("aria-label") || ""} ${
          overlayRoot.getAttribute("title") || ""
        } ${overlayRoot.textContent || ""}`.slice(0, 400),
      );
      if (/\b(emoji|emojis|sticker|stickers|gif|gifs|search emoji)\b/i.test(label)) {
        return true;
      }

      return Boolean(
        overlayRoot.querySelector(
          '[aria-label*="Search emoji" i], [placeholder*="Search emoji" i], [data-testid*="emoji"]',
        ),
      );
    };

    const exceedsCallPopupDescendantScanLimit = (
      element: Element,
      limit: number,
    ): boolean => {
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_ELEMENT,
      );
      let seen = 0;
      while (walker.nextNode()) {
        seen += 1;
        if (seen > limit) {
          return true;
        }
      }
      return false;
    };

    // Check if an element or its children contain call-related UI
    const isCallPopupElement = (element: Element): boolean => {
      if (isSidebarCallStatusElement(element)) {
        return false;
      }
      if (isComposerOverlayElement(element)) {
        return false;
      }

      // Check for call-related selectors
      for (const selector of callPopupSelectors) {
        try {
          if (element.matches?.(selector) && isAriaVisible(element)) {
            return true;
          }

          const matchedDescendants = element.querySelectorAll?.(selector);
          if (
            matchedDescendants &&
            Array.from(matchedDescendants).some((candidate) =>
              isAriaVisible(candidate),
            )
          ) {
            return true;
          }
        } catch {
          // Ignore invalid selector errors
        }
      }

      const visibleContainers = queryVisibleContainers();
      if (visibleContainers.length === 0) {
        return false;
      }

      if (
        visibleContainers.some(
          (container) =>
            container === element ||
            container.contains(element) ||
            element.contains(container),
        )
      ) {
        return Boolean(getVisibleIncomingCallUiState().source);
      }

      return false;
    };

    // Process added nodes to check for call popup
    const checkForCallPopup = (nodes: NodeList) => {
      const now = Date.now();
      if (now - lastCallSignalTime < CALL_SIGNAL_DEBOUNCE_MS) {
        return; // Debounce - don't check if we recently signaled
      }

      for (const node of Array.from(nodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const element = node as Element;
        if (isComposerOverlayElement(element)) {
          continue;
        }

        // Check if this element or its descendants indicate a call popup
        if (isCallPopupElement(element)) {
          const uiState = getVisibleIncomingCallUiState();
          if (!uiState.source) {
            continue;
          }
          log("Call popup detected in DOM - bringing window to foreground");
          markIncomingCallUiVisible(now);
          lastCallSignalTime = now;
          const payload = buildIncomingCallPayload(uiState.source, {
            caller: uiState.caller,
            matchedPattern: uiState.matchedPattern,
            hasVisibleControls: uiState.hasVisibleControls,
            capturedAt: now,
          });
          rememberIncomingCallEvidence(
            payload.evidence as IncomingCallEvidence,
          );
          signalIncomingCall(payload);
          return;
        }

        // Also check children for deeply nested call UI
        if (
          exceedsCallPopupDescendantScanLimit(
            element,
            MAX_CALL_POPUP_CHILD_COUNT,
          )
        ) {
          continue;
        }
        const descendants = element.querySelectorAll("*");
        for (const desc of Array.from(descendants)) {
          if (isComposerOverlayElement(desc)) {
            continue;
          }
          if (isCallPopupElement(desc)) {
            const uiState = getVisibleIncomingCallUiState();
            if (!uiState.source) {
              continue;
            }
            log(
              "Call popup detected in descendant - bringing window to foreground",
            );
            markIncomingCallUiVisible(now);
            lastCallSignalTime = now;
            const payload = buildIncomingCallPayload(uiState.source, {
              caller: uiState.caller,
              matchedPattern: uiState.matchedPattern,
              hasVisibleControls: uiState.hasVisibleControls,
              capturedAt: now,
            });
            rememberIncomingCallEvidence(
              payload.evidence as IncomingCallEvidence,
            );
            signalIncomingCall(payload);
            return;
          }
        }
      }
    };

    // Returns true when the element is not aria-hidden/hidden and is actually rendered.
    // Used to distinguish a visible call popup from pre-rendered hidden controls.
    const isAriaVisible = (el: Element | null): boolean => {
      if (!el) return false;
      if (el.closest('[aria-hidden="true"]') || el.closest("[hidden]")) {
        return false;
      }

      const target = el instanceof HTMLElement ? el : null;
      if (!target) return true;

      const style = window.getComputedStyle(target);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }

      const rect = target.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return false;
      }

      return true;
    };

    // Observe the entire document for call popup additions AND attribute changes
    // (Facebook sometimes reveals a pre-rendered overlay by toggling CSS classes).
    const callObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          checkForCallPopup(mutation.addedNodes);
        } else if (mutation.type === "attributes") {
          const changedEl = mutation.target as Element;
          if (changedEl.nodeType !== Node.ELEMENT_NODE) continue;
          if (isComposerOverlayElement(changedEl)) continue;
          const now = Date.now();
          if (now - lastCallSignalTime < CALL_SIGNAL_DEBOUNCE_MS) continue;
          // Throttle: class changes fire constantly in React — check at most twice/sec
          if (now - lastAttributeScanTime < ATTRIBUTE_SCAN_THROTTLE_MS)
            continue;
          lastAttributeScanTime = now;
          // Skip large containers to bound the cost of querySelector subtree walks
          if (
            changedEl.childElementCount <= MAX_CALL_POPUP_CHILD_COUNT &&
            isCallPopupElement(changedEl)
          ) {
            const uiState = getVisibleIncomingCallUiState();
            if (!uiState.source) {
              continue;
            }
            log("Call popup detected via attribute change");
            markIncomingCallUiVisible(now);
            lastCallSignalTime = now;
            const payload = buildIncomingCallPayload(uiState.source, {
              caller: uiState.caller,
              matchedPattern: uiState.matchedPattern,
              hasVisibleControls: uiState.hasVisibleControls,
              capturedAt: now,
            });
            rememberIncomingCallEvidence(
              payload.evidence as IncomingCallEvidence,
            );
            signalIncomingCall(payload);
          }
        }
      }
    });

    // Start observing after the page has settled (reduced from 3000ms)
    setTimeout(() => {
      callObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "aria-hidden"],
      });
      log("Call popup observer active");

      // Periodic fallback scan when the window is not focused.
      // Catches call popups revealed via mechanisms the MutationObserver may miss
      // (e.g. React portals, CSS-only show/hide not involving new DOM nodes).
      window.setInterval(() => {
        const now = Date.now();
        const uiState = getVisibleIncomingCallUiState();
        if (uiState.source) {
          markIncomingCallUiVisible(now);

          if (
            now - lastCallSignalTime >= CALL_SIGNAL_DEBOUNCE_MS &&
            !isWindowFocused()
          ) {
            const periodicScanEvidenceSource: IncomingCallEvidenceSource =
              uiState.hasVisibleControls ? "dom-explicit" : "periodic-scan";
            const payload = buildIncomingCallPayload(
              periodicScanEvidenceSource,
              {
                caller: uiState.caller,
                matchedPattern: uiState.matchedPattern,
                hasVisibleControls: uiState.hasVisibleControls,
                capturedAt: now,
              },
            );
            const promotion = shouldPromoteIncomingCallEvidence(
              payload.evidence as IncomingCallEvidence,
            );
            if (!promotion.shouldPromote) {
              emitIncomingCallDebug("incoming-call-periodic-scan-suppressed", {
                reason: promotion.reason,
                confidence: payload.evidence?.confidence,
                recoveryActive: payload.recoveryActive === true,
                url: window.location.href,
              });
              return;
            }
            log("Periodic scan: incoming call UI detected");
            lastCallSignalTime = now;
            rememberIncomingCallEvidence(
              payload.evidence as IncomingCallEvidence,
            );
            signalIncomingCall(payload);
          }
          return;
        }

        if (!hasActiveIncomingCallUi || !confirmedVisibleIncomingCallUi) {
          return;
        }

        if (now - lastIncomingCallUiSeenAt < CALL_END_GRACE_MS) {
          return;
        }

        if (missingIncomingCallUiSince === null) {
          missingIncomingCallUiSince = now;
          return;
        }

        if (now - missingIncomingCallUiSince < CALL_END_CONFIRMATION_MS) {
          return;
        }

        hasActiveIncomingCallUi = false;
        confirmedVisibleIncomingCallUi = false;
        lastIncomingCallUiSeenAt = 0;
        missingIncomingCallUiSince = null;
        signalIncomingCallEnded("controls-disappeared");
      }, 5000);
    }, 1000);
  };

  setupCallPopupObserver();

  // ============================================================================
  // KEYBOARD SHORTCUTS & QUICK SWITCHER
  // ============================================================================

  // Get all conversation rows from sidebar (raw, may include empty rows)
  const getAllConversationRows = (): Element[] => {
    const sidebar = findSidebarElement();
    if (!sidebar) return [];
    return Array.from(sidebar.querySelectorAll(selectors.conversationRow));
  };

  // Get only valid chat rows (rows with actual conversation links)
  type ValidChatRow = {
    row: Element;
    link: HTMLAnchorElement;
    threadId: string;
  };

  const isConversationRowVisible = (row: Element): boolean => {
    if (!(row instanceof HTMLElement)) {
      return false;
    }

    if (row.closest('[aria-hidden="true"]') || row.closest("[hidden]")) {
      return false;
    }

    const style = window.getComputedStyle(row);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      style.pointerEvents === "none"
    ) {
      return false;
    }

    const rect = row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getConversationLink = (row: Element): HTMLAnchorElement | null => {
    const link = row.querySelector('a[href*="/t/"], a[href*="/e2ee/t/"]');
    return link instanceof HTMLAnchorElement ? link : null;
  };

  const getValidChatRows = (): {
    row: Element;
    link: HTMLAnchorElement;
    threadId: string;
  }[] => {
    const rows = getAllConversationRows();
    const valid: ValidChatRow[] = [];
    const seenThreadIds = new Set<string>();

    for (const row of rows) {
      if (!isConversationRowVisible(row)) continue;

      const link = getConversationLink(row);
      const threadId = getThreadIdFromHref(link?.getAttribute("href"));
      if (!link || !threadId || seenThreadIds.has(threadId)) continue;

      seenThreadIds.add(threadId);
      valid.push({ row, link, threadId });
    }
    return valid;
  };

  // Click on a conversation link
  const clickConversation = (link: HTMLAnchorElement): void => {
    link.click();
  };

  // Navigate to nth chat (1-indexed)
  const navigateToChat = (index: number): void => {
    const chats = getValidChatRows();
    if (index >= 1 && index <= chats.length) {
      clickConversation(chats[index - 1].link);
      log(`Navigated to chat ${index}`);
    }
  };

  const isConversationRowActive = (row: Element): boolean => {
    const activeSelector = [
      '[aria-current="page"]',
      '[aria-current="true"]',
      '[aria-selected="true"]',
    ].join(", ");

    return row.matches(activeSelector) || row.querySelector(activeSelector) !== null;
  };

  // Get currently active conversation index
  const getCurrentChatIndex = (): number => {
    const chats = getValidChatRows();
    const currentThreadId = getThreadIdFromHref(window.location.href);

    if (currentThreadId) {
      for (let i = 0; i < chats.length; i++) {
        if (chats[i].threadId === currentThreadId) {
          return i;
        }
      }
    }

    for (let i = 0; i < chats.length; i++) {
      if (isConversationRowActive(chats[i].row)) {
        return i;
      }
    }

    return -1;
  };

  const getFallbackChatIndex = (
    chats: ValidChatRow[],
    direction: "next" | "prev",
  ): number => {
    if (chats.length === 0) {
      return -1;
    }

    const currentThreadId = getThreadIdFromHref(window.location.href);
    let fallbackIndex = -1;

    if (direction === "next") {
      fallbackIndex = chats.findIndex((chat) => chat.threadId !== currentThreadId);
    } else {
      for (let i = chats.length - 1; i >= 0; i--) {
        if (chats[i].threadId !== currentThreadId) {
          fallbackIndex = i;
          break;
        }
      }
    }

    if (fallbackIndex >= 0) {
      return fallbackIndex;
    }

    return direction === "next" ? 0 : chats.length - 1;
  };

  // Navigate to previous chat (up in sidebar)
  const navigateToPrevChat = (): void => {
    const chats = getValidChatRows();
    if (chats.length === 0) {
      log("No conversation rows found");
      return;
    }

    const currentIndex = getCurrentChatIndex();
    const newIndex =
      currentIndex >= 0
        ? currentIndex <= 0
          ? chats.length - 1
          : currentIndex - 1
        : getFallbackChatIndex(chats, "prev");
    log(
      `Prev chat: current=${currentIndex}, new=${newIndex}, total=${chats.length}`,
    );
    clickConversation(chats[newIndex].link);
  };

  // Navigate to next chat (down in sidebar)
  const navigateToNextChat = (): void => {
    const chats = getValidChatRows();
    if (chats.length === 0) {
      log("No conversation rows found");
      return;
    }

    const currentIndex = getCurrentChatIndex();
    const newIndex =
      currentIndex >= 0
        ? currentIndex >= chats.length - 1
          ? 0
          : currentIndex + 1
        : getFallbackChatIndex(chats, "next");
    log(
      `Next chat: current=${currentIndex}, new=${newIndex}, total=${chats.length}`,
    );
    clickConversation(chats[newIndex].link);
  };

  // ============================================================================
  // THEME DETECTION
  // ============================================================================

  interface ThemeColors {
    backdrop: string;
    background: string;
    backgroundHover: string;
    border: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    kbd: string;
    shadow: string;
  }

  const darkTheme: ThemeColors = {
    backdrop: "rgba(0, 0, 0, 0.7)",
    background: "#242526",
    backgroundHover: "#3a3b3c",
    border: "#3a3b3c",
    text: "#e4e6eb",
    textSecondary: "#ffffff",
    textMuted: "#8a8d91",
    kbd: "#3a3b3c",
    shadow: "0 8px 32px rgba(0,0,0,0.4)",
  };

  const lightTheme: ThemeColors = {
    backdrop: "rgba(0, 0, 0, 0.4)",
    background: "#ffffff",
    backgroundHover: "#f0f2f5",
    border: "#dddfe2",
    text: "#050505",
    textSecondary: "#1c1e21",
    textMuted: "#65676b",
    kbd: "#e4e6eb",
    shadow: "0 8px 32px rgba(0,0,0,0.15)",
  };

  const detectTheme = (): ThemeColors => {
    // Check for Facebook's dark mode class
    if (
      document.documentElement.classList.contains("__fb-dark-mode") ||
      document.body.classList.contains("__fb-dark-mode")
    ) {
      return darkTheme;
    }

    // Check for light mode class
    if (
      document.documentElement.classList.contains("__fb-light-mode") ||
      document.body.classList.contains("__fb-light-mode")
    ) {
      return lightTheme;
    }

    // Fallback: detect by background color luminance
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5 ? darkTheme : lightTheme;
    }

    // Default to dark theme
    return darkTheme;
  };

  // ============================================================================
  // KEYBOARD SHORTCUTS OVERLAY
  // ============================================================================

  let shortcutsOverlay: HTMLElement | null = null;

  // Detect if running on macOS (in renderer process)
  const isMacOS = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const modKey = isMacOS ? "⌘" : "Ctrl";

  const getShortcutsHTML = (theme: ThemeColors): string => `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: ${theme.backdrop};
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    " data-shortcuts-backdrop>
      <div style="
        background: ${theme.background};
        border-radius: 12px;
        padding: 24px 32px;
        min-width: 380px;
        color: ${theme.text};
        box-shadow: ${theme.shadow};
      ">
        <h2 style="margin: 0 0 20px 0; font-size: 20px; font-weight: 600; color: ${theme.textSecondary};">
          Keyboard Shortcuts
        </h2>
        <div style="display: grid; gap: 12px;">
          <div style="border-bottom: 1px solid ${theme.border}; padding-bottom: 12px;">
            <div style="color: ${theme.textMuted}; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;">Navigation</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; gap: 24px;">
              <span>Jump to chat 1-9</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + 1-9</kbd>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; gap: 24px;">
              <span>Previous chat</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + Shift + [</kbd>
            </div>
            <div style="display: flex; justify-content: space-between; gap: 24px;">
              <span>Next chat</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + Shift + ]</kbd>
            </div>
          </div>
          <div style="border-bottom: 1px solid ${theme.border}; padding-bottom: 12px;">
            <div style="color: ${theme.textMuted}; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;">Quick Actions</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; gap: 24px;">
              <span>Quick switcher</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + O</kbd>
            </div>
            <div style="display: flex; justify-content: space-between; gap: 24px;">
              <span>Show this help</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + /</kbd>
            </div>
          </div>
        </div>
        <div style="margin-top: 16px; text-align: center; color: ${theme.textMuted}; font-size: 13px;">
          Press <kbd style="background: ${theme.kbd}; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Esc</kbd> or click outside to close
        </div>
      </div>
    </div>
  `;

  const showShortcutsOverlay = (): void => {
    if (shortcutsOverlay) {
      hideShortcutsOverlay();
      return;
    }

    const theme = detectTheme();
    const div = document.createElement("div");
    div.innerHTML = getShortcutsHTML(theme);
    shortcutsOverlay = div.firstElementChild as HTMLElement;
    document.body.appendChild(shortcutsOverlay);

    // Close on backdrop click
    shortcutsOverlay.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).hasAttribute("data-shortcuts-backdrop")) {
        hideShortcutsOverlay();
      }
    });

    log("Shortcuts overlay shown");
  };

  const hideShortcutsOverlay = (): void => {
    if (shortcutsOverlay) {
      shortcutsOverlay.remove();
      shortcutsOverlay = null;
      log("Shortcuts overlay hidden");
    }
  };

  // ============================================================================
  // NAME CACHE - Learn real names from conversation avatars
  // ============================================================================

  const NAME_CACHE_KEY = "messenger-desktop-name-cache";
  type NameCache = Record<string, { realNames: string[]; updatedAt: number }>;

  const loadNameCache = (): NameCache => {
    try {
      const data = localStorage.getItem(NAME_CACHE_KEY);
      if (!data) return {};
      const parsed = JSON.parse(data);
      // Migrate old format (realName: string) to new format (realNames: string[])
      for (const key of Object.keys(parsed)) {
        if (typeof parsed[key].realName === "string") {
          parsed[key] = {
            realNames: [parsed[key].realName],
            updatedAt: parsed[key].updatedAt,
          };
        }
      }
      return parsed;
    } catch {
      return {};
    }
  };

  const saveNameCache = (cache: NameCache): void => {
    try {
      localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* ignore */
    }
  };

  const nameCache = loadNameCache();

  type NotificationDisplayPolicyApi = {
    isGenericNotificationDisplayName?: (
      value: string | null | undefined,
    ) => boolean;
    formatNotificationDisplayTitle?: (input: {
      title: string;
      alternateNames?: Array<string | null | undefined>;
      maxAlternateNames?: number;
    }) => string;
  };

  const getNotificationDisplayPolicy =
    (): NotificationDisplayPolicyApi | null => {
      const policy = (globalThis as typeof globalThis & {
        __mdNotificationDisplayPolicy?: NotificationDisplayPolicyApi;
      }).__mdNotificationDisplayPolicy;
      if (!policy || typeof policy !== "object") {
        return null;
      }
      return policy;
    };

  const getThreadIdFromHref = (href: string | null | undefined): string | null => {
    const normalizedHref = String(href || "");
    if (!normalizedHref) return null;

    const match = normalizedHref.match(/\/(?:messages\/(?:e2ee\/)?t|t)\/(\d+)/i);
    return match?.[1] || null;
  };

  const getCachedRealNamesForNotification = (
    href: string | null | undefined,
    displayTitle: string,
  ): string[] => {
    const threadId = getThreadIdFromHref(href);
    if (!threadId) return [];

    const cached = nameCache[threadId];
    if (!cached?.realNames?.length) return [];

    const normalizedTitle = displayTitle.toLowerCase();
    return cached.realNames.filter((name) => name.toLowerCase() !== normalizedTitle);
  };

  const formatNotificationConversationTitle = (input: {
    title: string;
    href?: string;
    alternateTitle?: string | null;
  }): string => {
    const displayTitle = String(input.title || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!displayTitle) return "";

    const policy = getNotificationDisplayPolicy();
    const alternateNames = [
      input.alternateTitle,
      ...getCachedRealNamesForNotification(input.href, displayTitle),
    ];

    if (typeof policy?.formatNotificationDisplayTitle === "function") {
      return policy.formatNotificationDisplayTitle({
        title: displayTitle,
        alternateNames,
        maxAlternateNames: 2,
      });
    }

    return displayTitle;
  };

  // Extract all real names from avatar alts in current conversation
  const extractRealNamesFromConversation = (): string[] => {
    const mainArea = document.querySelector('[role="main"]');
    if (!mainArea) return [];

    const imgs = Array.from(mainArea.querySelectorAll("img[alt]"));
    const names: string[] = [];
    const seen: Record<string, boolean> = {};

    for (let i = 0; i < imgs.length; i++) {
      const alt = imgs[i].getAttribute("alt") || "";
      if (alt.length < 3 || alt.length > 50) continue;
      if (alt.startsWith("Seen by")) continue;
      if (alt.startsWith("Open ")) continue; // "Open photo" etc
      if (alt.startsWith("Original ")) continue; // "Original image"
      if (["GIF", "Sticker", "Photo", "Video"].includes(alt)) continue;
      // Skip emoji-only alts
      if (/^[\p{Emoji}\s]+$/u.test(alt)) continue;

      if (!seen[alt]) {
        seen[alt] = true;
        names.push(alt);
      }
    }
    return names;
  };

  // Update cache when viewing a conversation
  const updateNameCache = (): void => {
    const match = window.location.pathname.match(/\/t\/(\d+)/);
    if (!match) return;
    const threadId = match[1];

    const realNames = extractRealNamesFromConversation();
    if (realNames.length === 0) return;

    // Check if different from what we have
    const existing = nameCache[threadId];
    const namesChanged =
      !existing ||
      existing.realNames.length !== realNames.length ||
      existing.realNames.some((n, i) => n !== realNames[i]);

    if (namesChanged) {
      nameCache[threadId] = { realNames, updatedAt: Date.now() };
      saveNameCache(nameCache);
      log(`Name cache: thread ${threadId} -> [${realNames.join(", ")}]`);
    }
  };

  // Monitor for conversation changes with retry for slow-loading conversations
  let lastCheckedPath = "";
  setInterval(() => {
    if (window.location.pathname !== lastCheckedPath) {
      lastCheckedPath = window.location.pathname;
      // Try multiple times as conversation may load slowly
      const tryExtract = (attempt: number) => {
        updateNameCache();
        // Retry up to 5 times if no names found yet (covers ~8 seconds total)
        const match = window.location.pathname.match(/\/t\/(\d+)/);
        if (match && attempt < 5) {
          const threadId = match[1];
          if (
            !nameCache[threadId] ||
            nameCache[threadId].realNames.length === 0
          ) {
            setTimeout(() => tryExtract(attempt + 1), 1500);
          }
        }
      };
      setTimeout(() => tryExtract(0), 500); // Initial delay shorter
    }
  }, 500);

  // ============================================================================
  // QUICK SWITCHER
  // ============================================================================

  let commandPaletteEl: HTMLElement | null = null;
  let paletteInputEl: HTMLInputElement | null = null;
  let paletteResultsEl: HTMLElement | null = null;
  let paletteSelectedIndex = 0;
  let paletteContacts: {
    name: string;
    realNames?: string[];
    threadId?: string;
    row: Element;
  }[] = [];

  // Simple fuzzy match: check if query chars appear in order
  const fuzzyMatch = (
    query: string,
    text: string,
  ): { match: boolean; score: number } => {
    const q = query.toLowerCase();
    const t = text.toLowerCase();

    if (t.includes(q)) {
      return { match: true, score: t.indexOf(q) === 0 ? 100 : 50 };
    }

    let qi = 0;
    let score = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += ti === 0 || t[ti - 1] === " " ? 10 : 5;
        qi++;
      }
    }

    return { match: qi === q.length, score };
  };

  // Match against both nickname and real names (supports multiple for groups)
  const fuzzyMatchContact = (
    query: string,
    contact: { name: string; realNames?: string[] },
  ): { match: boolean; score: number } => {
    const nicknameMatch = fuzzyMatch(query, contact.name);
    let bestScore = nicknameMatch.score;
    let matched = nicknameMatch.match;

    if (contact.realNames) {
      for (const realName of contact.realNames) {
        const realNameMatch = fuzzyMatch(query, realName);
        if (realNameMatch.match && realNameMatch.score > bestScore) {
          bestScore = realNameMatch.score + 10; // Boost real name matches
          matched = true;
        }
      }
    }
    return { match: matched, score: bestScore };
  };

  // Extract contacts from sidebar with cached real names
  const extractContacts = (): {
    name: string;
    realNames?: string[];
    threadId?: string;
    row: Element;
  }[] => {
    const rows = getAllConversationRows();
    const contacts: {
      name: string;
      realNames?: string[];
      threadId?: string;
      row: Element;
    }[] = [];

    for (const row of rows) {
      const info = extractConversationInfo(row);
      if (info?.title) {
        // Get thread ID from href
        const match = info.href.match(/\/t\/(\d+)/);
        const threadId = match ? match[1] : undefined;

        // Look up real names from cache
        const cached = threadId ? nameCache[threadId] : undefined;
        // Only include if at least one real name differs from the display name
        const realNames = cached?.realNames?.filter((n) => n !== info.title);

        contacts.push({
          name: info.title,
          realNames: realNames && realNames.length > 0 ? realNames : undefined,
          threadId,
          row,
        });
      }
    }

    return contacts;
  };

  const getPaletteStyles = (theme: ThemeColors): string => `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    width: 400px;
    max-width: 90vw;
    background: ${theme.background};
    border-radius: 12px;
    box-shadow: ${theme.shadow};
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden;
  `;

  let currentPaletteTheme: ThemeColors = darkTheme;

  const showCommandPalette = (): void => {
    if (commandPaletteEl) {
      hideCommandPalette();
      return;
    }

    currentPaletteTheme = detectTheme();
    paletteContacts = extractContacts();
    paletteSelectedIndex = 0;

    const div = document.createElement("div");
    div.style.cssText = getPaletteStyles(currentPaletteTheme);
    div.innerHTML = `
      <div style="padding: 12px;">
        <input type="text" placeholder="Search conversations..." style="
          width: 100%;
          background: ${currentPaletteTheme.backgroundHover};
          border: none;
          border-radius: 8px;
          padding: 12px 16px;
          font-size: 15px;
          color: ${currentPaletteTheme.text};
          outline: none;
          box-sizing: border-box;
        " data-palette-input>
      </div>
      <div style="max-height: 320px; overflow-y: auto;" data-palette-results></div>
    `;

    commandPaletteEl = div;
    paletteInputEl = div.querySelector(
      "[data-palette-input]",
    ) as HTMLInputElement;
    paletteResultsEl = div.querySelector(
      "[data-palette-results]",
    ) as HTMLElement;

    document.body.appendChild(commandPaletteEl);
    paletteInputEl.focus();

    // Show all contacts initially
    updatePaletteResults("");

    // Handle input
    paletteInputEl.addEventListener("input", () => {
      paletteSelectedIndex = 0;
      updatePaletteResults(paletteInputEl!.value);
    });

    // Handle keyboard navigation
    paletteInputEl.addEventListener("keydown", (e) => {
      const items =
        paletteResultsEl?.querySelectorAll("[data-palette-item]") || [];

      if (e.key === "ArrowDown") {
        e.preventDefault();
        paletteSelectedIndex = Math.min(
          paletteSelectedIndex + 1,
          items.length - 1,
        );
        updatePaletteSelection();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
        updatePaletteSelection();
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectPaletteItem(paletteSelectedIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideCommandPalette();
      }
    });

    log("Quick switcher shown");
  };

  const hideCommandPalette = (): void => {
    if (commandPaletteEl) {
      commandPaletteEl.remove();
      commandPaletteEl = null;
      paletteInputEl = null;
      paletteResultsEl = null;
      paletteContacts = [];
      log("Quick switcher hidden");
    }
  };

  const updatePaletteResults = (query: string): void => {
    if (!paletteResultsEl) return;

    let results: {
      name: string;
      realNames?: string[];
      threadId?: string;
      row: Element;
      score: number;
    }[];

    if (!query.trim()) {
      // Show first 10 contacts
      results = paletteContacts
        .slice(0, 10)
        .map((c, i) => ({ ...c, score: 100 - i }));
    } else {
      // Fuzzy search - match against both nickname and real names
      results = paletteContacts
        .map((c) => {
          const { match, score } = fuzzyMatchContact(query, c);
          return { ...c, score, match };
        })
        .filter((c) => c.match)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }

    if (results.length === 0) {
      paletteResultsEl.innerHTML = `
        <div style="padding: 24px; text-align: center; color: ${currentPaletteTheme.textMuted};">
          No conversations found
        </div>
      `;
      return;
    }

    // Format display name: show "Nickname (Real Name, Real Name, ...)" if different
    const formatDisplayName = (c: {
      name: string;
      realNames?: string[];
    }): string => {
      if (c.realNames && c.realNames.length > 0) {
        const namesStr = c.realNames.map((n) => escapeHtml(n)).join(", ");
        return `${escapeHtml(c.name)} <span style="color: ${currentPaletteTheme.textMuted};">(${namesStr})</span>`;
      }
      return escapeHtml(c.name);
    };

    paletteResultsEl.innerHTML = results
      .map(
        (r, i) => `
      <div data-palette-item="${i}" style="
        padding: 10px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 12px;
        background: ${i === paletteSelectedIndex ? currentPaletteTheme.backgroundHover : "transparent"};
        color: ${currentPaletteTheme.text};
      ">
        <div style="
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: #0084ff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 14px;
          color: white;
        ">${(r.realNames?.[0] || r.name).charAt(0).toUpperCase()}</div>
        <span style="font-size: 15px;">${formatDisplayName(r)}</span>
      </div>
    `,
      )
      .join("");

    // Add click handlers
    paletteResultsEl.querySelectorAll("[data-palette-item]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-palette-item") || "0", 10);
        selectPaletteItem(idx);
      });
      el.addEventListener("mouseenter", () => {
        const idx = parseInt(el.getAttribute("data-palette-item") || "0", 10);
        paletteSelectedIndex = idx;
        updatePaletteSelection();
      });
    });
  };

  const updatePaletteSelection = (): void => {
    if (!paletteResultsEl) return;
    paletteResultsEl
      .querySelectorAll("[data-palette-item]")
      .forEach((el, i) => {
        (el as HTMLElement).style.background =
          i === paletteSelectedIndex
            ? currentPaletteTheme.backgroundHover
            : "transparent";
      });
  };

  const selectPaletteItem = (index: number): void => {
    const query = paletteInputEl?.value.trim() || "";
    let results: { name: string; realNames?: string[]; row: Element }[];

    if (!query) {
      results = paletteContacts.slice(0, 10);
    } else {
      // Use fuzzyMatchContact to match both nickname and real names (same as updatePaletteResults)
      results = paletteContacts
        .map((c) => ({ ...c, ...fuzzyMatchContact(query, c) }))
        .filter((c) => c.match)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }

    if (results[index]) {
      const link = results[index].row.querySelector(
        'a[href*="/t/"]',
      ) as HTMLAnchorElement | null;
      if (link) {
        clickConversation(link);
      }
      hideCommandPalette();
    }
  };

  // HTML escape helper
  const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };

  // ============================================================================
  // GLOBAL KEYBOARD LISTENER
  // ============================================================================

  const hasPrimaryModifier = (e: KeyboardEvent): boolean =>
    (e.metaKey || e.ctrlKey) && !e.altKey;

  const matchesHelpShortcut = (e: KeyboardEvent): boolean =>
    hasPrimaryModifier(e) &&
    (e.code === "Slash" || e.key === "/" || e.key === "?");

  const matchesQuickSwitcherShortcut = (e: KeyboardEvent): boolean =>
    hasPrimaryModifier(e) &&
    !e.shiftKey &&
    (e.code === "KeyO" || e.key.toLowerCase() === "o");

  const getChatJumpIndex = (e: KeyboardEvent): number | null => {
    if (!hasPrimaryModifier(e) || e.shiftKey) {
      return null;
    }

    if (/^Digit[1-9]$/.test(e.code)) {
      return parseInt(e.code.slice("Digit".length), 10);
    }

    if (/^[1-9]$/.test(e.key)) {
      return parseInt(e.key, 10);
    }

    return null;
  };

  const matchesPrevChatShortcut = (e: KeyboardEvent): boolean =>
    hasPrimaryModifier(e) &&
    e.shiftKey &&
    (e.code === "BracketLeft" || e.key === "[" || e.key === "{");

  const matchesNextChatShortcut = (e: KeyboardEvent): boolean =>
    hasPrimaryModifier(e) &&
    e.shiftKey &&
    (e.code === "BracketRight" || e.key === "]" || e.key === "}");

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      // Close overlays on Escape
      if (e.key === "Escape") {
        if (shortcutsOverlay) {
          hideShortcutsOverlay();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (commandPaletteEl) {
          hideCommandPalette();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Don't handle shortcuts if typing in a form input (but allow contentEditable for chat nav)
      const target = e.target instanceof HTMLElement ? e.target : null;
      const isInFormInput =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      // Allow palette keyboard nav
      if (commandPaletteEl && target === paletteInputEl) {
        return; // Let palette handle its own keyboard events
      }

      // Cmd/Ctrl + O → Quick switcher (works everywhere)
      if (matchesQuickSwitcherShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        showCommandPalette();
        return;
      }

      // Cmd/Ctrl + / → Shortcuts help (works everywhere)
      if (matchesHelpShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        showShortcutsOverlay();
        return;
      }

      // Skip navigation shortcuts if in form input (but allow in contentEditable message box)
      if (isInFormInput) return;

      // Cmd/Ctrl + 1-9 → Jump to chat
      const chatJumpIndex = getChatJumpIndex(e);
      if (chatJumpIndex !== null) {
        e.preventDefault();
        e.stopPropagation();
        navigateToChat(chatJumpIndex);
        return;
      }

      // Cmd/Ctrl + Shift + [ or { → Previous chat (use e.code for physical key)
      if (matchesPrevChatShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        navigateToPrevChat();
        return;
      }

      // Cmd/Ctrl + Shift + ] or } → Next chat (use e.code for physical key)
      if (matchesNextChatShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        navigateToNextChat();
        return;
      }
    },
    true,
  ); // Use capture to get events before Messenger

  // Listen for menu-triggered shortcuts overlay
  document.addEventListener("show-keyboard-shortcuts", () => {
    showShortcutsOverlay();
  });

  log("Keyboard shortcuts initialized");

  log("Initialization complete");
})(window, Notification);
