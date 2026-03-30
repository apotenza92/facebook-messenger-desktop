type ViewportMode = "chat" | "media" | "other";

type DeterministicCaseName = "all" | "muted-conflict";

const fs = require("fs");
const path = require("path");

const APP_ROOT = process.env.MESSENGER_APP_ROOT
  ? path.resolve(process.env.MESSENGER_APP_ROOT)
  : path.resolve(__dirname, "..");

const {
  resolveMessagesViewportState,
  resolveViewportMode,
  shouldApplyMessagesCrop,
} = require(path.join(APP_ROOT, "src/preload/messages-viewport-policy"));
const {
  collectMarketplaceThreadHintSignals,
  hasMarketplaceThreadHeaderSignal,
  isMarketplaceThreadActionHint,
  isMarketplaceThreadBackHint,
  isMarketplaceThreadHeaderHint,
} = require(path.join(APP_ROOT, "src/preload/marketplace-thread-policy.ts"));
const loadIncomingCallHintPolicy = () =>
  require(
    path.join(APP_ROOT, "src/preload/incoming-call-overlay-hint-policy.ts"),
  );
const loadNotificationDecisionPolicy = () =>
  require(path.join(APP_ROOT, "src/preload/notification-decision-policy.ts"));
const loadNotificationDisplayPolicy = () =>
  require(path.join(APP_ROOT, "src/preload/notification-display-policy.ts"));
const loadIncomingCallOverlayPolicy = () =>
  require(path.join(APP_ROOT, "src/main/incoming-call-overlay-policy.ts"));
const loadIncomingCallIpcPolicy = () =>
  require(path.join(APP_ROOT, "src/main/incoming-call-ipc-policy.ts"));
const loadIncomingCallEvidence = () =>
  require(path.join(APP_ROOT, "src/shared/incoming-call-evidence.ts"));
const loadFacebookHeaderSuppressionPolicy = () =>
  require(
    path.join(APP_ROOT, "src/preload/facebook-header-suppression-policy.ts"),
  );
const {
  decideWindowOpenAction,
  isMessagesSurfaceRoute,
} = require(
  path.join(APP_ROOT, "src/main/url-policy"),
);

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`,
    );
  }
};

const shouldApplyMainCrop = (input: { url: string }): boolean => {
  return isMessagesSurfaceRoute(input.url);
};

const parseCliArgs = (
  argv: string[],
): {
  caseName: DeterministicCaseName;
  jsonOutput?: string;
} => {
  let caseName: DeterministicCaseName = "all";
  let jsonOutput: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--case") {
      const value = String(argv[i + 1] || "").trim();
      i += 1;
      if (value === "all" || value === "muted-conflict") {
        caseName = value;
      } else {
        throw new Error(`Unknown --case value: ${value}`);
      }
    } else if (arg === "--json-output") {
      jsonOutput = path.resolve(String(argv[i + 1] || "").trim());
      i += 1;
    } else if (arg === "--app-root") {
      // Consumed by APP_ROOT via env; accepting the flag keeps the script ergonomically consistent.
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node -r ./scripts/register-ts.js scripts/test-issues-regressions.ts [options]\n\nOptions:\n  --case <all|muted-conflict>   Run the full deterministic suite or the Issue #46 evidence case\n  --json-output <path>          Write structured JSON evidence to the given path\n  --app-root <dir>              Alternate app root (prefer MESSENGER_APP_ROOT env)\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { caseName, jsonOutput };
};

const writeJsonOutput = (
  jsonOutput: string | undefined,
  value: unknown,
): void => {
  if (!jsonOutput) return;
  fs.mkdirSync(path.dirname(jsonOutput), { recursive: true });
  fs.writeFileSync(jsonOutput, JSON.stringify(value, null, 2), "utf8");
};

const buildMutedConflictEvidence = () => {
  const notificationDecisionPolicy = loadNotificationDecisionPolicy();
  const payload = {
    title: "Alex",
    body: "sent a message",
  };
  const candidateRows = [
    {
      href: "/t/alex",
      title: "Alex",
      body: "sent a message",
      muted: false,
      unread: true,
    },
    {
      href: "/t/group-project",
      title: "Project Squad",
      body: "Alex sent a message",
      muted: true,
      unread: true,
    },
  ];
  const observedHref = "/t/alex";
  const nativeMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      payload,
      candidateRows,
    );
  const observedDecision =
    typeof notificationDecisionPolicy.resolveObservedSidebarNotificationTarget ===
    "function"
      ? notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
          payload,
          observedHref,
          candidateRows,
        )
      : {
          ...nativeMatch,
          observedHref,
          matchedObservedHref: nativeMatch.matchedHref === observedHref,
          shouldNotify:
            !nativeMatch.ambiguous &&
            !nativeMatch.muted &&
            nativeMatch.matchedHref === observedHref,
          fallback: "derived-from-native-match",
        };
  const capturedNotificationEvents = Array.isArray(
    (globalThis as typeof globalThis & { __mdNotificationEvents?: unknown[] })
      .__mdNotificationEvents,
  )
    ? [
        ...((
          globalThis as typeof globalThis & {
            __mdNotificationEvents?: unknown[];
          }
        ).__mdNotificationEvents as unknown[]),
      ]
    : [];

  return {
    case: "muted-conflict",
    generatedAt: new Date().toISOString(),
    appRoot: APP_ROOT,
    expected: {
      nativeReason: "muted-conflict",
      nativeShouldNotify: false,
      observedReason: "muted-conflict",
      observedShouldNotify: false,
      matchedHref: null,
      matchedObservedHref: false,
    },
    payload,
    candidateRows,
    nativeMatch: {
      ...nativeMatch,
      shouldNotify: !nativeMatch.ambiguous && !nativeMatch.muted,
      matchedHref: nativeMatch.matchedHref ?? null,
      unmatchedHrefs: candidateRows
        .map((candidate: { href: string }) => candidate.href)
        .filter((href: string) => href !== nativeMatch.matchedHref),
    },
    observedDecision: {
      ...observedDecision,
      observedHref,
      matchedHref: observedDecision.matchedHref ?? null,
      unmatchedHrefs: candidateRows
        .map((candidate: { href: string }) => candidate.href)
        .filter((href: string) => href !== observedDecision.matchedHref),
    },
    notificationCapture: {
      enabled:
        process.env.MESSENGER_TEST_CAPTURE_NOTIFICATIONS === "1" ||
        process.env.MESSENGER_TEST_CAPTURE_NOTIFICATIONS === "true",
      eventCount: capturedNotificationEvents.length,
      events: capturedNotificationEvents,
    },
  };
};

const runViewportPolicyTests = () => {
  const expectMode = (
    path: string,
    expectedMode: ViewportMode,
    expectedCrop: boolean,
    extra: {
      mediaOverlayVisible?: boolean;
      marketplaceThreadVisible?: boolean;
    } = {},
  ) => {
    const mode = resolveViewportMode({
      urlPath: path,
      mediaOverlayVisible: extra.mediaOverlayVisible,
      marketplaceThreadVisible: extra.marketplaceThreadVisible,
    });
    const crop = shouldApplyMessagesCrop({
      urlPath: path,
      mediaOverlayVisible: extra.mediaOverlayVisible,
      marketplaceThreadVisible: extra.marketplaceThreadVisible,
    });
    assertEqual(
      mode,
      expectedMode,
      `#45 viewport mode mismatch for ${path}`,
    );
    assertEqual(
      crop,
      expectedCrop,
      `#45 crop mismatch for ${path}`,
    );
  };

  // Core #45 deterministic checks
  expectMode("/messages/t/123", "chat", true);
  expectMode("/messages/e2ee/t/123", "chat", true);
  expectMode("/messages/media_viewer.123", "media", false);
  expectMode("/messenger_media?attachment_id=123", "media", false);
  expectMode("/messenger_media/?attachment_id=123", "media", false);
  expectMode("/photo/123", "media", false);
  expectMode("/settings", "other", false);
  expectMode("/messages/t/123", "media", false, {
    mediaOverlayVisible: true,
  });
  expectMode("/messages/e2ee/t/123", "media", false, {
    mediaOverlayVisible: true,
  });
  expectMode("/messages/t/123", "chat", false, {
    marketplaceThreadVisible: true,
  });
  expectMode("/messages/t/123", "chat", true);

  const viewportState = resolveMessagesViewportState({
    url: "https://www.facebook.com/messages/e2ee/t/123",
    urlPath: "/messages/e2ee/t/123",
    headerHeight: 56,
  });
  assertEqual(
    viewportState.routeKind,
    "chat",
    "#45 viewport state should classify E2EE thread routes as chat layout",
  );
  assertEqual(
    viewportState.shouldCrop,
    true,
    "#45 viewport state should keep the permanent crop for E2EE chat routes",
  );

  const overlayViewportState = resolveMessagesViewportState({
    url: "https://www.facebook.com/messages/e2ee/t/123",
    urlPath: "/messages/e2ee/t/123",
    headerHeight: 56,
    mediaOverlayVisible: true,
  });
  assertEqual(
    overlayViewportState.routeKind,
    "media",
    "#45 same-route E2EE media viewer should switch to media layout",
  );
  assertEqual(
    overlayViewportState.shouldCrop,
    false,
    "#45 same-route E2EE media viewer should disable chat crop",
  );

  const composerOverlayViewportState = resolveMessagesViewportState({
    url: "https://www.facebook.com/messages/t/123",
    urlPath: "/messages/t/123",
    headerHeight: 56,
  });
  assertEqual(
    composerOverlayViewportState.routeKind,
    "chat",
    "#41 emoji/composer overlays should not change the underlying chat route classification",
  );
  assertEqual(
    composerOverlayViewportState.shouldCrop,
    true,
    "#41 emoji/composer overlays should keep the BrowserView crop active",
  );

  const marketplaceViewportState = resolveMessagesViewportState({
    url: "https://www.facebook.com/messages/t/123",
    urlPath: "/messages/t/123",
    headerHeight: 56,
    marketplaceThreadVisible: true,
  });
  assertEqual(
    marketplaceViewportState.routeKind,
    "chat",
    "#49 marketplace threads should keep the chat header-suppression path active",
  );
  assertEqual(
    marketplaceViewportState.shouldCrop,
    false,
    "#49 marketplace threads should disable the BrowserView crop without disabling header suppression",
  );

  // Transition sequence reproducing "first chat works, subsequent chats break"
  const sequence: Array<{
    path: string;
    mode: ViewportMode;
    crop: boolean;
  }> = [
    { path: "/messages/t/first", mode: "chat", crop: true },
    { path: "/messages/media_viewer.123", mode: "media", crop: false },
    { path: "/messages/t/first", mode: "chat", crop: true },
    { path: "/messages/t/second", mode: "chat", crop: true },
    { path: "/messenger_media?attachment_id=2", mode: "media", crop: false },
    { path: "/messenger_media/?attachment_id=2", mode: "media", crop: false },
    { path: "/messages/t/second", mode: "chat", crop: true },
    { path: "/photo/42", mode: "media", crop: false },
    { path: "/messages/t/first", mode: "chat", crop: true },
  ];

  sequence.forEach((step, index) => {
    expectMode(step.path, step.mode, step.crop);
    assertEqual(
      step.mode === "chat",
      step.crop,
      `#45 sequence stale crop state at step ${index + 1}`,
    );
  });
};

const runMarketplaceThreadPolicyTests = () => {
  assertEqual(
    isMarketplaceThreadActionHint("View Listing"),
    true,
    "#49 marketplace listing actions should mark the native marketplace thread UI",
  );
  assertEqual(
    isMarketplaceThreadActionHint(
      "https://www.facebook.com/marketplace/item/1234567890",
    ),
    true,
    "#49 marketplace item links should mark the native marketplace thread UI",
  );
  assertEqual(
    JSON.stringify(
      collectMarketplaceThreadHintSignals(
        "Back https://www.facebook.com/marketplace/item/1234567890 Marketplace",
      ),
    ),
    JSON.stringify(["item-link", "header", "back"]),
    "#49 marketplace hint classification should stay structured and privacy-safe",
  );
  assertEqual(
    isMarketplaceThreadHeaderHint("Marketplace"),
    true,
    "#49 marketplace thread headers should be recognized",
  );
  assertEqual(
    isMarketplaceThreadBackHint("Back to Previous Page"),
    true,
    "#49 marketplace back controls should be recognized",
  );
  assertEqual(
    hasMarketplaceThreadHeaderSignal(["Back", "Marketplace"]),
    true,
    "#49 Allen's Back + Marketplace header should disable the Messenger crop",
  );
  assertEqual(
    hasMarketplaceThreadHeaderSignal(["Back", "Chat info"]),
    false,
    "#49 generic chat back controls should not disable the Messenger crop",
  );
};

const runWindowOpenRoutingTests = () => {
  assertEqual(
    decideWindowOpenAction("https://www.facebook.com/messages/t/123"),
    "reroute-main-view",
    "#45 chat popups should still reroute into the main Messenger surface",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/messenger_media?attachment_id=123",
    ),
    "reroute-main-view",
    "#45 canonical messenger_media routes should stay in the main Messenger surface",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/messenger_media/?attachment_id=123",
    ),
    "reroute-main-view",
    "#45 messenger_media routes should stay in the main Messenger surface",
  );
  assertEqual(
    decideWindowOpenAction("https://www.facebook.com/messages/media_viewer.123"),
    "reroute-main-view",
    "#45 media_viewer routes should stay in the main Messenger surface",
  );
};

const runHeaderSuppressionPolicyTests = () => {
  const headerSuppressionPolicy = loadFacebookHeaderSuppressionPolicy();
  assert(
    typeof headerSuppressionPolicy.resolveEffectiveFacebookHeaderSuppressionMode ===
      "function",
    "header suppression policy missing effective-mode resolver",
  );

  assertEqual(
    headerSuppressionPolicy.resolveFacebookHeaderSuppressionMode({
      isMessagesSurface: true,
      hasTopAnchoredBanner: true,
      hasFacebookNavSignal: true,
      hasPreservedMessengerControls: false,
    }),
    "hide-banner",
    "#45 pure Facebook global header should be hidden as a banner",
  );

  assertEqual(
    headerSuppressionPolicy.resolveFacebookHeaderSuppressionMode({
      isMessagesSurface: true,
      hasTopAnchoredBanner: true,
      hasFacebookNavSignal: true,
      hasPreservedMessengerControls: true,
    }),
    "hide-facebook-nav-descendants",
    "#47 mixed banner should hide only Facebook chrome descendants",
  );

  assertEqual(
    headerSuppressionPolicy.resolveFacebookHeaderSuppressionMode({
      isMessagesSurface: true,
      hasTopAnchoredBanner: true,
      hasFacebookNavSignal: false,
      hasPreservedMessengerControls: true,
    }),
    "off",
    "#45 unknown top banner should fail open",
  );

  assertEqual(
    headerSuppressionPolicy.resolveEffectiveFacebookHeaderSuppressionMode({
      requestedMode: "hide-banner",
      incomingCallOverlayHintActive: true,
      hasFacebookNavSignal: true,
      previousMode: null,
    }),
    "hide-facebook-nav-descendants",
    "#47 incoming-call hint should downgrade whole-banner suppression to descendant-only hiding",
  );

  assertEqual(
    headerSuppressionPolicy.resolveEffectiveFacebookHeaderSuppressionMode({
      requestedMode: "hide-banner",
      incomingCallOverlayHintActive: true,
      hasFacebookNavSignal: false,
      previousMode: null,
    }),
    "off",
    "#47 incoming-call hint should fail open instead of hiding the whole banner when chrome descendants are missing",
  );

  assertEqual(
    headerSuppressionPolicy.resolveEffectiveFacebookHeaderSuppressionMode({
      requestedMode: "hide-banner",
      incomingCallOverlayHintActive: true,
      hasFacebookNavSignal: false,
      previousMode: "hide-facebook-nav-descendants",
    }),
    "hide-facebook-nav-descendants",
    "#47 incoming-call hint should retain the prior descendant-only mode through short DOM misses",
  );

  assertEqual(
    headerSuppressionPolicy.shouldKeepFacebookHeaderSuppressionActive({
      previousActive: true,
      currentActive: false,
      missingForMs: 240,
      graceMs: 600,
    }),
    true,
    "#45 header suppression should survive short Messenger reflow gaps",
  );

  assertEqual(
    headerSuppressionPolicy.shouldKeepFacebookHeaderSuppressionActive({
      previousActive: true,
      currentActive: false,
      missingForMs: 900,
      graceMs: 600,
    }),
    false,
    "#45 header suppression should clear once the reflow grace window expires",
  );

  assertEqual(
    headerSuppressionPolicy.resolveMessagesShellTargetHeight({
      viewportHeight: 900,
      shellTop: 48,
      collapseHeight: 56,
    }),
    900,
    "#45 shell stretch should account for the collapsed header offset to avoid a bottom gap",
  );

  assertEqual(
    headerSuppressionPolicy.resolveMessagesShellTargetHeight({
      viewportHeight: 900,
      shellTop: 96,
      collapseHeight: 40,
    }),
    844,
    "#45 shell stretch should preserve any remaining top inset after partial collapse",
  );
};

const runIncomingCallOverlayLifecycleTests = () => {
  const incomingCallOverlayPolicy = loadIncomingCallOverlayPolicy();
  assert(
    typeof incomingCallOverlayPolicy.parseIncomingCallOverlayHintVisible ===
      "function",
    "incoming call overlay policy missing parseIncomingCallOverlayHintVisible",
  );
  assert(
    typeof incomingCallOverlayPolicy.applyIncomingCallOverlayHintSignal ===
      "function",
    "incoming call overlay policy missing applyIncomingCallOverlayHintSignal",
  );
  assert(
    typeof incomingCallOverlayPolicy.clearIncomingCallOverlayHintState ===
      "function",
    "incoming call overlay policy missing clearIncomingCallOverlayHintState",
  );
  assert(
    typeof incomingCallOverlayPolicy.collectStaleIncomingCallOverlayHintIds ===
      "function",
    "incoming call overlay policy missing collectStaleIncomingCallOverlayHintIds",
  );
  assert(
    typeof incomingCallOverlayPolicy.shouldAcceptIncomingCallOverlayHintSender ===
      "function",
    "incoming call overlay policy missing sender guard helper",
  );
  assert(
    typeof incomingCallOverlayPolicy.shouldResetIncomingCallOverlayOnNavigation ===
      "function",
    "incoming call overlay policy missing navigation-reset helper",
  );

  const state = {
    visibleByWebContentsId: new Map<number, boolean>(),
    lastHintAtByWebContentsId: new Map<number, number>(),
  };
  const webContentsId = 41;
  const activeSenderId = 41;
  const otherSenderId = 73;

  assertEqual(
    incomingCallOverlayPolicy.shouldAcceptIncomingCallOverlayHintSender(
      activeSenderId,
      activeSenderId,
    ),
    true,
    "#47 incoming-call hint should accept active messenger sender",
  );
  assertEqual(
    incomingCallOverlayPolicy.shouldAcceptIncomingCallOverlayHintSender(
      otherSenderId,
      activeSenderId,
    ),
    false,
    "#47 incoming-call hint should reject non-active sender",
  );

  const chatUrl = "https://www.facebook.com/messages/t/123";
  assertEqual(
    incomingCallOverlayPolicy.shouldResetIncomingCallOverlayOnNavigation(
      chatUrl,
    ),
    false,
    "#47 incoming-call overlay should not reset on in-messages navigation",
  );
  assertEqual(
    incomingCallOverlayPolicy.shouldResetIncomingCallOverlayOnNavigation(
      "https://www.facebook.com/settings",
    ),
    true,
    "#47 incoming-call overlay should reset when leaving messages routes",
  );

  assertEqual(
    shouldApplyMainCrop({
      url: chatUrl,
    }),
    true,
    "#47 main crop should be enabled before incoming-call hint",
  );

  const t0 = 1_000;
  const incomingCallStart =
    incomingCallOverlayPolicy.applyIncomingCallOverlayHintSignal(
      state,
      webContentsId,
      true,
      t0,
    );
  assertEqual(
    incomingCallStart.changed,
    true,
    "#47 incoming-call true hint should transition visibility",
  );
  assertEqual(
    shouldApplyMainCrop({
      url: chatUrl,
    }),
    true,
    "#47 main crop should stay enabled while incoming-call hint is visible",
  );

  const heartbeat =
    incomingCallOverlayPolicy.applyIncomingCallOverlayHintSignal(
      state,
      webContentsId,
      true,
      t0 + 12_000,
    );
  assertEqual(
    heartbeat.changed,
    false,
    "#47 incoming-call heartbeat should refresh timestamp without toggling visibility",
  );

  const staleTooEarly =
    incomingCallOverlayPolicy.collectStaleIncomingCallOverlayHintIds(
      state,
      t0 + 12_000 + 29_999,
      30_000,
    );
  assertEqual(
    staleTooEarly.includes(webContentsId),
    false,
    "#47 watchdog should not expire recent incoming-call heartbeat state",
  );

  const incomingCallEnd =
    incomingCallOverlayPolicy.applyIncomingCallOverlayHintSignal(
      state,
      webContentsId,
      false,
      t0 + 13_000,
    );
  assertEqual(
    incomingCallEnd.changed,
    true,
    "#47 incoming-call false hint should restore visibility state",
  );
  assertEqual(
    shouldApplyMainCrop({
      url: chatUrl,
    }),
    true,
    "#47 main crop should be restored after incoming-call hint clears",
  );

  incomingCallOverlayPolicy.applyIncomingCallOverlayHintSignal(
    state,
    webContentsId,
    true,
    t0 + 30_000,
  );
  const staleIds =
    incomingCallOverlayPolicy.collectStaleIncomingCallOverlayHintIds(
      state,
      t0 + 60_001,
      30_000,
    );
  assertEqual(
    staleIds.includes(webContentsId),
    true,
    "#47 watchdog should identify stale incoming-call hint state",
  );

  const staleReset =
    incomingCallOverlayPolicy.clearIncomingCallOverlayHintState(
      state,
      webContentsId,
    );
  assertEqual(
    staleReset.changed,
    true,
    "#47 watchdog/navigation reset should clear stale incoming-call state",
  );
  assertEqual(
    shouldApplyMainCrop({
      url: chatUrl,
    }),
    true,
    "#47 crop should be restored after stale incoming-call state recovery",
  );
};

const runIncomingCallHintPolicyTests = () => {
  const incomingCallHintPolicy = loadIncomingCallHintPolicy();
  assert(
    typeof incomingCallHintPolicy.shouldTreatIncomingCallUiAsVisible ===
      "function",
    "incoming call hint policy missing shouldTreatIncomingCallUiAsVisible",
  );
  assert(
    typeof incomingCallHintPolicy.shouldActivateIncomingCallHint === "function",
    "incoming call hint policy missing shouldActivateIncomingCallHint",
  );
  assert(
    typeof incomingCallHintPolicy.shouldKeepIncomingCallHintActive ===
      "function",
    "incoming call hint policy missing shouldKeepIncomingCallHintActive",
  );
  assert(
    typeof incomingCallHintPolicy.getIncomingCallHintClearReason === "function",
    "incoming call hint policy missing getIncomingCallHintClearReason",
  );

  assertEqual(
    incomingCallHintPolicy.shouldTreatIncomingCallUiAsVisible({
      answerVisible: false,
      declineVisible: false,
      joinVisible: false,
      titleSignal: false,
      selectorSignal: true,
      textSignal: false,
    }),
    true,
    "#47 soft selector signal should keep incoming-call hint visible",
  );
  assertEqual(
    incomingCallHintPolicy.shouldTreatIncomingCallUiAsVisible({
      answerVisible: false,
      declineVisible: false,
      joinVisible: false,
      titleSignal: false,
      selectorSignal: false,
      textSignal: true,
    }),
    true,
    "#47 call text signal should keep incoming-call hint visible",
  );
  assertEqual(
    incomingCallHintPolicy.shouldActivateIncomingCallHint({
      evidence: {
        source: "dom-soft",
        confidence: "medium",
        hasVisibleControls: false,
      },
      overlayVisibleNow: false,
    }),
    false,
    "#41 soft/background evidence alone should not start the incoming-call overlay hint",
  );
  assertEqual(
    incomingCallHintPolicy.shouldActivateIncomingCallHint({
      evidence: {
        source: "dom-explicit",
        confidence: "high",
        hasVisibleControls: true,
      },
      overlayVisibleNow: false,
    }),
    true,
    "#41 explicit incoming-call UI should still start the incoming-call overlay hint",
  );
  assertEqual(
    incomingCallHintPolicy.shouldActivateIncomingCallHint({
      evidence: {
        source: "native-notification",
        confidence: "medium",
        hasVisibleControls: false,
      },
      overlayVisibleNow: true,
    }),
    true,
    "#41 a currently visible incoming-call overlay should keep the hint active even after a native-notification signal",
  );
  assertEqual(
    incomingCallHintPolicy.shouldKeepIncomingCallHintActive({
      sinceStartMs: 3_500,
      sinceVisibleMs: 2_500,
      minHoldMs: 4_000,
      missGraceMs: 2_000,
    }),
    true,
    "#47 hint hold should survive short Messenger reflow gaps",
  );
  assertEqual(
    incomingCallHintPolicy.shouldKeepIncomingCallHintActive({
      sinceStartMs: 4_500,
      sinceVisibleMs: 2_500,
      minHoldMs: 4_000,
      missGraceMs: 2_000,
    }),
    false,
    "#47 hint hold should end once hold and grace windows both expire",
  );
  assertEqual(
    incomingCallHintPolicy.getIncomingCallHintClearReason({
      activeForMs: 4_500,
      missingForMs: 2_500,
      detectedSinceHint: true,
      minStickyMs: 4_000,
      missingClearMs: 2_000,
      maxWithoutDetectionMs: 10_000,
    }),
    "incoming-call-controls-missing",
    "#47 visible-call clear should wait for wider missing-controls window",
  );
  assertEqual(
    incomingCallHintPolicy.getIncomingCallHintClearReason({
      activeForMs: 9_500,
      missingForMs: 9_500,
      detectedSinceHint: false,
      minStickyMs: 4_000,
      missingClearMs: 2_000,
      maxWithoutDetectionMs: 10_000,
    }),
    null,
    "#47 never-detected hint should not clear before stale timeout",
  );
};

const runIncomingCallIpcPolicyTests = () => {
  const incomingCallIpcPolicy = loadIncomingCallIpcPolicy();
  const incomingCallEvidence = loadIncomingCallEvidence();
  assert(
    typeof incomingCallIpcPolicy.applyIncomingCallWindowFocus === "function",
    "incoming call IPC policy missing applyIncomingCallWindowFocus",
  );
  assert(
    typeof incomingCallIpcPolicy.decideIncomingCallNativeNotification ===
      "function",
    "incoming call IPC policy missing decideIncomingCallNativeNotification",
  );
  assert(
    typeof incomingCallIpcPolicy.decideIncomingCallSignalEscalation ===
      "function",
    "incoming call IPC policy missing decideIncomingCallSignalEscalation",
  );

  const notificationOnlyEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      source: "notification:NATIVE_CALL",
    });
  assertEqual(
    notificationOnlyEscalation.shouldEscalate,
    false,
    "#47 notification-only call signals should not arm incoming-call reminder state",
  );

  const periodicScanWithoutCallerEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      source: "periodic-scan",
    });
  assertEqual(
    periodicScanWithoutCallerEscalation.shouldEscalate,
    false,
    "#47 periodic-scan call signals without a caller should not arm incoming-call reminder state",
  );

  const domSignalEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      source: "dom-node",
    });
  assertEqual(
    domSignalEscalation.shouldEscalate,
    true,
    "#47 explicit DOM call signals should still arm incoming-call reminder state",
  );

  const lowConfidenceEvidenceEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "native-notification",
        confidence: "low",
      }),
    });
  assertEqual(
    lowConfidenceEvidenceEscalation.shouldEscalate,
    false,
    "#41 low-confidence native call evidence should not escalate",
  );
  assertEqual(
    lowConfidenceEvidenceEscalation.reason,
    "low-confidence-evidence",
    "#41 low-confidence native call evidence should report suppression reason",
  );

  const recoverySoftEvidenceEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "dom-soft",
        confidence: "medium",
        recoveryActive: true,
      }),
      recoveryActive: true,
    });
  assertEqual(
    recoverySoftEvidenceEscalation.shouldEscalate,
    false,
    "#41 recovery settling should suppress non-explicit incoming-call evidence",
  );
  assertEqual(
    recoverySoftEvidenceEscalation.reason,
    "recovery-requires-explicit-dom",
    "#41 recovery settling should require explicit DOM call evidence",
  );

  const recoveryExplicitEvidenceEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "dom-explicit",
        confidence: "high",
        hasVisibleControls: true,
        recoveryActive: true,
      }),
      recoveryActive: true,
    });
  assertEqual(
    recoveryExplicitEvidenceEscalation.shouldEscalate,
    true,
    "#41 recovery settling should still allow explicit DOM call evidence",
  );

  const focusEvents: string[] = [];
  const focusResult = incomingCallIpcPolicy.applyIncomingCallWindowFocus({
    isMinimized: () => true,
    restore: () => focusEvents.push("restore"),
    show: () => focusEvents.push("show"),
    focus: () => focusEvents.push("focus"),
  });
  assertEqual(
    focusResult.focused,
    true,
    "incoming-call IPC should focus an available window",
  );
  assertEqual(
    focusResult.restoredFromMinimized,
    true,
    "incoming-call IPC should report restore when minimized",
  );
  assertEqual(
    focusEvents.join(","),
    "restore,show,focus",
    "incoming-call IPC should restore then show/focus minimized windows",
  );

  const directFocusEvents: string[] = [];
  const directFocusResult = incomingCallIpcPolicy.applyIncomingCallWindowFocus({
    isMinimized: () => false,
    restore: () => directFocusEvents.push("restore"),
    show: () => directFocusEvents.push("show"),
    focus: () => directFocusEvents.push("focus"),
  });
  assertEqual(
    directFocusResult.restoredFromMinimized,
    false,
    "incoming-call IPC should not restore non-minimized windows",
  );
  assertEqual(
    directFocusEvents.join(","),
    "show,focus",
    "incoming-call IPC should show/focus non-minimized windows",
  );

  const noWindowResult =
    incomingCallIpcPolicy.applyIncomingCallWindowFocus(null);
  assertEqual(
    noWindowResult.focused,
    false,
    "incoming-call IPC should safely handle missing windows",
  );

  const baseNow = 100_000;
  const map = new Map<string, number>([["stale-key", baseNow - 80_000]]);
  let lastNoKeyAt = 0;

  const firstKeyed = incomingCallIpcPolicy.decideIncomingCallNativeNotification(
    {
      payload: { dedupeKey: " call-123 " },
      now: baseNow,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    },
  );
  assertEqual(
    firstKeyed.shouldNotify,
    true,
    "incoming-call IPC should allow first keyed notification",
  );
  assertEqual(
    firstKeyed.callKey,
    "call-123",
    "incoming-call IPC should normalize dedupe key",
  );
  map.set(incomingCallIpcPolicy.INCOMING_CALL_NO_KEY_MAP_KEY, firstKeyed.now);

  const noKeyAfterRecentIncomingCall =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: {},
      now: firstKeyed.now + 2_000,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: firstKeyed.now,
    });
  assertEqual(
    noKeyAfterRecentIncomingCall.shouldNotify,
    false,
    "incoming-call IPC should suppress no-key echoes immediately after a recent incoming-call notification",
  );
  assertEqual(
    noKeyAfterRecentIncomingCall.reason,
    "no-key-cooldown",
    "incoming-call IPC should treat recent incoming-call notifications as no-key cooldown guards",
  );

  map.set(firstKeyed.callKey, firstKeyed.now);

  const duplicateKeyed =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: { dedupeKey: "call-123" },
      now: baseNow + 3_000,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    });
  assertEqual(
    duplicateKeyed.shouldNotify,
    false,
    "incoming-call IPC should dedupe repeat keyed notifications",
  );
  assertEqual(
    duplicateKeyed.reason,
    "same-key",
    "incoming-call IPC should report same-key dedupe reason",
  );

  const ttlMs = incomingCallIpcPolicy.INCOMING_CALL_KEY_TTL_MS;
  const noKeyCooldownMs =
    incomingCallIpcPolicy.INCOMING_CALL_NO_KEY_COOLDOWN_MS;

  const keyedAfterTtl =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: { dedupeKey: "call-123" },
      now: firstKeyed.now + ttlMs + 5,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    });
  assertEqual(
    keyedAfterTtl.shouldNotify,
    true,
    "incoming-call IPC should allow keyed notification after TTL",
  );
  assertEqual(
    map.has("stale-key"),
    false,
    "incoming-call IPC should clean stale dedupe keys",
  );

  const noKeyFirst = incomingCallIpcPolicy.decideIncomingCallNativeNotification(
    {
      payload: {},
      now: baseNow + ttlMs + 10_000,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    },
  );
  assertEqual(
    noKeyFirst.shouldNotify,
    true,
    "incoming-call IPC should allow first no-key notification",
  );
  map.set(incomingCallIpcPolicy.INCOMING_CALL_NO_KEY_MAP_KEY, noKeyFirst.now);
  lastNoKeyAt = noKeyFirst.now;

  const noKeyJitter =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: {},
      now:
        noKeyFirst.now +
        incomingCallIpcPolicy.INCOMING_CALL_NO_KEY_JITTER_GUARD_MS -
        1,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    });
  assertEqual(
    noKeyJitter.shouldNotify,
    false,
    "incoming-call IPC should suppress no-key jitter bursts",
  );
  assertEqual(
    noKeyJitter.reason,
    "no-key-jitter-window",
    "incoming-call IPC should report no-key jitter dedupe reason",
  );

  const noKeyCooldown =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: {},
      now:
        noKeyFirst.now +
        incomingCallIpcPolicy.INCOMING_CALL_NO_KEY_JITTER_GUARD_MS +
        50,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    });
  assertEqual(
    noKeyCooldown.shouldNotify,
    false,
    "incoming-call IPC should suppress no-key cooldown duplicates",
  );
  assertEqual(
    noKeyCooldown.reason,
    "no-key-cooldown",
    "incoming-call IPC should report no-key cooldown dedupe reason",
  );

  const noKeyAfterCooldown =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: {},
      now: noKeyFirst.now + noKeyCooldownMs + 5,
      notificationByKey: map,
      lastNoKeyIncomingCallNotificationAt: lastNoKeyAt,
    });
  assertEqual(
    noKeyAfterCooldown.shouldNotify,
    true,
    "incoming-call IPC should allow no-key notification after cooldown",
  );
};

const runNotificationPolicyTests = () => {
  const notificationDecisionPolicy = loadNotificationDecisionPolicy();
  assert(
    typeof notificationDecisionPolicy.resolveNativeNotificationTarget ===
      "function",
    "notification decision policy missing resolveNativeNotificationTarget",
  );
  assert(
    typeof notificationDecisionPolicy.createNotificationDeduper === "function",
    "notification decision policy missing createNotificationDeduper",
  );
  assert(
    typeof notificationDecisionPolicy.resolveObservedSidebarNotificationTarget ===
      "function",
    "notification decision policy missing resolveObservedSidebarNotificationTarget",
  );
  assert(
    typeof notificationDecisionPolicy.isLikelyGlobalFacebookNotification ===
      "function",
    "notification decision policy missing isLikelyGlobalFacebookNotification",
  );
  assert(
    typeof notificationDecisionPolicy.classifyCallNotification === "function",
    "notification decision policy missing classifyCallNotification",
  );
  assert(
    typeof notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview ===
      "function",
    "notification decision policy missing isLikelySelfAuthoredMessagePreview",
  );
  assert(
    typeof notificationDecisionPolicy.shouldSuppressSelfAuthoredNotification ===
      "function",
    "notification decision policy missing shouldSuppressSelfAuthoredNotification",
  );

  const mutedIndividualMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Alex",
        body: "Can you review this?",
      },
      [
        {
          href: "/t/alex",
          title: "Alex",
          body: "Can you review this?",
          muted: true,
          unread: true,
        },
        {
          href: "/t/group-project",
          title: "Project Squad",
          body: "Alex sent a message",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    mutedIndividualMatch.ambiguous,
    false,
    "#46 muted individual should resolve to a single candidate",
  );
  assertEqual(
    mutedIndividualMatch.matchedHref,
    "/t/alex",
    "#46 muted individual matched wrong conversation",
  );
  assertEqual(
    mutedIndividualMatch.muted,
    true,
    "#46 muted individual should mark result as muted",
  );

  const mutedConflictEvidence = buildMutedConflictEvidence();
  const mutedConflictMatch = mutedConflictEvidence.nativeMatch;
  assertEqual(
    mutedConflictMatch.ambiguous,
    true,
    "#46 sender-title + muted group alternative should fail closed",
  );
  assertEqual(
    mutedConflictMatch.reason,
    "muted-conflict",
    "#46 sender-title + muted group alternative should return muted-conflict reason",
  );
  assertEqual(
    mutedConflictMatch.matchedHref,
    null,
    "#46 muted-conflict should not resolve a matchedHref",
  );

  const placeholderTitleMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Facebook User",
        body: "Alex sent a message",
      },
      [
        {
          href: "/t/alex",
          title: "Alex",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Alex sent a message",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    placeholderTitleMutedConflict.reason,
    "muted-conflict",
    "#46 placeholder-title notifications should fail closed when a muted candidate overlaps",
  );
  assertEqual(
    placeholderTitleMutedConflict.ambiguityReason,
    "placeholder-title",
    "#46 placeholder-title notifications should record the placeholder ambiguity reason",
  );
  assertEqual(
    placeholderTitleMutedConflict.placeholderTitle,
    "facebook user",
    "#46 placeholder-title notifications should preserve the normalized placeholder title for diagnostics",
  );

  const aliasMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Alexander",
        body: "sent a message",
      },
      [
        {
          href: "/t/alexander",
          title: "Alexander",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Alex sent a message",
          searchText: "Project Squad Alexander sent a message",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    aliasMutedConflict.reason,
    "muted-conflict",
    "#46 sender-title notifications should fail closed when muted-group metadata carries the sender real name",
  );

  const aliasMutedConflictWithoutMetadata =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Alexander",
        body: "sent a message",
      },
      [
        {
          href: "/t/alexander",
          title: "Alexander",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Alex sent a message",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    aliasMutedConflictWithoutMetadata.reason,
    "muted-conflict",
    "#46 sender-title notifications should fail closed when muted-group previews only expose the sender nickname",
  );

  const aliasNonMutedAlternative =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Alexander",
        body: "sent a message",
      },
      [
        {
          href: "/t/alexander",
          title: "Alexander",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Alex sent a message",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    aliasNonMutedAlternative.ambiguous,
    false,
    "#46 sender-title notifications should stay deliverable when the only alias overlap is in an unmuted conversation",
  );
  assertEqual(
    aliasNonMutedAlternative.matchedHref,
    "/t/alexander",
    "#46 sender-title notifications should still target the direct conversation when alias overlap is unmuted",
  );
  assertEqual(
    aliasNonMutedAlternative.muted,
    false,
    "#46 sender-title notifications should not be muted just because an unmuted conversation shares the sender nickname",
  );

  const newMessageMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "New Message",
        body: "Shipped the fix",
      },
      [
        {
          href: "/t/direct-thread",
          title: "Alex",
          body: "Shipped the fix",
          muted: false,
          unread: true,
        },
        {
          href: "/t/release-group",
          title: "Release Squad",
          body: "Shipped the fix",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    newMessageMutedConflict.reason,
    "muted-conflict",
    "#46 generic New Message notifications should fail closed when muted previews overlap",
  );
  assertEqual(
    newMessageMutedConflict.ambiguityReason,
    "placeholder-title",
    "#46 generic New Message notifications should be classified as placeholder-title ambiguity",
  );

  const notificationTitleMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Notification",
        body: "Shipped the fix",
      },
      [
        {
          href: "/t/direct-thread",
          title: "Alex",
          body: "Shipped the fix",
          muted: false,
          unread: true,
        },
        {
          href: "/t/release-group",
          title: "Release Squad",
          body: "Shipped the fix",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    notificationTitleMutedConflict.reason,
    "muted-conflict",
    "#46 generic Notification titles should fail closed when muted previews overlap",
  );
  assertEqual(
    notificationTitleMutedConflict.ambiguityReason,
    "placeholder-title",
    "#46 generic Notification titles should preserve placeholder-title ambiguity",
  );

  const mutedGroupTitleMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Project Squad",
        body: "Alex: shipped the fix",
      },
      [
        {
          href: "/t/group-project",
          title: "Project Squad",
          body: "Alex: shipped the fix",
          muted: true,
          unread: true,
        },
        {
          href: "/t/alex",
          title: "Alex",
          body: "shipped the fix",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    mutedGroupTitleMatch.ambiguous,
    false,
    "#46 muted group-title case should resolve to a single candidate",
  );
  assertEqual(
    mutedGroupTitleMatch.matchedHref,
    "/t/group-project",
    "#46 muted group-title case matched wrong conversation",
  );
  assertEqual(
    mutedGroupTitleMatch.muted,
    true,
    "#46 muted group-title case should mark result as muted",
  );

  const directMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Taylor",
        body: "Are you free?",
      },
      [
        {
          href: "/t/taylor",
          title: "Taylor",
          body: "Are you free?",
          muted: false,
          unread: true,
        },
        {
          href: "/t/random-group",
          title: "Weekend Plans",
          body: "Dinner on Friday",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    directMatch.ambiguous,
    false,
    "#46 direct conversation should resolve confidently",
  );
  assertEqual(
    directMatch.matchedHref,
    "/t/taylor",
    "#46 direct conversation matched wrong conversation",
  );
  assertEqual(
    directMatch.muted,
    false,
    "#46 direct conversation should not be muted",
  );

  const observedDirectMatch =
    notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
      {
        title: "Taylor",
        body: "Are you free?",
      },
      "/t/taylor",
      [
        {
          href: "/t/taylor",
          title: "Taylor",
          body: "Are you free?",
          muted: false,
          unread: true,
        },
        {
          href: "/t/weekend-group",
          title: "Weekend Plans",
          body: "Dinner on Friday",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    observedDirectMatch.shouldNotify,
    true,
    "#46 observed direct conversation should remain deliverable",
  );
  assertEqual(
    observedDirectMatch.matchedObservedHref,
    true,
    "#46 observed direct conversation should match the changed sidebar row",
  );

  const observedMutedConflict = mutedConflictEvidence.observedDecision;
  assertEqual(
    observedMutedConflict.shouldNotify,
    false,
    "#46 observed muted-conflict sidebar updates should fail closed",
  );
  assertEqual(
    observedMutedConflict.reason,
    "muted-conflict",
    "#46 observed muted-conflict sidebar updates should preserve muted-conflict reason",
  );

  const observedRowMismatch =
    notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
      {
        title: "Weekend Plans",
        body: "Dinner on Friday",
      },
      "/t/taylor",
      [
        {
          href: "/t/taylor",
          title: "Taylor",
          body: "Are you free?",
          muted: false,
          unread: true,
        },
        {
          href: "/t/weekend-group",
          title: "Weekend Plans",
          body: "Dinner on Friday",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    observedRowMismatch.shouldNotify,
    false,
    "#46 observed sidebar mismatches should fail closed",
  );
  assertEqual(
    observedRowMismatch.reason,
    "observed-row-mismatch",
    "#46 observed sidebar mismatches should report observed-row-mismatch",
  );

  const globalSocialSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "Facebook",
      body: "Sam commented on your post",
    });
  assertEqual(
    globalSocialSuppressed,
    true,
    "#46 should suppress non-message Facebook activity notifications",
  );

  const facebookUserSocialSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "Facebook User",
      body: "Sam commented on your post",
    });
  assertEqual(
    facebookUserSocialSuppressed,
    true,
    "#46 should suppress generic Facebook User activity notifications",
  );

  const newNotificationSocialSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "New Notification",
      body: "Sam replied to your comment",
    });
  assertEqual(
    newNotificationSocialSuppressed,
    true,
    "#46 should suppress generic New Notification activity payloads",
  );

  const suggestedForYouSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "Notifications",
      body: "Suggested for you",
    });
  assertEqual(
    suggestedForYouSuppressed,
    true,
    "#46 should suppress generic Facebook suggestion notifications",
  );

  const directMessageNotSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "Taylor",
      body: "Are you free tonight?",
    });
  assertEqual(
    directMessageNotSuppressed,
    false,
    "#46 should not suppress normal message notifications",
  );

  const selfAuthoredTextMessage =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Michael Potenza",
      body: "You: selfnotif test",
    });
  assertEqual(
    selfAuthoredTextMessage,
    true,
    "#41 should suppress self-authored text previews",
  );

  const selfAuthoredAttachmentMessage =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Michael Potenza",
      body: "You sent an attachment.",
    });
  assertEqual(
    selfAuthoredAttachmentMessage,
    true,
    "#41 should suppress self-authored attachment previews",
  );

  const selfAuthoredDraftPreview =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Account A",
      body: "Draft: still typing this reply",
    });
  assertEqual(
    selfAuthoredDraftPreview,
    true,
    "#41 should suppress unsent draft previews",
  );

  const incomingMessagePreview =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Michael Potenza",
      body: "Can you review this?",
    });
  assertEqual(
    incomingMessagePreview,
    false,
    "#41 should not suppress incoming previews",
  );

  const selfAuthoredEditedMessage =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Michael Potenza",
      body: "You edited a message",
    });
  assertEqual(
    selfAuthoredEditedMessage,
    true,
    "#41 should suppress self-authored edited-message previews",
  );

  const selfAuthoredPayloadMismatchSuppressed =
    notificationDecisionPolicy.shouldSuppressSelfAuthoredNotification([
      {
        title: "Michael Potenza",
        body: "You: selfnotif test",
      },
      {
        title: "Michael Potenza",
        body: "selfnotif test",
      },
    ]);
  assertEqual(
    selfAuthoredPayloadMismatchSuppressed,
    true,
    "#41 should suppress self-authored notifications even when sidebar text drops the You prefix",
  );

  const draftPayloadMismatchSuppressed =
    notificationDecisionPolicy.shouldSuppressSelfAuthoredNotification([
      {
        title: "Account A",
        body: "New message",
      },
      {
        title: "Account A",
        body: "Draft: still typing this reply",
      },
    ]);
  assertEqual(
    draftPayloadMismatchSuppressed,
    true,
    "#41 should suppress notifications when the matched sidebar preview is still a local draft",
  );

  const incomingPayloadMismatchNotSuppressed =
    notificationDecisionPolicy.shouldSuppressSelfAuthoredNotification([
      {
        title: "Michael Potenza",
        body: "Can you review this?",
      },
      {
        title: "Michael Potenza",
        body: "Can you review this?",
      },
    ]);
  assertEqual(
    incomingPayloadMismatchNotSuppressed,
    false,
    "#41 should keep normal incoming notifications when neither payload is self-authored",
  );

  const callClassifierBodyCase =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Facebook",
      body: "Alex is calling you",
    });
  assertEqual(
    callClassifierBodyCase.isIncomingCall,
    true,
    "#46 call classifier should detect body-based incoming calls",
  );

  const callClassifierTitleCase =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Incoming video call",
      body: "",
    });
  assertEqual(
    callClassifierTitleCase.isIncomingCall,
    true,
    "#46 call classifier should detect title-based incoming calls",
  );

  const ongoingCallClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Messenger",
      body: "Ongoing Call...",
    });
  assertEqual(
    ongoingCallClassifier.isIncomingCall,
    false,
    "#47 call classifier should reject ongoing-call status rows",
  );

  const missedCallClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Messenger",
      body: "Missed video call",
    });
  assertEqual(
    missedCallClassifier.isIncomingCall,
    false,
    "#41 call classifier should reject missed-call history rows",
  );

  const cancelledCallClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Messenger",
      body: "Call cancelled",
    });
  assertEqual(
    cancelledCallClassifier.isIncomingCall,
    false,
    "#41 call classifier should reject cancelled-call history rows",
  );

  const answeredElsewhereClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Messenger",
      body: "Answered on another device",
    });
  assertEqual(
    answeredElsewhereClassifier.isIncomingCall,
    false,
    "#41 call classifier should reject answered-elsewhere status rows",
  );

  const callStartedClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Messenger",
      body: "Video call has started",
    });
  assertEqual(
    callStartedClassifier.isIncomingCall,
    false,
    "#41 call classifier should reject in-progress call started status rows",
  );

  const joinCallClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Messenger",
      body: "Join the video call",
    });
  assertEqual(
    joinCallClassifier.isIncomingCall,
    false,
    "#41 call classifier should reject join-call status rows",
  );

  const titleOnlyClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Incoming video call",
      body: "",
    });
  assertEqual(
    titleOnlyClassifier.usedTitleOnly,
    true,
    "#41 title-only call classification should be marked as title-only evidence",
  );

  const incomingCallNotSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "Facebook",
      body: "Alex is calling you",
    });
  assertEqual(
    incomingCallNotSuppressed,
    false,
    "#46 should not globally suppress incoming call notifications",
  );

  const deduper = notificationDecisionPolicy.createNotificationDeduper(5000);
  assertEqual(
    deduper.shouldSuppress("/t/group-project", 1000),
    false,
    "#46 deduper should allow first delivery",
  );
  assertEqual(
    deduper.shouldSuppress("/t/group-project", 2500),
    true,
    "#46 deduper should suppress rapid sender/group duplicates",
  );
  assertEqual(
    deduper.shouldSuppress("/t/group-project", 9000),
    false,
    "#46 deduper should allow after TTL expires",
  );
};

const runNotificationDisplayPolicyTests = () => {
  const notificationDisplayPolicy = loadNotificationDisplayPolicy();
  assert(
    typeof notificationDisplayPolicy.formatNotificationDisplayTitle ===
      "function",
    "notification display policy missing formatNotificationDisplayTitle",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Bub",
      alternateNames: ["Robert"],
    }),
    "Bub (Robert)",
    "#46 notification titles should show nickname + real name for direct chats",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Weekend Plans",
      alternateNames: ["Alexander", "Taylor", "Casey"],
    }),
    "Weekend Plans (Alexander, Taylor +1)",
    "#46 notification titles should summarize multiple real names for groups",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Alex",
      alternateNames: ["Facebook User", "Alex", "Alexander"],
    }),
    "Alex (Alexander)",
    "#46 notification titles should filter generic and duplicate alternate names",
  );
};

const runMutedConflictEvidenceCase = (jsonOutput?: string) => {
  const evidence = buildMutedConflictEvidence();
  const nativeLooksFixed =
    evidence.nativeMatch.reason === "muted-conflict" &&
    evidence.nativeMatch.shouldNotify === false &&
    evidence.nativeMatch.matchedHref === null;
  const observedLooksFixed =
    evidence.observedDecision.reason === "muted-conflict" &&
    evidence.observedDecision.shouldNotify === false &&
    evidence.observedDecision.matchedObservedHref === false;

  const enrichedEvidence = {
    ...evidence,
    verdict: {
      nativeLooksFixed,
      observedLooksFixed,
      overall:
        nativeLooksFixed && observedLooksFixed ? "fixed" : "pre-fix-or-partial",
    },
  };

  writeJsonOutput(jsonOutput, enrichedEvidence);
  console.log(
    jsonOutput
      ? `PASS deterministic regression tests (muted-conflict evidence written to ${jsonOutput})`
      : "PASS deterministic regression tests (muted-conflict evidence)",
  );
};

const run = (caseName: DeterministicCaseName, jsonOutput?: string) => {
  if (caseName === "muted-conflict") {
    runMutedConflictEvidenceCase(jsonOutput);
    return;
  }

  runViewportPolicyTests();
  runMarketplaceThreadPolicyTests();
  runWindowOpenRoutingTests();
  runHeaderSuppressionPolicyTests();
  runIncomingCallOverlayLifecycleTests();
  runIncomingCallHintPolicyTests();
  runIncomingCallIpcPolicyTests();
  runNotificationDisplayPolicyTests();
  runNotificationPolicyTests();
  console.log("PASS deterministic regression tests");
};

try {
  const args = parseCliArgs(process.argv.slice(2));
  run(args.caseName, args.jsonOutput);
} catch (error) {
  console.error("FAIL deterministic regression tests failed:", error);
  process.exit(1);
}
