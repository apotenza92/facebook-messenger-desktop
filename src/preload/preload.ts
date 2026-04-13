import { contextBridge, ipcRenderer } from "electron";
import {
  type FacebookHeaderSuppressionMode,
  resolveEffectiveFacebookHeaderSuppressionMode,
  resolveFacebookHeaderSuppressionMode,
  shouldKeepFacebookHeaderSuppressionActive,
} from "./facebook-header-suppression-policy";
import {
  type MessagesViewportMode,
  type MessagesViewportStatePayload,
  resolveMessagesViewportState,
  resolveViewportMode,
} from "./messages-viewport-policy";
import {
  getIncomingCallHintClearReason,
  shouldActivateIncomingCallHint,
  shouldKeepIncomingCallHintActive,
  shouldTreatIncomingCallUiAsVisible,
} from "./incoming-call-overlay-hint-policy";
import {
  decideWindowOpenAction,
  resolveWrappedNavigationTarget,
  shouldAllowMarketplaceActionInApp,
} from "./url-policy";
import {
  dismissActionSelectors,
  mediaDownloadSelectors,
  mediaNavigationSelectors,
  mediaShareSelectors,
} from "./media-action-policy";
import {
  evaluateMediaOverlayVisible,
  type MediaOverlaySignals,
} from "./media-overlay-policy";
import {
  collectMarketplaceThreadHintSignals,
  doesMarketplaceThreadBackAnchorMatch,
  doesMarketplaceThreadFreshHeaderPairMatch,
  doesMarketplaceThreadHeaderBandMatch,
  doesMarketplaceThreadRouteChangeWeakHeaderMatch,
  hasMarketplaceThreadHeaderSignal,
  isMarketplaceThreadBackHint,
  isMarketplaceThreadHeaderHint,
  resolveMarketplaceCurrentEvidenceClass,
  resolveMarketplaceOrdinaryClearBlockedReason,
  resolveMarketplaceVisualSessionDecision,
  resolvePendingBootstrapRouteChangeBridgeReason,
  resolveWeakMarketplaceBootstrapDecision,
  type MarketplaceCurrentEvidenceClass,
  type MarketplaceOrdinaryClearBlockedReason,
  type MarketplaceRouteChangePendingBridgeReason,
  type MarketplaceSessionConfirmationKind,
  type MarketplaceSessionLifecycleReason,
  type MarketplaceSessionSignalSource,
  type MarketplaceThreadHeaderBand,
  type MarketplaceVisualSessionRejectionReason,
  type MarketplaceVisualSessionState,
  type MarketplaceWeakBootstrapState,
} from "./marketplace-thread-policy";

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

// Hide Facebook global chrome inside Messenger routes without shifting the
// entire viewport. This keeps media and call controls in their native positions.
(function setupMessagesViewportCompensation() {
  const isDesktop =
    process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux";
  if (!isDesktop) return;

  const STYLE_ID = "md-fb-messages-viewport-fix-style";
  const ACTIVE_CLASS = "md-fb-messages-viewport-fix";
  const COLLAPSE_CLASS = "md-fb-messages-header-collapsed";
  const HEADER_HIDDEN_ATTR = "data-md-fb-header-suppression";
  const HIDDEN_CHROME_ATTR = "data-md-fb-hidden-chrome";
  const SHELL_STRETCH_ATTR = "data-md-fb-shell-stretch";
  const SHELL_TARGET_HEIGHT_VAR = "--md-fb-shell-target-height";
  const MEDIA_OVERLAY_TRANSITION_MS = 50;
  const VIEWPORT_STATE_SEND_DEBOUNCE_MS = 30;
  const COMPOSER_INTERACTION_PAUSE_MS = 2500;
  const MAX_ACTION_NODE_DIMENSION = 160;
  const MEDIA_OVERLAY_DEBUG_CHANNEL = "media-overlay-debug";
  const MEDIA_OVERLAY_DEBUG_COOLDOWN_MS = 120;
  const MARKETPLACE_SESSION_DOM_GRACE_MS = 2_500;
  const MARKETPLACE_ROUTE_CHANGE_RESCUE_MS = 1_800;
  const MARKETPLACE_WEAK_BOOTSTRAP_SETTLE_MS = 10_000;
  const MARKETPLACE_WEAK_BOOTSTRAP_REQUIRED_PASSES = 2;
  const MARKETPLACE_WEAK_BOOTSTRAP_MIN_CONFIRM_AGE_MS = 800;
  const MARKETPLACE_POST_CONFIRM_GRACE_MS = 1_500;
  const MARKETPLACE_ORDINARY_CLEAR_MIN_AGE_MS = 2_500;
  const MARKETPLACE_ORDINARY_CLEAR_REQUIRED_PASSES = 3;

  const INCOMING_CALL_HINT_MIN_STICKY_MS = 4_000;
  const INCOMING_CALL_HINT_MISSING_CLEAR_MS = 2_000;
  const INCOMING_CALL_HINT_MAX_WITHOUT_DETECTION_MS = 10_000;
  const DEFAULT_MESSAGES_HEADER_HEIGHT = 56;
  const HEADER_SUPPRESSION_REAPPLY_GRACE_MS = 600;

  let pendingApply = false;
  let mediaOverlayVisible = false;
  let forcedMediaOverlayVisible: boolean | null = null;
  let incomingCallOverlayHintActive = false;
  let incomingCallHintActivatedAt = 0;
  let incomingCallLastDetectedAt = 0;
  let incomingCallDetectedSinceHint = false;
  let mediaOverlayTransitionTimer: number | null = null;
  let viewportStateSendTimer: number | null = null;
  let composerInteractionPauseUntil = 0;
  let composerInteractionRecoveryTimer: number | null = null;
  let viewportRecoveryTimerIds: number[] = [];
  let lastSentViewportState: MessagesViewportStatePayload | null = null;
  let lastViewportMode: MessagesViewportMode | null = null;
  let lastMediaOverlayDebugSentAt = 0;
  let lastMarketplaceThreadDebugSignature = "";
  let lastHeaderSuppressionDebugSignature = "";
  let lastHeaderSuppressionState: Record<string, unknown> = {
    active: false,
    bannerCount: 0,
    hiddenBannerCount: 0,
    hiddenChromeCount: 0,
    mode: "off",
  };
  type MarketplaceThreadDebugState = {
    routeEligible: boolean;
    marketplaceThreadVisible: boolean;
    rightPaneMarketplaceSignalDetected: boolean;
    rightPaneItemLinkDetected: boolean;
    headerMarketplaceDetected: boolean;
    headerBackDetected: boolean;
    headerBackMarketplaceDetected: boolean;
    headerOrdinaryChatDetected: boolean;
    headerContainerTop: number | null;
    headerContainerBottom: number | null;
    headerContainerLeft: number | null;
    headerContainerRight: number | null;
    weakHeaderBand: MarketplaceThreadHeaderBand | null;
    weakHeaderMatchesSessionHeaderBand: boolean;
    headerBackMatchesSessionHeaderBand: boolean;
    sameRouteMarketplaceBackAnchorDetected: boolean;
    visualCropHeight: number | null;
    marketplaceSessionActive: boolean;
    marketplaceSessionRouteKey: string | null;
    marketplaceSessionConfirmationKind: MarketplaceSessionConfirmationKind | null;
    marketplaceSessionSignalSource: MarketplaceSessionSignalSource | null;
    marketplaceSessionLifecycleReason: MarketplaceSessionLifecycleReason | null;
    marketplaceSessionTransition: string;
    marketplaceSessionRejectionReason: MarketplaceVisualSessionRejectionReason | null;
    marketplaceSessionHeaderBand: MarketplaceThreadHeaderBand | null;
    marketplaceLastConfirmedAgeMs: number | null;
    marketplaceLastStrongConfirmedAgeMs: number | null;
    marketplaceCurrentEvidenceClass: MarketplaceCurrentEvidenceClass;
    marketplacePostConfirmGraceActive: boolean;
    marketplaceOrdinaryClearBlockedReason: MarketplaceOrdinaryClearBlockedReason | null;
    weakBootstrapSettled: boolean;
    weakBootstrapPendingSignalSource: Extract<
      MarketplaceSessionSignalSource,
      "right-pane-action" | "item-link"
    > | null;
    weakBootstrapStablePasses: number;
    weakBootstrapFirstSeenAgeMs: number | null;
    weakBootstrapConfirmationEligible: boolean;
    routeChangeDetected: boolean;
    routeChangeRecentMarketplaceMatch: boolean;
    routeChangeWeakHeaderMatchesPreviousSession: boolean;
    routeChangePendingBootstrapBridgeReason: MarketplaceRouteChangePendingBridgeReason | null;
    routeChangePendingBootstrapWouldBridge: boolean;
    routeChangeRescuePending: boolean;
    routeChangeRescueExpiresInMs: number | null;
    routeChangeRescueStartedAgeMs: number | null;
    ordinaryClearPending: boolean;
    ordinaryClearStablePasses: number;
    ordinaryClearEligible: boolean;
    ordinaryClearLastMarketplaceMatchAgeMs: number | null;
    matchedSignals: string[];
  };
  type MarketplaceOrdinaryClearState = {
    routeKey: string;
    stablePasses: number;
    lastSeenAt: number;
  };
  type MediaHeaderOverlayKind =
    | "menu"
    | "messenger"
    | "notifications"
    | "account";
  type HeaderSuppressionSnapshot = {
    active: boolean;
    shouldCollapse: boolean;
    bannerCount: number;
    hiddenBannerCount: number;
    hiddenChromeCount: number;
    mode: FacebookHeaderSuppressionMode;
    requestedMode: FacebookHeaderSuppressionMode;
    hasFacebookNavSignal: boolean;
    preservedMessengerControlsDetected: boolean;
    reusedIncomingSafeMode: boolean;
    incomingCallOverlayHintActive: boolean;
    collapseHeight: number;
    bannerTargets: Array<{
      node: HTMLElement;
      mode: "hide-banner" | "hide-facebook-nav-descendants";
    }>;
    hiddenChromeTargets: HTMLElement[];
    shellTarget: HTMLElement | null;
    shellTargetHeight: number | null;
  };
  let activeMediaHeaderOverlayKind: MediaHeaderOverlayKind | null = null;
  let lastAppliedHeaderSuppressionSnapshot: HeaderSuppressionSnapshot | null =
    null;
  let lastHeaderSuppressionDetectedAt = 0;
  let marketplaceVisualSession: MarketplaceVisualSessionState | null = null;
  let marketplaceWeakBootstrapState: MarketplaceWeakBootstrapState | null = null;
  let marketplaceOrdinaryClearState: MarketplaceOrdinaryClearState | null = null;
  let lastInterceptedExternalNavigation:
    | {
        url: string;
        at: number;
      }
    | null = null;

  const MEDIA_HEADER_HOME_LINK_MAX_TOP = 140;
  const MEDIA_HEADER_HOME_LINK_MAX_LEFT = 240;
  const MEDIA_HEADER_OVERLAY_MIN_WIDTH = 140;
  const MEDIA_HEADER_OVERLAY_MIN_HEIGHT = 40;
  const MEDIA_HEADER_OVERLAY_MIN_LEFT_RATIO = 0.45;
  const MEDIA_HEADER_MENU_OVERLAY_MIN_LEFT_RATIO = 0.25;
  const MEDIA_HEADER_NON_NAVIGATION_LABEL_PATTERN =
    /\b(close|back|go back|download|share|forward|next|previous)\b/i;
  const MEDIA_HEADER_OVERLAY_HINTS: Record<
    MediaHeaderOverlayKind,
    RegExp[]
  > = {
    menu: [
      /\bmenu\b/i,
      /\bcreate\b/i,
      /\bfeeds?\b/i,
      /\bgroups?\b/i,
      /\bevents?\b/i,
    ],
    messenger: [
      /\bchats?\b/i,
      /\bsee all in messenger\b/i,
      /\bsearch messenger\b/i,
    ],
    notifications: [
      /\bnotifications?\b/i,
      /\bsee previous notifications\b/i,
      /\bsee all\b/i,
    ],
    account: [
      /\bsettings\s*&\s*privacy\b/i,
      /\bhelp\s*&\s*support\b/i,
      /\blog out\b/i,
      /\bdisplay\s*&\s*accessibility\b/i,
      /\bsee all profiles\b/i,
    ],
  };
  const MEDIA_HEADER_OVERLAY_LINK_HINTS: Record<
    MediaHeaderOverlayKind,
    RegExp[]
  > = {
    menu: [/\bevents?\b/i, /\bfriends?\b/i, /\bgroups?\b/i, /\bfeeds?\b/i],
    messenger: [/\bsee all in messenger\b/i, /\bsee all\b/i],
    notifications: [/\bsee all\b/i, /\bsee previous notifications\b/i],
    account: [/\bsee all profiles\b/i, /\bprivacy\b/i, /\bterms\b/i],
  };
  const MEDIA_HEADER_TOGGLE_PATTERNS: Array<{
    kind: MediaHeaderOverlayKind;
    pattern: RegExp;
  }> = [
    { kind: "menu", pattern: /\bmenu\b/i },
    { kind: "messenger", pattern: /\bmessenger\b/i },
    { kind: "notifications", pattern: /\bnotifications?\b/i },
    {
      kind: "account",
      pattern: /\b(account controls and settings|your profile|account)\b/i,
    },
  ];

  const isFacebookHost = (): boolean => {
    try {
      const hostname = new URL(window.location.href).hostname;
      return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
    } catch {
      return false;
    }
  };

  const findClosestAnchor = (
    target: EventTarget | null,
  ): HTMLAnchorElement | null => {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest("a[href]");
    return anchor instanceof HTMLAnchorElement ? anchor : null;
  };

  const rememberExternalOpen = (
    url: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void => {
    const payload = {
      url,
      reason,
      at: Date.now(),
      route: window.location.href,
      ...extra,
    };

    try {
      (
        window as Window & {
          __mdLastExternalNavigation?: Record<string, unknown>;
        }
      ).__mdLastExternalNavigation = payload;
    } catch {
      // Ignore debug state failures.
    }

    try {
      document.documentElement.setAttribute("data-md-last-external-url", url);
      document.documentElement.setAttribute(
        "data-md-last-external-reason",
        reason,
      );
      document.documentElement.setAttribute(
        "data-md-last-external-at",
        String(payload.at),
      );
    } catch {
      // Ignore DOM debug state failures.
    }
  };

  const openExternalUrl = (
    input: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void => {
    const url = resolveWrappedNavigationTarget(input) ?? input;
    lastInterceptedExternalNavigation = {
      url,
      at: Date.now(),
    };
    rememberExternalOpen(url, reason, extra);
    ipcRenderer.send("open-external-url", url);
  };

  const shouldSkipDuplicateExternalIntercept = (input: string): boolean => {
    const url = resolveWrappedNavigationTarget(input) ?? input;
    if (!lastInterceptedExternalNavigation) {
      return false;
    }

    return (
      lastInterceptedExternalNavigation.url === url &&
      Date.now() - lastInterceptedExternalNavigation.at <= 1500
    );
  };

  const isMediaRoute = (): boolean => resolveMode() === "media";

  const isFacebookHomeUrl = (input: string): boolean => {
    try {
      const parsed = new URL(input, window.location.origin);
      const hostname = parsed.hostname.toLowerCase();
      return (
        (hostname === "facebook.com" || hostname.endsWith(".facebook.com")) &&
        (parsed.pathname === "/" || parsed.pathname === "")
      );
    } catch {
      return false;
    }
  };

  const isMessagesThreadNavigationUrl = (input: string): boolean => {
    try {
      const parsed = new URL(input, window.location.origin);
      return /^\/messages\/(?:e2ee\/)?t\/?/i.test(parsed.pathname);
    } catch {
      return false;
    }
  };

  const getMediaHeaderToggleKind = (
    target: EventTarget | null,
  ): MediaHeaderOverlayKind | null => {
    if (!(target instanceof Element)) return null;

    const interactive =
      target.closest("button") ||
      target.closest('[role="button"]') ||
      target.closest("a[role='button']") ||
      target.closest("a[href]");
    if (!(interactive instanceof HTMLElement) || !isAriaVisible(interactive)) {
      return null;
    }

    const rect = interactive.getBoundingClientRect();
    if (
      rect.top > 72 ||
      rect.height > 80 ||
      rect.width > 220 ||
      rect.right < window.innerWidth - 260
    ) {
      return null;
    }

    const label = extractInteractiveLabel(target);
    if (!label) return null;

    for (const entry of MEDIA_HEADER_TOGGLE_PATTERNS) {
      if (entry.pattern.test(label)) {
        return entry.kind;
      }
    }

    return null;
  };

  const isMediaHeaderFacebookButton = (anchor: HTMLAnchorElement): boolean => {
    if (!isAriaVisible(anchor)) {
      return false;
    }

    const resolvedHref = resolveWrappedNavigationTarget(anchor.href) ?? anchor.href;
    if (!isFacebookHomeUrl(resolvedHref)) {
      return false;
    }

    const rect = anchor.getBoundingClientRect();
    if (rect.top > MEDIA_HEADER_HOME_LINK_MAX_TOP) {
      return false;
    }

    if (rect.left > MEDIA_HEADER_HOME_LINK_MAX_LEFT) {
      return false;
    }

    const label = normalizeLabelText(
      anchor.getAttribute("aria-label") ||
        anchor.getAttribute("title") ||
        anchor.textContent,
    );

    return /facebook/i.test(label) || rect.width >= 24;
  };

  const resolveMediaHeaderExternalBinding = (
    anchor: HTMLAnchorElement,
  ): {
    reason: string;
    extra?: Record<string, unknown>;
  } | null => {
    if (!isMediaRoute() || !isAriaVisible(anchor)) {
      return null;
    }

    const href = anchor.href;
    if (!href) {
      return null;
    }

    if (isMediaHeaderFacebookButton(anchor)) {
      return { reason: "media-facebook-button" };
    }

    const label = extractInteractiveLabel(anchor);
    if (
      MEDIA_HEADER_NON_NAVIGATION_LABEL_PATTERN.test(label) ||
      getMediaHeaderToggleKind(anchor)
    ) {
      return null;
    }

    const overlayContext = resolveMediaHeaderOverlayContext(anchor);
    if (overlayContext) {
      return {
        reason: "media-header-overlay-link",
        extra: { overlayKind: overlayContext.kind },
      };
    }

    const anchorRect = anchor.getBoundingClientRect();
    if (
      activeMediaHeaderOverlayKind &&
      anchorRect.left >= window.innerWidth * MEDIA_HEADER_OVERLAY_MIN_LEFT_RATIO &&
      !MEDIA_HEADER_NON_NAVIGATION_LABEL_PATTERN.test(label) &&
      (matchesMediaHeaderOverlayLink(activeMediaHeaderOverlayKind, label) ||
        activeMediaHeaderOverlayKind === "menu" ||
        activeMediaHeaderOverlayKind === "notifications" ||
        activeMediaHeaderOverlayKind === "account" ||
        (activeMediaHeaderOverlayKind === "messenger" &&
          (/\/messages\/(?:e2ee\/)?t\/?/i.test(href) ||
            /see all in messenger/i.test(label))))
    ) {
      return {
        reason: "media-header-overlay-link",
        extra: { overlayKind: activeMediaHeaderOverlayKind },
      };
    }

    if (
      isMessagesThreadNavigationUrl(href) &&
      anchorRect.left >= window.innerWidth * MEDIA_HEADER_OVERLAY_MIN_LEFT_RATIO &&
      anchorRect.top <= window.innerHeight * 0.45
    ) {
      return { reason: "media-thread-link" };
    }

    return null;
  };

  const resolveMediaHeaderOverlayContext = (
    target: Element | null,
  ): {
    kind: MediaHeaderOverlayKind;
    root: HTMLElement;
  } | null => {
    let current = target instanceof HTMLElement ? target : null;

    while (current instanceof HTMLElement && current !== document.body) {
      if (!isAriaVisible(current)) {
        current = current.parentElement;
        continue;
      }

      const rect = current.getBoundingClientRect();
      const hint = normalizeLabelText(
        [
          current.getAttribute("aria-label"),
          current.getAttribute("title"),
          current.textContent,
        ]
          .filter(Boolean)
          .join(" "),
      ).slice(0, 1000);

      for (const [kind, patterns] of Object.entries(
        MEDIA_HEADER_OVERLAY_HINTS,
      ) as Array<[MediaHeaderOverlayKind, RegExp[]]>) {
        const matches = patterns.some((pattern) => pattern.test(hint));
        if (!matches) {
          continue;
        }

        if (activeMediaHeaderOverlayKind && activeMediaHeaderOverlayKind !== kind) {
          continue;
        }

        const minLeftRatio =
          kind === "menu"
            ? MEDIA_HEADER_MENU_OVERLAY_MIN_LEFT_RATIO
            : MEDIA_HEADER_OVERLAY_MIN_LEFT_RATIO;
        if (
          rect.top > window.innerHeight - 24 ||
          rect.bottom < 24 ||
          rect.width < MEDIA_HEADER_OVERLAY_MIN_WIDTH ||
          rect.height < MEDIA_HEADER_OVERLAY_MIN_HEIGHT ||
          rect.left < window.innerWidth * minLeftRatio
        ) {
          continue;
        }

        return { kind, root: current };
      }

      current = current.parentElement;
    }

    return null;
  };

  const matchesMediaHeaderOverlayLink = (
    kind: MediaHeaderOverlayKind | null,
    label: string,
  ): boolean => {
    if (!kind || !label) {
      return false;
    }

    return MEDIA_HEADER_OVERLAY_LINK_HINTS[kind].some((pattern) =>
      pattern.test(label),
    );
  };

  const bindMediaHeaderExternalAnchors = (): void => {
    if (!isMediaRoute()) {
      return;
    }

    for (const candidate of Array.from(document.querySelectorAll("a[href]"))) {
      if (!(candidate instanceof HTMLAnchorElement)) {
        continue;
      }

      if (candidate.dataset.mdMediaHeaderExternalBound === "true") {
        continue;
      }

      if (!resolveMediaHeaderExternalBinding(candidate)) {
        continue;
      }

      const handler = (event: Event): void => {
        const binding = resolveMediaHeaderExternalBinding(candidate);
        if (!binding) {
          return;
        }

        const href = candidate.href;
        if (!href) {
          return;
        }

        if (
          event.type === "click" &&
          shouldSkipDuplicateExternalIntercept(href)
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        openExternalUrl(href, binding.reason, binding.extra ?? {});
      };

      candidate.addEventListener("mousedown", handler, { capture: true });
      candidate.addEventListener("click", handler, { capture: true });
      candidate.dataset.mdMediaHeaderExternalBound = "true";
    }
  };

  const resolveMediaDownloadActionAtPoint = (
    point: Pick<MouseEvent, "clientX" | "clientY">,
  ): { href: string; label: string } | null => {
    if (!isMediaRoute()) {
      return null;
    }

    const selector = mediaDownloadSelectors.join(", ");
    const candidates = Array.from(
      document.querySelectorAll(selector),
    ) as HTMLElement[];

    for (const node of candidates) {
      if (!isMediaOverlayElementVisible(node)) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      if (rect.top < -160 || rect.top > 220) {
        continue;
      }

      if (
        point.clientX < rect.left ||
        point.clientX > rect.right ||
        point.clientY < rect.top ||
        point.clientY > rect.bottom
      ) {
        continue;
      }

      const anchor =
        node instanceof HTMLAnchorElement
          ? node
          : node.closest("a[href]") instanceof HTMLAnchorElement
            ? (node.closest("a[href]") as HTMLAnchorElement)
            : null;
      const href = anchor?.href || "";
      if (!href) {
        continue;
      }

      const label = extractInteractiveLabel(node);
      return { href, label };
    }

    return null;
  };

  const handleDocumentNavigationEvent = (event: MouseEvent): void => {
      const mediaDownloadAction = resolveMediaDownloadActionAtPoint(event);
      if (mediaDownloadAction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        if (event.type === "click") {
          ipcRenderer.send("download-url", mediaDownloadAction.href);
        }
        return;
      }

      const mediaToggleKind = isMediaRoute()
        ? getMediaHeaderToggleKind(event.target)
        : null;
      if (mediaToggleKind) {
        activeMediaHeaderOverlayKind = mediaToggleKind;
        return;
      }

      const anchor = findClosestAnchor(event.target);
      if (!anchor) return;

      const href = anchor.href;
      if (!href) {
        return;
      }
      const anchorLabel = extractInteractiveLabel(event.target);

      if (
        shouldAllowMarketplaceActionInApp({
          url: href,
          label: anchorLabel,
        })
      ) {
        return;
      }

      if (
        event.type === "click" &&
        shouldSkipDuplicateExternalIntercept(href)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        return;
      }

      if (isMediaRoute()) {
        const label = extractInteractiveLabel(anchor);
        if (isMediaHeaderFacebookButton(anchor)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          openExternalUrl(href, "media-facebook-button");
          return;
        }

        if (
          isMessagesThreadNavigationUrl(href) &&
          !MEDIA_HEADER_NON_NAVIGATION_LABEL_PATTERN.test(label)
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          openExternalUrl(href, "media-thread-link");
          return;
        }

        const anchorRect = anchor.getBoundingClientRect();
        const overlayContext = resolveMediaHeaderOverlayContext(anchor);
        if (overlayContext) {
          if (
            !MEDIA_HEADER_NON_NAVIGATION_LABEL_PATTERN.test(label) &&
            !getMediaHeaderToggleKind(anchor)
          ) {
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            openExternalUrl(href, "media-header-overlay-link", {
              overlayKind: overlayContext.kind,
            });
            return;
          }
        }

        if (
          activeMediaHeaderOverlayKind &&
          anchorRect.left >= window.innerWidth * MEDIA_HEADER_OVERLAY_MIN_LEFT_RATIO &&
          !MEDIA_HEADER_NON_NAVIGATION_LABEL_PATTERN.test(label) &&
          !getMediaHeaderToggleKind(anchor) &&
          (matchesMediaHeaderOverlayLink(activeMediaHeaderOverlayKind, label) ||
            activeMediaHeaderOverlayKind === "menu" ||
            activeMediaHeaderOverlayKind === "notifications" ||
            (activeMediaHeaderOverlayKind === "messenger" &&
              (/\/messages\/t\/?$/i.test(href) ||
                /see all in messenger/i.test(label))))
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          openExternalUrl(href, "media-header-overlay-link", {
            overlayKind: activeMediaHeaderOverlayKind,
          });
          return;
        }
      }

      const windowAction = decideWindowOpenAction(href);
      if (windowAction !== "open-external-browser") {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      openExternalUrl(href, "window-open-policy");
  };

  document.addEventListener("mousedown", handleDocumentNavigationEvent, {
    capture: true,
  });
  document.addEventListener("click", handleDocumentNavigationEvent, {
    capture: true,
  });

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
    if (el.closest("[hidden]")) {
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

  const collectMediaOverlaySignals = (): MediaOverlaySignals => {
    const path = window.location.pathname.toLowerCase();
    const modeFromPath = resolveViewportMode({
      urlPath: path,
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
      const marketplaceThreadState =
        extra.marketplaceThreadState &&
        typeof extra.marketplaceThreadState === "object" &&
        !Array.isArray(extra.marketplaceThreadState)
          ? extra.marketplaceThreadState
          : collectMarketplaceThreadDebugState();
      const viewportState =
        extra.viewportState &&
        typeof extra.viewportState === "object" &&
        !Array.isArray(extra.viewportState)
          ? (extra.viewportState as MessagesViewportStatePayload)
          : buildViewportStatePayload(
              marketplaceThreadState as MarketplaceThreadDebugState,
            );
      const composerOverlayState =
        extra.composerOverlayState &&
        typeof extra.composerOverlayState === "object" &&
        !Array.isArray(extra.composerOverlayState)
          ? extra.composerOverlayState
          : collectComposerOverlayState();
      const callSurfaceState =
        extra.callSurfaceState &&
        typeof extra.callSurfaceState === "object" &&
        !Array.isArray(extra.callSurfaceState)
          ? extra.callSurfaceState
          : collectCallSurfaceState();
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
          activeCrop: document.documentElement.classList.contains(ACTIVE_CLASS),
        },
        viewportState,
        marketplaceThreadState,
        headerSuppressionState: lastHeaderSuppressionState,
        composerOverlayState,
        callSurfaceState,
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

  const normalizeLabelText = (value: string | null | undefined): string =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  const createDefaultMarketplaceThreadDebugState =
    (): MarketplaceThreadDebugState => ({
      routeEligible: false,
      marketplaceThreadVisible: false,
      rightPaneMarketplaceSignalDetected: false,
      rightPaneItemLinkDetected: false,
      headerMarketplaceDetected: false,
      headerBackDetected: false,
      headerBackMarketplaceDetected: false,
      headerOrdinaryChatDetected: false,
      headerContainerTop: null,
      headerContainerBottom: null,
      headerContainerLeft: null,
      headerContainerRight: null,
      weakHeaderBand: null,
      weakHeaderMatchesSessionHeaderBand: false,
      headerBackMatchesSessionHeaderBand: false,
      sameRouteMarketplaceBackAnchorDetected: false,
      visualCropHeight: null,
      marketplaceSessionActive: false,
      marketplaceSessionRouteKey: null,
      marketplaceSessionConfirmationKind: null,
      marketplaceSessionSignalSource: null,
      marketplaceSessionLifecycleReason: null,
      marketplaceSessionTransition: "inactive",
      marketplaceSessionRejectionReason: null,
      marketplaceSessionHeaderBand: null,
      marketplaceLastConfirmedAgeMs: null,
      marketplaceLastStrongConfirmedAgeMs: null,
      marketplaceCurrentEvidenceClass: "none",
      marketplacePostConfirmGraceActive: false,
      marketplaceOrdinaryClearBlockedReason: null,
      weakBootstrapSettled: false,
      weakBootstrapPendingSignalSource: null,
      weakBootstrapStablePasses: 0,
      weakBootstrapFirstSeenAgeMs: null,
      weakBootstrapConfirmationEligible: false,
      routeChangeDetected: false,
      routeChangeRecentMarketplaceMatch: false,
      routeChangeWeakHeaderMatchesPreviousSession: false,
      routeChangePendingBootstrapBridgeReason: null,
      routeChangePendingBootstrapWouldBridge: false,
      routeChangeRescuePending: false,
      routeChangeRescueExpiresInMs: null,
      routeChangeRescueStartedAgeMs: null,
      ordinaryClearPending: false,
      ordinaryClearStablePasses: 0,
      ordinaryClearEligible: false,
      ordinaryClearLastMarketplaceMatchAgeMs: null,
      matchedSignals: [],
    });

  const getInteractiveNodeHint = (node: Element): string => {
    if (!(node instanceof HTMLElement)) {
      return "";
    }

    const href =
      node instanceof HTMLAnchorElement
        ? node.href
        : node.getAttribute("href") || "";
    const placeholder = node.getAttribute("placeholder") || "";
    return normalizeLabelText(
      [
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        placeholder,
        href,
        node.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
  };

  const MARKETPLACE_THREAD_HEADER_MAX_TOP = 180;
  const MARKETPLACE_THREAD_HEADER_MAX_LEFT = 280;
  const MARKETPLACE_THREAD_HEADER_MIN_WIDTH = 80;
  const MARKETPLACE_THREAD_HEADER_MAX_WIDTH = 560;
  const MARKETPLACE_THREAD_HEADER_MIN_HEIGHT = 24;
  const MARKETPLACE_THREAD_HEADER_MAX_HEIGHT = 220;
  const MARKETPLACE_THREAD_HEADER_DESCENDANT_LIMIT = 24;
  const MARKETPLACE_VISUAL_CROP_TOP_PADDING = 4;
  const MARKETPLACE_VISUAL_CROP_MIN_HEIGHT = 24;
  const MARKETPLACE_VISUAL_CROP_FALLBACK_HEIGHT =
    DEFAULT_MESSAGES_HEADER_HEIGHT - 20;
  const MARKETPLACE_THREAD_ORDINARY_CHAT_CONTROL_PATTERN =
    /\b(search in conversation|audio call|video call|start (?:an? )?(?:audio |video )?call|open conversation information|conversation information|chat info|details|info)\b/i;

  const getCurrentMarketplaceRouteKey = (): string =>
    `${window.location.pathname}${window.location.search}`;

  const isMarketplaceWeakBootstrapSettled = (): boolean =>
    document.readyState === "complete" &&
    performance.now() >= MARKETPLACE_WEAK_BOOTSTRAP_SETTLE_MS;

  const toMarketplaceThreadHeaderBand = (
    rect: DOMRect | null,
  ): MarketplaceThreadHeaderBand | null => {
    if (!rect) {
      return null;
    }

    const top = Math.max(0, Math.round(rect.top));
    const bottom = Math.max(top, Math.round(rect.bottom));
    const left = Math.max(0, Math.round(rect.left));
    const right = Math.max(left, Math.round(rect.right));
    return {
      top,
      bottom,
      left,
      right,
    };
  };

  const mergeMarketplaceThreadHeaderBands = (input: {
    primary?: MarketplaceThreadHeaderBand | null;
    secondary?: MarketplaceThreadHeaderBand | null;
  }): MarketplaceThreadHeaderBand | null => {
    const primary = input.primary;
    const secondary = input.secondary;
    if (!primary || !secondary) {
      return primary ?? secondary ?? null;
    }

    return {
      top: Math.min(primary.top, secondary.top),
      bottom: Math.max(primary.bottom, secondary.bottom),
      left: Math.min(primary.left, secondary.left),
      right: Math.max(primary.right, secondary.right),
    };
  };

  const isLikelyMarketplaceThreadHeaderContainer = (
    candidate: HTMLElement,
  ): boolean => {
    if (!isAriaVisible(candidate)) {
      return false;
    }

    const rect = candidate.getBoundingClientRect();
    if (
      rect.bottom < 0 ||
      rect.top > MARKETPLACE_THREAD_HEADER_MAX_TOP ||
      rect.left > MARKETPLACE_THREAD_HEADER_MAX_LEFT
    ) {
      return false;
    }

    if (
      rect.width < MARKETPLACE_THREAD_HEADER_MIN_WIDTH ||
      rect.width > MARKETPLACE_THREAD_HEADER_MAX_WIDTH ||
      rect.height < MARKETPLACE_THREAD_HEADER_MIN_HEIGHT ||
      rect.height > MARKETPLACE_THREAD_HEADER_MAX_HEIGHT
    ) {
      return false;
    }

    return rect.right <= window.innerWidth * 0.8;
  };

  const resolveMarketplaceThreadHeaderContainer = (
    node: HTMLElement,
    mode: "strong" | "weak",
  ): HTMLElement | null => {
    let current: HTMLElement | null = node;

    while (current instanceof HTMLElement && current !== document.body) {
      if (!isLikelyMarketplaceThreadHeaderContainer(current)) {
        current = current.parentElement;
        continue;
      }

      const descendantHints = Array.from(
        current.querySelectorAll(
          "button, [role='button'], a[href], [aria-label], [title], h1, h2, h3, [role='heading']",
        ),
      )
        .filter((descendant): descendant is HTMLElement => {
          return descendant instanceof HTMLElement && isAriaVisible(descendant);
        })
        .slice(0, MARKETPLACE_THREAD_HEADER_DESCENDANT_LIMIT)
        .map((descendant) => getInteractiveNodeHint(descendant));

      if (
        mode === "strong"
          ? hasMarketplaceThreadHeaderSignal([
              getInteractiveNodeHint(current),
              ...descendantHints,
            ])
          : [getInteractiveNodeHint(current), ...descendantHints].some((hint) =>
              isMarketplaceThreadHeaderHint(hint),
            )
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  };

  const normalizeMarketplaceVisualCropHeight = (value: number): number => {
    if (!Number.isFinite(value)) {
      return MARKETPLACE_VISUAL_CROP_FALLBACK_HEIGHT;
    }

    return Math.max(
      MARKETPLACE_VISUAL_CROP_MIN_HEIGHT,
      Math.min(DEFAULT_MESSAGES_HEADER_HEIGHT, Math.round(value)),
    );
  };

  const shouldUseMarketplaceVisualCropHeuristic = (
    state?: MarketplaceThreadDebugState | null,
  ): boolean =>
    typeof state?.visualCropHeight === "number" &&
    state.visualCropHeight > 0;

  const collectMarketplaceThreadDebugState =
    (): MarketplaceThreadDebugState => {
      const state = createDefaultMarketplaceThreadDebugState();
      if (!/^\/messages\/(?:e2ee\/)?t\//i.test(window.location.pathname)) {
        if (marketplaceVisualSession) {
          state.marketplaceSessionRouteKey = marketplaceVisualSession.routeKey;
          state.marketplaceSessionActive = false;
          state.marketplaceSessionSignalSource =
            marketplaceVisualSession.signalSource;
          state.marketplaceSessionLifecycleReason = "thread-destroyed";
          state.marketplaceSessionTransition = "cleared";
          state.marketplaceSessionHeaderBand = marketplaceVisualSession.headerBand;
          state.visualCropHeight = marketplaceVisualSession.visualCropHeight;
          state.matchedSignals = ["session:thread-destroyed"];
        }
        marketplaceVisualSession = null;
        marketplaceWeakBootstrapState = null;
        marketplaceOrdinaryClearState = null;
        return state;
      }

      state.routeEligible = true;
      const now = Date.now();
      const routeKey = getCurrentMarketplaceRouteKey();
      if (
        marketplaceWeakBootstrapState &&
        marketplaceWeakBootstrapState.routeKey !== routeKey
      ) {
        marketplaceWeakBootstrapState = null;
      }
      if (
        marketplaceOrdinaryClearState &&
        marketplaceOrdinaryClearState.routeKey !== routeKey
      ) {
        marketplaceOrdinaryClearState = null;
      }
      const previousMarketplaceSession = marketplaceVisualSession;
      const currentMarketplaceSession =
        previousMarketplaceSession &&
        previousMarketplaceSession.routeKey === routeKey
          ? previousMarketplaceSession
          : null;
      const matchedSignals = new Set<string>();
      const weakBootstrapSettled = isMarketplaceWeakBootstrapSettled();
      state.weakBootstrapSettled = weakBootstrapSettled;
      if (previousMarketplaceSession) {
        state.marketplaceLastConfirmedAgeMs = Math.max(
          0,
          now - previousMarketplaceSession.lastConfirmedAt,
        );
        state.marketplaceLastStrongConfirmedAgeMs =
          previousMarketplaceSession.lastStrongConfirmedAt !== null
            ? Math.max(0, now - previousMarketplaceSession.lastStrongConfirmedAt)
            : null;
        state.marketplacePostConfirmGraceActive =
          previousMarketplaceSession.confirmationKind === "strong-header" &&
          state.marketplaceLastStrongConfirmedAgeMs !== null &&
          state.marketplaceLastStrongConfirmedAgeMs <=
            MARKETPLACE_POST_CONFIRM_GRACE_MS;
        state.ordinaryClearLastMarketplaceMatchAgeMs = Math.max(
          0,
          now - previousMarketplaceSession.lastMatchedAt,
        );
      }
      const rightPaneMinLeft = Math.max(
        160,
        Math.round(window.innerWidth * 0.25),
      );
      const scanMaxTop = Math.max(220, Math.round(window.innerHeight * 0.45));
      const candidates = document.querySelectorAll(
        "button, [role='button'], a[href], [aria-label], [title]",
      );
      let strongSignalSource:
        | Extract<
            MarketplaceSessionSignalSource,
            "strong-header" | "right-pane-action" | "item-link"
          >
        | null = null;
      let weakSignalSource:
        | Extract<
            MarketplaceSessionSignalSource,
            "right-pane-action" | "item-link"
          >
        | null = null;
      let strongHeaderBand: MarketplaceThreadHeaderBand | null = null;
      let strongVisualCropHeight: number | null = null;
      let weakHeaderBand: MarketplaceThreadHeaderBand | null = null;
      let backControlBand: MarketplaceThreadHeaderBand | null = null;
      let ordinaryThreadControlDetected = false;

      for (const candidate of Array.from(candidates)) {
        if (!(candidate instanceof HTMLElement) || !isAriaVisible(candidate)) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();
        if (
          rect.bottom < 0 ||
          rect.top > scanMaxTop ||
          rect.left < rightPaneMinLeft
        ) {
          continue;
        }

        const hintSignals = collectMarketplaceThreadHintSignals(
          getInteractiveNodeHint(candidate),
        );
        const candidateHint = getInteractiveNodeHint(candidate);
        if (
          !hintSignals.includes("header") &&
          rect.top <= MARKETPLACE_THREAD_HEADER_MAX_TOP &&
          rect.right >= window.innerWidth * 0.52 &&
          MARKETPLACE_THREAD_ORDINARY_CHAT_CONTROL_PATTERN.test(candidateHint)
        ) {
          ordinaryThreadControlDetected = true;
          matchedSignals.add("header-ordinary-chat-control");
        }
        if (hintSignals.includes("action")) {
          state.rightPaneMarketplaceSignalDetected = true;
          matchedSignals.add("right-pane-action");
          if (!weakSignalSource) {
            weakSignalSource = "right-pane-action";
          }
        }
        if (hintSignals.includes("item-link")) {
          state.rightPaneItemLinkDetected = true;
          matchedSignals.add("right-pane-item-link");
          weakSignalSource = "item-link";
        }
      }

      const headerCandidates = document.querySelectorAll(
        "button, [role='button'], a[href], [aria-label], [title], h1, h2, h3, [role='heading']",
      );

      for (const candidate of Array.from(headerCandidates)) {
        if (!(candidate instanceof HTMLElement) || !isAriaVisible(candidate)) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();
        if (
          rect.bottom < 0 ||
          rect.top > MARKETPLACE_THREAD_HEADER_MAX_TOP ||
          rect.left > MARKETPLACE_THREAD_HEADER_MAX_LEFT
        ) {
          continue;
        }

        const hint = getInteractiveNodeHint(candidate);
        if (!hint) {
          continue;
        }

        if (isMarketplaceThreadBackHint(hint) && rect.left <= 120) {
          state.headerBackDetected = true;
          matchedSignals.add("header-back");
          if (!backControlBand) {
            backControlBand = toMarketplaceThreadHeaderBand(rect);
          }
          const headerContainer =
            resolveMarketplaceThreadHeaderContainer(candidate, "strong");
          if (headerContainer) {
            state.headerBackMarketplaceDetected = true;
            matchedSignals.add("header-back+marketplace");
            const containerRect = headerContainer.getBoundingClientRect();
            const headerBand = toMarketplaceThreadHeaderBand(containerRect);
            if (headerBand) {
              state.headerContainerTop = headerBand.top;
              state.headerContainerBottom = headerBand.bottom;
              state.headerContainerLeft = headerBand.left;
              state.headerContainerRight = headerBand.right;
              strongHeaderBand = headerBand;
              strongVisualCropHeight = normalizeMarketplaceVisualCropHeight(
                headerBand.top - MARKETPLACE_VISUAL_CROP_TOP_PADDING,
              );
              strongSignalSource = "strong-header";
            }
          }
        }

        if (isMarketplaceThreadHeaderHint(hint) && rect.left <= 180) {
          const headerContainer = resolveMarketplaceThreadHeaderContainer(
            candidate,
            "weak",
          );
          if (!headerContainer) {
            continue;
          }
          const candidateHeaderBand = toMarketplaceThreadHeaderBand(
            headerContainer.getBoundingClientRect(),
          );
          if (!candidateHeaderBand) {
            continue;
          }

          const matchesCurrentSession = doesMarketplaceThreadHeaderBandMatch({
            confirmedHeaderBand: currentMarketplaceSession?.headerBand,
            candidateHeaderBand,
          });
          if (!weakHeaderBand || matchesCurrentSession) {
            weakHeaderBand = candidateHeaderBand;
          }

          if (matchesCurrentSession) {
            matchedSignals.add("header-marketplace");
          } else {
            matchedSignals.add("header-marketplace-candidate");
          }
        }
      }

      const freshRouteMarketplaceHeaderPairMatched =
        !currentMarketplaceSession &&
        strongSignalSource === null &&
        state.headerBackDetected &&
        weakHeaderBand !== null &&
        doesMarketplaceThreadFreshHeaderPairMatch({
          candidateHeaderBand: weakHeaderBand,
          candidateBackBand: backControlBand,
        });
      if (freshRouteMarketplaceHeaderPairMatched) {
        matchedSignals.add("header-back+marketplace-fallback");
        state.headerBackMarketplaceDetected = true;
        strongSignalSource = "strong-header";
        strongHeaderBand = mergeMarketplaceThreadHeaderBands({
          primary: backControlBand,
          secondary: weakHeaderBand,
        });
        if (strongHeaderBand) {
          state.headerContainerTop = strongHeaderBand.top;
          state.headerContainerBottom = strongHeaderBand.bottom;
          state.headerContainerLeft = strongHeaderBand.left;
          state.headerContainerRight = strongHeaderBand.right;
          strongVisualCropHeight = normalizeMarketplaceVisualCropHeight(
            strongHeaderBand.top - MARKETPLACE_VISUAL_CROP_TOP_PADDING,
          );
        }
      } else if (
        !currentMarketplaceSession &&
        strongSignalSource === null &&
        state.headerBackDetected &&
        weakHeaderBand !== null
      ) {
        matchedSignals.add("header-back+marketplace-fallback-rejected");
      }

      state.headerOrdinaryChatDetected =
        ordinaryThreadControlDetected &&
        !state.rightPaneMarketplaceSignalDetected &&
        !state.rightPaneItemLinkDetected;
      if (state.headerOrdinaryChatDetected) {
        matchedSignals.add("header-ordinary-chat");
      }
      state.headerBackMatchesSessionHeaderBand =
        doesMarketplaceThreadBackAnchorMatch({
          confirmedHeaderBand: currentMarketplaceSession?.headerBand,
          candidateBackBand: backControlBand,
        });
      state.sameRouteMarketplaceBackAnchorDetected =
        currentMarketplaceSession?.confirmationKind === "strong-header" &&
        state.marketplacePostConfirmGraceActive &&
        state.headerBackMatchesSessionHeaderBand &&
        !state.headerBackMarketplaceDetected;
      if (state.headerBackMatchesSessionHeaderBand) {
        matchedSignals.add("header-back-match");
      }
      if (state.sameRouteMarketplaceBackAnchorDetected) {
        matchedSignals.add("header-back-anchor");
      }

      const weakHeaderMatchesCurrentSessionHeaderBand =
        doesMarketplaceThreadHeaderBandMatch({
          confirmedHeaderBand: currentMarketplaceSession?.headerBand,
          candidateHeaderBand: weakHeaderBand,
        });
      const routeChangeDetected =
        previousMarketplaceSession !== null &&
        previousMarketplaceSession !== undefined &&
        previousMarketplaceSession.routeKey !== routeKey;
      const routeChangeWeakHeaderMatchesPreviousSession =
        routeChangeDetected &&
        weakHeaderBand !== null &&
        doesMarketplaceThreadRouteChangeWeakHeaderMatch({
          confirmedHeaderBand: previousMarketplaceSession.headerBand,
          candidateHeaderBand: weakHeaderBand,
        });
      state.routeChangeDetected = routeChangeDetected;
      state.routeChangeWeakHeaderMatchesPreviousSession =
        routeChangeWeakHeaderMatchesPreviousSession;
      if (routeChangeWeakHeaderMatchesPreviousSession) {
        matchedSignals.add("route-change-marketplace-weak-header");
      } else if (routeChangeDetected && weakHeaderBand !== null) {
        matchedSignals.add("route-change-marketplace-weak-header-rejected");
      }

      let pendingBootstrapSignalSource:
        | Extract<
            MarketplaceSessionSignalSource,
            "right-pane-action" | "item-link"
          >
        | null = null;
      let pendingBootstrapAllowed = false;
      let pendingBootstrapRejectedReason:
        | MarketplaceVisualSessionRejectionReason
        | null = null;
      let isWeakBootstrapConfirmation = false;

      const weakBootstrapVisualCropHeight = normalizeMarketplaceVisualCropHeight(
        MARKETPLACE_VISUAL_CROP_FALLBACK_HEIGHT,
      );
      const weakBootstrapDecision = resolveWeakMarketplaceBootstrapDecision({
        routeKey,
        nowMs: now,
        weakSignalSource,
        weakBootstrapSettled,
        headerOrdinaryChatDetected: state.headerOrdinaryChatDetected,
        headerBackMarketplaceDetected: state.headerBackMarketplaceDetected,
        currentMarketplaceSessionActive: currentMarketplaceSession !== null,
        previousState: marketplaceWeakBootstrapState,
        requiredPasses: MARKETPLACE_WEAK_BOOTSTRAP_REQUIRED_PASSES,
        minConfirmAgeMs: MARKETPLACE_WEAK_BOOTSTRAP_MIN_CONFIRM_AGE_MS,
        visualCropHeight: weakBootstrapVisualCropHeight,
      });
      marketplaceWeakBootstrapState = weakBootstrapDecision.nextState;
      pendingBootstrapSignalSource =
        weakBootstrapDecision.pendingBootstrapSignalSource;
      pendingBootstrapAllowed = weakBootstrapDecision.pendingBootstrapAllowed;
      pendingBootstrapRejectedReason =
        weakBootstrapDecision.pendingBootstrapRejectedReason;
      state.weakBootstrapPendingSignalSource = pendingBootstrapSignalSource;
      state.weakBootstrapStablePasses = weakBootstrapDecision.stablePasses;
      state.weakBootstrapFirstSeenAgeMs =
        weakBootstrapDecision.firstSeenAgeMs;
      state.weakBootstrapConfirmationEligible =
        weakBootstrapDecision.confirmationEligible;
      const routeChangeRecentMarketplaceMatch =
        routeChangeDetected &&
        previousMarketplaceSession !== null &&
        previousMarketplaceSession !== undefined &&
        Number.isFinite(previousMarketplaceSession.lastMatchedAt) &&
        now - previousMarketplaceSession.lastMatchedAt <=
          MARKETPLACE_SESSION_DOM_GRACE_MS;
      state.routeChangeRecentMarketplaceMatch =
        routeChangeRecentMarketplaceMatch;
      const routeChangePendingBootstrapBridgeReason = routeChangeDetected
        ? resolvePendingBootstrapRouteChangeBridgeReason({
            pendingBootstrapSignalSource,
            pendingBootstrapAllowed,
            headerBackDetected: state.headerBackDetected,
          })
        : null;
      state.routeChangePendingBootstrapBridgeReason =
        routeChangePendingBootstrapBridgeReason;
      state.routeChangePendingBootstrapWouldBridge =
        routeChangeRecentMarketplaceMatch &&
        routeChangePendingBootstrapBridgeReason ===
          "allowed-right-pane-action-back-detected";
      if (routeChangeDetected && pendingBootstrapSignalSource) {
        matchedSignals.add(
          state.routeChangePendingBootstrapWouldBridge
            ? "route-change-pending-bootstrap-bridge"
            : `route-change-pending-bootstrap-blocked:${routeChangePendingBootstrapBridgeReason}`,
        );
      }
      if (routeChangeDetected && !routeChangeRecentMarketplaceMatch) {
        matchedSignals.add("route-change-pending-bootstrap-blocked:stale");
      }
      if (weakBootstrapDecision.transition === "rejected") {
        matchedSignals.add(
          pendingBootstrapRejectedReason === "weak-bootstrap-ordinary-chat"
            ? "weak-bootstrap-rejected:ordinary-chat"
            : "weak-bootstrap-rejected:startup",
        );
      } else if (weakBootstrapDecision.transition === "pending") {
        matchedSignals.add("weak-bootstrap-pending");
      } else if (weakBootstrapDecision.transition === "confirmed") {
        strongSignalSource = weakBootstrapDecision.confirmedSignalSource;
        strongVisualCropHeight = weakBootstrapVisualCropHeight;
        isWeakBootstrapConfirmation = true;
        matchedSignals.add("weak-bootstrap-confirmed");
      }

      const ordinaryChatOnlyDetected =
        currentMarketplaceSession !== null &&
        state.headerOrdinaryChatDetected &&
        !state.headerBackMarketplaceDetected &&
        !weakHeaderBand &&
        !weakSignalSource;
      let ordinaryClearPending = false;
      let explicitOrdinaryChatDetected = false;
      let ordinaryClearBlockedReason = resolveMarketplaceOrdinaryClearBlockedReason(
        {
          previousSession: currentMarketplaceSession,
          nowMs: now,
          postConfirmGraceMs: MARKETPLACE_POST_CONFIRM_GRACE_MS,
          sameRouteMarketplaceBackAnchorDetected:
            state.sameRouteMarketplaceBackAnchorDetected,
          headerOrdinaryChatDetected: state.headerOrdinaryChatDetected,
          headerBackMarketplaceDetected: state.headerBackMarketplaceDetected,
          weakHeaderMatchesSessionHeaderBand:
            weakHeaderMatchesCurrentSessionHeaderBand,
          weakSignalDetected: weakSignalSource !== null,
        },
      );
      if (ordinaryChatOnlyDetected && currentMarketplaceSession) {
        if (ordinaryClearBlockedReason) {
          marketplaceOrdinaryClearState = null;
          matchedSignals.add(`ordinary-clear-blocked:${ordinaryClearBlockedReason}`);
        } else {
          const stablePasses =
            marketplaceOrdinaryClearState &&
            marketplaceOrdinaryClearState.routeKey === routeKey
              ? marketplaceOrdinaryClearState.stablePasses + 1
              : 1;
          const eligible =
            state.ordinaryClearLastMarketplaceMatchAgeMs !== null &&
            state.ordinaryClearLastMarketplaceMatchAgeMs >=
              MARKETPLACE_ORDINARY_CLEAR_MIN_AGE_MS &&
            stablePasses >= MARKETPLACE_ORDINARY_CLEAR_REQUIRED_PASSES;
          marketplaceOrdinaryClearState = {
            routeKey,
            stablePasses,
            lastSeenAt: now,
          };
          state.ordinaryClearStablePasses = stablePasses;
          state.ordinaryClearEligible = eligible;
          if (eligible) {
            explicitOrdinaryChatDetected = true;
            matchedSignals.add("ordinary-clear-eligible");
          } else {
            ordinaryClearPending = true;
            ordinaryClearBlockedReason = "insufficient-passes";
            state.ordinaryClearPending = true;
            matchedSignals.add("ordinary-clear-pending");
          }
        }
      } else {
        if (
          marketplaceOrdinaryClearState &&
          currentMarketplaceSession &&
          (state.headerBackMarketplaceDetected ||
            weakHeaderMatchesCurrentSessionHeaderBand ||
            weakSignalSource !== null ||
            state.sameRouteMarketplaceBackAnchorDetected)
        ) {
          ordinaryClearBlockedReason = "marketplace-returned";
          matchedSignals.add("ordinary-clear-blocked:marketplace-returned");
        }
        marketplaceOrdinaryClearState = null;
      }
      state.marketplaceOrdinaryClearBlockedReason = ordinaryClearBlockedReason;
      state.marketplaceCurrentEvidenceClass = resolveMarketplaceCurrentEvidenceClass(
        {
          headerBackMarketplaceDetected: state.headerBackMarketplaceDetected,
          strongSignalSource,
          weakHeaderBand,
          weakSignalDetected: weakSignalSource !== null,
          sameRouteMarketplaceBackAnchorDetected:
            state.sameRouteMarketplaceBackAnchorDetected,
          headerOrdinaryChatDetected: state.headerOrdinaryChatDetected,
        },
      );

      if (
        strongSignalSource !== "strong-header" &&
        strongSignalSource &&
        previousMarketplaceSession?.visualCropHeight !== null
      ) {
        strongVisualCropHeight =
          previousMarketplaceSession?.visualCropHeight ?? null;
      }

      const sessionDecision = resolveMarketplaceVisualSessionDecision({
        currentRouteKey: routeKey,
        nowMs: now,
        graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
        routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
        previousSession: previousMarketplaceSession,
        strongSignalSource,
        isWeakBootstrapConfirmation,
        pendingBootstrapSignalSource,
        pendingBootstrapAllowed,
        pendingBootstrapRejectedReason,
        strongVisualCropHeight:
          strongSignalSource === "strong-header"
            ? strongVisualCropHeight ??
              normalizeMarketplaceVisualCropHeight(
                MARKETPLACE_VISUAL_CROP_FALLBACK_HEIGHT,
              )
            : strongVisualCropHeight,
        strongHeaderBand,
        weakHeaderBand,
        headerBackDetected: state.headerBackDetected,
        sameRouteMarketplaceBackAnchorDetected:
          state.sameRouteMarketplaceBackAnchorDetected,
        headerBackMatchesSessionHeaderBand:
          state.headerBackMatchesSessionHeaderBand,
        explicitOrdinaryChatDetected,
        ordinaryClearPending,
      });
      marketplaceVisualSession = sessionDecision.nextSession;
      if (sessionDecision.nextSession) {
        state.marketplaceLastConfirmedAgeMs = Math.max(
          0,
          now - sessionDecision.nextSession.lastConfirmedAt,
        );
        state.marketplaceLastStrongConfirmedAgeMs =
          sessionDecision.nextSession.lastStrongConfirmedAt !== null
            ? Math.max(0, now - sessionDecision.nextSession.lastStrongConfirmedAt)
            : null;
        state.marketplacePostConfirmGraceActive =
          sessionDecision.nextSession.confirmationKind === "strong-header" &&
          state.marketplaceLastStrongConfirmedAgeMs !== null &&
          state.marketplaceLastStrongConfirmedAgeMs <=
            MARKETPLACE_POST_CONFIRM_GRACE_MS;
      }

      state.headerMarketplaceDetected =
        state.headerBackMarketplaceDetected ||
        sessionDecision.weakHeaderMatchesSessionHeaderBand;
      state.weakHeaderBand = weakHeaderBand;
      state.weakHeaderMatchesSessionHeaderBand =
        sessionDecision.weakHeaderMatchesSessionHeaderBand;
      state.marketplaceSessionActive = sessionDecision.sessionActive;
      state.marketplaceSessionRouteKey = sessionDecision.nextSession?.routeKey ?? null;
      state.marketplaceSessionConfirmationKind =
        sessionDecision.nextSession?.confirmationKind ?? null;
      state.marketplaceSessionSignalSource = sessionDecision.signalSource;
      state.marketplaceSessionLifecycleReason = sessionDecision.lifecycleReason;
      state.marketplaceSessionTransition = sessionDecision.transition;
      state.marketplaceSessionRejectionReason = sessionDecision.rejectionReason;
      const marketplaceNextSession = sessionDecision.nextSession;
      state.marketplaceSessionHeaderBand =
        marketplaceNextSession?.headerBand ?? null;
      const routeChangeRescuePendingUntil =
        marketplaceNextSession?.routeChangeRescuePendingUntil ?? null;
      const routeChangeRescueStartedAt =
        marketplaceNextSession?.routeChangeRescueStartedAt ?? null;
      state.routeChangeRescuePending = routeChangeRescuePendingUntil !== null;
      state.routeChangeRescueExpiresInMs =
        routeChangeRescuePendingUntil !== null
          ? Math.max(0, routeChangeRescuePendingUntil - now)
          : null;
      state.routeChangeRescueStartedAgeMs =
        routeChangeRescueStartedAt !== null
          ? Math.max(0, now - routeChangeRescueStartedAt)
          : null;
      state.marketplaceThreadVisible = sessionDecision.sessionActive;
      state.visualCropHeight = sessionDecision.visualCropHeight;

      if (weakHeaderBand) {
        if (sessionDecision.weakHeaderMatchesSessionHeaderBand) {
          matchedSignals.add("header-marketplace-match");
        } else {
          matchedSignals.add("header-marketplace-rejected");
        }
      }
      if (sessionDecision.transition === "route-change-rescue-pending") {
        matchedSignals.add("route-change-rescue-pending");
        if (sessionDecision.weakHeaderMatchesSessionHeaderBand) {
          matchedSignals.add("route-change-rescue-late-weak-header");
        }
      }
      if (
        currentMarketplaceSession?.routeChangeRescuePendingUntil !== null &&
        sessionDecision.transition === "bridged" &&
        sessionDecision.signalSource === "weak-header"
      ) {
        matchedSignals.add("route-change-rescue-late-weak-header");
      }
      if (
        currentMarketplaceSession?.routeChangeRescuePendingUntil !== null &&
        sessionDecision.transition === "cleared"
      ) {
        matchedSignals.add(
          state.headerOrdinaryChatDetected
            ? "route-change-rescue-rejected-ordinary"
            : weakHeaderBand !== null
              ? "route-change-rescue-rejected-mismatch"
              : "route-change-rescue-expired",
        );
      }
      if (sessionDecision.lifecycleReason) {
        matchedSignals.add(`session:${sessionDecision.lifecycleReason}`);
      }
      if (sessionDecision.rejectionReason) {
        matchedSignals.add(`session:rejected:${sessionDecision.rejectionReason}`);
      }
      state.matchedSignals = Array.from(matchedSignals);
      return state;
    };

  const detectMarketplaceThreadUiVisible = (): boolean =>
    collectMarketplaceThreadDebugState().marketplaceThreadVisible;

  const resolveMode = (
    marketplaceThreadState?: MarketplaceThreadDebugState,
  ): MessagesViewportMode =>
    resolveViewportMode({
      urlPath: window.location.pathname,
      mediaOverlayVisible: mediaOverlayVisible || detectMediaOverlayVisible(),
      marketplaceThreadVisible:
        marketplaceThreadState?.marketplaceThreadVisible ??
        detectMarketplaceThreadUiVisible(),
    });

  const extractInteractiveLabel = (target: EventTarget | null): string => {
    if (!(target instanceof Element)) return "";

    const candidates = [
      target.closest("button"),
      target.closest('[role="button"]'),
      target.closest("a[role='button']"),
      target.closest("[aria-label]"),
      target,
    ];

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      const label = normalizeLabelText(
        candidate.getAttribute("aria-label") ||
          candidate.getAttribute("title") ||
          candidate.textContent,
      );
      if (label) {
        return label.slice(0, 160);
      }
    }

    return "";
  };

  const FACEBOOK_CHROME_SELECTORS = [
    '[aria-label="Menu" i]',
    '[aria-label="Messenger" i]',
    '[aria-label*="Notifications" i]',
    '[aria-label*="Account controls and settings" i]',
    '[aria-label="Your profile" i]',
    '[aria-label="Facebook" i]',
    '[aria-label="Home" i]',
    '[aria-label="Search" i]',
    '[aria-label*="Search Facebook" i]',
    'input[placeholder*="Search Facebook" i]',
    'a[href="/"]',
    'a[href="https://www.facebook.com/"]',
    'a[href="/messages/"]',
    'a[href*="/notifications/"]',
    'a[href*="/friends/"]',
    'a[href*="/watch/"]',
    'a[href*="/marketplace/"]',
  ];
  const FACEBOOK_CHROME_HINT_PATTERN =
    /\b(facebook|home|menu|notifications|account controls|your profile|search facebook|friends|watch|marketplace|messenger)\b/i;
  const PRESERVED_MESSENGER_CONTROL_PATTERN =
    /\b(answer|accept|decline|ignore|join|close|download|share|forward|next|previous|call|video call|audio call|mute|unmute|end call|hang up|details|info)\b/i;
  const TOP_CHROME_SCAN_MAX_TOP = 72;
  const HEADER_CONTAINER_TOP_TOLERANCE = 48;
  const HEADER_CONTAINER_MIN_HEIGHT = 24;
  const HEADER_CONTAINER_MAX_HEIGHT = 240;
  const HEADER_CONTAINER_MAX_BOTTOM = 180;
  const HEADER_CONTAINER_MIN_WIDTH_RATIO = 0.4;
  const TOP_LEFT_CHROME_MAX_TOP = 84;
  const TOP_LEFT_CHROME_MAX_LEFT = 160;
  const TOP_LEFT_CHROME_MIN_SIZE = 24;
  const TOP_LEFT_CHROME_MAX_SIZE = 96;
  const TOP_LEFT_CHROME_SQUARE_TOLERANCE = 12;
  const TOP_STRIP_MAX_TOP = 64;
  const TOP_STRIP_MAX_LEFT = 24;
  const TOP_STRIP_MIN_WIDTH = 80;
  const TOP_STRIP_MAX_WIDTH = 180;
  const TOP_STRIP_MIN_HEIGHT = 32;
  const TOP_STRIP_MAX_HEIGHT = 72;

  const isLikelyTopHeaderContainer = (candidate: HTMLElement): boolean => {
    if (!isAriaVisible(candidate)) {
      return false;
    }

    const rect = candidate.getBoundingClientRect();
    if (rect.top > HEADER_CONTAINER_TOP_TOLERANCE) {
      return false;
    }

    if (
      rect.height < HEADER_CONTAINER_MIN_HEIGHT ||
      rect.height > HEADER_CONTAINER_MAX_HEIGHT
    ) {
      return false;
    }

    if (rect.bottom > HEADER_CONTAINER_MAX_BOTTOM) {
      return false;
    }

    return rect.width >= window.innerWidth * HEADER_CONTAINER_MIN_WIDTH_RATIO;
  };

  const collectVisibleTopChromeNodes = (): HTMLElement[] => {
    const matches = new Set<HTMLElement>();

    for (const selector of FACEBOOK_CHROME_SELECTORS) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }

      for (const node of Array.from(nodes)) {
        if (!(node instanceof HTMLElement) || !isAriaVisible(node)) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        if (rect.top > TOP_CHROME_SCAN_MAX_TOP) {
          continue;
        }

        matches.add(node);
      }
    }

    const fallbackCandidates = document.querySelectorAll(
      "button, [role='button'], a[href]",
    );

    for (const node of Array.from(fallbackCandidates)) {
      if (!(node instanceof HTMLElement) || !isAriaVisible(node)) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      if (
        rect.top > TOP_LEFT_CHROME_MAX_TOP ||
        rect.left > TOP_LEFT_CHROME_MAX_LEFT
      ) {
        continue;
      }

      if (
        rect.width < TOP_LEFT_CHROME_MIN_SIZE ||
        rect.height < TOP_LEFT_CHROME_MIN_SIZE ||
        rect.width > TOP_LEFT_CHROME_MAX_SIZE ||
        rect.height > TOP_LEFT_CHROME_MAX_SIZE
      ) {
        continue;
      }

      if (
        Math.abs(rect.width - rect.height) > TOP_LEFT_CHROME_SQUARE_TOLERANCE
      ) {
        continue;
      }

      const hint = getHeaderNodeHint(node);
      if (PRESERVED_MESSENGER_CONTROL_PATTERN.test(hint)) {
        continue;
      }

      matches.add(node);
    }

    return Array.from(matches);
  };

  const collectLingeringTopStripTargets = (): HTMLElement[] => {
    const matches = new Set<HTMLElement>();
    const anchors = document.querySelectorAll(
      '[aria-label="Exit typeahead" i], [aria-label="Back to Previous Page" i]',
    );

    for (const anchor of Array.from(anchors)) {
      let current = anchor instanceof HTMLElement ? anchor : null;
      let target: HTMLElement | null = null;

      while (current instanceof HTMLElement && current !== document.body) {
        const rect = current.getBoundingClientRect();
        if (
          isAriaVisible(current) &&
          rect.top <= TOP_STRIP_MAX_TOP &&
          rect.left <= TOP_STRIP_MAX_LEFT &&
          rect.width >= TOP_STRIP_MIN_WIDTH &&
          rect.width <= TOP_STRIP_MAX_WIDTH &&
          rect.height >= TOP_STRIP_MIN_HEIGHT &&
          rect.height <= TOP_STRIP_MAX_HEIGHT
        ) {
          target = current;
        }
        current = current.parentElement;
      }

      if (target) {
        matches.add(target);
      }
    }

    return Array.from(matches);
  };

  const resolveTopHeaderContainer = (
    chromeNodes: HTMLElement[],
  ): HTMLElement | null => {
    const topStripCounts = new Map<HTMLElement, number>();
    const sampleXs = [
      12,
      Math.max(12, Math.round(window.innerWidth / 2)),
      Math.max(12, window.innerWidth - 12),
    ];
    const sampleYs = [8, 24, 40];

    for (const x of sampleXs) {
      for (const y of sampleYs) {
        for (const hit of document.elementsFromPoint(x, y)) {
          if (!(hit instanceof HTMLElement)) {
            continue;
          }

          let current: HTMLElement | null = hit;
          const seenForPoint = new Set<HTMLElement>();
          while (current instanceof HTMLElement && current !== document.body) {
            if (
              isLikelyTopHeaderContainer(current) &&
              !seenForPoint.has(current)
            ) {
              topStripCounts.set(current, (topStripCounts.get(current) ?? 0) + 1);
              seenForPoint.add(current);
            }
            current = current.parentElement;
          }
        }
      }
    }

    const rankedTopStripCandidates = Array.from(topStripCounts.entries())
      .filter(([candidate]) => candidate !== document.documentElement)
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }

        const rectA = a[0].getBoundingClientRect();
        const rectB = b[0].getBoundingClientRect();
        if (rectB.width !== rectA.width) {
          return rectB.width - rectA.width;
        }

        return rectA.height - rectB.height;
      });

    const topStripContainer = rankedTopStripCandidates[0]?.[0] ?? null;
    if (topStripContainer instanceof HTMLElement) {
      return topStripContainer;
    }

    const counts = new Map<HTMLElement, number>();

    for (const chromeNode of chromeNodes) {
      let current: HTMLElement | null = chromeNode;
      const seenForNode = new Set<HTMLElement>();

      while (current instanceof HTMLElement && current !== document.body) {
        if (isLikelyTopHeaderContainer(current) && !seenForNode.has(current)) {
          counts.set(current, (counts.get(current) ?? 0) + 1);
          seenForNode.add(current);
        }
        current = current.parentElement;
      }
    }

    const ranked = Array.from(counts.entries())
      .filter(([candidate]) => candidate !== document.documentElement)
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }

        const rectA = a[0].getBoundingClientRect();
        const rectB = b[0].getBoundingClientRect();
        if (rectB.width !== rectA.width) {
          return rectB.width - rectA.width;
        }

        return rectA.height - rectB.height;
      });

    return ranked[0]?.[0] ?? null;
  };

  const resolveTopHeaderHideTarget = (
    banner: HTMLElement,
  ): HTMLElement => {
    let target = banner;
    let current = banner.parentElement;

    while (current instanceof HTMLElement && current !== document.body) {
      if (!isLikelyTopHeaderContainer(current)) {
        break;
      }

      target = current;
      current = current.parentElement;
    }

    return target;
  };

  const getHeaderInteractiveNodes = (container: HTMLElement): HTMLElement[] => {
    return Array.from(
      container.querySelectorAll(
        "button, [role='button'], a[href], input, [aria-label], [title]",
      ),
    ).filter((node): node is HTMLElement => node instanceof HTMLElement);
  };

  const getHeaderNodeHint = (node: HTMLElement): string => {
    return getInteractiveNodeHint(node);
  };

  const getFacebookChromeNodes = (
    container: HTMLElement,
    nodes: HTMLElement[],
  ): HTMLElement[] => {
    const matches = new Set<HTMLElement>();

    for (const node of nodes) {
      const hint = getHeaderNodeHint(node);
      const matchesSelector = FACEBOOK_CHROME_SELECTORS.some((selector) => {
        try {
          return node.matches(selector);
        } catch {
          return false;
        }
      });
      if (!matchesSelector && !FACEBOOK_CHROME_HINT_PATTERN.test(hint)) {
        continue;
      }

      let target: HTMLElement = node;
      while (
        target.parentElement instanceof HTMLElement &&
        target.parentElement !== container
      ) {
        target = target.parentElement;
      }
      matches.add(target);
    }

    return Array.from(matches);
  };

  const hasPreservedMessengerControlsInBanner = (
    nodes: HTMLElement[],
  ): boolean => {
    return nodes.some((node) => {
      const hint = getHeaderNodeHint(node);
      return PRESERVED_MESSENGER_CONTROL_PATTERN.test(hint);
    });
  };

  const setInactiveHeaderSuppressionState = (
    extra: Record<string, unknown> = {},
  ): void => {
    lastHeaderSuppressionState = {
      active: false,
      bannerCount: 0,
      hiddenBannerCount: 0,
      hiddenChromeCount: 0,
      mode: "off",
      requestedMode: "off",
      hasFacebookNavSignal: false,
      preservedMessengerControlsDetected: false,
      reusedIncomingSafeMode: false,
      incomingCallOverlayHintActive,
      stickyRecovery: false,
      ...extra,
    };
  };

  const setHeaderSuppressionStateFromSnapshot = (
    snapshot: HeaderSuppressionSnapshot,
    extra: Record<string, unknown> = {},
  ): void => {
    lastHeaderSuppressionState = {
      active: snapshot.active,
      bannerCount: snapshot.bannerCount,
      hiddenBannerCount: snapshot.hiddenBannerCount,
      hiddenChromeCount: snapshot.hiddenChromeCount,
      mode: snapshot.mode,
      requestedMode: snapshot.requestedMode,
      hasFacebookNavSignal: snapshot.hasFacebookNavSignal,
      preservedMessengerControlsDetected:
        snapshot.preservedMessengerControlsDetected,
      reusedIncomingSafeMode: snapshot.reusedIncomingSafeMode,
      incomingCallOverlayHintActive: snapshot.incomingCallOverlayHintActive,
      stickyRecovery: false,
      ...extra,
    };
  };

  const maybeSendHeaderSuppressionDebug = (reason: string): void => {
    const signature = JSON.stringify(lastHeaderSuppressionState);
    if (signature === lastHeaderSuppressionDebugSignature) {
      return;
    }

    lastHeaderSuppressionDebugSignature = signature;
    sendMediaOverlayDebug(reason, {
      force: true,
      headerSuppressionState: lastHeaderSuppressionState,
    });
  };

  const clearHeaderSuppressionMarkers = (): void => {
    document.documentElement.classList.remove(COLLAPSE_CLASS);
    document.documentElement.style.removeProperty(
      "--md-fb-header-collapse-height",
    );
    document.documentElement.style.removeProperty("--md-fb-shell-bottom-gap");
    document.documentElement.style.removeProperty(SHELL_TARGET_HEIGHT_VAR);
    document
      .querySelectorAll(
        `[${HEADER_HIDDEN_ATTR}], [${HIDDEN_CHROME_ATTR}], [${SHELL_STRETCH_ATTR}]`,
      )
      .forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        node.removeAttribute(HEADER_HIDDEN_ATTR);
        node.removeAttribute(HIDDEN_CHROME_ATTR);
        node.removeAttribute(SHELL_STRETCH_ATTR);
      });

  };

  const hasConnectedHeaderSuppressionTargets = (
    snapshot: HeaderSuppressionSnapshot | null,
  ): boolean => {
    if (!snapshot || !snapshot.active) {
      return false;
    }

    return (
      snapshot.bannerTargets.some(({ node }) => node.isConnected) ||
      snapshot.hiddenChromeTargets.some((node) => node.isConnected)
    );
  };

  const getStickyHeaderSuppressionSnapshot = (
    snapshot: HeaderSuppressionSnapshot | null,
  ): HeaderSuppressionSnapshot | null => {
    if (!snapshot || !snapshot.active) {
      return null;
    }

    if (!incomingCallOverlayHintActive || snapshot.mode !== "hide-banner") {
      return snapshot;
    }

    const bannerTargets = snapshot.bannerTargets.filter(
      (target) => target.mode !== "hide-banner",
    );
    const hiddenChromeCount = snapshot.hiddenChromeTargets.length;
    const active = bannerTargets.length > 0 || hiddenChromeCount > 0;

    return {
      ...snapshot,
      active,
      shouldCollapse: false,
      hiddenBannerCount: 0,
      hiddenChromeCount,
      mode: active ? "hide-facebook-nav-descendants" : "off",
      bannerTargets,
      collapseHeight: 0,
      reusedIncomingSafeMode: true,
      incomingCallOverlayHintActive: true,
    };
  };

  const applyHeaderSuppressionSnapshot = (
    snapshot: HeaderSuppressionSnapshot,
  ): void => {
    document.documentElement.classList.toggle(ACTIVE_CLASS, snapshot.active);
    document.documentElement.classList.toggle(
      COLLAPSE_CLASS,
      snapshot.active && snapshot.shouldCollapse && snapshot.collapseHeight > 0,
    );

    if (!snapshot.active) {
      return;
    }

    for (const { node, mode } of snapshot.bannerTargets) {
      if (!node.isConnected) continue;
      node.setAttribute(HEADER_HIDDEN_ATTR, mode);
    }

    for (const node of snapshot.hiddenChromeTargets) {
      if (!node.isConnected) continue;
      node.setAttribute(HIDDEN_CHROME_ATTR, "true");
    }

    if (snapshot.shouldCollapse && snapshot.collapseHeight > 0) {
      document.documentElement.style.setProperty(
        "--md-fb-header-collapse-height",
        `${Math.round(snapshot.collapseHeight)}px`,
      );

      if (
        snapshot.shellTarget instanceof HTMLElement &&
        snapshot.shellTarget.isConnected &&
        snapshot.shellTargetHeight !== null
      ) {
        snapshot.shellTarget.setAttribute(SHELL_STRETCH_ATTR, "true");
        document.documentElement.style.setProperty(
          SHELL_TARGET_HEIGHT_VAR,
          `${snapshot.shellTargetHeight}px`,
        );
      }
    }
  };

  const buildHeaderSuppressionSnapshot = (): HeaderSuppressionSnapshot => {
    const topChromeNodes = collectVisibleTopChromeNodes();
    const headerContainer = resolveTopHeaderContainer(topChromeNodes);
    const banners =
      headerContainer instanceof HTMLElement ? [headerContainer] : [];
    const bannerTargets: HeaderSuppressionSnapshot["bannerTargets"] = [];
    const topChromeHideTargets = new Set<HTMLElement>();
    const incomingCallBannerProtectionActive = incomingCallOverlayHintActive;
    let collapseHeight = 0;

    let hiddenBannerCount = 0;
    let hiddenChromeCount = 0;
    let lastMode: FacebookHeaderSuppressionMode = "off";
    let lastRequestedMode: FacebookHeaderSuppressionMode = "off";
    let hasFacebookNavSignal = topChromeNodes.length > 0;
    let preservedMessengerControlsDetected = false;
    let reusedIncomingSafeMode = false;

    for (const banner of banners) {
      const nodes = getHeaderInteractiveNodes(banner);
      const chromeNodes = getFacebookChromeNodes(banner, nodes);
      const hideTarget = resolveTopHeaderHideTarget(banner);
      const hasPreservedMessengerControls =
        hasPreservedMessengerControlsInBanner(nodes);
      const requestedMode = resolveFacebookHeaderSuppressionMode({
        isMessagesSurface: true,
        hasTopAnchoredBanner: true,
        hasFacebookNavSignal: chromeNodes.length > 0,
        hasPreservedMessengerControls,
      });
      const mode = resolveEffectiveFacebookHeaderSuppressionMode({
        requestedMode,
        incomingCallOverlayHintActive: incomingCallBannerProtectionActive,
        hasFacebookNavSignal:
          chromeNodes.length > 0 || topChromeNodes.length > 0,
        previousMode: lastAppliedHeaderSuppressionSnapshot?.mode ?? null,
      });
      lastRequestedMode = requestedMode;
      lastMode = mode;
      hasFacebookNavSignal =
        hasFacebookNavSignal ||
        chromeNodes.length > 0 ||
        topChromeNodes.length > 0;
      preservedMessengerControlsDetected =
        preservedMessengerControlsDetected || hasPreservedMessengerControls;
      reusedIncomingSafeMode =
        reusedIncomingSafeMode || requestedMode !== mode;

      if (mode === "hide-banner") {
        hiddenBannerCount += 1;
        collapseHeight = Math.max(
          collapseHeight,
          hideTarget.getBoundingClientRect().height,
        );
      } else if (mode === "hide-facebook-nav-descendants") {
        bannerTargets.push({ node: banner, mode });
      }

      for (const chromeNode of chromeNodes) {
        topChromeHideTargets.add(chromeNode);
      }
    }

    for (const chromeNode of topChromeNodes) {
      topChromeHideTargets.add(chromeNode);
    }

    if (!incomingCallBannerProtectionActive) {
      for (const stripTarget of collectLingeringTopStripTargets()) {
        hiddenBannerCount += 1;
        collapseHeight = Math.max(
          collapseHeight,
          stripTarget.getBoundingClientRect().height,
        );
      }
    }

    const hiddenChromeTargets = Array.from(topChromeHideTargets);
    hiddenChromeCount = hiddenChromeTargets.length;
    if (hiddenChromeCount > 0 && lastMode === "off") {
      lastMode = "hide-facebook-nav-descendants";
    }

    if (hiddenBannerCount > 0) {
      collapseHeight = Math.max(collapseHeight, 48);
    }

    const shouldCollapseMessagesSurface =
      hiddenBannerCount > 0 ||
      (hiddenChromeCount > 0 &&
        /^\/messages\/(?:e2ee\/)?t\//i.test(window.location.pathname));

    const active = hiddenBannerCount > 0 || hiddenChromeCount > 0;
    if (hiddenBannerCount === 0 && shouldCollapseMessagesSurface) {
      const topChromeBottom = topChromeNodes.reduce((maxBottom, node) => {
        return Math.max(maxBottom, node.getBoundingClientRect().bottom);
      }, 0);
      collapseHeight = Math.max(
        collapseHeight,
        Math.max(32, topChromeBottom - 20),
      );
    }

    const snapshot: HeaderSuppressionSnapshot = {
      active,
      shouldCollapse: false,
      bannerCount: banners.length,
      hiddenBannerCount,
      hiddenChromeCount,
      mode: lastMode,
      requestedMode: lastRequestedMode,
      hasFacebookNavSignal,
      preservedMessengerControlsDetected,
      reusedIncomingSafeMode,
      incomingCallOverlayHintActive: incomingCallBannerProtectionActive,
      collapseHeight,
      bannerTargets,
      hiddenChromeTargets,
      shellTarget: null,
      shellTargetHeight: null,
    };

    return snapshot;
  };

  const applyFacebookHeaderSuppression = (
    marketplaceThreadState?: MarketplaceThreadDebugState,
  ): void => {
    const currentMarketplaceThreadState =
      marketplaceThreadState ?? collectMarketplaceThreadDebugState();
    const routeKind = resolveMode(currentMarketplaceThreadState);
    const previousSnapshot = getStickyHeaderSuppressionSnapshot(
      lastAppliedHeaderSuppressionSnapshot,
    );
    clearHeaderSuppressionMarkers();

    if (routeKind !== "chat") {
      document.documentElement.classList.remove(ACTIVE_CLASS);
      activeMediaHeaderOverlayKind =
        routeKind === "media" ? activeMediaHeaderOverlayKind : null;
      lastAppliedHeaderSuppressionSnapshot = null;
      lastHeaderSuppressionDetectedAt = 0;
      setInactiveHeaderSuppressionState({
        incomingCallOverlayHintActive,
      });
      maybeSendHeaderSuppressionDebug("header-suppression-state");
      return;
    }

    if (shouldUseMarketplaceVisualCropHeuristic(currentMarketplaceThreadState)) {
      lastAppliedHeaderSuppressionSnapshot = null;
      lastHeaderSuppressionDetectedAt = 0;
      document.documentElement.classList.remove(ACTIVE_CLASS);
      setInactiveHeaderSuppressionState({
        incomingCallOverlayHintActive,
        marketplaceVisualCropActive: true,
        marketplaceVisualCropHeight:
          currentMarketplaceThreadState.visualCropHeight,
      });
      maybeSendHeaderSuppressionDebug("header-suppression-state");
      return;
    }

    const snapshot = buildHeaderSuppressionSnapshot();
    if (snapshot.active) {
      applyHeaderSuppressionSnapshot(snapshot);
      lastAppliedHeaderSuppressionSnapshot = snapshot;
      lastHeaderSuppressionDetectedAt = Date.now();
      setHeaderSuppressionStateFromSnapshot(snapshot);
      maybeSendHeaderSuppressionDebug("header-suppression-state");
      return;
    }

    const missingForMs =
      lastHeaderSuppressionDetectedAt > 0
        ? Date.now() - lastHeaderSuppressionDetectedAt
        : Number.POSITIVE_INFINITY;
    if (
      hasConnectedHeaderSuppressionTargets(previousSnapshot) &&
      shouldKeepFacebookHeaderSuppressionActive({
        previousActive: previousSnapshot?.active === true,
        currentActive: snapshot.active,
        missingForMs,
        graceMs: HEADER_SUPPRESSION_REAPPLY_GRACE_MS,
      })
    ) {
      applyHeaderSuppressionSnapshot(previousSnapshot!);
      lastAppliedHeaderSuppressionSnapshot = previousSnapshot;
      setHeaderSuppressionStateFromSnapshot(previousSnapshot!, {
        stickyRecovery: true,
        missingForMs,
      });
      maybeSendHeaderSuppressionDebug("header-suppression-state");
      return;
    }

    lastAppliedHeaderSuppressionSnapshot = null;
    lastHeaderSuppressionDetectedAt = 0;
    document.documentElement.classList.remove(ACTIVE_CLASS);
    setInactiveHeaderSuppressionState({
      incomingCallOverlayHintActive,
    });
    maybeSendHeaderSuppressionDebug("header-suppression-state");
  };

  type ComposerOverlayDebugState = {
    emojiPickerVisible: boolean;
    portalRootVisible: boolean;
    anchorVisible: boolean;
  };

  const collectComposerOverlayState = (): ComposerOverlayDebugState => {
    const emojiTriggerSelectors = [
      '[aria-label*="emoji" i]',
      '[title*="emoji" i]',
      '[data-testid*="emoji"]',
    ];
    const overlaySelectors = [
      "[role='dialog']",
      "[role='menu']",
      "[role='listbox']",
      "[role='grid']",
      "[aria-modal='true']",
      "[data-testid*='popover']",
      "[data-testid*='emoji']",
    ];
    const overlayHintPattern = /\b(emoji|emojis|sticker|stickers|gif|gifs)\b/i;

    const anchorVisible = emojiTriggerSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some((node) =>
        isAriaVisible(node),
      ),
    );

    const portalRootVisible = overlaySelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some((node) => {
        if (!(node instanceof HTMLElement) || !isAriaVisible(node)) {
          return false;
        }
        if (node.closest("[role='banner']")) {
          return false;
        }

        const label = normalizeLabelText(
          node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            node.textContent,
        );
        if (overlayHintPattern.test(label.slice(0, 240))) {
          return true;
        }

        const childLabels = Array.from(
          node.querySelectorAll("button, [role='button'], [aria-label]"),
        )
          .slice(0, 12)
          .map((child) => extractInteractiveLabel(child))
          .filter(Boolean);
        return childLabels.some((childLabel) =>
          overlayHintPattern.test(childLabel),
        );
      }),
    );

    return {
      emojiPickerVisible: anchorVisible && portalRootVisible,
      portalRootVisible,
      anchorVisible,
    };
  };

  const isComposerInteractionPauseActive = (now = Date.now()): boolean =>
    composerInteractionPauseUntil > now;

  const scheduleComposerInteractionRecovery = (): void => {
    if (composerInteractionRecoveryTimer !== null) {
      clearTimeout(composerInteractionRecoveryTimer);
      composerInteractionRecoveryTimer = null;
    }

    const remainingMs = composerInteractionPauseUntil - Date.now();
    if (remainingMs <= 0) {
      composerInteractionPauseUntil = 0;
      scheduleMediaOverlayRecheck();
      scheduleApply();
      scheduleViewportStateSend(true);
      return;
    }

    composerInteractionRecoveryTimer = window.setTimeout(() => {
      composerInteractionRecoveryTimer = null;
      if (!isComposerInteractionPauseActive()) {
        composerInteractionPauseUntil = 0;
        scheduleMediaOverlayRecheck();
        scheduleApply();
        scheduleViewportStateSend(true);
      }
    }, remainingMs + 10);
  };

  const armComposerInteractionPause = (
    durationMs = COMPOSER_INTERACTION_PAUSE_MS,
  ): void => {
    composerInteractionPauseUntil = Math.max(
      composerInteractionPauseUntil,
      Date.now() + Math.max(100, Math.round(durationMs)),
    );
    scheduleComposerInteractionRecovery();
  };

  const isComposerOverlayInteractionTarget = (
    target: EventTarget | null,
  ): boolean => {
    if (!(target instanceof Element)) {
      return false;
    }

    const overlayRoot = target.closest(
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
    if (!(overlayRoot instanceof HTMLElement) || !isAriaVisible(overlayRoot)) {
      return false;
    }

    const label = normalizeLabelText(
      overlayRoot.getAttribute("aria-label") ||
        overlayRoot.getAttribute("title") ||
        overlayRoot.textContent,
    ).slice(0, 240);
    return /\b(emoji|emojis|sticker|stickers|gif|gifs)\b/i.test(label);
  };

  const collectCallSurfaceState = (): {
    callWindowOpen: boolean;
    isMuted: boolean | null;
  } => {
    const controls = Array.from(
      document.querySelectorAll("button, [role='button'], a[role='button']"),
    );
    let callWindowOpen = false;
    let isMuted: boolean | null = null;

    for (const control of controls) {
      if (!(control instanceof HTMLElement) || !isAriaVisible(control)) {
        continue;
      }

      const label = extractInteractiveLabel(control);
      if (!label) continue;

      if (
        /\b(end call|hang up|leave call|disconnect|mute|unmute|turn off camera|turn on camera|speaker)\b/i.test(
          label,
        )
      ) {
        callWindowOpen = true;
      }

      const normalizedLabel = label.toLowerCase();
      if (normalizedLabel.includes("unmute")) {
        isMuted = true;
      } else if (normalizedLabel.includes("mute") && isMuted === null) {
        isMuted = false;
      }
    }

    return { callWindowOpen, isMuted };
  };

  const handleRendererInteractionEvent = (event: Event): void => {
    const label = extractInteractiveLabel(event.target);
    const emojiInteraction =
      /\bemoji\b/i.test(label) || isComposerOverlayInteractionTarget(event.target);
    if (emojiInteraction) {
      armComposerInteractionPause();
    }
    if (!label) return;

    let interactionKind: "call-mute-toggle" | null = null;
    if (/\b(?:mute|unmute)\b/i.test(label)) {
      interactionKind = "call-mute-toggle";
    }

    if (!interactionKind) return;

    window.setTimeout(() => {
      const composerOverlayState = collectComposerOverlayState();
      const callSurfaceState = collectCallSurfaceState();
      sendMediaOverlayDebug("renderer-interaction", {
        force: true,
        interactionKind,
        interactionLabel: label,
        viewportState: buildViewportStatePayload(),
        composerOverlayState,
        callSurfaceState,
      });
      scheduleViewportStateSend(true);
      scheduleApply();
    }, 0);
  };

  document.addEventListener("mousedown", handleRendererInteractionEvent, {
    capture: true,
  });
  document.addEventListener("click", handleRendererInteractionEvent, {
    capture: true,
  });

  const buildViewportStatePayload = (
    marketplaceThreadState?: MarketplaceThreadDebugState,
  ): MessagesViewportStatePayload => {
    const currentMarketplaceThreadState =
      marketplaceThreadState ?? collectMarketplaceThreadDebugState();
    const marketplaceThreadVisible =
      currentMarketplaceThreadState.marketplaceThreadVisible;
    const marketplaceVisualCropHeight = shouldUseMarketplaceVisualCropHeuristic(
      currentMarketplaceThreadState,
    )
      ? currentMarketplaceThreadState.visualCropHeight
      : null;
    const effectiveMediaOverlayVisible =
      mediaOverlayVisible || detectMediaOverlayVisible();
    const routeKind = resolveViewportMode({
      urlPath: window.location.pathname,
      mediaOverlayVisible: effectiveMediaOverlayVisible,
      marketplaceThreadVisible,
    });
    const headerHeight =
      routeKind === "chat"
        ? Math.round(
            lastAppliedHeaderSuppressionSnapshot?.collapseHeight ??
              DEFAULT_MESSAGES_HEADER_HEIGHT,
          )
        : null;

    return resolveMessagesViewportState({
      url: window.location.href,
      urlPath: window.location.pathname,
      headerHeight,
      cropHeight: marketplaceVisualCropHeight,
      mediaOverlayVisible: effectiveMediaOverlayVisible,
      marketplaceThreadVisible,
      marketplaceVisualCropHeight,
    });
  };

  const sendViewportStateNow = (force = false): void => {
    const marketplaceThreadState = collectMarketplaceThreadDebugState();
    const viewportState = buildViewportStatePayload(marketplaceThreadState);
    const unchanged =
      !force &&
      lastSentViewportState !== null &&
      JSON.stringify(lastSentViewportState) === JSON.stringify(viewportState);
    if (unchanged) return;

    lastSentViewportState = viewportState;
    ipcRenderer.send("messages-viewport-state", viewportState);
    sendMediaOverlayDebug("viewport-state-send", {
      force,
      sentVisible: mediaOverlayVisible,
      incomingCallOverlayVisible:
        incomingCallOverlayHintActive || detectIncomingCallOverlayVisible(),
      incomingCallOverlayHintActive,
      effectiveOverlayVisible: getViewportOverlayVisible(),
      viewportState,
      marketplaceThreadState,
    });
  };

  const scheduleViewportStateSend = (force = false): void => {
    if (viewportStateSendTimer !== null) {
      clearTimeout(viewportStateSendTimer);
    }

    viewportStateSendTimer = window.setTimeout(() => {
      viewportStateSendTimer = null;
      sendViewportStateNow(force);
    }, VIEWPORT_STATE_SEND_DEBOUNCE_MS);
  };

  const ensureStyleTag = (): void => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html.${ACTIVE_CLASS} [${HEADER_HIDDEN_ATTR}="hide-banner"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      html.${ACTIVE_CLASS} [${HIDDEN_CHROME_ATTR}="true"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      html.${ACTIVE_CLASS} [${HEADER_HIDDEN_ATTR}="hide-facebook-nav-descendants"],
      html.${ACTIVE_CLASS} [${HEADER_HIDDEN_ATTR}="hide-facebook-nav-descendants"]::before,
      html.${ACTIVE_CLASS} [${HEADER_HIDDEN_ATTR}="hide-facebook-nav-descendants"]::after {
        box-shadow: none !important;
        filter: none !important;
        border-bottom: none !important;
      }

      html.${ACTIVE_CLASS}.${COLLAPSE_CLASS} body > div[id^="mount_"],
      html.${ACTIVE_CLASS}.${COLLAPSE_CLASS} body > div[id^="mount_"] > div,
      html.${ACTIVE_CLASS}.${COLLAPSE_CLASS} [data-pagelet="root"] {
        margin-top: calc(-1 * var(--md-fb-header-collapse-height, 0px)) !important;
        padding-top: 0 !important;
        min-height: calc(100vh + var(--md-fb-header-collapse-height, 0px)) !important;
      }

      html.${ACTIVE_CLASS}.${COLLAPSE_CLASS} [${SHELL_STRETCH_ATTR}="true"] {
        min-height: var(${SHELL_TARGET_HEIGHT_VAR}, auto) !important;
        height: var(${SHELL_TARGET_HEIGHT_VAR}, auto) !important;
        max-height: none !important;
      }

      html.${ACTIVE_CLASS} body > div[id^="mount_"],
      html.${ACTIVE_CLASS} body > div[id^="mount_"] > div,
      html.${ACTIVE_CLASS} [data-pagelet="root"] {
        margin-top: 0 !important;
        padding-top: 0 !important;
      }
    `;
    document.head.appendChild(style);
  };

  const applyCompensation = (): void => {
    if (!document.head) return;
    ensureStyleTag();

    if (isComposerInteractionPauseActive()) {
      scheduleComposerInteractionRecovery();
      return;
    }

    const marketplaceThreadState = collectMarketplaceThreadDebugState();
    const marketplaceThreadDebugSignature = JSON.stringify(
      marketplaceThreadState,
    );
    if (marketplaceThreadDebugSignature !== lastMarketplaceThreadDebugSignature) {
      lastMarketplaceThreadDebugSignature = marketplaceThreadDebugSignature;
      sendMediaOverlayDebug("marketplace-thread-state-change", {
        force: true,
        marketplaceThreadState,
      });
    }

    const mode = resolveMode(marketplaceThreadState);
    if (mode !== lastViewportMode) {
      const previousMode = lastViewportMode;
      lastViewportMode = mode;
      if (mode !== "media") {
        activeMediaHeaderOverlayKind = null;
      }
      scheduleViewportStateSend(true);
      sendMediaOverlayDebug("viewport-mode-change", {
        force: true,
        previousMode,
        nextMode: mode,
        marketplaceThreadState,
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

    applyFacebookHeaderSuppression(marketplaceThreadState);
    bindMediaHeaderExternalAnchors();
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
      if (isComposerInteractionPauseActive()) {
        scheduleComposerInteractionRecovery();
        return;
      }
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
    "click",
    (_event) => {
      if (isComposerInteractionPauseActive()) {
        scheduleComposerInteractionRecovery();
        return;
      }
      scheduleMediaOverlayRecheck();
      scheduleApply();
      scheduleViewportStateSend(true);
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (isComposerOverlayInteractionTarget(event.target)) {
        armComposerInteractionPause();
      }
      if (isComposerInteractionPauseActive()) {
        scheduleComposerInteractionRecovery();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      scheduleMediaOverlayRecheck();
      scheduleApply();
      scheduleViewportStateSend(true);
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

  ipcRenderer.on(
    "trigger-viewport-recovery",
    (_event, payload?: { reason?: string; delay?: number; timestamp?: number }) => {
      const reason =
        typeof payload?.reason === "string"
          ? payload.reason
          : "main-process-request";
      sendMediaOverlayDebug("viewport-recovery-trigger", {
        force: true,
        reason,
        delay:
          typeof payload?.delay === "number" ? payload.delay : undefined,
        timestamp:
          typeof payload?.timestamp === "number"
            ? payload.timestamp
            : undefined,
      });
      scheduleViewportRecovery(reason);
      scheduleApply();
      scheduleViewportStateSend(true);
    },
  );
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
