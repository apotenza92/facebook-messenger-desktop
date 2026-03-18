type ViewportMode = "chat" | "media" | "other";

type DeterministicCaseName = "all" | "muted-conflict";

const fs = require("fs");
const path = require("path");

const APP_ROOT = process.env.MESSENGER_APP_ROOT
  ? path.resolve(process.env.MESSENGER_APP_ROOT)
  : path.resolve(__dirname, "..");

const {
  resolveMediaViewerStateVisible,
  resolveViewportMode,
  shouldApplyMessagesCrop,
  shouldTreatDetectedMediaOverlayAsVisible,
  shouldKeepMediaViewerBannerHiddenDuringLoadingWindow,
  shouldHideMediaViewerBannerWhileLoading,
  shouldTreatHintedMediaOverlayAsVisible,
} = require(path.join(APP_ROOT, "src/preload/messages-viewport-policy"));
const loadIncomingCallHintPolicy = () =>
  require(
    path.join(APP_ROOT, "src/preload/incoming-call-overlay-hint-policy.ts"),
  );
const loadNotificationDecisionPolicy = () =>
  require(path.join(APP_ROOT, "src/preload/notification-decision-policy.ts"));
const loadIncomingCallOverlayPolicy = () =>
  require(path.join(APP_ROOT, "src/main/incoming-call-overlay-policy.ts"));
const loadIncomingCallIpcPolicy = () =>
  require(path.join(APP_ROOT, "src/main/incoming-call-ipc-policy.ts"));
const loadIncomingCallEvidence = () =>
  require(path.join(APP_ROOT, "src/shared/incoming-call-evidence.ts"));
const { isMessagesRoute, isMessagesMediaViewerRoute } = require(
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

const isMessagesMediaPopupUrl = (url: string): boolean => {
  if (!url) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      path === "/messages/attachment_preview" ||
      path.startsWith("/messages/attachment_preview/") ||
      path === "/messages/media_viewer" ||
      path.startsWith("/messages/media_viewer/")
    );
  } catch {
    return false;
  }
};

const shouldApplyMainCrop = (input: {
  url: string;
  mediaViewerVisible: boolean;
  incomingCallOverlayVisible: boolean;
}): boolean => {
  return (
    isMessagesRoute(input.url) &&
    !isMessagesMediaViewerRoute(input.url) &&
    !isMessagesMediaPopupUrl(input.url) &&
    !input.mediaViewerVisible &&
    !input.incomingCallOverlayVisible
  );
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
    mediaOverlayVisible: boolean,
    expectedMode: ViewportMode,
    expectedCrop: boolean,
  ) => {
    const mode = resolveViewportMode({ urlPath: path, mediaOverlayVisible });
    const crop = shouldApplyMessagesCrop({
      urlPath: path,
      mediaOverlayVisible,
    });
    assertEqual(
      mode,
      expectedMode,
      `#45 viewport mode mismatch for ${path} (visible=${mediaOverlayVisible})`,
    );
    assertEqual(
      crop,
      expectedCrop,
      `#45 crop mismatch for ${path} (visible=${mediaOverlayVisible})`,
    );
  };

  // Core #45 deterministic checks
  expectMode("/messages/t/123", false, "chat", true);
  expectMode("/messages/t/123", true, "media", false);
  expectMode("/messages/e2ee/t/123", false, "chat", true);
  expectMode("/messages/e2ee/t/123", true, "media", false);
  expectMode("/messages/media_viewer.123", false, "media", false);
  expectMode("/messenger_media/?attachment_id=123", false, "media", false);
  expectMode("/photo/123", false, "media", false);
  expectMode("/settings", false, "other", false);

  // Transition sequence reproducing "first chat works, subsequent chats break"
  const sequence: Array<{
    path: string;
    visible: boolean;
    mode: ViewportMode;
    crop: boolean;
  }> = [
    { path: "/messages/t/first", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/first", visible: true, mode: "media", crop: false },
    { path: "/messages/t/first", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/second", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/second", visible: true, mode: "media", crop: false },
    { path: "/messages/t/second", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/first", visible: true, mode: "media", crop: false },
    { path: "/messages/t/first", visible: false, mode: "chat", crop: true },
  ];

  sequence.forEach((step, index) => {
    expectMode(step.path, step.visible, step.mode, step.crop);
    assertEqual(
      step.mode === "chat",
      step.crop,
      `#45 sequence stale crop state at step ${index + 1}`,
    );
  });

  // Incoming-call overlays must not contaminate media-viewer IPC state.
  assertEqual(
    resolveMediaViewerStateVisible({
      mediaOverlayVisible: false,
      incomingCallOverlayVisible: true,
    }),
    false,
    "#47 incoming-call overlay should not force media-viewer-state visible",
  );
  assertEqual(
    resolveMediaViewerStateVisible({
      mediaOverlayVisible: true,
      incomingCallOverlayVisible: false,
    }),
    true,
    "#47 real media overlay should continue forcing media-viewer-state visible",
  );

  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/photo/123",
      hasDismissAction: false,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
    }),
    true,
    "#49 photo route should hide the Facebook banner while viewer controls are still loading",
  );
  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/messages/media_viewer.123",
      hasDismissAction: false,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
    }),
    true,
    "#49 messages media viewer route should hide the Facebook banner while viewer controls are still loading",
  );
  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/messenger_media/?attachment_id=123",
      hasDismissAction: false,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
    }),
    true,
    "#49 messenger_media route should hide the Facebook banner while viewer controls are still loading",
  );
  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/photo/123",
      hasDismissAction: true,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
    }),
    false,
    "#49 photo route should stop hiding the banner once dismiss controls mount",
  );
  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/video/123",
      hasDismissAction: false,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
    }),
    false,
    "#49 non-photo media routes should keep their existing banner behavior",
  );
  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/messages/t/123",
      hasDismissAction: false,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
    }),
    false,
    "#49 chat routes should never enter the media-loading banner suppression state",
  );
  assertEqual(
    shouldHideMediaViewerBannerWhileLoading({
      urlPath: "/photo/123",
      hasDismissAction: false,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: true,
    }),
    false,
    "#49 photo route should stop hiding the banner once viewer navigation mounts",
  );
  assertEqual(
    shouldKeepMediaViewerBannerHiddenDuringLoadingWindow({
      loadingWindowActive: true,
      routeBasedLoading: true,
      hintedOverlayLoading: false,
      hasMarkedCloseAction: false,
      hasMarkedDownloadAction: false,
      hasMarkedShareAction: false,
      hasVisibleNavigationAction: false,
    }),
    true,
    "#49 loading window should keep the banner hidden while route-based media chrome is still absent",
  );
  assertEqual(
    shouldKeepMediaViewerBannerHiddenDuringLoadingWindow({
      loadingWindowActive: true,
      routeBasedLoading: true,
      hintedOverlayLoading: false,
      hasMarkedCloseAction: true,
      hasMarkedDownloadAction: false,
      hasMarkedShareAction: false,
      hasVisibleNavigationAction: false,
    }),
    false,
    "#49 loading banner must stop hiding once a close action has been captured",
  );
  assertEqual(
    shouldKeepMediaViewerBannerHiddenDuringLoadingWindow({
      loadingWindowActive: true,
      routeBasedLoading: true,
      hintedOverlayLoading: false,
      hasMarkedCloseAction: false,
      hasMarkedDownloadAction: false,
      hasMarkedShareAction: false,
      hasVisibleNavigationAction: true,
    }),
    false,
    "#49 loading banner must stop hiding once viewer navigation is visible",
  );
  assertEqual(
    shouldKeepMediaViewerBannerHiddenDuringLoadingWindow({
      loadingWindowActive: false,
      routeBasedLoading: true,
      hintedOverlayLoading: true,
      hasMarkedCloseAction: false,
      hasMarkedDownloadAction: false,
      hasMarkedShareAction: false,
      hasVisibleNavigationAction: false,
    }),
    false,
    "#49 loading banner suppression must expire when the bounded loading window ends",
  );
  assertEqual(
    shouldTreatHintedMediaOverlayAsVisible({
      dismissCount: 1,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
      hasLargeMedia: false,
      hasPendingOpenHint: true,
    }),
    true,
    "#49 pending open hint should treat a single dismiss control as enough same-route overlay chrome",
  );
  assertEqual(
    shouldTreatHintedMediaOverlayAsVisible({
      dismissCount: 2,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
      hasLargeMedia: false,
      hasPendingOpenHint: true,
    }),
    true,
    "#49 pending open hint should force media mode once overlay dismiss chrome appears",
  );
  assertEqual(
    shouldTreatHintedMediaOverlayAsVisible({
      dismissCount: 1,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
      hasLargeMedia: true,
      hasPendingOpenHint: true,
    }),
    true,
    "#49 pending open hint should force media mode once large media appears",
  );
  assertEqual(
    shouldTreatHintedMediaOverlayAsVisible({
      dismissCount: 1,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: true,
      hasLargeMedia: false,
      hasPendingOpenHint: true,
    }),
    true,
    "#49 pending open hint should force media mode once dismiss plus photo navigation chrome appears",
  );
  assertEqual(
    shouldTreatHintedMediaOverlayAsVisible({
      dismissCount: 2,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
      hasLargeMedia: false,
      hasPendingOpenHint: false,
    }),
    false,
    "#49 overlay chrome without a pending hint should still wait for stable media signals",
  );
  assertEqual(
    shouldTreatDetectedMediaOverlayAsVisible({
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: false,
      hasShareAction: false,
      hasNavigationAction: false,
      hasLargeMedia: false,
      hasPendingOpenHint: true,
    }),
    true,
    "#49 same-route chat overlays should enter media mode once a hinted dismiss control appears",
  );
  assertEqual(
    shouldTreatDetectedMediaOverlayAsVisible({
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: false,
      hasShareAction: true,
      hasNavigationAction: false,
      hasLargeMedia: true,
      hasPendingOpenHint: false,
    }),
    false,
    "#49 chat thread share actions plus a large inline image must not keep media mode stuck after close",
  );
  assertEqual(
    shouldTreatDetectedMediaOverlayAsVisible({
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: true,
      hasShareAction: false,
      hasNavigationAction: false,
      hasLargeMedia: true,
      hasPendingOpenHint: false,
    }),
    true,
    "#49 download plus large media should still count as a real overlay on chat routes",
  );
  assertEqual(
    shouldTreatDetectedMediaOverlayAsVisible({
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 2,
      hasDownloadAction: false,
      hasShareAction: true,
      hasNavigationAction: false,
      hasLargeMedia: true,
      hasPendingOpenHint: false,
    }),
    true,
    "#49 share-only overlays should still count once strong dismiss chrome is present",
  );

  const preloadSource = fs.readFileSync(
    path.join(APP_ROOT, "src/preload/preload.ts"),
    "utf8",
  );
  const mediaActionPolicySource = fs.readFileSync(
    path.join(APP_ROOT, "src/preload/media-action-policy.ts"),
    "utf8",
  );
  assert(
    /Back to Previous Page/.test(mediaActionPolicySource),
    "#49 media dismiss selectors should include the real Back to Previous Page label",
  );
  assert(
    /rankEdgeCloseCandidates\(\s*dismissActionSelectors,\s*selectedNodes,\s*\)/m.test(
      preloadSource,
    ),
    "#49 media close ranking should reuse the shared dismiss selector source",
  );
  assert(
    /getDismissActionPriority/.test(preloadSource),
    "#49 media close ranking should prioritize the real dismiss label before fallback history actions",
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
      mediaViewerVisible: false,
      incomingCallOverlayVisible: false,
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
      mediaViewerVisible: false,
      incomingCallOverlayVisible:
        state.visibleByWebContentsId.get(webContentsId) === true,
    }),
    false,
    "#47 main crop should be disabled while incoming-call hint is visible",
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
      mediaViewerVisible: false,
      incomingCallOverlayVisible:
        state.visibleByWebContentsId.get(webContentsId) === true,
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
      mediaViewerVisible: false,
      incomingCallOverlayVisible:
        state.visibleByWebContentsId.get(webContentsId) === true,
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
  runIncomingCallOverlayLifecycleTests();
  runIncomingCallHintPolicyTests();
  runIncomingCallIpcPolicyTests();
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
