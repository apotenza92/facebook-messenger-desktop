import { contextBridge, ipcRenderer } from "electron";
import {
  MessagesViewportMode,
  resolveMediaViewerStateVisible,
  resolveViewportMode,
  shouldApplyMessagesCrop,
  shouldTreatDetectedMediaOverlayAsVisible,
  shouldKeepMediaViewerBannerHiddenDuringLoadingWindow,
  shouldHideMediaViewerBannerWhileLoading,
} from "./messages-viewport-policy";
import {
  getIncomingCallHintClearReason,
  shouldActivateIncomingCallHint,
  shouldKeepIncomingCallHintActive,
  shouldTreatIncomingCallUiAsVisible,
} from "./incoming-call-overlay-hint-policy";

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

const incomingCallTextPatterns = [
  /\bis\s+calling\b/i,
  /\bcalling\s+you\b/i,
  /\bincoming\s+(?:video\s+|audio\s+)?call\b/i,
  /\bwants\s+to\s+(?:video\s+)?call\b/i,
  /\bjoin\s+(?:the\s+)?(?:video\s+|audio\s+)?call\b/i,
  /\b(?:video|audio)\s+call\s+(?:has\s+)?started\b/i,
];

const nonIncomingCallTextPatterns = [
  /\bongoing call\b/i,
  /\byou started (?:an? )?(?:video\s+|audio\s+)?call\b/i,
  /\bstarted (?:an? )?(?:video\s+|audio\s+)?call\b/i,
  /\bjoined (?:the\s+)?(?:video\s+|audio\s+)?call\b/i,
  /\bcall ended\b/i,
  /\bmissed (?:video\s+|audio\s+)?call\b/i,
  /\bcall cancel(?:ed|led)\b/i,
  /\banswered (?:on|with) another device\b/i,
  /\banswered elsewhere\b/i,
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

function isSidebarCallStatusElement(el: Element): boolean {
  return (
    incomingCallSidebarExclusionSelectors.some(
      (selector) => el.closest(selector) !== null,
    ) || /\bongoing call\b/i.test(String(el.textContent || ""))
  );
}

function queryVisibleElements(
  selectors: string[],
  isVisible: (el: Element | null) => boolean,
): Element[] {
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
        !isVisible(match) ||
        isSidebarCallStatusElement(match)
      ) {
        continue;
      }
      seen.add(match);
      results.push(match);
    }
  }

  return results;
}

function hasIncomingCallTitleSignal(title: string): boolean {
  const normalizedTitle = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedTitle) return false;
  if (
    nonIncomingCallTextPatterns.some((pattern) => pattern.test(normalizedTitle))
  ) {
    return false;
  }
  return incomingCallTextPatterns.some((pattern) =>
    pattern.test(normalizedTitle),
  );
}

function hasVisibleIncomingCallContainer(
  isVisible: (el: Element | null) => boolean,
): boolean {
  return (
    queryVisibleElements(incomingCallSignalContainerSelectors, isVisible)
      .length > 0
  );
}

function hasIncomingCallTextSignal(
  isVisible: (el: Element | null) => boolean,
): boolean {
  const candidates = queryVisibleElements(
    incomingCallSignalContainerSelectors,
    isVisible,
  );

  for (const candidate of candidates) {
    const text = String(candidate.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > 400) {
      continue;
    }

    if (nonIncomingCallTextPatterns.some((pattern) => pattern.test(text))) {
      continue;
    }

    if (incomingCallTextPatterns.some((pattern) => pattern.test(text))) {
      return true;
    }
  }

  return false;
}

function detectIncomingCallUiVisible(
  isVisible: (el: Element | null) => boolean,
): boolean {
  const hasVisibleContainer = hasVisibleIncomingCallContainer(isVisible);
  const answerVisible =
    queryVisibleElements(incomingCallAnswerSelectors, isVisible).length > 0;
  const declineVisible =
    queryVisibleElements(incomingCallDeclineSelectors, isVisible).length > 0;
  const joinVisible =
    queryVisibleElements(incomingCallJoinSelectors, isVisible).length > 0;
  const selectorSignal =
    queryVisibleElements(incomingCallSoftSignalSelectors, isVisible).length >
      0 && hasVisibleContainer;
  const textSignal = hasIncomingCallTextSignal(isVisible);
  const titleSignal =
    hasIncomingCallTitleSignal(document.title) &&
    hasVisibleContainer &&
    (selectorSignal ||
      textSignal ||
      answerVisible ||
      declineVisible ||
      joinVisible);

  return shouldTreatIncomingCallUiAsVisible({
    answerVisible,
    declineVisible,
    joinVisible,
    titleSignal,
    selectorSignal,
    textSignal,
  });
}

function sendIncomingCallOverlayHint(visible: boolean, reason: string): void {
  ipcRenderer.send("incoming-call-overlay-hint", { visible, reason });
  try {
    window.postMessage(
      { type: "md-incoming-call-overlay-hint", visible, reason },
      "*",
    );
  } catch {
    // Ignore postMessage failures
  }
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Notification API override (legacy - kept for compatibility)
  showNotification: (data: {
    title: string;
    body: string;
    icon?: string;
    tag?: string;
    silent?: boolean;
  }) => {
    ipcRenderer.send("show-notification", data);
  },

  // Unread count updates
  updateUnreadCount: (count: number) => {
    console.log(`[Preload] Sending update-unread-count: ${count}`);
    ipcRenderer.send("update-unread-count", count);
  },

  // Clear badge
  clearBadge: () => {
    ipcRenderer.send("clear-badge");
  },

  // Incoming call - bring window to foreground
  incomingCall: () => {
    console.log("[Preload] Sending incoming-call signal");
    ipcRenderer.send("incoming-call");
  },

  // Notification actions
  onNotificationAction: (callback: (action: string, data: any) => void) => {
    ipcRenderer.on("notification-action-handler", (event, action, data) => {
      callback(action, data);
    });
  },

  // Test notification (for testing)
  testNotification: () => {
    ipcRenderer.send("test-notification");
  },

  // Menu bar hover tracking
  sendMousePosition: (y: number) => {
    ipcRenderer.send("mouse-position", y);
  },
});

// Forward power/sleep state changes to page context
ipcRenderer.on(
  "power-state",
  (_event, data: { state: string; timestamp: number }) => {
    try {
      window.postMessage({ type: "electron-power-state", data }, "*");
    } catch {
      // Ignore postMessage failures
    }
  },
);

// BrowserView bounds crop removes the Facebook top bar; this keeps the messages
// app root tall enough so we don't expose a blank bottom gap on some layouts.
(function setupMessagesViewportCompensation() {
  const isDesktop =
    process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux";
  if (!isDesktop) return;

  const STYLE_ID = "md-fb-messages-viewport-fix-style";
  const ACTIVE_CLASS = "md-fb-messages-viewport-fix";
  const MEDIA_CLEAN_CLASS = "md-fb-media-viewer-clean";
  const MEDIA_LOADING_CLASS = "md-fb-media-viewer-loading";
  const INCOMING_CALL_CLEAN_CLASS = "md-fb-incoming-call-clean";
  const MEDIA_LEFT_DISMISS_CLASS = "md-fb-media-dismiss-left";
  const MEDIA_CLOSE_ACTION_CLASS = "md-fb-media-action-close";
  const MEDIA_DOWNLOAD_ACTION_CLASS = "md-fb-media-action-download";
  const MEDIA_SHARE_ACTION_CLASS = "md-fb-media-action-share";
  const MEDIA_FALLBACK_CONTROLS_ID = "md-fb-media-fallback-controls";
  const MEDIA_FALLBACK_BUTTON_CLASS = "md-fb-media-fallback-button";
  const MEDIA_FALLBACK_CONTROL_ATTR = "data-md-fb-fallback-control";
  const HEADER_HEIGHT_CSS_VAR = "--md-fb-header-height";
  const DEFAULT_HEADER_HEIGHT = 56;
  const MIN_HEADER_HEIGHT = DEFAULT_HEADER_HEIGHT;
  const MAX_HEADER_HEIGHT = 120;
  const HEADER_SEND_DEBOUNCE_MS = 120;
  const MEDIA_OVERLAY_TRANSITION_MS = 50;
  const VIEWPORT_STATE_SEND_DEBOUNCE_MS = 30;
  const NON_DRAG_APP_REGION = "no-drag";
  const MEDIA_ACTION_TOP_OFFSET = 8;
  const MEDIA_ACTION_CLOSE_LEFT_OFFSET = 16;
  const MAX_ACTION_NODE_DIMENSION = 160;
  const MEDIA_OVERLAY_DEBUG_CHANNEL = "media-overlay-debug";
  const MEDIA_OVERLAY_DEBUG_COOLDOWN_MS = 120;

  type AriaSelectorMatcher =
    | { type: "exact"; value: string }
    | { type: "contains"; value: string };

  const buildActionSelectors = (matchers: AriaSelectorMatcher[]): string[] => {
    const selectors = new Set<string>();
    const targets = ['[role="button"]', "button", "a[href]"];

    for (const matcher of matchers) {
      const attribute =
        matcher.type === "exact"
          ? `[aria-label="${matcher.value}" i]`
          : `[aria-label*="${matcher.value}" i]`;

      selectors.add(attribute);
      for (const target of targets) {
        selectors.add(`${target}${attribute}`);
      }
    }

    return Array.from(selectors);
  };

  const dismissActionSelectors = buildActionSelectors([
    { type: "exact", value: "Close" },
    { type: "exact", value: "Back" },
    { type: "contains", value: "Go back" },
    { type: "exact", value: "Back to Previous Page" },
  ]);
  const mediaDownloadSelectors = [
    '[aria-label*="Download" i][role="button"]',
    'button[aria-label*="Download" i]',
    '[aria-label*="Save" i][role="button"]',
    'button[aria-label*="Save" i]',
  ];
  const mediaShareSelectors = [
    '[aria-label*="Share" i][role="button"]',
    'button[aria-label*="Share" i]',
    '[aria-label*="Forward" i][role="button"]',
    'button[aria-label*="Forward" i]',
  ];
  const mediaNavigationSelectors = [
    '[aria-label*="Next" i][role="button"]',
    'button[aria-label*="Next" i]',
    '[aria-label*="Previous" i][role="button"]',
    'button[aria-label*="Previous" i]',
    '[aria-label*="Prev" i][role="button"]',
    'button[aria-label*="Prev" i]',
  ];
  const INCOMING_CALL_HINT_MIN_STICKY_MS = 4_000;
  const INCOMING_CALL_HINT_MISSING_CLEAR_MS = 2_000;
  const INCOMING_CALL_HINT_MAX_WITHOUT_DETECTION_MS = 10_000;
  const MEDIA_OPEN_HINT_DURATION_MS = 4_000;

  let pendingApply = false;
  let pendingSend = false;
  let currentHeaderHeight = DEFAULT_HEADER_HEIGHT;
  let lastSentHeaderHeight = DEFAULT_HEADER_HEIGHT;
  let mediaOverlayVisible = false;
  let forcedMediaOverlayVisible: boolean | null = null;
  let incomingCallOverlayHintActive = false;
  let incomingCallHintActivatedAt = 0;
  let incomingCallLastDetectedAt = 0;
  let incomingCallDetectedSinceHint = false;
  let mediaOverlayOpenHintUntil = 0;
  let mediaOverlayOpenHintTimer: number | null = null;
  let mediaOverlayTransitionTimer: number | null = null;
  let viewportStateSendTimer: number | null = null;
  let viewportRecoveryTimerIds: number[] = [];
  let lastSentViewportState: { visible: boolean; url: string } | null = null;
  let lastViewportMode: MessagesViewportMode | null = null;
  let lastMediaOverlayDebugSentAt = 0;
  let lastMediaOpenSourceUrl: string | null = null;
  let lastMediaOpenSourceKind: "image" | "video" | "unknown" = "unknown";
  const mediaActionClasses = [
    MEDIA_CLOSE_ACTION_CLASS,
    MEDIA_DOWNLOAD_ACTION_CLASS,
    MEDIA_SHARE_ACTION_CLASS,
  ];
  const pinnedStyleProperties = [
    "position",
    "top",
    "right",
    "left",
    "margin",
    "transform",
    "z-index",
    "pointer-events",
    "-webkit-app-region",
    "inset-inline-start",
    "inset-inline-end",
  ];
  const pinnedMediaActionNodes = new Set<HTMLElement>();
  const pinnedMediaActionOriginalStyles = new Map<
    HTMLElement,
    Map<string, { hadValue: boolean; value: string; priority: string }>
  >();

  const isFacebookHost = (): boolean => {
    try {
      const hostname = new URL(window.location.href).hostname;
      return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
    } catch {
      return false;
    }
  };

  const isFacebookHostname = (hostname: string): boolean =>
    hostname === "facebook.com" || hostname.endsWith(".facebook.com");

  const parseNavigationUrl = (input: string): URL | null => {
    try {
      if (input.startsWith("http://") || input.startsWith("https://")) {
        return new URL(input);
      }
      return new URL(input, "https://www.facebook.com");
    } catch {
      return null;
    }
  };

  const extractNestedNavigationUrl = (parsed: URL): string | null => {
    for (const key of ["u", "url", "href", "link", "next"]) {
      const value = parsed.searchParams.get(key);
      if (value) return value;
    }
    return null;
  };

  const isMarketplaceNavigationUrl = (input: string, depth = 0): boolean => {
    if (depth > 2) return false;
    const parsed = parseNavigationUrl(input);
    if (!parsed) return false;

    if (
      isFacebookHostname(parsed.hostname) &&
      parsed.pathname.toLowerCase().includes("/marketplace")
    ) {
      return true;
    }

    const nestedUrl = extractNestedNavigationUrl(parsed);
    return nestedUrl ? isMarketplaceNavigationUrl(nestedUrl, depth + 1) : false;
  };

  const findClosestAnchor = (
    target: EventTarget | null,
  ): HTMLAnchorElement | null => {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest("a[href]");
    return anchor instanceof HTMLAnchorElement ? anchor : null;
  };

  document.addEventListener(
    "click",
    (event) => {
      const anchor = findClosestAnchor(event.target);
      if (!anchor) return;

      const href = anchor.href;
      if (!href || !isMarketplaceNavigationUrl(href)) return;

      event.preventDefault();
      event.stopPropagation();
      ipcRenderer.send("open-external-url", href);
    },
    { capture: true },
  );

  const isAriaVisible = (el: Element | null): boolean => {
    if (!el) return false;
    if (el.closest('[aria-hidden="true"]') || el.closest("[hidden]")) {
      return false;
    }

    const target = el instanceof HTMLElement ? el : null;
    if (!target) return true;
    const style = window.getComputedStyle(target);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      return false;
    }

    // Require the control to intersect viewport; hidden/off-canvas remnants
    // can otherwise keep incoming-call state stuck true.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      return false;
    }

    const opacity = Number.parseFloat(style.opacity || "1");
    if (Number.isFinite(opacity) && opacity <= 0.01) {
      return false;
    }

    return true;
  };

  const detectIncomingCallOverlayVisible = (): boolean => {
    if (!isFacebookHost()) return false;
    return detectIncomingCallUiVisible(isAriaVisible);
  };

  const isMediaOverlayElementVisible = (el: Element | null): boolean => {
    if (!el) return false;
    if (
      el.closest("[hidden]") ||
      el.closest(`[${MEDIA_FALLBACK_CONTROL_ATTR}="true"]`)
    ) {
      return false;
    }

    const target = el instanceof HTMLElement ? el : null;
    if (!target) return true;
    const style = window.getComputedStyle(target);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      return false;
    }
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      return false;
    }

    const opacity = Number.parseFloat(style.opacity || "1");
    if (Number.isFinite(opacity) && opacity <= 0.01) {
      return false;
    }

    return true;
  };

  const getViewportOverlayVisible = (): boolean =>
    mediaOverlayVisible ||
    incomingCallOverlayHintActive ||
    detectIncomingCallOverlayVisible();

  const countTopAnchoredActions = (
    selector: string,
    minTop = -120,
    maxTop = 220,
    minRightFraction = 0,
  ): number => {
    const nodes = Array.from(
      document.querySelectorAll(selector),
    ) as HTMLElement[];
    let count = 0;
    for (const node of nodes) {
      if (!isMediaOverlayElementVisible(node)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) continue;
      if (rect.top < minTop || rect.top > maxTop) continue;
      if (
        minRightFraction > 0 &&
        rect.right < window.innerWidth * minRightFraction
      ) {
        continue;
      }

      count += 1;
    }

    return count;
  };

  const countMediaNavigationActions = (
    selector: string,
    maxEdgeDistance = 180,
  ): number => {
    const nodes = Array.from(
      document.querySelectorAll(selector),
    ) as HTMLElement[];
    let count = 0;
    for (const node of nodes) {
      if (!isMediaOverlayElementVisible(node)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) continue;
      if (
        rect.width > MAX_ACTION_NODE_DIMENSION ||
        rect.height > MAX_ACTION_NODE_DIMENSION
      ) {
        continue;
      }
      if (rect.bottom < window.innerHeight * 0.12) continue;
      if (rect.top > window.innerHeight * 0.88) continue;

      const edgeDistance = Math.min(
        Math.abs(rect.left),
        Math.abs(window.innerWidth - rect.right),
      );
      if (edgeDistance > maxEdgeDistance) continue;

      count += 1;
    }

    return count;
  };

  const hasLargeViewportMedia = (): boolean => {
    const nodes = Array.from(
      document.querySelectorAll("img, video, [role='img']"),
    ) as HTMLElement[];
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    for (const node of nodes) {
      if (!isMediaOverlayElementVisible(node)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 180 && rect.height < 180) continue;
      if (rect.width * rect.height < 50000) continue;
      if (rect.bottom < 24 || rect.top > window.innerHeight - 24) continue;

      const containsCenter =
        centerX >= rect.left &&
        centerX <= rect.right &&
        centerY >= rect.top &&
        centerY <= rect.bottom;
      if (!containsCenter) continue;

      return true;
    }

    return false;
  };

  const isMessagesThreadSubtabRoute = (path: string): boolean =>
    /^\/messages\/(?:e2ee\/)?t\/[^/]+\/(media|files|links|search)(?:\/|$)/.test(
      path,
    );

  type MediaOverlaySignals = {
    path: string;
    modeFromPath: MessagesViewportMode;
    threadSubtabRoute: boolean;
    hasDismissAction: boolean;
    dismissCount: number;
    hasDownloadAction: boolean;
    downloadCount: number;
    hasShareAction: boolean;
    shareCount: number;
    hasNavigationAction: boolean;
    navigationCount: number;
    hasLargeMedia: boolean;
  };

  type MarkedMediaActionState = {
    closeMarked: boolean;
    downloadMarked: boolean;
    shareMarked: boolean;
  };

  const collectMediaOverlaySignals = (): MediaOverlaySignals => {
    const path = window.location.pathname.toLowerCase();
    const modeFromPath = resolveViewportMode({
      urlPath: path,
      mediaOverlayVisible: false,
    });

    const dismissSelector = dismissActionSelectors.join(", ");
    const downloadSelector = mediaDownloadSelectors.join(", ");
    const shareSelector = mediaShareSelectors.join(", ");
    const navigationSelector = mediaNavigationSelectors.join(", ");

    const dismissCount = countTopAnchoredActions(dismissSelector, -160, 260);
    const downloadCount = countTopAnchoredActions(
      downloadSelector,
      -160,
      260,
      0.35,
    );
    const shareCount = countTopAnchoredActions(shareSelector, -160, 260, 0.35);
    const navigationCount = countMediaNavigationActions(navigationSelector);

    return {
      path,
      modeFromPath,
      threadSubtabRoute: isMessagesThreadSubtabRoute(path),
      hasDismissAction: dismissCount > 0,
      dismissCount,
      hasDownloadAction: downloadCount > 0,
      downloadCount,
      hasShareAction: shareCount > 0,
      shareCount,
      hasNavigationAction: navigationCount > 0,
      navigationCount,
      hasLargeMedia: hasLargeViewportMedia(),
    };
  };

  const evaluateMediaOverlayVisible = (
    signals: MediaOverlaySignals,
  ): boolean => {
    return shouldTreatDetectedMediaOverlayAsVisible({
      modeFromPath: signals.modeFromPath,
      threadSubtabRoute: signals.threadSubtabRoute,
      hasDismissAction: signals.hasDismissAction,
      dismissCount: signals.dismissCount,
      hasDownloadAction: signals.hasDownloadAction,
      hasShareAction: signals.hasShareAction,
      hasNavigationAction: signals.hasNavigationAction,
      hasLargeMedia: signals.hasLargeMedia,
      hasPendingOpenHint: hasMediaOverlayOpenHint(),
    });
  };

  const sendMediaOverlayDebug = (
    reason: string,
    extra: Record<string, unknown> = {},
  ): void => {
    const now = Date.now();
    const force = extra.force === true;
    if (
      !force &&
      now - lastMediaOverlayDebugSentAt < MEDIA_OVERLAY_DEBUG_COOLDOWN_MS
    ) {
      return;
    }

    lastMediaOverlayDebugSentAt = now;

    try {
      const signals = collectMediaOverlaySignals();
      const computedVisible = evaluateMediaOverlayVisible(signals);
      const incomingCallOverlayVisible = detectIncomingCallOverlayVisible();
      ipcRenderer.send(MEDIA_OVERLAY_DEBUG_CHANNEL, {
        timestamp: now,
        reason,
        url: window.location.href,
        forcedVisible: forcedMediaOverlayVisible,
        trackedVisible: mediaOverlayVisible,
        computedVisible,
        incomingCallOverlayVisible,
        incomingCallOverlayHintActive,
        effectiveOverlayVisible:
          computedVisible ||
          incomingCallOverlayVisible ||
          incomingCallOverlayHintActive ||
          forcedMediaOverlayVisible === true,
        signals,
        classes: {
          mediaClean:
            document.documentElement.classList.contains(MEDIA_CLEAN_CLASS),
          activeCrop: document.documentElement.classList.contains(ACTIVE_CLASS),
          leftDismiss: document.documentElement.classList.contains(
            MEDIA_LEFT_DISMISS_CLASS,
          ),
        },
        ...extra,
      });
    } catch {
      // Ignore debug telemetry failures.
    }
  };

  const detectMediaOverlayVisible = (): boolean => {
    if (forcedMediaOverlayVisible !== null) {
      return forcedMediaOverlayVisible;
    }

    if (!isFacebookHost()) return false;

    // Incoming-call overlays can resemble media overlays (dim backdrop + top actions).
    // Never treat them as media mode, or we can hide/move call controls.
    if (incomingCallOverlayHintActive || detectIncomingCallOverlayVisible()) {
      return false;
    }

    const signals = collectMediaOverlaySignals();
    return evaluateMediaOverlayVisible(signals);
  };

  const hasMediaOverlayOpenHint = (): boolean =>
    mediaOverlayOpenHintUntil > Date.now();

  const shouldHideMediaBannerDuringLoad = (
    signals: MediaOverlaySignals,
    markedActions: MarkedMediaActionState,
  ): boolean => {
    return shouldKeepMediaViewerBannerHiddenDuringLoadingWindow({
      loadingWindowActive: hasMediaOverlayOpenHint(),
      routeBasedLoading: shouldHideMediaViewerBannerWhileLoading({
        urlPath: signals.path,
        hasDismissAction: signals.hasDismissAction,
        hasDownloadAction: signals.hasDownloadAction,
        hasShareAction: signals.hasShareAction,
        hasNavigationAction: signals.hasNavigationAction,
      }),
      hintedOverlayLoading:
        !signals.hasDownloadAction &&
        !signals.hasShareAction &&
        !signals.hasNavigationAction &&
        (signals.dismissCount >= 2 || signals.hasLargeMedia),
      hasMarkedCloseAction: markedActions.closeMarked,
      hasMarkedDownloadAction: markedActions.downloadMarked,
      hasMarkedShareAction: markedActions.shareMarked,
      hasVisibleNavigationAction: signals.hasNavigationAction,
    });
  };

  const scheduleMediaOpenHintExpiry = (): void => {
    if (mediaOverlayOpenHintTimer !== null) {
      clearTimeout(mediaOverlayOpenHintTimer);
      mediaOverlayOpenHintTimer = null;
    }

    if (!hasMediaOverlayOpenHint()) return;

    const remainingMs = Math.max(0, mediaOverlayOpenHintUntil - Date.now());
    mediaOverlayOpenHintTimer = window.setTimeout(() => {
      mediaOverlayOpenHintTimer = null;
      if (!hasMediaOverlayOpenHint()) {
        sendMediaOverlayDebug("media-open-hint-expired", { force: true });
        scheduleMediaOverlayRecheck();
        scheduleApply();
        scheduleViewportStateSend(true);
      }
    }, remainingMs + 5);
  };

  const clearMediaOverlayOpenHint = (reason: string): void => {
    const hadHint = hasMediaOverlayOpenHint();
    mediaOverlayOpenHintUntil = 0;
    if (mediaOverlayOpenHintTimer !== null) {
      clearTimeout(mediaOverlayOpenHintTimer);
      mediaOverlayOpenHintTimer = null;
    }
    if (!hadHint) return;

    sendMediaOverlayDebug("media-open-hint-cleared", {
      force: true,
      reason,
    });
  };

  const primeMediaOverlayOpenHint = (reason: string): void => {
    const nextUntil = Date.now() + MEDIA_OPEN_HINT_DURATION_MS;
    if (nextUntil <= mediaOverlayOpenHintUntil) return;

    mediaOverlayOpenHintUntil = nextUntil;
    sendMediaOverlayDebug("media-open-hint-primed", {
      force: true,
      reason,
      expiresInMs: MEDIA_OPEN_HINT_DURATION_MS,
    });
    scheduleMediaOpenHintExpiry();
  };

  const applyMediaOverlayOpenHint = (reason: string): void => {
    primeMediaOverlayOpenHint(reason);
    sendMediaOverlayDebug("media-open-hint", {
      force: true,
      reason,
      expiresInMs: MEDIA_OPEN_HINT_DURATION_MS,
    });
    scheduleMediaOverlayRecheck();
    scheduleApply();
    scheduleViewportStateSend(true);
  };

  const setPinnedStyle = (
    node: HTMLElement,
    property: string,
    value: string,
  ): void => {
    let originalStyles = pinnedMediaActionOriginalStyles.get(node);
    if (!originalStyles) {
      originalStyles = new Map();
      pinnedMediaActionOriginalStyles.set(node, originalStyles);
    }

    if (!originalStyles.has(property)) {
      const existingValue = node.style.getPropertyValue(property);
      const existingPriority = node.style.getPropertyPriority(property);
      originalStyles.set(property, {
        hadValue: existingValue.length > 0,
        value: existingValue,
        priority: existingPriority,
      });
    }

    node.style.setProperty(property, value, "important");
  };

  const restorePinnedStyles = (node: HTMLElement): void => {
    const originalStyles = pinnedMediaActionOriginalStyles.get(node);
    if (!originalStyles) {
      for (const property of pinnedStyleProperties) {
        node.style.removeProperty(property);
      }
      return;
    }

    for (const property of pinnedStyleProperties) {
      const snapshot = originalStyles.get(property);
      if (!snapshot) {
        node.style.removeProperty(property);
        continue;
      }

      if (snapshot.hadValue) {
        node.style.setProperty(property, snapshot.value, snapshot.priority);
      } else {
        node.style.removeProperty(property);
      }
    }

    pinnedMediaActionOriginalStyles.delete(node);
  };

  const clearMarkedMediaActions = (): void => {
    document.documentElement.classList.remove(MEDIA_LEFT_DISMISS_CLASS);

    for (const node of pinnedMediaActionNodes) {
      restorePinnedStyles(node);
    }
    pinnedMediaActionNodes.clear();

    for (const className of mediaActionClasses) {
      const nodes = document.querySelectorAll(`.${className}`);
      for (const node of Array.from(nodes)) {
        node.classList.remove(className);
      }
    }
  };

  const pinMediaAction = (
    node: HTMLElement,
    anchor: "left" | "right",
    offsetPx: number,
    topOffsetPx = MEDIA_ACTION_TOP_OFFSET,
  ): void => {
    setPinnedStyle(node, "position", "fixed");
    setPinnedStyle(node, "top", `${topOffsetPx}px`);
    setPinnedStyle(node, "margin", "0");
    setPinnedStyle(node, "transform", "none");
    setPinnedStyle(node, "z-index", "2147483647");
    setPinnedStyle(node, "pointer-events", "auto");
    setPinnedStyle(node, "-webkit-app-region", NON_DRAG_APP_REGION);

    if (anchor === "right") {
      const scrollbarWidth = Math.max(
        0,
        window.innerWidth - document.documentElement.clientWidth,
      );
      const effectiveRight = Math.max(0, offsetPx - scrollbarWidth);
      setPinnedStyle(node, "right", `${effectiveRight}px`);
      setPinnedStyle(node, "left", "auto");
    } else {
      setPinnedStyle(node, "left", `${offsetPx}px`);
      setPinnedStyle(node, "right", "auto");
    }

    pinnedMediaActionNodes.add(node);
  };

  const unpinMediaAction = (node: HTMLElement): void => {
    restorePinnedStyles(node);
    pinnedMediaActionNodes.delete(node);
  };

  const isPinnedActionHitVisible = (node: HTMLElement): boolean => {
    const rect = node.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return false;

    const x = Math.min(
      window.innerWidth - 1,
      Math.max(1, rect.left + rect.width / 2),
    );
    const y = Math.min(
      window.innerHeight - 1,
      Math.max(1, rect.top + rect.height / 2),
    );
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    const topNode = document.elementFromPoint(x, y);
    if (!(topNode instanceof Element)) return false;
    return topNode === node || node.contains(topNode);
  };

  const pinMediaActionWithValidation = (
    node: HTMLElement,
    anchor: "left" | "right",
    offsetPx: number,
    topOffsetPx = MEDIA_ACTION_TOP_OFFSET,
  ): boolean => {
    pinMediaAction(node, anchor, offsetPx, topOffsetPx);
    if (isPinnedActionHitVisible(node)) {
      return true;
    }

    unpinMediaAction(node);
    return false;
  };

  const resolveInteractiveActionNode = (node: HTMLElement): HTMLElement => {
    const interactive = node.closest(
      'button, [role="button"], a[href], [tabindex]',
    );
    if (interactive instanceof HTMLElement) {
      return interactive;
    }
    return node;
  };

  type ActionCandidate = {
    node: HTMLElement;
    rect: DOMRect;
    area: number;
  };

  const collectActionCandidates = (
    selectors: string[],
    excludedNodes: Set<HTMLElement>,
  ): ActionCandidate[] => {
    const nodes = new Set<HTMLElement>();
    for (const selector of selectors) {
      const matches = document.querySelectorAll(
        selector,
      ) as NodeListOf<HTMLElement>;
      for (const match of Array.from(matches)) {
        const resolved = resolveInteractiveActionNode(match);
        if (excludedNodes.has(resolved)) continue;
        nodes.add(resolved);
      }
    }

    const candidates: ActionCandidate[] = [];
    for (const node of nodes) {
      if (!isMediaOverlayElementVisible(node)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) continue;
      if (rect.top < -200 || rect.top > 300) continue;
      if (
        rect.width > MAX_ACTION_NODE_DIMENSION ||
        rect.height > MAX_ACTION_NODE_DIMENSION
      ) {
        continue;
      }

      candidates.push({
        node,
        rect,
        area: rect.width * rect.height,
      });
    }

    return candidates;
  };

  const rankRightActionCandidates = (
    selectors: string[],
    excludedNodes: Set<HTMLElement>,
    minRightFraction = 0.35,
  ): ActionCandidate[] => {
    const candidates = collectActionCandidates(selectors, excludedNodes).filter(
      (candidate) =>
        candidate.rect.right >= window.innerWidth * minRightFraction,
    );

    candidates.sort((a, b) => {
      if (a.rect.right !== b.rect.right) return b.rect.right - a.rect.right;
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.area - b.area;
    });

    return candidates;
  };

  const rankEdgeCloseCandidates = (
    selectors: string[],
    excludedNodes: Set<HTMLElement>,
  ): ActionCandidate[] => {
    const candidates = collectActionCandidates(selectors, excludedNodes).filter(
      (candidate) => candidate.rect.top <= 140,
    );

    candidates.sort((a, b) => {
      const aLeftDist = Math.abs(a.rect.left);
      const aRightDist = Math.abs(window.innerWidth - a.rect.right);
      const bLeftDist = Math.abs(b.rect.left);
      const bRightDist = Math.abs(window.innerWidth - b.rect.right);
      const aEdgeDist = Math.min(aLeftDist, aRightDist);
      const bEdgeDist = Math.min(bLeftDist, bRightDist);

      if (aEdgeDist !== bEdgeDist) return aEdgeDist - bEdgeDist;
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.area - b.area;
    });

    return candidates;
  };

  const markMediaActions = (): MarkedMediaActionState => {
    clearMarkedMediaActions();

    const selectedNodes = new Set<HTMLElement>();
    const markedState: MarkedMediaActionState = {
      closeMarked: false,
      downloadMarked: false,
      shareMarked: false,
    };
    let usingRightDismissLayout = true;
    let pinnedTopOffset = MEDIA_ACTION_TOP_OFFSET;
    let mirroredEdgeGap = MEDIA_ACTION_CLOSE_LEFT_OFFSET;

    const closeCandidates = rankEdgeCloseCandidates(
      dismissActionSelectors,
      selectedNodes,
    );

    for (const candidate of closeCandidates) {
      const closeNode = candidate.node;
      const leftDistance = Math.max(0, Math.round(candidate.rect.left));
      const rightDistance = Math.max(
        0,
        Math.round(window.innerWidth - candidate.rect.right),
      );
      const isRightDismiss = rightDistance < leftDistance;

      const intersectsViewport =
        candidate.rect.right >= 8 &&
        candidate.rect.left <= window.innerWidth - 8 &&
        candidate.rect.bottom >= 8 &&
        candidate.rect.top <= window.innerHeight - 8;
      if (!intersectsViewport && !isPinnedActionHitVisible(closeNode)) {
        continue;
      }

      closeNode.classList.add(MEDIA_CLOSE_ACTION_CLASS);
      selectedNodes.add(closeNode);
      markedState.closeMarked = true;
      usingRightDismissLayout = isRightDismiss;
      pinnedTopOffset = Math.max(
        MEDIA_ACTION_TOP_OFFSET,
        Math.round(candidate.rect.top),
      );
      mirroredEdgeGap = Math.max(
        MEDIA_ACTION_CLOSE_LEFT_OFFSET,
        isRightDismiss ? rightDistance : leftDistance,
      );

      if (!isRightDismiss) {
        document.documentElement.classList.add(MEDIA_LEFT_DISMISS_CLASS);
      }
      break;
    }

    const downloadOffset = usingRightDismissLayout
      ? mirroredEdgeGap + 48
      : mirroredEdgeGap;
    const shareOffset = usingRightDismissLayout
      ? mirroredEdgeGap + 96
      : mirroredEdgeGap + 48;

    const applyPinnedRightAction = (
      selectors: string[],
      className: string,
      offset: number,
    ): void => {
      const candidates = rankRightActionCandidates(selectors, selectedNodes);
      for (const candidate of candidates) {
        const node = candidate.node;
        node.classList.add(className);
        const pinned = pinMediaActionWithValidation(
          node,
          "right",
          offset,
          pinnedTopOffset,
        );
        if (pinned) {
          selectedNodes.add(node);
          if (className === MEDIA_DOWNLOAD_ACTION_CLASS) {
            markedState.downloadMarked = true;
          } else if (className === MEDIA_SHARE_ACTION_CLASS) {
            markedState.shareMarked = true;
          }
          return;
        }
        node.classList.remove(className);
      }
    };

    applyPinnedRightAction(
      [
        '[aria-label*="Download" i][role="button"]',
        'button[aria-label*="Download" i]',
        '[aria-label*="Download" i]',
        '[aria-label*="Save" i][role="button"]',
        'button[aria-label*="Save" i]',
        '[aria-label*="Save" i]',
      ],
      MEDIA_DOWNLOAD_ACTION_CLASS,
      downloadOffset,
    );

    applyPinnedRightAction(
      [
        '[aria-label*="Share" i][role="button"]',
        'button[aria-label*="Share" i]',
        '[aria-label*="Share" i]',
        '[aria-label*="Forward" i][role="button"]',
        'button[aria-label*="Forward" i]',
        '[aria-label*="Forward" i]',
      ],
      MEDIA_SHARE_ACTION_CLASS,
      shareOffset,
    );

    return markedState;
  };

  const dispatchProxyClick = (node: HTMLElement | null): boolean => {
    if (!(node instanceof HTMLElement)) return false;

    try {
      node.click();
    } catch {
      // Fall through to synthetic events below.
    }

    const rect = node.getBoundingClientRect();
    const clientX = Math.max(1, rect.left + rect.width / 2);
    const clientY = Math.max(1, rect.top + rect.height / 2);
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      try {
        const EventCtor = type === "pointerdown" ? PointerEvent : MouseEvent;
        node.dispatchEvent(
          new EventCtor(type, {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
      } catch {
        // Ignore synthetic dispatch failures.
      }
    }

    return true;
  };

  const clearFallbackMediaControls = (): void => {
    document.getElementById(MEDIA_FALLBACK_CONTROLS_ID)?.remove();
  };

  const getOrCreateFallbackMediaControlsHost = (): HTMLElement => {
    const existing = document.getElementById(MEDIA_FALLBACK_CONTROLS_ID);
    if (existing instanceof HTMLElement) {
      return existing;
    }

    const host = document.createElement("div");
    host.id = MEDIA_FALLBACK_CONTROLS_ID;
    host.setAttribute(MEDIA_FALLBACK_CONTROL_ATTR, "true");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.pointerEvents = "none";
    host.style.zIndex = "2147483646";
    document.body.appendChild(host);
    return host;
  };

  const upsertFallbackMediaButton = (input: {
    host: HTMLElement;
    key: string;
    label: string;
    text: string;
    top: number;
    left?: number;
    right?: number;
    onClick: () => void;
  }): void => {
    const buttonId = `${MEDIA_FALLBACK_CONTROLS_ID}-${input.key}`;
    let button = document.getElementById(buttonId) as HTMLButtonElement | null;
    if (!(button instanceof HTMLButtonElement)) {
      button = document.createElement("button");
      button.id = buttonId;
      button.type = "button";
      button.className = MEDIA_FALLBACK_BUTTON_CLASS;
      button.setAttribute(MEDIA_FALLBACK_CONTROL_ATTR, "true");
      input.host.appendChild(button);
    }

    button.setAttribute("aria-label", input.label);
    button.textContent = input.text;
    button.style.top = `${Math.max(8, Math.round(input.top))}px`;
    button.style.left =
      typeof input.left === "number" ? `${input.left}px` : "auto";
    button.style.right =
      typeof input.right === "number" ? `${input.right}px` : "auto";
    button.style.display = "flex";
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.onClick();
    };
  };

  const hideFallbackMediaButton = (key: string): void => {
    const button = document.getElementById(
      `${MEDIA_FALLBACK_CONTROLS_ID}-${key}`,
    );
    if (button instanceof HTMLElement) {
      button.style.display = "none";
    }
  };

  const resolveActiveMediaSourceUrl = (): string | null => {
    const nodes = Array.from(
      document.querySelectorAll("img, video, [role='img']"),
    ) as HTMLElement[];
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    for (const node of nodes) {
      if (!isAriaVisible(node)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 180 && rect.height < 180) continue;
      if (rect.width * rect.height < 30000) continue;
      if (rect.bottom < 24 || rect.top > window.innerHeight - 24) continue;
      const containsCenter =
        centerX >= rect.left &&
        centerX <= rect.right &&
        centerY >= rect.top &&
        centerY <= rect.bottom;
      if (!containsCenter) continue;

      const source = resolveMediaSourceFromNode(node);
      if (source.url) {
        lastMediaOpenSourceUrl = source.url;
        lastMediaOpenSourceKind = source.kind;
        return source.url;
      }
    }

    return lastMediaOpenSourceUrl;
  };

  const triggerDownloadForUrl = (rawUrl: string): boolean => {
    if (!rawUrl) return false;

    try {
      const anchor = document.createElement("a");
      anchor.href = rawUrl;
      anchor.download = "";
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return true;
    } catch {
      return false;
    }
  };

  const updateFallbackMediaControls = (
    markedActions: MarkedMediaActionState,
  ): void => {
    const closeCandidate = rankEdgeCloseCandidates(
      dismissActionSelectors,
      new Set<HTMLElement>(),
    )[0];
    const closeNode = closeCandidate?.node || null;
    const closeRect = closeCandidate?.rect || null;
    const closePinnedVisible = closeNode
      ? isPinnedActionHitVisible(closeNode)
      : false;
    const closeNeedsFallback =
      closeRect !== null &&
      (!markedActions.closeMarked ||
        !closePinnedVisible ||
        closeRect.left < 8 ||
        closeRect.right > window.innerWidth - 8 ||
        closeNode?.closest('[aria-hidden="true"]') !== null);

    const downloadCandidate = !markedActions.downloadMarked
      ? rankRightActionCandidates(
          [
            '[aria-label*="Download" i][role="button"]',
            'button[aria-label*="Download" i]',
            '[aria-label*="Download" i]',
            '[aria-label*="Save" i][role="button"]',
            'button[aria-label*="Save" i]',
            '[aria-label*="Save" i]',
          ],
          new Set<HTMLElement>(),
          0,
        )[0]
      : null;

    const shareCandidate = !markedActions.shareMarked
      ? rankRightActionCandidates(
          [
            '[aria-label*="Share" i][role="button"]',
            'button[aria-label*="Share" i]',
            '[aria-label*="Share" i]',
            '[aria-label*="Forward" i][role="button"]',
            'button[aria-label*="Forward" i]',
            '[aria-label*="Forward" i]',
          ],
          new Set<HTMLElement>(),
          0,
        )[0]
      : null;

    const activeMediaSourceUrl = resolveActiveMediaSourceUrl();
    const topOffset = closeRect ? Math.max(8, Math.round(closeRect.top)) : 8;
    const closeOnLeft =
      closeRect !== null
        ? Math.abs(closeRect.left) <=
          Math.abs(window.innerWidth - closeRect.right)
        : true;

    const host = getOrCreateFallbackMediaControlsHost();

    if (closeNeedsFallback && closeNode) {
      upsertFallbackMediaButton({
        host,
        key: "close",
        label: closeNode.getAttribute("aria-label") || "Close",
        text: "×",
        top: topOffset,
        ...(closeOnLeft
          ? { left: MEDIA_ACTION_CLOSE_LEFT_OFFSET }
          : { right: 16 }),
        onClick: () => {
          dispatchProxyClick(closeNode);
        },
      });
    } else {
      hideFallbackMediaButton("close");
    }

    const showDownloadFallback = Boolean(
      downloadCandidate || activeMediaSourceUrl,
    );
    const showShareFallback = Boolean(shareCandidate);

    if (showDownloadFallback) {
      upsertFallbackMediaButton({
        host,
        key: "download",
        label:
          downloadCandidate?.node.getAttribute("aria-label") ||
          "Download media attachment",
        text: "↓",
        top: topOffset,
        right: showShareFallback ? 64 : 16,
        onClick: () => {
          if (downloadCandidate?.node) {
            if (dispatchProxyClick(downloadCandidate.node)) return;
          }
          if (activeMediaSourceUrl) {
            triggerDownloadForUrl(activeMediaSourceUrl);
          }
        },
      });
    } else {
      hideFallbackMediaButton("download");
    }

    if (showShareFallback && shareCandidate?.node) {
      upsertFallbackMediaButton({
        host,
        key: "share",
        label: shareCandidate.node.getAttribute("aria-label") || "Forward",
        text: "↗",
        top: topOffset,
        right: 16,
        onClick: () => {
          dispatchProxyClick(shareCandidate.node);
        },
      });
    } else {
      hideFallbackMediaButton("share");
    }
  };

  const resolveMode = (): MessagesViewportMode =>
    resolveViewportMode({
      urlPath: window.location.pathname,
      mediaOverlayVisible,
    });

  const clampHeaderHeight = (value: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_HEADER_HEIGHT;
    return Math.max(
      MIN_HEADER_HEIGHT,
      Math.min(MAX_HEADER_HEIGHT, Math.round(value)),
    );
  };

  const measureHeaderHeight = (): number => {
    const banners = Array.from(
      document.querySelectorAll('[role="banner"]'),
    ) as HTMLElement[];

    let topAnchoredBannerBottom = 0;
    for (const banner of banners) {
      const rect = banner.getBoundingClientRect();
      // Facebook's global top bar is anchored at the top edge.
      if (rect.top > 12) continue;
      if (rect.height < 20) continue;
      topAnchoredBannerBottom = Math.max(topAnchoredBannerBottom, rect.bottom);
    }

    if (topAnchoredBannerBottom > 0) {
      return clampHeaderHeight(topAnchoredBannerBottom);
    }

    return DEFAULT_HEADER_HEIGHT;
  };

  const setHeaderHeight = (height: number): void => {
    currentHeaderHeight = clampHeaderHeight(height);
    document.documentElement.style.setProperty(
      HEADER_HEIGHT_CSS_VAR,
      `${currentHeaderHeight}px`,
    );
  };

  const scheduleHeaderHeightSend = (): void => {
    if (pendingSend) return;
    pendingSend = true;
    window.setTimeout(() => {
      pendingSend = false;
      if (Math.abs(currentHeaderHeight - lastSentHeaderHeight) < 2) return;
      lastSentHeaderHeight = currentHeaderHeight;
      ipcRenderer.send("messages-header-height", currentHeaderHeight);
    }, HEADER_SEND_DEBOUNCE_MS);
  };

  const scheduleViewportStateSend = (force = false): void => {
    if (viewportStateSendTimer !== null) {
      clearTimeout(viewportStateSendTimer);
    }

    viewportStateSendTimer = window.setTimeout(() => {
      viewportStateSendTimer = null;
      // IMPORTANT: `media-viewer-state` is consumed by main to toggle the
      // media-overlay crop bypass. Keep this channel scoped to media-only state.
      // Incoming-call overlays are tracked separately via incoming-call-overlay-hint.
      const payload = {
        visible: resolveMediaViewerStateVisible({
          mediaOverlayVisible,
          incomingCallOverlayVisible:
            incomingCallOverlayHintActive || detectIncomingCallOverlayVisible(),
        }),
        url: window.location.href,
      };
      const unchanged =
        !force &&
        lastSentViewportState !== null &&
        lastSentViewportState.visible === payload.visible &&
        lastSentViewportState.url === payload.url;
      if (unchanged) return;

      lastSentViewportState = payload;
      ipcRenderer.send("media-viewer-state", payload);
      sendMediaOverlayDebug("viewport-state-send", {
        force,
        sentVisible: payload.visible,
        incomingCallOverlayVisible: detectIncomingCallOverlayVisible(),
        incomingCallOverlayHintActive,
        effectiveOverlayVisible: getViewportOverlayVisible(),
      });
    }, VIEWPORT_STATE_SEND_DEBOUNCE_MS);
  };

  const ensureStyleTag = (): void => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html.${ACTIVE_CLASS},
      html.${ACTIVE_CLASS} body {
        overflow: hidden !important;
        height: calc(100vh + var(${HEADER_HEIGHT_CSS_VAR}, ${DEFAULT_HEADER_HEIGHT}px)) !important;
        min-height: calc(100vh + var(${HEADER_HEIGHT_CSS_VAR}, ${DEFAULT_HEADER_HEIGHT}px)) !important;
      }

      html.${ACTIVE_CLASS} body > div[id^="mount_"],
      html.${ACTIVE_CLASS} body > div[id^="mount_"] > div,
      html.${ACTIVE_CLASS} [data-pagelet="root"] {
        height: calc(100vh + var(${HEADER_HEIGHT_CSS_VAR}, ${DEFAULT_HEADER_HEIGHT}px)) !important;
        min-height: calc(100vh + var(${HEADER_HEIGHT_CSS_VAR}, ${DEFAULT_HEADER_HEIGHT}px)) !important;
      }

      /* Remove residual top-edge divider/shadow from Facebook's fixed header layer */
      html.${ACTIVE_CLASS} [role="banner"],
      html.${ACTIVE_CLASS} [role="banner"]::before,
      html.${ACTIVE_CLASS} [role="banner"]::after {
        box-shadow: none !important;
        filter: none !important;
        border-bottom: none !important;
      }

      /* Keep the top edge under native titlebar uniform in light mode */
      @media (prefers-color-scheme: light) {
        html.${ACTIVE_CLASS},
        html.${ACTIVE_CLASS} body,
        html.${ACTIVE_CLASS} body > div[id^="mount_"],
        html.${ACTIVE_CLASS} body > div[id^="mount_"] > div,
        html.${ACTIVE_CLASS} [data-pagelet="root"] {
          background-color: #F2F4F7 !important;
        }

        html.${ACTIVE_CLASS} body::before {
          content: "";
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 8px;
          background: #F2F4F7;
          pointer-events: none;
          z-index: 2147483647;
        }
      }

      /* On media viewer, hide Facebook global top-right controls (menu, messenger, bell, profile)
         but keep media controls like Close/Download visible. */
      html.${MEDIA_CLEAN_CLASS} [role="banner"] [aria-label="Menu" i],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] [aria-label="Messenger" i],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] [aria-label*="Notifications" i],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] [aria-label*="Account controls and settings" i],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] [aria-label="Your profile" i],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] [aria-label="Facebook" i],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] a[href="/"],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] a[href="https://www.facebook.com/"],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] a[href*="/notifications/"],
      html.${MEDIA_CLEAN_CLASS} [role="banner"] a[href="/messages/"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* Route-based media viewers can render Facebook's banner shell before
         the real viewer controls mount. Hide that shell until media chrome exists. */
      html.${MEDIA_LOADING_CLASS} [role="banner"],
      html.${MEDIA_LOADING_CLASS} [role="banner"]::before,
      html.${MEDIA_LOADING_CLASS} [role="banner"]::after {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      html.${MEDIA_LOADING_CLASS} body > div[id^="mount_"],
      html.${MEDIA_LOADING_CLASS} body > div[id^="mount_"] > div,
      html.${MEDIA_LOADING_CLASS} [data-pagelet="root"] {
        margin-top: 0 !important;
        padding-top: 0 !important;
      }

      /* Incoming call overlay: hide only Facebook global chrome controls,
         not the entire banner container (call controls can be hosted there). */
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] [aria-label="Menu" i],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] [aria-label="Messenger" i],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] [aria-label*="Notifications" i],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] [aria-label*="Account controls and settings" i],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] [aria-label="Your profile" i],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] [aria-label="Facebook" i],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] a[href="/"],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] a[href="https://www.facebook.com/"],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] a[href*="/notifications/"],
      html.${INCOMING_CALL_CLEAN_CLASS} [role="banner"] a[href="/messages/"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* Collapse residual top spacing Facebook leaves while incoming call UI is active. */
      html.${INCOMING_CALL_CLEAN_CLASS} body > div[id^="mount_"],
      html.${INCOMING_CALL_CLEAN_CLASS} body > div[id^="mount_"] > div,
      html.${INCOMING_CALL_CLEAN_CLASS} [data-pagelet="root"] {
        margin-top: 0 !important;
        padding-top: 0 !important;
      }

      /* Never let detected media actions fall into a drag region. */
      html.${MEDIA_CLEAN_CLASS} .${MEDIA_CLOSE_ACTION_CLASS},
      html.${MEDIA_CLEAN_CLASS} .${MEDIA_DOWNLOAD_ACTION_CLASS},
      html.${MEDIA_CLEAN_CLASS} .${MEDIA_SHARE_ACTION_CLASS} {
        pointer-events: auto !important;
        -webkit-app-region: ${NON_DRAG_APP_REGION} !important;
      }

      #${MEDIA_FALLBACK_CONTROLS_ID} .${MEDIA_FALLBACK_BUTTON_CLASS} {
        position: fixed;
        width: 32px;
        height: 32px;
        display: none;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        background: rgba(24, 25, 26, 0.88);
        color: #fff;
        font: 600 18px/1 -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        pointer-events: auto;
        cursor: pointer;
        z-index: 2147483647;
        -webkit-app-region: ${NON_DRAG_APP_REGION} !important;
      }
    `;
    document.head.appendChild(style);
  };

  const applyCompensation = (): void => {
    if (!document.head) return;
    ensureStyleTag();

    const mode = resolveMode();
    if (mode !== lastViewportMode) {
      const previousMode = lastViewportMode;
      lastViewportMode = mode;
      scheduleViewportStateSend(true);
      sendMediaOverlayDebug("viewport-mode-change", {
        force: true,
        previousMode,
        nextMode: mode,
      });
    }

    const detectedIncomingCallOverlayVisible =
      detectIncomingCallOverlayVisible();
    const now = Date.now();

    if (detectedIncomingCallOverlayVisible) {
      incomingCallLastDetectedAt = now;
      if (incomingCallOverlayHintActive) {
        incomingCallDetectedSinceHint = true;
      }
    }

    if (
      incomingCallOverlayHintActive &&
      !detectedIncomingCallOverlayVisible &&
      incomingCallHintActivatedAt > 0
    ) {
      const activeForMs = now - incomingCallHintActivatedAt;
      const missingForMs =
        incomingCallLastDetectedAt > 0
          ? now - incomingCallLastDetectedAt
          : activeForMs;
      const reason = getIncomingCallHintClearReason({
        activeForMs,
        missingForMs,
        detectedSinceHint: incomingCallDetectedSinceHint,
        minStickyMs: INCOMING_CALL_HINT_MIN_STICKY_MS,
        missingClearMs: INCOMING_CALL_HINT_MISSING_CLEAR_MS,
        maxWithoutDetectionMs: INCOMING_CALL_HINT_MAX_WITHOUT_DETECTION_MS,
      });

      if (reason) {
        applyIncomingCallOverlayHint(false, reason);
        sendIncomingCallOverlayHint(false, reason);
      }
    }

    const mediaSignals = mode === "media" ? collectMediaOverlaySignals() : null;

    if (
      mode === "media" &&
      !detectedIncomingCallOverlayVisible &&
      !incomingCallOverlayHintActive
    ) {
      if (
        mediaSignals &&
        !hasMediaOverlayOpenHint() &&
        shouldHideMediaViewerBannerWhileLoading({
          urlPath: mediaSignals.path,
          hasDismissAction: mediaSignals.hasDismissAction,
          hasDownloadAction: mediaSignals.hasDownloadAction,
          hasShareAction: mediaSignals.hasShareAction,
          hasNavigationAction: mediaSignals.hasNavigationAction,
        })
      ) {
        primeMediaOverlayOpenHint("media-route-loading");
      }

      const markedActions = markMediaActions();
      updateFallbackMediaControls(markedActions);
      document.documentElement.classList.add(MEDIA_CLEAN_CLASS);
      if (
        mediaSignals &&
        shouldHideMediaBannerDuringLoad(mediaSignals, markedActions)
      ) {
        document.documentElement.classList.add(MEDIA_LOADING_CLASS);
      } else {
        document.documentElement.classList.remove(MEDIA_LOADING_CLASS);
      }
    } else {
      document.documentElement.classList.remove(MEDIA_CLEAN_CLASS);
      document.documentElement.classList.remove(MEDIA_LOADING_CLASS);
      clearMarkedMediaActions();
      clearFallbackMediaControls();
    }

    const incomingCallOverlayVisible =
      incomingCallOverlayHintActive || detectedIncomingCallOverlayVisible;
    if (incomingCallOverlayVisible) {
      document.documentElement.classList.add(INCOMING_CALL_CLEAN_CLASS);
    } else {
      document.documentElement.classList.remove(INCOMING_CALL_CLEAN_CLASS);
    }

    const shouldCropMessagesViewport =
      !incomingCallOverlayVisible &&
      shouldApplyMessagesCrop({
        urlPath: window.location.pathname,
        mediaOverlayVisible: getViewportOverlayVisible(),
      });

    if (shouldCropMessagesViewport) {
      document.documentElement.classList.add(ACTIVE_CLASS);
      setHeaderHeight(measureHeaderHeight());
      scheduleHeaderHeightSend();
    } else {
      document.documentElement.classList.remove(ACTIVE_CLASS);
      document.documentElement.style.removeProperty(HEADER_HEIGHT_CSS_VAR);
    }
  };

  const applyComputedMediaOverlayVisibility = (
    reason: string,
    extra: Record<string, unknown> = {},
  ): boolean => {
    const previousVisible = mediaOverlayVisible;
    const nextVisible = detectMediaOverlayVisible();
    if (nextVisible === previousVisible) return false;

    mediaOverlayVisible = nextVisible;
    sendMediaOverlayDebug(reason, {
      force: true,
      previousVisible,
      nextVisible,
      ...extra,
    });
    scheduleViewportStateSend(true);
    scheduleApply();
    return true;
  };

  const scheduleMediaOverlayRecheck = (): void => {
    if (mediaOverlayTransitionTimer !== null) {
      clearTimeout(mediaOverlayTransitionTimer);
    }

    mediaOverlayTransitionTimer = window.setTimeout(() => {
      mediaOverlayTransitionTimer = null;
      applyComputedMediaOverlayVisibility("recheck-visible-change");
    }, MEDIA_OVERLAY_TRANSITION_MS);
  };

  const isDismissActionTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target.closest(dismissActionSelectors.join(", ")) !== null;
  };

  const mediaOpenActionSelectors = [
    '[aria-label^="View photo" i]',
    '[aria-label^="View video" i]',
    '[aria-label^="View attachment" i]',
    '[aria-label^="Open photo" i]',
    '[aria-label^="Open video" i]',
    'a[href*="/photo/"]',
    'a[href*="/photos/"]',
    'a[href*="/video/"]',
    'a[href*="/messages/media_viewer"]',
    'a[href*="/messages/attachment_preview"]',
    'a[href*="/messenger_media"]',
  ];

  const findMediaOpenPreviewNode = (root: HTMLElement): HTMLElement | null => {
    const directCandidates = [
      root,
      ...(Array.from(
        root.querySelectorAll("img, video, [role='img']"),
      ) as HTMLElement[]),
    ];

    for (const candidate of directCandidates) {
      if (!(candidate instanceof HTMLElement) || !isAriaVisible(candidate)) {
        continue;
      }

      const style = window.getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      const hasBackgroundImage =
        typeof style.backgroundImage === "string" &&
        style.backgroundImage !== "none";
      const looksLikeMediaNode =
        candidate.matches("img, video, [role='img']") || hasBackgroundImage;
      if (!looksLikeMediaNode) continue;
      const largestDimension = Math.max(rect.width, rect.height);
      const area = rect.width * rect.height;
      if (largestDimension < 120 || area < 9000) continue;
      if (rect.right <= 250) continue;
      return candidate;
    }

    return null;
  };

  const parseBackgroundImageUrl = (
    value: string | null | undefined,
  ): string | null => {
    const match = String(value || "").match(/url\((['"]?)(.*?)\1\)/i);
    return match?.[2] || null;
  };

  const resolveMediaSourceFromNode = (
    node: HTMLElement | null,
  ): { url: string | null; kind: "image" | "video" | "unknown" } => {
    if (!(node instanceof HTMLElement)) {
      return { url: null, kind: "unknown" };
    }

    if (node instanceof HTMLImageElement) {
      return {
        url: node.currentSrc || node.src || null,
        kind: "image",
      };
    }

    if (node instanceof HTMLVideoElement) {
      return {
        url: node.currentSrc || node.src || node.poster || null,
        kind: "video",
      };
    }

    const mediaChild = node.querySelector("img, video") as
      | HTMLImageElement
      | HTMLVideoElement
      | null;
    if (mediaChild instanceof HTMLImageElement) {
      return {
        url: mediaChild.currentSrc || mediaChild.src || null,
        kind: "image",
      };
    }
    if (mediaChild instanceof HTMLVideoElement) {
      return {
        url:
          mediaChild.currentSrc || mediaChild.src || mediaChild.poster || null,
        kind: "video",
      };
    }

    const style = window.getComputedStyle(node);
    const backgroundUrl = parseBackgroundImageUrl(style.backgroundImage);
    if (backgroundUrl) {
      return {
        url: backgroundUrl,
        kind: "image",
      };
    }

    return { url: null, kind: "unknown" };
  };

  const rememberMediaOpenSourceFromTarget = (
    target: EventTarget | null,
  ): void => {
    if (!(target instanceof Element)) return;

    const clickable = target.closest(
      'button, [role="button"], a[href], [tabindex]',
    );
    const previewNode =
      clickable instanceof HTMLElement
        ? findMediaOpenPreviewNode(clickable)
        : null;
    const source = resolveMediaSourceFromNode(previewNode);
    if (!source.url) return;

    lastMediaOpenSourceUrl = source.url;
    lastMediaOpenSourceKind = source.kind;
  };

  const isMediaOpenActionTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;

    const matched = target.closest(mediaOpenActionSelectors.join(", "));
    if (matched) return true;

    const clickable = target.closest(
      'button, [role="button"], a[href], [tabindex]',
    );
    if (!(clickable instanceof HTMLElement)) return false;
    if (
      clickable.closest(
        '[role="banner"], [role="navigation"], [aria-label="Chats" i]',
      )
    ) {
      return false;
    }

    return findMediaOpenPreviewNode(clickable) !== null;
  };

  const scheduleOpenFastPathChecks = (trigger: string): void => {
    const delays = [0, 20, 52, 96, 160, 260, 420];
    for (const delay of delays) {
      window.setTimeout(() => {
        applyComputedMediaOverlayVisibility("open-fast-path", {
          trigger,
          delay,
        });
      }, delay);
    }
  };

  const scheduleDismissFastPathChecks = (trigger: string): void => {
    const delays = [0, 20, 52, 96];
    for (const delay of delays) {
      window.setTimeout(() => {
        applyComputedMediaOverlayVisibility("dismiss-fast-path", {
          trigger,
          delay,
        });
      }, delay);
    }
  };

  const scheduleApply = (): void => {
    if (pendingApply) return;
    pendingApply = true;
    window.setTimeout(() => {
      pendingApply = false;
      applyCompensation();
    }, 0);
  };

  const scheduleViewportRecovery = (reason: string): void => {
    for (const timerId of viewportRecoveryTimerIds) {
      clearTimeout(timerId);
    }
    viewportRecoveryTimerIds = [];

    const delays = [0, 120, 500, 1500];
    for (const delay of delays) {
      const timerId = window.setTimeout(() => {
        viewportRecoveryTimerIds = viewportRecoveryTimerIds.filter(
          (value) => value !== timerId,
        );
        sendMediaOverlayDebug("viewport-recovery", {
          force: true,
          reason,
          delay,
          url: window.location.href,
        });
        scheduleMediaOverlayRecheck();
        scheduleApply();
        scheduleViewportStateSend(true);
      }, delay);
      viewportRecoveryTimerIds.push(timerId);
    }
  };

  const startObservers = (): void => {
    if (!document.body) return;
    const observer = new MutationObserver(() => {
      scheduleMediaOverlayRecheck();
      scheduleApply();
      scheduleViewportStateSend();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "role", "aria-hidden", "hidden"],
    });
  };

  const applyForcedMediaOverlayVisible = (visible: boolean | null): void => {
    const previousForced = forcedMediaOverlayVisible;
    forcedMediaOverlayVisible = typeof visible === "boolean" ? visible : null;
    mediaOverlayVisible = detectMediaOverlayVisible();
    sendMediaOverlayDebug("forced-overlay-update", {
      force: true,
      previousForced,
      nextForced: forcedMediaOverlayVisible,
      resultingVisible: mediaOverlayVisible,
    });
    scheduleViewportStateSend(true);
    scheduleApply();
  };

  const applyIncomingCallOverlayHint = (
    visible: boolean,
    reason: string,
  ): void => {
    const previous = incomingCallOverlayHintActive;
    if (previous === visible) {
      if (visible) {
        const now = Date.now();
        if (incomingCallHintActivatedAt <= 0) {
          incomingCallHintActivatedAt = now;
        }
        incomingCallLastDetectedAt = now;
        incomingCallDetectedSinceHint = true;
      }
      return;
    }

    incomingCallOverlayHintActive = visible;
    if (visible) {
      incomingCallHintActivatedAt = Date.now();
      incomingCallLastDetectedAt = 0;
      incomingCallDetectedSinceHint = false;
    } else {
      incomingCallHintActivatedAt = 0;
      incomingCallLastDetectedAt = 0;
      incomingCallDetectedSinceHint = false;
    }

    sendMediaOverlayDebug("incoming-call-overlay-hint", {
      force: true,
      previous,
      next: incomingCallOverlayHintActive,
      reason,
    });
    scheduleViewportStateSend(true);
    scheduleApply();
  };

  (
    window as typeof window & {
      __mdSetForcedMediaOverlayVisible?: (visible: boolean | null) => void;
      __mdSetIncomingCallOverlayHint?: (
        visible: boolean,
        reason?: string,
      ) => void;
    }
  ).__mdSetForcedMediaOverlayVisible = (visible: boolean | null) => {
    applyForcedMediaOverlayVisible(visible);
  };

  (
    window as typeof window & {
      __mdSetIncomingCallOverlayHint?: (
        visible: boolean,
        reason?: string,
      ) => void;
    }
  ).__mdSetIncomingCallOverlayHint = (
    visible: boolean,
    reason = "window-hook",
  ) => {
    applyIncomingCallOverlayHint(Boolean(visible), reason);
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const payload = event.data;
    if (!payload || typeof payload !== "object") return;

    if (payload.type === "md-force-media-overlay-visible") {
      const visible =
        typeof payload.visible === "boolean" ? payload.visible : null;
      applyForcedMediaOverlayVisible(visible);
      return;
    }

    if (payload.type === "md-incoming-call-overlay-hint") {
      const visible = payload.visible === true;
      const reason =
        typeof payload.reason === "string" ? payload.reason : "message-event";
      applyIncomingCallOverlayHint(visible, reason);
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (isMediaOpenActionTarget(event.target)) {
        rememberMediaOpenSourceFromTarget(event.target);
        applyMediaOverlayOpenHint("open-pointerdown");
        scheduleOpenFastPathChecks("open-pointerdown");
      }
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "click",
    (event) => {
      if (isMediaOpenActionTarget(event.target)) {
        rememberMediaOpenSourceFromTarget(event.target);
        applyMediaOverlayOpenHint("open-click");
        scheduleOpenFastPathChecks("open-click");
      }
      if (!isDismissActionTarget(event.target)) return;
      clearMediaOverlayOpenHint("dismiss-click");
      scheduleDismissFastPathChecks("dismiss-click");
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        isMediaOpenActionTarget(event.target)
      ) {
        rememberMediaOpenSourceFromTarget(event.target);
        applyMediaOverlayOpenHint("open-key");
        scheduleOpenFastPathChecks("open-key");
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!isDismissActionTarget(event.target)) return;
      clearMediaOverlayOpenHint("dismiss-key");
      scheduleDismissFastPathChecks("dismiss-key");
    },
    { passive: true, capture: true },
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startObservers();
      mediaOverlayVisible = detectMediaOverlayVisible();
      sendMediaOverlayDebug("dom-content-loaded", {
        force: true,
        visible: mediaOverlayVisible,
      });
      scheduleApply();
      scheduleViewportStateSend(true);
    });
  } else {
    startObservers();
    mediaOverlayVisible = detectMediaOverlayVisible();
    sendMediaOverlayDebug("init-ready", {
      force: true,
      visible: mediaOverlayVisible,
    });
    scheduleApply();
    scheduleViewportStateSend(true);
  }

  let lastUrl = window.location.href;
  window.setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = currentUrl;
      clearMediaOverlayOpenHint("url-change");
      sendMediaOverlayDebug("url-change", {
        force: true,
        previousUrl,
        nextUrl: currentUrl,
      });
      scheduleMediaOverlayRecheck();
      scheduleApply();
      scheduleViewportStateSend(true);
    }
  }, 300);

  window.addEventListener("pageshow", () => {
    sendMediaOverlayDebug("pageshow", { force: true });
    scheduleMediaOverlayRecheck();
    scheduleApply();
  });
  window.addEventListener("online", () => {
    scheduleViewportRecovery("online");
  });
  window.addEventListener("focus", () => {
    scheduleViewportRecovery("window-focus");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleViewportRecovery("visibility-visible");
    }
  });
  window.addEventListener("resize", () => {
    sendMediaOverlayDebug("resize");
    scheduleMediaOverlayRecheck();
    scheduleApply();
  });

  ipcRenderer.on("power-state", (_event, payload: { state?: string }) => {
    const state = typeof payload?.state === "string" ? payload.state : "";
    if (state === "resume" || state === "unlock-screen") {
      scheduleViewportRecovery(`power-${state}`);
    }
  });
})();

// Listen for notification events from the injected script
// The injected script dispatches custom events that we can catch
// We need to inject a listener into the page context that forwards to us
(function setupNotificationBridge() {
  // Inject a script into the page context to listen for custom events
  // and forward them to the preload context via a message
  const _bridgeScript = `
    (function() {
      window.addEventListener('electron-notification', function(event) {
        // Forward to preload via a message we can catch
        window.postMessage({ type: 'electron-notification', data: event.detail }, '*');
      });
    })();
  `;

  // Execute the bridge listener in the page context
  // This runs after the page loads, so we'll inject it via main process

  let incomingCallOverlayHintTimer: number | null = null;
  let incomingCallOverlayHintHeartbeatTimer: number | null = null;
  let incomingCallOverlayHintStartedAt = 0;
  let incomingCallOverlayHintLastVisibleAt = 0;
  const INCOMING_CALL_OVERLAY_HINT_RECHECK_MS = 1_200;
  const INCOMING_CALL_OVERLAY_HINT_HEARTBEAT_MS = 1_000;
  const INCOMING_CALL_OVERLAY_HINT_MIN_HOLD_MS = 4_000;
  const INCOMING_CALL_OVERLAY_HINT_MISS_GRACE_MS = 2_000;

  const isElementVisible = (el: Element | null): boolean => {
    if (!el) return false;

    const target = el instanceof HTMLElement ? el : null;
    if (!target) return false;

    if (target.closest('[aria-hidden="true"]') || target.closest("[hidden]")) {
      return false;
    }

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
    return rect.width >= 4 && rect.height >= 4;
  };

  const detectIncomingCallOverlayVisibleForHint = (): boolean => {
    return detectIncomingCallUiVisible(isElementVisible);
  };

  const clearIncomingCallOverlayHintTimers = (): void => {
    if (incomingCallOverlayHintTimer !== null) {
      clearTimeout(incomingCallOverlayHintTimer);
      incomingCallOverlayHintTimer = null;
    }

    if (incomingCallOverlayHintHeartbeatTimer !== null) {
      clearInterval(incomingCallOverlayHintHeartbeatTimer);
      incomingCallOverlayHintHeartbeatTimer = null;
    }
  };

  const shouldKeepIncomingCallOverlayHintActive = (now: number): boolean => {
    const sinceStart =
      incomingCallOverlayHintStartedAt > 0
        ? now - incomingCallOverlayHintStartedAt
        : Number.POSITIVE_INFINITY;
    const sinceVisible =
      incomingCallOverlayHintLastVisibleAt > 0
        ? now - incomingCallOverlayHintLastVisibleAt
        : Number.POSITIVE_INFINITY;

    return shouldKeepIncomingCallHintActive({
      sinceStartMs: sinceStart,
      sinceVisibleMs: sinceVisible,
      minHoldMs: INCOMING_CALL_OVERLAY_HINT_MIN_HOLD_MS,
      missGraceMs: INCOMING_CALL_OVERLAY_HINT_MISS_GRACE_MS,
    });
  };

  const scheduleIncomingCallOverlayHintRecheck = (reason: string): void => {
    if (incomingCallOverlayHintTimer !== null) {
      clearTimeout(incomingCallOverlayHintTimer);
    }

    incomingCallOverlayHintTimer = window.setTimeout(() => {
      incomingCallOverlayHintTimer = null;
      const now = Date.now();
      if (detectIncomingCallOverlayVisibleForHint()) {
        incomingCallOverlayHintLastVisibleAt = now;
        sendIncomingCallOverlayHint(true, `${reason}-refresh`);
        scheduleIncomingCallOverlayHintRecheck("incoming-call-timeout");
        return;
      }

      if (shouldKeepIncomingCallOverlayHintActive(now)) {
        sendIncomingCallOverlayHint(true, `${reason}-hold`);
        scheduleIncomingCallOverlayHintRecheck("incoming-call-timeout");
        return;
      }

      sendIncomingCallOverlayHint(false, "incoming-call-timeout-clear");
      incomingCallOverlayHintStartedAt = 0;
      incomingCallOverlayHintLastVisibleAt = 0;
      clearIncomingCallOverlayHintTimers();
    }, INCOMING_CALL_OVERLAY_HINT_RECHECK_MS);
  };

  const ensureIncomingCallOverlayHintHeartbeat = (): void => {
    if (incomingCallOverlayHintHeartbeatTimer !== null) {
      return;
    }

    incomingCallOverlayHintHeartbeatTimer = window.setInterval(() => {
      const now = Date.now();
      if (detectIncomingCallOverlayVisibleForHint()) {
        incomingCallOverlayHintLastVisibleAt = now;
        sendIncomingCallOverlayHint(true, "incoming-call-heartbeat");
        scheduleIncomingCallOverlayHintRecheck("incoming-call-heartbeat");
        return;
      }

      if (shouldKeepIncomingCallOverlayHintActive(now)) {
        sendIncomingCallOverlayHint(true, "incoming-call-heartbeat-hold");
        scheduleIncomingCallOverlayHintRecheck("incoming-call-heartbeat-hold");
        return;
      }

      sendIncomingCallOverlayHint(false, "incoming-call-heartbeat-clear");
      incomingCallOverlayHintStartedAt = 0;
      incomingCallOverlayHintLastVisibleAt = 0;
      clearIncomingCallOverlayHintTimers();
    }, INCOMING_CALL_OVERLAY_HINT_HEARTBEAT_MS);
  };

  window.addEventListener("beforeunload", () => {
    const hadTimers =
      incomingCallOverlayHintTimer !== null ||
      incomingCallOverlayHintHeartbeatTimer !== null;
    clearIncomingCallOverlayHintTimers();
    incomingCallOverlayHintStartedAt = 0;
    incomingCallOverlayHintLastVisibleAt = 0;
    if (hadTimers) {
      sendIncomingCallOverlayHint(false, "incoming-call-beforeunload");
    }
  });

  // Also listen for messages (fallback)
  window.addEventListener("message", (event: MessageEvent) => {
    // Only process messages from the same origin (our injected script)
    if (event.data && typeof event.data === "object") {
      // Handle both 'electron-notification' (from bridge) and 'notification' (from fallback)
      if (
        event.data.type === "electron-notification" ||
        event.data.type === "notification"
      ) {
        const data = event.data.data;
        try {
          console.log("[Preload Bridge] Received electron-notification", {
            title: data?.title,
            hasIcon: Boolean(data?.icon),
            tag: data?.tag,
            id: data?.id,
          });
        } catch {
          /* intentionally empty */
        }

        // Convert icon if it's a data URL
        if (data.icon) {
          const image = new Image();
          image.crossOrigin = "anonymous";

          image.addEventListener("load", () => {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (context) {
              canvas.width = image.width;
              canvas.height = image.height;
              context.drawImage(image, 0, 0);

              const iconDataUrl = canvas.toDataURL();
              ipcRenderer.send("show-notification", {
                title: data.title,
                body: data.body,
                icon: iconDataUrl,
                tag: data.tag,
                silent: data.silent,
                id: data.id,
                href: data.href, // Pass conversation URL for click navigation
              });
              try {
                console.log(
                  "[Preload Bridge] Sent notification with icon to main",
                  { id: data.id, title: data.title, href: data.href },
                );
              } catch {
                /* intentionally empty */
              }
            }
          });

          image.addEventListener("error", () => {
            // If image loading fails, send without icon
            ipcRenderer.send("show-notification", {
              title: data.title,
              body: data.body,
              tag: data.tag,
              silent: data.silent,
              id: data.id,
              href: data.href, // Pass conversation URL for click navigation
            });
            try {
              console.warn(
                "[Preload Bridge] Icon load failed, sent without icon",
                { id: data.id, title: data.title, href: data.href },
              );
            } catch {
              /* intentionally empty */
            }
          });

          image.src = data.icon;
        } else {
          // No icon, send directly
          ipcRenderer.send("show-notification", {
            title: data.title,
            body: data.body,
            tag: data.tag,
            silent: data.silent,
            id: data.id,
            href: data.href, // Pass conversation URL for click navigation
          });
          try {
            console.log(
              "[Preload Bridge] Sent notification without icon to main",
              { id: data.id, title: data.title, href: data.href },
            );
          } catch {
            /* intentionally empty */
          }
        }
      } else if (event.data.type === "electron-fallback-log") {
        try {
          ipcRenderer.send("log-fallback", event.data.data);
        } catch {
          /* intentionally empty */
        }
      } else if (event.data.type === "electron-incoming-call-debug") {
        try {
          ipcRenderer.send("incoming-call-debug", event.data.data);
        } catch {
          /* intentionally empty */
        }
      } else if (event.data.type === "electron-badge-update") {
        // Handle badge count updates from page context
        const count = event.data.count;
        if (typeof count === "number") {
          console.log(
            `[Preload Bridge] Received badge update from page context: ${count}`,
          );
          ipcRenderer.send("update-unread-count", count);
        }
      } else if (event.data.type === "electron-incoming-call") {
        // Handle incoming call detection from page context
        const incomingCallDataRaw =
          event.data && typeof event.data.data === "object" && event.data.data
            ? event.data.data
            : {};
        const incomingCallData = {
          dedupeKey:
            typeof incomingCallDataRaw.dedupeKey === "string"
              ? incomingCallDataRaw.dedupeKey
              : undefined,
          caller:
            typeof incomingCallDataRaw.caller === "string"
              ? incomingCallDataRaw.caller
              : undefined,
          source:
            typeof incomingCallDataRaw.source === "string"
              ? incomingCallDataRaw.source
              : undefined,
          recoveryActive: incomingCallDataRaw.recoveryActive === true,
          evidence:
            incomingCallDataRaw.evidence &&
            typeof incomingCallDataRaw.evidence === "object"
              ? incomingCallDataRaw.evidence
              : undefined,
        };

        console.log(
          "[Preload Bridge] Incoming call detected - signaling main process",
          incomingCallData,
        );
        ipcRenderer.send("incoming-call", incomingCallData);

        const evidence =
          incomingCallData.evidence &&
          typeof incomingCallData.evidence === "object"
            ? incomingCallData.evidence
            : null;

        const overlayVisibleNow = detectIncomingCallOverlayVisibleForHint();
        if (
          shouldActivateIncomingCallHint({
            evidence,
            overlayVisibleNow,
          })
        ) {
          // Force-disable header crop so in-page incoming call controls stay visible
          // while Messenger animates in. Keep hint sticky for a grace window even if
          // controls temporarily disappear during UI reflows.
          const now = Date.now();
          incomingCallOverlayHintStartedAt = now;
          incomingCallOverlayHintLastVisibleAt = now;
          sendIncomingCallOverlayHint(true, "incoming-call-detected");
          ensureIncomingCallOverlayHintHeartbeat();
          scheduleIncomingCallOverlayHintRecheck("incoming-call-detected");
        }
      } else if (event.data.type === "electron-incoming-call-ended") {
        const incomingCallEndedRaw =
          event.data && typeof event.data.data === "object" && event.data.data
            ? event.data.data
            : {};
        const endedReason =
          typeof incomingCallEndedRaw.reason === "string"
            ? incomingCallEndedRaw.reason
            : "incoming-call-ended";

        const now = Date.now();
        const overlayStillVisible = detectIncomingCallOverlayVisibleForHint();
        const softEndSignal = /controls-disappeared/i.test(endedReason);

        try {
          ipcRenderer.send("incoming-call-ended", { reason: endedReason });
        } catch {
          /* intentionally empty */
        }

        if (softEndSignal && overlayStillVisible) {
          if (overlayStillVisible) {
            incomingCallOverlayHintLastVisibleAt = now;
          }
          console.log(
            "[Preload Bridge] Incoming call end signal deferred (overlay still/sticky)",
            { reason: endedReason, overlayStillVisible },
          );
          sendIncomingCallOverlayHint(
            true,
            `incoming-call-ended-deferred:${endedReason}`,
          );
          ensureIncomingCallOverlayHintHeartbeat();
          scheduleIncomingCallOverlayHintRecheck(
            "incoming-call-ended-deferred",
          );
        } else {
          console.log(
            "[Preload Bridge] Incoming call ended - clearing overlay hint",
            { reason: endedReason, overlayStillVisible },
          );
          clearIncomingCallOverlayHintTimers();
          incomingCallOverlayHintStartedAt = 0;
          incomingCallOverlayHintLastVisibleAt = 0;
          sendIncomingCallOverlayHint(
            false,
            `incoming-call-ended:${endedReason}`,
          );
        }
      } else if (event.data.type === "electron-recount-badge") {
        // Handle badge recount request from injected script (issue #38)
        console.log(
          "[Preload Bridge] Badge recount requested - triggering DOM count",
        );
        // Dispatch custom event that the badge monitor will catch
        document.dispatchEvent(
          new CustomEvent("electron-badge-recount-request", { detail: {} }),
        );
      }
    }
  });
})();

// Track mouse position for menu bar hover (Windows/Linux only)
// We use screenY and window.screenY to calculate position relative to window top
// This is more reliable than clientY which starts at the web content area
if (process.platform !== "darwin") {
  let lastInHoverZone = false;
  const HOVER_ZONE = 10; // Pixels from top of window content area

  function setupMouseTracking() {
    document.addEventListener("mousemove", (event: MouseEvent) => {
      // Use clientY - position within the viewport/web content
      const y = event.clientY;

      // Detect if mouse is near the top of the content area
      const inHoverZone = y <= HOVER_ZONE;

      // Only send updates when state changes (to avoid spam)
      if (inHoverZone !== lastInHoverZone) {
        lastInHoverZone = inHoverZone;
        if (window.electronAPI && window.electronAPI.sendMousePosition) {
          window.electronAPI.sendMousePosition(y);
        }
      }
    });
  }

  // Set up mouse tracking when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupMouseTracking);
  } else {
    setupMouseTracking();
  }
}

// Legacy Notification override (kept as fallback, but main injection happens after page load)
// This must happen immediately and be non-configurable to prevent site scripts from overriding it
(function () {
  "use strict";

  // Store original Notification constructor if it exists
  const _OriginalNotification = window.Notification;

  // Create a robust Notification override
  function createNotificationOverride() {
    class ElectronNotification {
      public title: string;
      public body: string;
      public tag?: string;
      private options: NotificationOptions;
      private listeners: Map<string, EventListener[]> = new Map();

      constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options || {};
        this.tag = this.options.tag;
        this.body = this.options.body || "";

        console.log("[Notification Override] Creating notification:", {
          title,
          body: this.body,
          tag: this.tag,
        });

        // Intentionally suppress this legacy fallback path.
        // Notifications are handled by notifications-inject.ts with mute filters.
      }

      addEventListener(event: string, listener: EventListener | null) {
        if (!listener) return;
        if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(listener);
      }

      removeEventListener(event: string, listener: EventListener | null) {
        if (!listener) return;
        const listeners = this.listeners.get(event);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index > -1) {
            listeners.splice(index, 1);
          }
        }
      }

      close() {
        // Notification closed
      }

      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve("granted");
      }

      static get permission(): NotificationPermission {
        return "granted";
      }

      // Some scripts assign to Notification.permission; include a no-op setter to avoid TypeErrors
      static set permission(_value: NotificationPermission) {
        // ignore
      }
    }

    return ElectronNotification;
  }

  const ElectronNotification = createNotificationOverride();

  // Replace window.Notification immediately and make it non-configurable
  try {
    // Delete existing Notification if it exists and is configurable
    const existingDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "Notification",
    );
    if (existingDescriptor && existingDescriptor.configurable) {
      delete (window as any).Notification;
    }

    Object.defineProperty(window, "Notification", {
      value: ElectronNotification,
      writable: false,
      configurable: false,
      enumerable: true,
    });

    // Note: We don't need to define the prototype property - it's already
    // read-only on class constructors and cannot be reassigned

    console.log(
      "[Notification Override] Successfully overridden Notification API",
    );
  } catch (e) {
    // If defineProperty fails, we can't safely assign a class constructor directly
    // as it may cause prototype errors. Log the error and continue.
    console.error(
      "[Notification Override] Failed to override Notification API:",
      e,
    );
    console.warn(
      "[Notification Override] Notifications may not work correctly",
    );
  }

  // Continuously monitor and re-override if site scripts try to change it
  let _overrideCheckInterval: number | null = null;

  function ensureOverride() {
    // Check if Notification was changed by comparing constructor name or instance
    const currentNotification = (window as any).Notification;

    // If it's already our notification, don't do anything
    if (currentNotification === ElectronNotification) {
      return;
    }

    // Check if it has our class name
    if (
      currentNotification &&
      currentNotification.name === "ElectronNotification"
    ) {
      return;
    }

    // Only try to override if it's actually different
    console.log(
      "[Notification Override] Detected Notification was changed, re-overriding...",
    );

    // Check if the property is configurable
    const descriptor = Object.getOwnPropertyDescriptor(window, "Notification");
    if (descriptor && !descriptor.configurable) {
      // If it's non-configurable and not ours, we can't change it
      // This shouldn't happen if our initial override worked, but handle it gracefully
      console.warn(
        "[Notification Override] Cannot override - property is non-configurable",
      );
      return;
    }

    try {
      // If property exists and is configurable, delete it first to avoid conflicts
      if (descriptor && descriptor.configurable) {
        delete (window as any).Notification;
      }

      Object.defineProperty(window, "Notification", {
        value: ElectronNotification,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch (e) {
      // If defineProperty fails completely, log the error but don't try direct assignment
      // Direct assignment of class constructors can cause prototype errors
      console.warn("[Notification Override] Failed to re-override:", e);
    }
  }

  // Check periodically to ensure override stays in place (every 2 seconds)
  _overrideCheckInterval = window.setInterval(ensureOverride, 2000);

  // Also override when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureOverride();
    });
  } else {
    ensureOverride();
  }

  // Monitor unread count and keep app badge state synchronized.
  // Simplified strategy:
  // 1) Use sidebar DOM count as the only unread source of truth
  // 2) If sidebar is unavailable, hold the last computed count
  // 3) Defer clearing to 0 while app is unfocused (preserves unread signal)
  function monitorUnreadCount() {
    type DomUnreadCountResult = {
      count: number;
      sidebarFound: boolean;
      totalRows: number;
      countedRows: number;
    };

    type UnreadSnapshot = {
      source: "dom" | "hold";
      chosenCount: number;
      dom: DomUnreadCountResult;
    };

    const chatLinkSelector = 'a[href*="/t/"], a[href*="/e2ee/t/"]';
    const unreadIndicatorSelector =
      '[aria-label*="Mark as read" i], [aria-label*="Unread message" i]';

    let lastSentCount = -1;
    let deferredZeroWhileUnfocused = false;
    let recountTimer: number | null = null;
    let pendingTrigger = "startup";

    const isAppFocused = (): boolean => {
      return document.hasFocus() && document.visibilityState === "visible";
    };

    const normalizeConversationPath = (raw: string): string | null => {
      try {
        const url =
          raw.startsWith("http://") || raw.startsWith("https://")
            ? new URL(raw)
            : new URL(raw, window.location.origin);
        const path =
          (url.pathname || "/").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
        return path
          .replace(/^\/messages\/e2ee\/t\//, "/t/")
          .replace(/^\/messages\/t\//, "/t/")
          .replace(/^\/e2ee\/t\//, "/t/");
      } catch {
        return null;
      }
    };

    const isConversationUnread = (conversationEl: Element): boolean => {
      const textContent = conversationEl.textContent || "";
      if (textContent.includes("Unread message:")) {
        return true;
      }

      const ariaLabel = (
        conversationEl.getAttribute("aria-label") || ""
      ).toLowerCase();
      if (ariaLabel.includes("unread message")) {
        return true;
      }

      return Boolean(conversationEl.querySelector(unreadIndicatorSelector));
    };

    const isConversationMuted = (conversationEl: Element): boolean => {
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
          return true;
        }
      }

      const useNodes = Array.from(conversationEl.querySelectorAll("svg use"));
      for (const useNode of useNodes) {
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
          return true;
        }
      }

      const labelSources: string[] = [];
      const pushLabel = (value: string | null | undefined): void => {
        const text = value?.trim();
        if (text) {
          labelSources.push(text.toLowerCase());
        }
      };

      pushLabel(conversationEl.textContent);
      pushLabel(conversationEl.getAttribute("aria-label"));
      pushLabel(conversationEl.getAttribute("title"));
      pushLabel(conversationEl.getAttribute("data-tooltip-content"));

      const metaNodes = conversationEl.querySelectorAll(
        "[aria-label], [title], [data-tooltip-content], [data-tooltip], img[alt]",
      );
      metaNodes.forEach((node) => {
        pushLabel(node.getAttribute("aria-label"));
        pushLabel(node.getAttribute("title"));
        pushLabel(node.getAttribute("data-tooltip-content"));
        pushLabel(node.getAttribute("data-tooltip"));
        if (node instanceof HTMLImageElement) {
          pushLabel(node.alt);
        }
      });

      return labelSources.some(
        (text) =>
          text.includes("muted") ||
          text.includes("notifications are off") ||
          text.includes("notifications off") ||
          text.includes("notification off") ||
          text.includes("unmute"),
      );
    };

    const findSidebarElement = (): Element | null => {
      const navigationSidebar = document.querySelector(
        '[role="navigation"]:has([role="grid"])',
      );
      if (navigationSidebar) return navigationSidebar;

      const chatsGrid = document.querySelector(
        '[role="grid"][aria-label="Chats"]',
      );
      if (chatsGrid) {
        return chatsGrid.closest('[role="navigation"]') || chatsGrid;
      }

      return null;
    };

    const countUnreadConversations = (): DomUnreadCountResult => {
      try {
        const sidebar = findSidebarElement();
        if (!sidebar) {
          return {
            count: -1,
            sidebarFound: false,
            totalRows: 0,
            countedRows: 0,
          };
        }

        const rowsFromLinks = new Set<Element>();
        sidebar.querySelectorAll(chatLinkSelector).forEach((link) => {
          const row =
            link.closest('[role="row"]') || link.closest('[role="listitem"]');
          if (row && sidebar.contains(row)) {
            rowsFromLinks.add(row);
          }
        });

        const fallbackRows = Array.from(
          sidebar.querySelectorAll('[role="row"], [role="listitem"]'),
        ).filter((row) => row.querySelector(chatLinkSelector));

        const rows = Array.from(
          new Set(
            rowsFromLinks.size > 0 ? Array.from(rowsFromLinks) : fallbackRows,
          ),
        ).filter((row) => {
          const el = row as HTMLElement;
          if (el.getAttribute("aria-hidden") === "true") return false;
          if (el.closest('[aria-hidden="true"]')) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          return el.getClientRects().length > 0;
        });

        const currentConversationPath = normalizeConversationPath(
          window.location.pathname,
        );
        const focused = isAppFocused();

        let count = 0;
        const seenConversationPaths = new Set<string>();

        rows.forEach((conversationEl) => {
          const link = conversationEl.querySelector(
            chatLinkSelector,
          ) as HTMLAnchorElement | null;
          if (!link) return;

          const href = link.getAttribute("href") || link.href;
          if (!href) return;

          const conversationPath = normalizeConversationPath(href);
          if (!conversationPath) return;

          if (!isConversationUnread(conversationEl)) return;
          if (isConversationMuted(conversationEl)) return;

          // Do not count the active conversation while app is focused.
          if (
            focused &&
            currentConversationPath &&
            conversationPath === currentConversationPath
          ) {
            return;
          }

          if (seenConversationPaths.has(conversationPath)) return;
          seenConversationPaths.add(conversationPath);
          count += 1;
        });

        return {
          count,
          sidebarFound: true,
          totalRows: rows.length,
          countedRows: seenConversationPaths.size,
        };
      } catch {
        return {
          count: -1,
          sidebarFound: false,
          totalRows: 0,
          countedRows: 0,
        };
      }
    };

    const computeSnapshot = (): UnreadSnapshot => {
      const dom = countUnreadConversations();

      if (dom.sidebarFound) {
        return {
          source: "dom",
          chosenCount: Math.max(0, dom.count),
          dom,
        };
      }

      // Sidebar unavailable (loading/transient route): keep last known count.
      return {
        source: "hold",
        chosenCount: Math.max(0, lastSentCount),
        dom,
      };
    };

    const sendBadgeUpdate = (
      nextCount: number,
      trigger: string,
      snapshot: UnreadSnapshot,
    ): void => {
      if (nextCount === 0 && lastSentCount > 0 && !isAppFocused()) {
        deferredZeroWhileUnfocused = true;
        console.log("[BadgeMonitor] Deferring clear while unfocused", {
          trigger,
          lastSentCount,
          domCount: snapshot.dom.count,
          source: snapshot.source,
        });
        return;
      }

      if (nextCount > 0) {
        deferredZeroWhileUnfocused = false;
      }

      if (nextCount === lastSentCount) {
        return;
      }

      lastSentCount = nextCount;
      console.log("[BadgeMonitor] Sending badge update", {
        trigger,
        count: nextCount,
        source: snapshot.source,
        domCount: snapshot.dom.count,
        sidebarFound: snapshot.dom.sidebarFound,
        rows: `${snapshot.dom.countedRows}/${snapshot.dom.totalRows}`,
      });
      window.postMessage(
        { type: "electron-badge-update", count: nextCount },
        "*",
      );
    };

    const runRecount = (trigger: string): void => {
      const snapshot = computeSnapshot();

      if (
        deferredZeroWhileUnfocused &&
        isAppFocused() &&
        snapshot.chosenCount === 0
      ) {
        deferredZeroWhileUnfocused = false;
      }

      sendBadgeUpdate(snapshot.chosenCount, trigger, snapshot);
    };

    const scheduleRecount = (trigger: string, delayMs = 120): void => {
      pendingTrigger = trigger;
      if (recountTimer !== null) {
        clearTimeout(recountTimer);
      }
      recountTimer = window.setTimeout(() => {
        recountTimer = null;
        runRecount(pendingTrigger);
      }, delayMs);
    };

    // Observe title changes only as a recount trigger (not as a count source).
    const titleObserver = new MutationObserver(() => {
      scheduleRecount("title-change", 60);
    });
    titleObserver.observe(document.querySelector("title") || document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Observe DOM changes to catch unread state transitions.
    const domObserver = new MutationObserver(() => {
      scheduleRecount("dom-mutation", 150);
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "class"],
    });

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        scheduleRecount("visibility", 50);
      }
    };

    const handleFocus = (): void => {
      scheduleRecount("focus", 40);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    // Messenger is SPA; detect in-app route changes.
    let lastUrl = window.location.href;
    const onUrlMaybeChanged = (trigger: string): void => {
      const currentUrl = window.location.href;
      if (currentUrl === lastUrl) return;
      lastUrl = currentUrl;
      scheduleRecount(trigger, 80);
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(history, args);
      window.setTimeout(() => onUrlMaybeChanged("pushstate"), 50);
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(history, args);
      window.setTimeout(() => onUrlMaybeChanged("replacestate"), 50);
    };

    window.addEventListener("popstate", () => {
      window.setTimeout(() => onUrlMaybeChanged("popstate"), 50);
    });

    const scheduleRecountBurst = (trigger: string, delays: number[]): void => {
      delays.forEach((delay) => {
        window.setTimeout(() => {
          runRecount(`${trigger}:${delay}`);
        }, delay);
      });
    };

    const isMarkUnreadReadAction = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      const actionEl = target.closest(
        '[role="menuitem"], [role="button"], button, [aria-label], [title]',
      );
      if (!actionEl) return false;

      const text = `${actionEl.getAttribute("aria-label") || ""} ${
        actionEl.getAttribute("title") || ""
      } ${actionEl.textContent || ""}`
        .toLowerCase()
        .replace(/\s+/g, " ");

      return (
        text.includes("mark as unread") ||
        text.includes("mark unread") ||
        text.includes("mark as read") ||
        text.includes("mark read")
      );
    };

    // Trigger recounts when user is active anywhere in Messages.
    let activityTimer: number | null = null;
    const scheduleActivityRecount = (): void => {
      if (!window.location.pathname.includes("/messages")) {
        return;
      }
      if (activityTimer !== null) {
        clearTimeout(activityTimer);
      }
      activityTimer = window.setTimeout(() => {
        activityTimer = null;
        scheduleRecount("activity", 40);
      }, 400);
    };

    document.addEventListener(
      "click",
      (event) => {
        scheduleActivityRecount();
        if (isMarkUnreadReadAction(event.target)) {
          // Mark unread/read is often applied asynchronously after the context menu closes.
          // Burst recounts to make dock/taskbar badge update feel immediate.
          scheduleRecountBurst("mark-toggle", [40, 180, 450, 900]);
        }
      },
      { passive: true, capture: true },
    );

    document.addEventListener(
      "keydown",
      (event) => {
        scheduleActivityRecount();
        if (
          (event.key === "Enter" || event.key === " ") &&
          isMarkUnreadReadAction(event.target)
        ) {
          scheduleRecountBurst("mark-toggle-key", [40, 180, 450, 900]);
        }
      },
      { passive: true, capture: true },
    );

    // Recount requested by injected notifications script.
    document.addEventListener(
      "electron-badge-recount-request",
      () => {
        scheduleRecount("requested", 20);
      },
      { passive: true },
    );

    // Catch cross-device read state changes.
    window.setInterval(() => {
      scheduleRecount("periodic", 0);
    }, 30000);

    // Initial recount after startup settle.
    scheduleRecount("startup", 250);
  }

  // Wait for DOM to be ready, then wait a bit more for electronAPI to be available
  function startMonitoring() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        // Wait a bit for contextBridge to complete
        setTimeout(monitorUnreadCount, 100);
      });
    } else {
      // Wait a bit for contextBridge to complete
      setTimeout(monitorUnreadCount, 100);
    }
  }

  startMonitoring();
})();

// Type definitions for TypeScript
declare global {
  interface Window {
    electronAPI: {
      showNotification: (data: {
        title: string;
        body: string;
        icon?: string;
        tag?: string;
        silent?: boolean;
      }) => void;
      sendMousePosition: (y: number) => void;
      updateUnreadCount: (count: number) => void;
      clearBadge: () => void;
      incomingCall: () => void;
      onNotificationAction: (
        callback: (action: string, data: any) => void,
      ) => void;
      testNotification: () => void;
    };
  }
}
