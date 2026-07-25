type ViewportMode = "chat" | "media" | "other";

type DeterministicCaseName = "all" | "muted-conflict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { EventEmitter } = require("events");

const APP_ROOT = process.env.MESSENGER_APP_ROOT
  ? path.resolve(process.env.MESSENGER_APP_ROOT)
  : path.resolve(__dirname, "..");

const {
  resolveMessagesViewportState,
  resolveViewportMode,
  shouldApplyMessagesCrop,
} = require(path.join(APP_ROOT, "src/preload/messages-viewport-policy"));
const {
  doesMarketplaceThreadBackAnchorMatch,
  doesMarketplaceThreadFreshHeaderPairMatch,
  doesMarketplaceThreadRouteChangeWeakHeaderMatch,
  collectMarketplaceThreadHintSignals,
  doesMarketplaceThreadHeaderBandMatch,
  hasMarketplaceThreadHeaderSignal,
  isMarketplaceThreadUiActive,
  isMarketplaceThreadActionHint,
  isMarketplaceThreadBackHint,
  isMarketplaceThreadHeaderHint,
  resolveMarketplaceCurrentEvidenceClass,
  resolveMarketplaceOrdinaryClearBlockedReason,
  resolveMarketplaceVisualSessionDecision,
  resolveWeakMarketplaceBootstrapDecision,
  shouldConfirmWeakMarketplaceBootstrap,
  shouldRetainMarketplaceVisualCrop,
} = require(path.join(APP_ROOT, "src/preload/marketplace-thread-policy.ts"));
const { evaluateMediaOverlayVisible } = require(
  path.join(APP_ROOT, "src/preload/media-overlay-policy.ts"),
);
const {
  collectMessengerThreadSubviewHintSignals,
  doesMessengerThreadSubviewFreshHeaderPairMatch,
  hasMessengerThreadSubviewHeaderSignal,
  isMessengerThreadSubviewHeaderHint,
  isMessengerThreadSubviewBackHint,
  isOrdinaryThreadControlHint,
  resolveMessengerThreadSubviewHeaderKind,
  resolveMessengerThreadSubviewKind,
  shouldAcceptMessengerThreadSubviewHeaderPair,
  shouldCarryMessengerThreadSubviewSession,
  shouldContinueMessengerThreadSubviewSession,
} = require(path.join(APP_ROOT, "src/preload/thread-subview-policy.ts"));
const loadIncomingCallHintPolicy = () =>
  require(
    path.join(APP_ROOT, "src/preload/incoming-call-overlay-hint-policy.ts"),
  );
const loadNotificationDecisionPolicy = () =>
  require(path.join(APP_ROOT, "src/preload/notification-decision-policy.ts"));
const loadNotificationActivityPolicy = () =>
  require(path.join(APP_ROOT, "src/shared/notification-activity-policy.ts"));
const loadNotificationDisplayPolicy = () =>
  require(path.join(APP_ROOT, "src/preload/notification-display-policy.ts"));
const loadNotificationTextPolicy = () =>
  require(path.join(APP_ROOT, "src/preload/notification-text-policy.ts"));
const loadNotificationHandler = () =>
  require(path.join(APP_ROOT, "src/main/notification-handler.ts"));
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
  decideWindowOpenActionForContext,
  isExternalAuthProviderRoute,
  isMessagesSurfaceRoute,
} = require(path.join(APP_ROOT, "src/main/url-policy"));

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

const loadFixtureJson = <T>(relativePath: string): T => {
  const absolutePath = path.join(APP_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
};

const readLocalZipEntries = (zipPath: string): Map<string, string> => {
  const archive = fs.readFileSync(zipPath);
  const entries = new Map<string, string>();
  let offset = 0;

  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    assertEqual(
      signature,
      0x04034b50,
      "debug zip should contain valid local file headers",
    );

    const compressionMethod = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;

    assert(
      dataEnd <= archive.length,
      "debug zip entry should not read beyond archive bounds",
    );

    const fileName = archive
      .subarray(fileNameStart, fileNameEnd)
      .toString("utf8");
    const compressed = archive.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (compressionMethod === 8) {
      content = zlib.inflateRawSync(compressed);
    } else if (compressionMethod === 0) {
      content = compressed;
    } else {
      throw new Error(
        `Unsupported test zip compression method: ${compressionMethod}`,
      );
    }

    assertEqual(
      content.length,
      uncompressedSize,
      `debug zip entry ${fileName} should inflate to its declared size`,
    );
    entries.set(fileName, content.toString("utf8"));
    offset = dataEnd;
  }

  return entries;
};

const runDebugZipExportTests = () => {
  const { writeZipArchive } = require(
    path.join(APP_ROOT, "src/main/zip-archive.ts"),
  );
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "messenger-zip-test-"),
  );

  try {
    const firstPath = path.join(tempRoot, "debug-summary.json");
    const secondPath = path.join(tempRoot, "reload-debug.ndjson");
    const zipPath = path.join(tempRoot, "messenger-debug-logs-test.zip");
    fs.writeFileSync(firstPath, '{"ok":true}\n', "utf8");
    fs.writeFileSync(secondPath, '{"event":"auth"}\n', "utf8");

    writeZipArchive(zipPath, [
      {
        filePath: firstPath,
        archivePath: path.join(
          "messenger-debug-logs-test",
          "debug-summary.json",
        ),
      },
      {
        filePath: secondPath,
        archivePath: path.join(
          "messenger-debug-logs-test",
          "reload-debug.ndjson",
        ),
      },
    ]);

    const entries = readLocalZipEntries(zipPath);
    assertEqual(
      entries.get("messenger-debug-logs-test/debug-summary.json"),
      '{"ok":true}\n',
      "#54 debug zip should contain the JSON summary",
    );
    assertEqual(
      entries.get("messenger-debug-logs-test/reload-debug.ndjson"),
      '{"event":"auth"}\n',
      "#54 debug zip should contain reload/auth debug events",
    );
    assert(
      Array.from(entries.keys()).every(
        (entryPath) => !path.isAbsolute(entryPath) && !entryPath.includes("\\"),
      ),
      "#54 debug zip should use portable relative entry paths",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

const buildMutedConflictEvidence = () => {
  const notificationDecisionPolicy = loadNotificationDecisionPolicy();
  const payload = {
    title: "Person A",
    body: "sent a message",
  };
  const candidateRows = [
    {
      href: "/t/person-a",
      title: "Person A",
      body: "sent a message",
      muted: false,
      unread: true,
    },
    {
      href: "/t/group-project",
      title: "Project Squad",
      body: "Person A sent a message",
      muted: true,
      unread: true,
    },
  ];
  const observedHref = "/t/person-a";
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
      marketplaceVisualCropHeight?: number;
    } = {},
  ) => {
    const mode = resolveViewportMode({
      urlPath: path,
      mediaOverlayVisible: extra.mediaOverlayVisible,
      marketplaceThreadVisible: extra.marketplaceThreadVisible,
      marketplaceVisualCropHeight: extra.marketplaceVisualCropHeight,
    });
    const crop = shouldApplyMessagesCrop({
      urlPath: path,
      mediaOverlayVisible: extra.mediaOverlayVisible,
      marketplaceThreadVisible: extra.marketplaceThreadVisible,
      marketplaceVisualCropHeight: extra.marketplaceVisualCropHeight,
    });
    assertEqual(mode, expectedMode, `#45 viewport mode mismatch for ${path}`);
    assertEqual(crop, expectedCrop, `#45 crop mismatch for ${path}`);
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
  expectMode("/messages/t/123", "chat", true, {
    marketplaceThreadVisible: true,
    marketplaceVisualCropHeight: 36,
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
    "#49 generic marketplace thread hints should keep the BrowserView crop disabled",
  );

  const marketplaceBackHeaderViewportState = resolveMessagesViewportState({
    url: "https://www.facebook.com/messages/t/123",
    urlPath: "/messages/t/123",
    headerHeight: 56,
    cropHeight: 36,
    marketplaceThreadVisible: true,
    marketplaceVisualCropHeight: 36,
  });
  assertEqual(
    marketplaceBackHeaderViewportState.routeKind,
    "chat",
    "#49 marketplace back-header threads should stay on the chat route",
  );
  assertEqual(
    marketplaceBackHeaderViewportState.shouldCrop,
    true,
    "#49 reporter's Back + Marketplace header should switch to the reduced BrowserView crop heuristic",
  );
  assertEqual(
    marketplaceBackHeaderViewportState.cropHeight,
    36,
    "#49 reduced Marketplace crop height should be carried through the viewport payload",
  );

  const archivedChatsBackHeaderViewportState = resolveMessagesViewportState({
    url: "https://www.facebook.com/messages/",
    urlPath: "/messages/",
    headerHeight: 56,
    cropHeight: null,
  });
  assertEqual(
    archivedChatsBackHeaderViewportState.routeKind,
    "chat",
    "#50 archived chats should stay on the chat route",
  );
  assertEqual(
    archivedChatsBackHeaderViewportState.shouldCrop,
    true,
    "#50 archived chats should stay on the normal Messenger crop policy",
  );
  assertEqual(
    archivedChatsBackHeaderViewportState.cropHeight,
    null,
    "#50 Messenger list subviews should not move Facebook Home into the native titlebar",
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

const runMessengerThreadSubviewPolicyTests = () => {
  assertEqual(
    JSON.stringify(
      collectMessengerThreadSubviewHintSignals("Back Archived chats"),
    ),
    JSON.stringify(["back", "list-subview-header"]),
    "#50 archived chats hint classification should stay structured",
  );
  assertEqual(
    isMessengerThreadSubviewBackHint("Go back"),
    true,
    "#50 archived chats back controls should be recognized",
  );
  assertEqual(
    isMessengerThreadSubviewHeaderHint("Archived chats"),
    true,
    "#50 archived chats headers should be recognized",
  );
  assertEqual(
    resolveMessengerThreadSubviewHeaderKind("Message requests"),
    "message-requests",
    "#50 message requests headers should be recognized",
  );
  assertEqual(
    resolveMessengerThreadSubviewHeaderKind("Requests"),
    "message-requests",
    "#50 requests headers should be recognized",
  );
  assertEqual(
    resolveMessengerThreadSubviewHeaderKind("Restricted accounts"),
    "restricted-accounts",
    "#50 restricted account headers should be recognized",
  );
  assertEqual(
    hasMessengerThreadSubviewHeaderSignal(["Back", "Archived chats"]),
    true,
    "#50 Back + Archived chats header should disable the full Messenger crop",
  );
  assertEqual(
    hasMessengerThreadSubviewHeaderSignal(["Back", "Message requests"]),
    true,
    "#50 Back + Message requests header should disable the full Messenger crop",
  );
  assertEqual(
    hasMessengerThreadSubviewHeaderSignal(["Back", "Chat info"]),
    false,
    "#50 generic chat back controls should not disable the full Messenger crop",
  );
  assertEqual(
    isOrdinaryThreadControlHint("Search in conversation"),
    true,
    "#50 ordinary thread controls should still be recognized",
  );
  assertEqual(
    resolveMessengerThreadSubviewKind({
      headerBackDetected: false,
      headerKind: "archived-chats",
      ordinaryThreadControlDetected: false,
    }),
    null,
    "#50 stale Archived chats titles without Back should not keep the subview crop active",
  );
  assertEqual(
    resolveMessengerThreadSubviewKind({
      headerBackDetected: true,
      headerKind: "message-requests",
      ordinaryThreadControlDetected: false,
    }),
    "message-requests",
    "#50 Message requests should confirm a list subview",
  );
  assertEqual(
    resolveMessengerThreadSubviewKind({
      headerBackDetected: true,
      headerKind: "archived-chats",
      ordinaryThreadControlDetected: true,
    }),
    "archived-chats",
    "#50 a fresh Archived chats Back + header pair should survive stale ordinary conversation controls",
  );
  assertEqual(
    doesMessengerThreadSubviewFreshHeaderPairMatch({
      candidateBackBand: { top: 80, bottom: 116, left: 16, right: 52 },
      candidateHeaderBand: { top: 82, bottom: 114, left: 56, right: 220 },
    }),
    true,
    "#50 adjacent archived chats Back + header controls should match",
  );
  assertEqual(
    doesMessengerThreadSubviewFreshHeaderPairMatch({
      candidateBackBand: { top: 80, bottom: 116, left: 16, right: 52 },
      candidateHeaderBand: { top: 220, bottom: 250, left: 320, right: 520 },
    }),
    false,
    "#50 distant Back + Archived chats text should not match",
  );
  assertEqual(
    shouldAcceptMessengerThreadSubviewHeaderPair({
      freshPairMatched: false,
      headerKind: "archived-chats",
      candidateBackBand: { top: 68, bottom: 100, left: 16, right: 48 },
      candidateHeaderBand: { top: 76, bottom: 94, left: 56, right: 224 },
    }),
    true,
    "#50 beta 31 Archived chats Back + header should survive ordinary controls even when strict geometry fails",
  );
  assertEqual(
    shouldAcceptMessengerThreadSubviewHeaderPair({
      freshPairMatched: false,
      headerKind: "message-requests",
      candidateBackBand: { top: 68, bottom: 100, left: 16, right: 48 },
      candidateHeaderBand: { top: 76, bottom: 94, left: 56, right: 224 },
    }),
    false,
    "#50 relaxed Back + header acceptance should stay Archived-only",
  );
  assertEqual(
    shouldAcceptMessengerThreadSubviewHeaderPair({
      freshPairMatched: false,
      headerKind: "archived-chats",
      candidateBackBand: { top: 56, bottom: 870, left: 0, right: 360 },
      candidateHeaderBand: { top: 76, bottom: 93, left: 24, right: 192 },
    }),
    true,
    "#50 beta 32 loaded Archived chats Back hit region should survive when it expands to the left pane",
  );
  assertEqual(
    shouldAcceptMessengerThreadSubviewHeaderPair({
      freshPairMatched: false,
      headerKind: "archived-chats",
      candidateBackBand: { top: 220, bottom: 252, left: 16, right: 48 },
      candidateHeaderBand: { top: 76, bottom: 94, left: 56, right: 224 },
    }),
    false,
    "#50 relaxed Archived chats acceptance should still reject Back outside the top-left band",
  );
  assertEqual(
    shouldCarryMessengerThreadSubviewSession({
      kind: "archived-chats",
      previousRouteKey: "/messages/",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 1_200,
      candidateBackBand: { top: 56, bottom: 870, left: 0, right: 360 },
    }),
    true,
    "#50 archived chats should carry through an oversized top-left Back hit region",
  );
  assertEqual(
    shouldCarryMessengerThreadSubviewSession({
      kind: "archived-chats",
      previousRouteKey: "/messages/",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 1_200,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
    }),
    true,
    "#50 archived chats should carry the back-safe subview crop into a selected archived thread",
  );
  assertEqual(
    shouldCarryMessengerThreadSubviewSession({
      kind: "message-requests",
      previousRouteKey: "/messages/",
      currentRouteKey: "/messages/t/request-thread",
      lastMatchedAgeMs: 1_200,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
    }),
    false,
    "#50 message requests should not use the archived-only route carryover",
  );
  assertEqual(
    shouldCarryMessengerThreadSubviewSession({
      kind: "archived-chats",
      previousRouteKey: "/messages/",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 9_000,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
    }),
    false,
    "#50 archived chats route carryover should expire instead of becoming sticky",
  );
  assertEqual(
    shouldCarryMessengerThreadSubviewSession({
      kind: "archived-chats",
      previousRouteKey: "/messages/",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 1_200,
      candidateBackBand: null,
    }),
    false,
    "#50 archived chats route carryover should clear when the top-left Back control is gone",
  );
  assertEqual(
    shouldContinueMessengerThreadSubviewSession({
      kind: "archived-chats",
      headerKind: "archived-chats",
      previousRouteKey: "/messages/t/archived-thread",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 1_400,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
    }),
    true,
    "#50 archived chats should keep subview state while Back and header remain on the same route",
  );
  assertEqual(
    shouldContinueMessengerThreadSubviewSession({
      kind: "archived-chats",
      headerKind: "archived-chats",
      previousRouteKey: "/messages/e2ee/t/archived-thread?initial=1",
      currentRouteKey: "/messages/e2ee/t/archived-thread",
      lastMatchedAgeMs: 2_200,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
      ordinaryThreadControlDetected: true,
    }),
    true,
    "#50 beta 30 Archived chats Back + header should survive ordinary controls and route-key churn",
  );
  assertEqual(
    shouldContinueMessengerThreadSubviewSession({
      kind: "archived-chats",
      headerKind: "archived-chats",
      previousRouteKey: "/messages/t/archived-thread",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 1_400,
      candidateBackBand: null,
    }),
    false,
    "#50 archived chats header continuation should clear when Back disappears",
  );
  assertEqual(
    shouldContinueMessengerThreadSubviewSession({
      kind: "archived-chats",
      headerKind: "message-requests",
      previousRouteKey: "/messages/t/archived-thread",
      currentRouteKey: "/messages/t/archived-thread",
      lastMatchedAgeMs: 1_400,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
    }),
    false,
    "#50 archived chats header continuation should not bridge to another subview header",
  );
  assertEqual(
    shouldContinueMessengerThreadSubviewSession({
      kind: "message-requests",
      headerKind: "message-requests",
      previousRouteKey: "/messages/t/request-thread",
      currentRouteKey: "/messages/t/request-thread",
      lastMatchedAgeMs: 1_400,
      candidateBackBand: { top: 76, bottom: 112, left: 16, right: 52 },
      ordinaryThreadControlDetected: true,
    }),
    false,
    "#50 Message requests should not inherit the Archived chats sticky continuation",
  );
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
    "#49 reporter's Back + Marketplace header should disable the Messenger crop",
  );
  assertEqual(
    hasMarketplaceThreadHeaderSignal(["Back", "Chat info"]),
    false,
    "#49 generic chat back controls should not disable the Messenger crop",
  );
  assertEqual(
    isMarketplaceThreadUiActive({
      headerMarketplaceDetected: true,
    }),
    false,
    "#49 a bare Marketplace label should not flip ordinary chats into the Marketplace layout path",
  );
  assertEqual(
    isMarketplaceThreadUiActive({
      rightPaneMarketplaceSignalDetected: true,
    }),
    true,
    "#49 right-pane Marketplace actions should still activate the Marketplace layout path",
  );
  assertEqual(
    isMarketplaceThreadUiActive({
      headerBackMarketplaceDetected: true,
    }),
    true,
    "#49 the native Back + Marketplace header should still activate the Marketplace layout path",
  );
  assertEqual(
    shouldRetainMarketplaceVisualCrop({
      headerMarketplaceDetected: true,
    }),
    false,
    "#49 a bare Marketplace top-chrome signal should not keep refreshing the reduced crop heuristic",
  );
  assertEqual(
    shouldRetainMarketplaceVisualCrop({
      headerBackDetected: true,
    }),
    false,
    "#49 a generic back control should not keep the Marketplace crop alive on regular chats",
  );
  assertEqual(
    shouldRetainMarketplaceVisualCrop({
      rightPaneItemLinkDetected: true,
    }),
    true,
    "#49 live Marketplace thread content should still allow the reduced crop carry-over to bridge same-route re-renders",
  );
  const confirmedHeaderBand = {
    top: 62,
    bottom: 106,
    left: 12,
    right: 244,
  };
  const matchingWeakHeaderBand = {
    top: 64,
    bottom: 108,
    left: 14,
    right: 248,
  };
  const moderatelyShiftedWeakHeaderBand = {
    top: 64,
    bottom: 110,
    left: 88,
    right: 274,
  };
  const mismatchedWeakHeaderBand = {
    top: 64,
    bottom: 108,
    left: 320,
    right: 620,
  };
  assertEqual(
    doesMarketplaceThreadHeaderBandMatch({
      confirmedHeaderBand,
      candidateHeaderBand: matchingWeakHeaderBand,
    }),
    true,
    "#49 weak Marketplace hints in the same header band should match the confirmed Marketplace session",
  );
  assertEqual(
    doesMarketplaceThreadHeaderBandMatch({
      confirmedHeaderBand,
      candidateHeaderBand: moderatelyShiftedWeakHeaderBand,
    }),
    true,
    "#49 moderately shifted weak Marketplace hints should still match the confirmed header region on the same route",
  );
  assertEqual(
    doesMarketplaceThreadHeaderBandMatch({
      confirmedHeaderBand,
      candidateHeaderBand: mismatchedWeakHeaderBand,
    }),
    false,
    "#49 stray Marketplace labels outside the confirmed header band should be rejected",
  );

  const MARKETPLACE_SESSION_DOM_GRACE_MS = 2_500;
  const MARKETPLACE_ROUTE_CHANGE_RESCUE_MS = 1_800;
  const MARKETPLACE_RECENT_CONTINUITY_GRACE_MS = 10_000;
  const confirmedSession = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 10_000,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    strongSignalSource: "strong-header",
    strongVisualCropHeight: 56,
    strongHeaderBand: confirmedHeaderBand,
  });
  assertEqual(
    confirmedSession.sessionActive,
    true,
    "#49 strong Marketplace confirmation should enter a Marketplace session",
  );
  assertEqual(
    confirmedSession.visualCropHeight,
    56,
    "#49 strong Marketplace confirmation should carry the reduced crop height",
  );
  assertEqual(
    confirmedSession.transition,
    "strong-confirmed",
    "#49 strong Marketplace confirmation should report a confirmed session transition",
  );
  assertEqual(
    confirmedSession.lifecycleReason,
    "confirmed-marketplace-thread",
    "#49 strong Marketplace confirmation should record the session entry reason",
  );
  assertEqual(
    JSON.stringify({
      confirmationKind: confirmedSession.nextSession?.confirmationKind,
      lastStrongConfirmedAt:
        confirmedSession.nextSession?.lastStrongConfirmedAt,
    }),
    JSON.stringify({
      confirmationKind: "strong-header",
      lastStrongConfirmedAt: 10_000,
    }),
    "#49 strong Marketplace confirmation should preserve strong confirmation provenance",
  );

  const weakBootstrapRejected = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 10_100,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: null,
    pendingBootstrapSignalSource: "right-pane-action",
    pendingBootstrapAllowed: false,
    pendingBootstrapRejectedReason: "weak-bootstrap-startup-settling",
  });
  assertEqual(
    JSON.stringify({
      sessionActive: weakBootstrapRejected.sessionActive,
      transition: weakBootstrapRejected.transition,
      signalSource: weakBootstrapRejected.signalSource,
      rejectionReason: weakBootstrapRejected.rejectionReason,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "rejected",
      signalSource: "right-pane-action",
      rejectionReason: "weak-bootstrap-startup-settling",
    }),
    "#49 fresh-route weak Marketplace signals should be rejected during startup settling",
  );

  const weakBootstrapPending = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 10_200,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: null,
    pendingBootstrapSignalSource: "item-link",
    pendingBootstrapAllowed: true,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: weakBootstrapPending.sessionActive,
      transition: weakBootstrapPending.transition,
      signalSource: weakBootstrapPending.signalSource,
      rejectionReason: weakBootstrapPending.rejectionReason,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "weak-bootstrap-pending",
      signalSource: "item-link",
      rejectionReason: null,
    }),
    "#49 fresh-route weak Marketplace signals should remain pending until the corroboration threshold is met",
  );

  const weakBootstrapCallerRejected = resolveWeakMarketplaceBootstrapDecision({
    routeKey: "/messages/t/marketplace-thread",
    nowMs: 10_120,
    weakSignalSource: "right-pane-action",
    weakBootstrapSettled: false,
    headerOrdinaryChatDetected: false,
    headerBackMarketplaceDetected: false,
    currentMarketplaceSessionActive: false,
    previousState: null,
    requiredPasses: 2,
    minConfirmAgeMs: 800,
    visualCropHeight: 36,
  });
  assertEqual(
    JSON.stringify({
      transition: weakBootstrapCallerRejected.transition,
      pendingBootstrapSignalSource:
        weakBootstrapCallerRejected.pendingBootstrapSignalSource,
      pendingBootstrapAllowed:
        weakBootstrapCallerRejected.pendingBootstrapAllowed,
      pendingBootstrapRejectedReason:
        weakBootstrapCallerRejected.pendingBootstrapRejectedReason,
      nextState: weakBootstrapCallerRejected.nextState,
    }),
    JSON.stringify({
      transition: "rejected",
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: false,
      pendingBootstrapRejectedReason: "weak-bootstrap-startup-settling",
      nextState: null,
    }),
    "#49 preload weak-bootstrap wiring should reject fresh-route weak Marketplace signals during startup settling before they enter tracking state",
  );

  const weakBootstrapCallerFirstPending =
    resolveWeakMarketplaceBootstrapDecision({
      routeKey: "/messages/t/marketplace-thread",
      nowMs: 10_200,
      weakSignalSource: "right-pane-action",
      weakBootstrapSettled: true,
      headerOrdinaryChatDetected: false,
      headerBackMarketplaceDetected: false,
      currentMarketplaceSessionActive: false,
      previousState: null,
      requiredPasses: 2,
      minConfirmAgeMs: 800,
      visualCropHeight: 36,
    });
  assertEqual(
    JSON.stringify({
      transition: weakBootstrapCallerFirstPending.transition,
      pendingBootstrapSignalSource:
        weakBootstrapCallerFirstPending.pendingBootstrapSignalSource,
      pendingBootstrapAllowed:
        weakBootstrapCallerFirstPending.pendingBootstrapAllowed,
      stablePasses: weakBootstrapCallerFirstPending.stablePasses,
      firstSeenAgeMs: weakBootstrapCallerFirstPending.firstSeenAgeMs,
      confirmationEligible:
        weakBootstrapCallerFirstPending.confirmationEligible,
      trackedSignal: weakBootstrapCallerFirstPending.nextState?.signalSource,
    }),
    JSON.stringify({
      transition: "pending",
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      stablePasses: 1,
      firstSeenAgeMs: 0,
      confirmationEligible: false,
      trackedSignal: "right-pane-action",
    }),
    "#49 preload weak-bootstrap wiring should retain the first settled weak Marketplace signal as pending tracked state",
  );

  const weakBootstrapCallerConfirmed = resolveWeakMarketplaceBootstrapDecision({
    routeKey: "/messages/t/marketplace-thread",
    nowMs: 11_050,
    weakSignalSource: "right-pane-action",
    weakBootstrapSettled: true,
    headerOrdinaryChatDetected: false,
    headerBackMarketplaceDetected: false,
    currentMarketplaceSessionActive: false,
    previousState: weakBootstrapCallerFirstPending.nextState,
    requiredPasses: 2,
    minConfirmAgeMs: 800,
    visualCropHeight: 36,
  });
  assertEqual(
    JSON.stringify({
      transition: weakBootstrapCallerConfirmed.transition,
      confirmedSignalSource: weakBootstrapCallerConfirmed.confirmedSignalSource,
      stablePasses: weakBootstrapCallerConfirmed.stablePasses,
      firstSeenAgeMs: weakBootstrapCallerConfirmed.firstSeenAgeMs,
      confirmationEligible: weakBootstrapCallerConfirmed.confirmationEligible,
      nextState: weakBootstrapCallerConfirmed.nextState,
    }),
    JSON.stringify({
      transition: "confirmed",
      confirmedSignalSource: "right-pane-action",
      stablePasses: 2,
      firstSeenAgeMs: 850,
      confirmationEligible: true,
      nextState: null,
    }),
    "#49 preload weak-bootstrap wiring should promote repeated settled weak Marketplace evidence once the confirmation age threshold is met",
  );

  assertEqual(
    shouldConfirmWeakMarketplaceBootstrap({
      stablePasses: 2,
      firstSeenAgeMs: 22,
      requiredPasses: 2,
      minConfirmAgeMs: 800,
    }),
    false,
    "#49 fresh-route weak Marketplace signals should not confirm during the immediate route handoff burst",
  );
  assertEqual(
    shouldConfirmWeakMarketplaceBootstrap({
      stablePasses: 2,
      firstSeenAgeMs: 820,
      requiredPasses: 2,
      minConfirmAgeMs: 800,
    }),
    true,
    "#49 settled weak Marketplace signals should confirm only after the route has stayed stable long enough",
  );

  const weakBootstrapConfirmed = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 10_300,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: null,
    strongSignalSource: "right-pane-action",
    strongVisualCropHeight: 36,
    isWeakBootstrapConfirmation: true,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: weakBootstrapConfirmed.sessionActive,
      transition: weakBootstrapConfirmed.transition,
      signalSource: weakBootstrapConfirmed.signalSource,
      lifecycleReason: weakBootstrapConfirmed.lifecycleReason,
      visualCropHeight: weakBootstrapConfirmed.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "weak-bootstrap-confirmed",
      signalSource: "right-pane-action",
      lifecycleReason: "weak-bootstrap-confirmed",
      visualCropHeight: 36,
    }),
    "#49 repeated settled weak Marketplace signals on the same fresh route should confirm a Marketplace session",
  );
  assertEqual(
    weakBootstrapConfirmed.nextSession?.confirmationKind,
    "weak-bootstrap",
    "#49 weak bootstrap confirmation should record weak confirmation provenance",
  );

  assertEqual(
    doesMarketplaceThreadBackAnchorMatch({
      confirmedHeaderBand,
      candidateBackBand: {
        top: 12,
        bottom: 44,
        left: 8,
        right: 52,
      },
    }),
    true,
    "#49 a back control anchored near the confirmed Marketplace header should count as same-route Marketplace continuity",
  );
  assertEqual(
    doesMarketplaceThreadBackAnchorMatch({
      confirmedHeaderBand,
      candidateBackBand: {
        top: 12,
        bottom: 44,
        left: 280,
        right: 332,
      },
    }),
    false,
    "#49 a back control far from the confirmed Marketplace header band should not count as Marketplace continuity",
  );
  assertEqual(
    doesMarketplaceThreadFreshHeaderPairMatch({
      candidateBackBand: {
        top: 66,
        bottom: 100,
        left: 8,
        right: 54,
      },
      candidateHeaderBand: {
        top: 70,
        bottom: 99,
        left: 52,
        right: 199,
      },
    }),
    true,
    "#49 a fresh-route split Back plus Marketplace header should bootstrap Marketplace mode when the controls share the same top-left band",
  );
  assertEqual(
    doesMarketplaceThreadFreshHeaderPairMatch({
      candidateBackBand: {
        top: 66,
        bottom: 100,
        left: 8,
        right: 54,
      },
      candidateHeaderBand: null,
    }),
    false,
    "#49 a fresh route with only a back control must not bootstrap Marketplace mode",
  );
  assertEqual(
    doesMarketplaceThreadFreshHeaderPairMatch({
      candidateBackBand: {
        top: 66,
        bottom: 100,
        left: 8,
        right: 54,
      },
      candidateHeaderBand: mismatchedWeakHeaderBand,
    }),
    false,
    "#49 a fresh-route Marketplace label far from the back control must not bootstrap Marketplace mode",
  );
  const april10ReplayHeaderBands = [
    { top: 70, bottom: 99, left: 168, right: 315 },
    { top: 70, bottom: 99, left: 136, right: 283 },
    { top: 70, bottom: 99, left: 83, right: 230 },
    { top: 70, bottom: 99, left: 35, right: 183 },
    { top: 70, bottom: 99, left: 22, right: 169 },
  ];
  const april10ReplayMatches = april10ReplayHeaderBands.map((band) =>
    doesMarketplaceThreadFreshHeaderPairMatch({
      candidateBackBand: {
        top: 66,
        bottom: 100,
        left: 8,
        right: 54,
      },
      candidateHeaderBand: band,
    }),
  );
  assertEqual(
    JSON.stringify(april10ReplayMatches),
    JSON.stringify([false, false, true, true, true]),
    "#49 the April 10 split-header replay should start matching once the Marketplace label slides into the anchored back-button band",
  );
  assertEqual(
    doesMarketplaceThreadRouteChangeWeakHeaderMatch({
      confirmedHeaderBand: {
        top: 62,
        bottom: 106,
        left: 76,
        right: 264,
      },
      candidateHeaderBand: {
        top: 70,
        bottom: 99,
        left: 20,
        right: 167,
      },
    }),
    true,
    "#49 a route change into another Marketplace thread should bridge when the new weak header band still sits inside the previous Marketplace header region",
  );
  assertEqual(
    doesMarketplaceThreadRouteChangeWeakHeaderMatch({
      confirmedHeaderBand: {
        top: 62,
        bottom: 106,
        left: 76,
        right: 264,
      },
      candidateHeaderBand: mismatchedWeakHeaderBand,
    }),
    false,
    "#49 a route-change weak Marketplace label far from the previous header region must not bridge Marketplace mode",
  );

  assertEqual(
    resolveMarketplaceOrdinaryClearBlockedReason({
      previousSession: confirmedSession.nextSession,
      nowMs: 10_600,
      postConfirmGraceMs: 1_500,
      headerOrdinaryChatDetected: true,
    }),
    "recent-confirmation",
    "#49 a recently strong-confirmed Marketplace route should block ordinary clear even if Marketplace text briefly disappears",
  );
  assertEqual(
    resolveMarketplaceOrdinaryClearBlockedReason({
      previousSession: confirmedSession.nextSession,
      nowMs: 10_600,
      postConfirmGraceMs: 1_500,
      headerOrdinaryChatDetected: true,
      sameRouteMarketplaceBackAnchorDetected: true,
    }),
    "back-anchor-match",
    "#49 a same-route back-anchor match should outrank generic ordinary-chat evidence after strong confirmation",
  );
  assertEqual(
    resolveMarketplaceOrdinaryClearBlockedReason({
      previousSession: weakBootstrapConfirmed.nextSession,
      nowMs: 10_600,
      postConfirmGraceMs: 1_500,
      headerOrdinaryChatDetected: true,
    }),
    null,
    "#49 weak-bootstrap-confirmed Marketplace sessions should not gain the stronger post-confirm clear block automatically",
  );

  assertEqual(
    resolveMarketplaceCurrentEvidenceClass({
      headerBackMarketplaceDetected: true,
      headerOrdinaryChatDetected: true,
    }),
    "strong",
    "#49 a live Back + Marketplace header should classify as strong evidence even if ordinary controls are also visible",
  );
  assertEqual(
    resolveMarketplaceCurrentEvidenceClass({
      sameRouteMarketplaceBackAnchorDetected: true,
      headerOrdinaryChatDetected: true,
    }),
    "weak",
    "#49 same-route back-anchor continuity should classify as weak Marketplace evidence",
  );
  assertEqual(
    resolveMarketplaceCurrentEvidenceClass({
      headerOrdinaryChatDetected: true,
    }),
    "ordinary-only",
    "#49 ordinary controls without Marketplace evidence should classify as ordinary-only",
  );

  const weakBridge = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 11_000,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: confirmedSession.nextSession,
    weakHeaderBand: matchingWeakHeaderBand,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: weakBridge.sessionActive,
      shouldApplyReducedCrop: weakBridge.shouldApplyReducedCrop,
      transition: weakBridge.transition,
      signalSource: weakBridge.signalSource,
      lifecycleReason: weakBridge.lifecycleReason,
      weakHeaderMatchesSessionHeaderBand:
        weakBridge.weakHeaderMatchesSessionHeaderBand,
      visualCropHeight: weakBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      shouldApplyReducedCrop: true,
      transition: "bridged",
      signalSource: "weak-header",
      lifecycleReason: "same-thread-rerender",
      weakHeaderMatchesSessionHeaderBand: true,
      visualCropHeight: 56,
    }),
    "#49 same-route weak Marketplace rerenders inside the confirmed header band should keep the Marketplace session alive",
  );

  const freshRouteSplitHeaderBootstrap =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread",
      nowMs: 10_350,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: null,
      strongSignalSource: "strong-header",
      strongVisualCropHeight: 58,
      strongHeaderBand: {
        top: 62,
        bottom: 106,
        left: 8,
        right: 199,
      },
      weakHeaderBand: {
        top: 70,
        bottom: 99,
        left: 52,
        right: 199,
      },
    });
  assertEqual(
    JSON.stringify({
      sessionActive: freshRouteSplitHeaderBootstrap.sessionActive,
      transition: freshRouteSplitHeaderBootstrap.transition,
      signalSource: freshRouteSplitHeaderBootstrap.signalSource,
      lifecycleReason: freshRouteSplitHeaderBootstrap.lifecycleReason,
      visualCropHeight: freshRouteSplitHeaderBootstrap.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "strong-confirmed",
      signalSource: "strong-header",
      lifecycleReason: "confirmed-marketplace-thread",
      visualCropHeight: 58,
    }),
    "#49 a fresh-route split Back plus Marketplace header should reuse the normal strong confirmation session path once paired",
  );

  const sameRouteBackAnchorBridge = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 11_050,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: confirmedSession.nextSession,
    sameRouteMarketplaceBackAnchorDetected: true,
    headerBackMatchesSessionHeaderBand: true,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: sameRouteBackAnchorBridge.sessionActive,
      transition: sameRouteBackAnchorBridge.transition,
      signalSource: sameRouteBackAnchorBridge.signalSource,
      lifecycleReason: sameRouteBackAnchorBridge.lifecycleReason,
      visualCropHeight: sameRouteBackAnchorBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      visualCropHeight: 56,
    }),
    "#49 a strong-confirmed Marketplace route should stay bridged when only the back anchor survives on the same route",
  );

  let repeatedWeakSession = weakBridge.nextSession;
  [12_300, 13_600, 14_900, 16_200].forEach((nowMs) => {
    const repeatedWeakDecision = resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread",
      nowMs,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: repeatedWeakSession,
      weakHeaderBand: matchingWeakHeaderBand,
    });
    assertEqual(
      repeatedWeakDecision.sessionActive,
      true,
      `#49 repeated same-route weak Marketplace rerenders should stay active at ${nowMs}ms`,
    );
    assertEqual(
      repeatedWeakDecision.visualCropHeight,
      56,
      `#49 repeated same-route weak Marketplace rerenders should keep the reduced crop at ${nowMs}ms`,
    );
    repeatedWeakSession = repeatedWeakDecision.nextSession;
  });

  const rejectedWeakHeader = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 17_000,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: repeatedWeakSession,
    weakHeaderBand: mismatchedWeakHeaderBand,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: rejectedWeakHeader.sessionActive,
      transition: rejectedWeakHeader.transition,
      signalSource: rejectedWeakHeader.signalSource,
      lifecycleReason: rejectedWeakHeader.lifecycleReason,
      weakHeaderMatchesSessionHeaderBand:
        rejectedWeakHeader.weakHeaderMatchesSessionHeaderBand,
      visualCropHeight: rejectedWeakHeader.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      weakHeaderMatchesSessionHeaderBand: false,
      visualCropHeight: 56,
    }),
    "#49 same-route weak Marketplace hints outside the confirmed header band should be treated as neutral rerenders instead of clearing the session",
  );

  const marketplaceReplayFixture = loadFixtureJson<{
    graceMs: number;
    routeChangeRescueMs: number;
    steps: Array<{
      name: string;
      nowMs: number;
      input: Record<string, unknown>;
      expect: {
        sessionActive: boolean;
        transition: string;
        signalSource: string | null;
        lifecycleReason: string | null;
        visualCropHeight: number | null;
        rescuePending: boolean;
      };
    }>;
  }>("fixtures/issue49/marketplace-beta2-route-change-replay.json");
  let replayPreviousSession = repeatedWeakSession;
  const replayResults = marketplaceReplayFixture.steps.map((step) => {
    const decision = resolveMarketplaceVisualSessionDecision({
      graceMs: marketplaceReplayFixture.graceMs,
      routeChangeRescueMs: marketplaceReplayFixture.routeChangeRescueMs,
      previousSession: replayPreviousSession,
      ...(step.input as any),
      nowMs: step.nowMs,
    });
    replayPreviousSession = decision.nextSession;
    return {
      name: step.name,
      actual: {
        sessionActive: decision.sessionActive,
        transition: decision.transition,
        signalSource: decision.signalSource,
        lifecycleReason: decision.lifecycleReason,
        visualCropHeight: decision.visualCropHeight,
        rescuePending:
          decision.nextSession?.routeChangeRescuePendingUntil !== null,
      },
      expected: step.expect,
    };
  });
  assertEqual(
    JSON.stringify(replayResults.map((result) => result.actual)),
    JSON.stringify(replayResults.map((result) => result.expected)),
    "#49 the local Marketplace fixture replay should match reporter's latest beta.2 route-change timeline closely enough to validate the rescue-state behavior",
  );

  const routeChangeRescuePending = replayResults[1]?.actual;
  assertEqual(
    JSON.stringify(routeChangeRescuePending),
    JSON.stringify(marketplaceReplayFixture.steps[1].expect),
    "#49 the latest beta.2 route-change miss should hold a recently confirmed Marketplace session long enough to inspect delayed weak evidence on the next route",
  );

  const routeChangeLateWeakHeaderStillPending = replayResults[2]?.actual;
  assertEqual(
    JSON.stringify(routeChangeLateWeakHeaderStillPending),
    JSON.stringify(marketplaceReplayFixture.steps[2].expect),
    "#49 the first late weak Marketplace candidate from reporter's beta.2 bundle should keep the rescue hold alive even if it is not spatially strong enough yet",
  );

  const routeChangeLateWeakHeaderRescue = replayResults[3]?.actual;
  assertEqual(
    JSON.stringify(routeChangeLateWeakHeaderRescue),
    JSON.stringify(marketplaceReplayFixture.steps[3].expect),
    "#49 the later weak Marketplace header from reporter's beta.2 bundle should rescue the held route-change session once it slides back into the expected header region",
  );

  const routeChangeRescueExpired = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/ordinary-chat",
    nowMs: 18_950,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    previousSession: replayPreviousSession,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: routeChangeRescueExpired.sessionActive,
      transition: routeChangeRescueExpired.transition,
      lifecycleReason: routeChangeRescueExpired.lifecycleReason,
      visualCropHeight: routeChangeRescueExpired.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 route-change rescue should still fail closed once the late-evidence window expires",
  );

  const routeChangeWeakHeaderBridge = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread-3",
    nowMs: 18_350,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: {
      ...confirmedSession.nextSession,
      routeKey: "/messages/t/marketplace-thread-2",
      headerBand: {
        top: 62,
        bottom: 106,
        left: 76,
        right: 264,
      },
      lastMatchedAt: 18_000,
    },
    weakHeaderBand: {
      top: 70,
      bottom: 99,
      left: 20,
      right: 167,
    },
  });
  assertEqual(
    JSON.stringify({
      sessionActive: routeChangeWeakHeaderBridge.sessionActive,
      transition: routeChangeWeakHeaderBridge.transition,
      signalSource: routeChangeWeakHeaderBridge.signalSource,
      lifecycleReason: routeChangeWeakHeaderBridge.lifecycleReason,
      visualCropHeight: routeChangeWeakHeaderBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "weak-header",
      lifecycleReason: "route-changed",
      visualCropHeight: 56,
    }),
    "#49 a fresh route that immediately follows a confirmed Marketplace thread should bridge across the route change when only the next weak Marketplace header is visible",
  );

  const routeChangePendingBootstrapBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-3",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
      previousSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-2",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: true,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: routeChangePendingBootstrapBridge.sessionActive,
      transition: routeChangePendingBootstrapBridge.transition,
      signalSource: routeChangePendingBootstrapBridge.signalSource,
      lifecycleReason: routeChangePendingBootstrapBridge.lifecycleReason,
      visualCropHeight: routeChangePendingBootstrapBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "right-pane-action",
      lifecycleReason: "route-changed",
      visualCropHeight: 56,
    }),
    "#49 a fresh route that immediately follows a confirmed Marketplace thread should bridge across the route change when the new route only exposes a pending Marketplace bootstrap signal at first",
  );

  const staleRouteChangeWeakHeader = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread-4",
    nowMs: 20_600,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: {
      ...confirmedSession.nextSession,
      routeKey: "/messages/t/marketplace-thread-3",
      headerBand: {
        top: 62,
        bottom: 106,
        left: 76,
        right: 264,
      },
      lastMatchedAt: 18_000,
    },
    weakHeaderBand: {
      top: 70,
      bottom: 99,
      left: 20,
      right: 167,
    },
  });
  assertEqual(
    JSON.stringify({
      sessionActive: staleRouteChangeWeakHeader.sessionActive,
      transition: staleRouteChangeWeakHeader.transition,
      lifecycleReason: staleRouteChangeWeakHeader.lifecycleReason,
      visualCropHeight: staleRouteChangeWeakHeader.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 stale route-change weak Marketplace headers must not keep bridging indefinitely after the last confirmed Marketplace match",
  );

  const routeChangeItemLinkPendingBootstrapRejected =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/ordinary-chat-with-marketplace-link",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
      previousSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-2",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "item-link",
      pendingBootstrapAllowed: true,
      headerBackDetected: true,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: routeChangeItemLinkPendingBootstrapRejected.sessionActive,
      transition: routeChangeItemLinkPendingBootstrapRejected.transition,
      lifecycleReason:
        routeChangeItemLinkPendingBootstrapRejected.lifecycleReason,
      visualCropHeight:
        routeChangeItemLinkPendingBootstrapRejected.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 ordinary chats that only expose a generic back button plus a shared Marketplace item link must not inherit Marketplace mode across route changes",
  );

  const staleRouteChangePendingBootstrap =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-4",
      nowMs: 20_600,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-3",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: true,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: staleRouteChangePendingBootstrap.sessionActive,
      transition: staleRouteChangePendingBootstrap.transition,
      lifecycleReason: staleRouteChangePendingBootstrap.lifecycleReason,
      visualCropHeight: staleRouteChangePendingBootstrap.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 stale route-change pending Marketplace bootstrap signals must not keep bridging indefinitely after the last confirmed Marketplace match",
  );

  const weakBootstrapRouteChangeBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-weak-B",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: {
        ...weakBootstrapConfirmed.nextSession,
        routeKey: "/messages/t/marketplace-thread-weak-A",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: weakBootstrapRouteChangeBridge.sessionActive,
      transition: weakBootstrapRouteChangeBridge.transition,
      signalSource: weakBootstrapRouteChangeBridge.signalSource,
      lifecycleReason: weakBootstrapRouteChangeBridge.lifecycleReason,
      visualCropHeight: weakBootstrapRouteChangeBridge.visualCropHeight,
      confirmationKind:
        weakBootstrapRouteChangeBridge.nextSession?.confirmationKind ?? null,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "right-pane-action",
      lifecycleReason: "route-changed",
      visualCropHeight: 36,
      confirmationKind: "weak-bootstrap",
    }),
    "#49 recent weak-bootstrap Marketplace continuity should bridge across route changes when the next route again exposes a right-pane Marketplace action even without an early back control",
  );

  const weakBootstrapRouteChangeItemLinkRejected =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/ordinary-chat-with-marketplace-link-2",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: {
        ...weakBootstrapConfirmed.nextSession,
        routeKey: "/messages/t/marketplace-thread-weak-A",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "item-link",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: weakBootstrapRouteChangeItemLinkRejected.sessionActive,
      transition: weakBootstrapRouteChangeItemLinkRejected.transition,
      lifecycleReason: weakBootstrapRouteChangeItemLinkRejected.lifecycleReason,
      visualCropHeight:
        weakBootstrapRouteChangeItemLinkRejected.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 weak-bootstrap continuity must still fail closed for ordinary chats that only expose a Marketplace item-link hint on the next route",
  );

  const staleWeakBootstrapRouteChangeBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-weak-B",
      nowMs: 20_800,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: {
        ...weakBootstrapConfirmed.nextSession,
        routeKey: "/messages/t/marketplace-thread-weak-A",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: staleWeakBootstrapRouteChangeBridge.sessionActive,
      transition: staleWeakBootstrapRouteChangeBridge.transition,
      lifecycleReason: staleWeakBootstrapRouteChangeBridge.lifecycleReason,
      visualCropHeight: staleWeakBootstrapRouteChangeBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 weak-bootstrap Marketplace continuity must still expire once the recent-match window is stale",
  );

  const ordinaryRoutePendingBootstrap = resolveMarketplaceVisualSessionDecision(
    {
      currentRouteKey: "/messages/t/ordinary-chat-2",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
      previousSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-2",
        lastMatchedAt: 18_000,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    },
  );
  assertEqual(
    JSON.stringify({
      sessionActive: ordinaryRoutePendingBootstrap.sessionActive,
      transition: ordinaryRoutePendingBootstrap.transition,
      lifecycleReason: ordinaryRoutePendingBootstrap.lifecycleReason,
      visualCropHeight: ordinaryRoutePendingBootstrap.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 ordinary chats with only a transient pending Marketplace bootstrap signal and no back-control corroboration should still fail closed on route change",
  );

  const detachedRecentContinuityPendingBootstrapBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-detoured-E",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      recentContinuityGraceMs: MARKETPLACE_RECENT_CONTINUITY_GRACE_MS,
      previousSession: null,
      recentSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-detoured-B",
        lastMatchedAt: 12_100,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    JSON.stringify({
      sessionActive:
        detachedRecentContinuityPendingBootstrapBridge.sessionActive,
      transition: detachedRecentContinuityPendingBootstrapBridge.transition,
      signalSource: detachedRecentContinuityPendingBootstrapBridge.signalSource,
      lifecycleReason:
        detachedRecentContinuityPendingBootstrapBridge.lifecycleReason,
      visualCropHeight:
        detachedRecentContinuityPendingBootstrapBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "right-pane-action",
      lifecycleReason: "route-changed",
      visualCropHeight: 56,
    }),
    "#49 a recently confirmed Marketplace thread should still bridge back in after one or more ordinary-chat detours when the new route only exposes a right-pane Marketplace action at first",
  );

  const detachedRecentContinuityWeakHeaderBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-detoured-F",
      nowMs: 18_450,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      recentContinuityGraceMs: MARKETPLACE_RECENT_CONTINUITY_GRACE_MS,
      previousSession: null,
      recentSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-detoured-B",
        lastMatchedAt: 12_100,
        headerBand: {
          top: 62,
          bottom: 106,
          left: 76,
          right: 264,
        },
      },
      weakHeaderBand: {
        top: 70,
        bottom: 99,
        left: 20,
        right: 167,
      },
    });
  assertEqual(
    JSON.stringify({
      sessionActive: detachedRecentContinuityWeakHeaderBridge.sessionActive,
      transition: detachedRecentContinuityWeakHeaderBridge.transition,
      signalSource: detachedRecentContinuityWeakHeaderBridge.signalSource,
      lifecycleReason: detachedRecentContinuityWeakHeaderBridge.lifecycleReason,
      visualCropHeight:
        detachedRecentContinuityWeakHeaderBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "weak-header",
      lifecycleReason: "route-changed",
      visualCropHeight: 56,
    }),
    "#49 a recent Marketplace continuity snapshot should rescue a detoured re-entry when the next weak header matches even after the active session was already cleared",
  );

  const staleDetachedRecentContinuityBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-detoured-G",
      nowMs: 22_250,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      recentContinuityGraceMs: MARKETPLACE_RECENT_CONTINUITY_GRACE_MS,
      previousSession: null,
      recentSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-detoured-B",
        lastMatchedAt: 12_100,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: staleDetachedRecentContinuityBridge.sessionActive,
      transition: staleDetachedRecentContinuityBridge.transition,
      lifecycleReason: staleDetachedRecentContinuityBridge.lifecycleReason,
      visualCropHeight: staleDetachedRecentContinuityBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 detached Marketplace continuity must still expire once the recent detour window has gone stale",
  );

  const detachedRecentContinuityItemLinkRejected =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/ordinary-chat-detoured-H",
      nowMs: 18_320,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      recentContinuityGraceMs: MARKETPLACE_RECENT_CONTINUITY_GRACE_MS,
      previousSession: null,
      recentSession: {
        ...confirmedSession.nextSession,
        routeKey: "/messages/t/marketplace-thread-detoured-B",
        lastMatchedAt: 12_100,
      },
      pendingBootstrapSignalSource: "item-link",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: detachedRecentContinuityItemLinkRejected.sessionActive,
      transition: detachedRecentContinuityItemLinkRejected.transition,
      lifecycleReason: detachedRecentContinuityItemLinkRejected.lifecycleReason,
      visualCropHeight:
        detachedRecentContinuityItemLinkRejected.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "route-changed",
      visualCropHeight: null,
    }),
    "#49 detached Marketplace continuity must still fail closed for ordinary chats that only surface Marketplace item-link noise after a detour",
  );

  const detouredMarketplaceSession = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread-2",
    nowMs: 17_300,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: null,
    strongSignalSource: "strong-header",
    strongVisualCropHeight: 56,
    strongHeaderBand: confirmedHeaderBand,
  });
  const detouredImmediateOrdinaryLookingRerender =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread-2",
      nowMs: 17_360,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: detouredMarketplaceSession.nextSession,
      sameRouteMarketplaceBackAnchorDetected: true,
      headerBackMatchesSessionHeaderBand: true,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: detouredImmediateOrdinaryLookingRerender.sessionActive,
      transition: detouredImmediateOrdinaryLookingRerender.transition,
      visualCropHeight:
        detouredImmediateOrdinaryLookingRerender.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      visualCropHeight: 56,
    }),
    "#49 a freshly re-entered Marketplace route should stay bridged after a chat detour when only the back anchor survives the immediate rerender",
  );

  const ordinaryChatMarketplaceLabel = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/ordinary-chat",
    nowMs: 17_200,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: null,
    weakHeaderBand: mismatchedWeakHeaderBand,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: ordinaryChatMarketplaceLabel.sessionActive,
      transition: ordinaryChatMarketplaceLabel.transition,
      visualCropHeight: ordinaryChatMarketplaceLabel.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "rejected",
      visualCropHeight: null,
    }),
    "#49 ordinary chats with a stray Marketplace label should not enter a Marketplace session",
  );

  const briefNoSignalBridge = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 11_900,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: weakBridge.nextSession,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: briefNoSignalBridge.sessionActive,
      transition: briefNoSignalBridge.transition,
      signalSource: briefNoSignalBridge.signalSource,
      lifecycleReason: briefNoSignalBridge.lifecycleReason,
      visualCropHeight: briefNoSignalBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      visualCropHeight: 56,
    }),
    "#49 brief same-route no-signal churn should bridge without dropping the Marketplace session immediately",
  );

  const beta48ReplayBridge = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 11_564,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: confirmedSession.nextSession,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: beta48ReplayBridge.sessionActive,
      transition: beta48ReplayBridge.transition,
      signalSource: beta48ReplayBridge.signalSource,
      lifecycleReason: beta48ReplayBridge.lifecycleReason,
      visualCropHeight: beta48ReplayBridge.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      visualCropHeight: 56,
    }),
    "#49 the April 6 same-route Marketplace replay should stay bridged beyond the old 1.5s cutoff when no valid weak header remains",
  );

  const persistentIdleReplay = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 38_700,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: confirmedSession.nextSession,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: persistentIdleReplay.sessionActive,
      transition: persistentIdleReplay.transition,
      signalSource: persistentIdleReplay.signalSource,
      lifecycleReason: persistentIdleReplay.lifecycleReason,
      visualCropHeight: persistentIdleReplay.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      visualCropHeight: 56,
    }),
    "#49 long same-route idle gaps should not silently expire a confirmed Marketplace session",
  );

  const pendingOrdinaryChatClear = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 38_900,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: confirmedSession.nextSession,
    ordinaryClearPending: true,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: pendingOrdinaryChatClear.sessionActive,
      transition: pendingOrdinaryChatClear.transition,
      signalSource: pendingOrdinaryChatClear.signalSource,
      lifecycleReason: pendingOrdinaryChatClear.lifecycleReason,
      visualCropHeight: pendingOrdinaryChatClear.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "ordinary-clear-pending",
      signalSource: "bridge",
      lifecycleReason: "ordinary-clear-pending",
      visualCropHeight: 56,
    }),
    "#49 same-route ordinary-only rerenders should stay active while the Marketplace clear is still pending",
  );

  const freshBackOnlyRoute = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 39_100,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: null,
    sameRouteMarketplaceBackAnchorDetected: true,
    headerBackMatchesSessionHeaderBand: true,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: freshBackOnlyRoute.sessionActive,
      transition: freshBackOnlyRoute.transition,
      visualCropHeight: freshBackOnlyRoute.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "inactive",
      visualCropHeight: null,
    }),
    "#49 a fresh route with only a back control must not bootstrap Marketplace mode",
  );

  const returningMarketplaceCancelsPendingClear =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-thread",
      nowMs: 38_950,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      previousSession: pendingOrdinaryChatClear.nextSession,
      weakHeaderBand: matchingWeakHeaderBand,
    });
  assertEqual(
    JSON.stringify({
      sessionActive: returningMarketplaceCancelsPendingClear.sessionActive,
      transition: returningMarketplaceCancelsPendingClear.transition,
      signalSource: returningMarketplaceCancelsPendingClear.signalSource,
      lifecycleReason: returningMarketplaceCancelsPendingClear.lifecycleReason,
      visualCropHeight:
        returningMarketplaceCancelsPendingClear.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: true,
      transition: "bridged",
      signalSource: "weak-header",
      lifecycleReason: "same-thread-rerender",
      visualCropHeight: 56,
    }),
    "#49 any returning Marketplace evidence should cancel a pending ordinary clear on the same route",
  );

  const explicitOrdinaryChatClear = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-thread",
    nowMs: 39_000,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    previousSession: weakBridge.nextSession,
    explicitOrdinaryChatDetected: true,
  });
  assertEqual(
    JSON.stringify({
      sessionActive: explicitOrdinaryChatClear.sessionActive,
      transition: explicitOrdinaryChatClear.transition,
      lifecycleReason: explicitOrdinaryChatClear.lifecycleReason,
      visualCropHeight: explicitOrdinaryChatClear.visualCropHeight,
    }),
    JSON.stringify({
      sessionActive: false,
      transition: "cleared",
      lifecycleReason: "explicit-ordinary-chat",
      visualCropHeight: null,
    }),
    "#49 same-route Marketplace sessions should clear only when ordinary-chat evidence is explicit",
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
      "https://www.facebook.com/messages/t/issue52-thread/",
    ),
    "reroute-main-view",
    "#52 regular chat clicks opened through window.open should reroute into the app instead of the system browser",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/messages/e2ee/t/issue52-thread/",
    ),
    "reroute-main-view",
    "#52 E2EE chat clicks opened through window.open should reroute into the app instead of the system browser",
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
    decideWindowOpenAction(
      "https://www.facebook.com/messages/media_viewer.123",
    ),
    "reroute-main-view",
    "#45 media_viewer routes should stay in the main Messenger surface",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/checkpoint/1501092823525282/",
    ),
    "reroute-auth-flow",
    "#54 Facebook checkpoint popups should reroute into the app login flow instead of the system browser",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/login/device-based/regular/login/",
    ),
    "reroute-auth-flow",
    "#54 Facebook login verification popups should stay attached to the app",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/remember_browser/?next=https%3A%2F%2Fwww.facebook.com%2Fmessages%2F",
    ),
    "reroute-auth-flow",
    "#54 post-verification remember-browser routes should stay attached to the app",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://accounts.google.com/signin/v2/challenge/pwd",
    ),
    "open-external-browser",
    "#54 non-Facebook verification pages should still open in the system browser",
  );
  assertEqual(
    isExternalAuthProviderRoute(
      "https://accounts.google.com/signin/v2/challenge/pwd",
    ),
    true,
    "#54 Google account verification should be recognized as an external auth provider route",
  );
  assertEqual(
    decideWindowOpenActionForContext(
      "https://accounts.google.com/signin/v2/challenge/pwd",
      { facebookAuthFlowActive: true },
    ),
    "open-auth-provider-browser",
    "#54 Google verification should fall back to the system browser during an active Facebook auth flow",
  );
  assertEqual(
    decideWindowOpenActionForContext(
      "https://accounts.google.com/signin/v2/challenge/pwd",
      { facebookAuthFlowActive: false },
    ),
    "open-external-browser",
    "#54 Google verification links should remain external outside a Facebook auth flow",
  );
  assertEqual(
    decideWindowOpenActionForContext(
      "https://www.google.com/search?q=messenger",
      { facebookAuthFlowActive: true },
    ),
    "open-external-browser",
    "#54 generic Google pages should not be pulled into the app auth window",
  );
  assertEqual(
    isMessagesSurfaceRoute(
      "https://www.facebook.com/messages/?checkpoint_src=any",
    ),
    true,
    "#54 post-checkpoint Messenger landing should be recognized as a Messenger surface",
  );
  assertEqual(
    decideWindowOpenAction(
      "https://www.facebook.com/messages/?checkpoint_src=any",
    ),
    "reroute-main-view",
    "#54 post-checkpoint Messenger landing should hand off to the main window",
  );

  const mainSource = fs.readFileSync(
    path.join(APP_ROOT, "src/main/main.ts"),
    "utf8",
  );
  const completionIndex = mainSource.indexOf(
    "isFacebookHomePage(url) || isMessagesSurfaceRoute(url)",
  );
  const browserFallbackIndex = mainSource.indexOf(
    "if (isExternalAuthProviderRoute(url))",
    completionIndex,
  );
  const allowAuthIndex = mainSource.indexOf(
    "if (isAuthOrCheckpointRoute(url))",
    browserFallbackIndex,
  );
  assert(
    mainSource.includes("function openAuthWindow(") &&
      mainSource.includes("getWaitingForLoginPageURL()") &&
      mainSource.includes("getExternalAuthProviderFallbackPageURL()") &&
      mainSource.includes("finishAuthFlowInTarget(") &&
      mainSource.includes("openExternalAuthProviderBrowserFallback(") &&
      mainSource.includes("resumeExternalAuthProviderFallback(") &&
      mainSource.includes("activeExternalAuthProviderFallback") &&
      mainSource.includes("facebook-auth-url-preserved") &&
      mainSource.includes("external-provider-browser-opened") &&
      mainSource.includes("external-provider-browser-resume-requested") &&
      mainSource.includes(
        "external-provider-browser-resume-reusing-auth-window",
      ) &&
      mainSource.includes("EXTERNAL_AUTH_PROVIDER_RESUME_MARKER") &&
      mainSource.includes("pushAuthFlowDebugEvent(") &&
      mainSource.includes("buildAuthFlowRouteDebug("),
    "#54 main process should keep Facebook auth in a dedicated auth window, preserve/reuse it across browser fallback, and return to Messenger after completion",
  );
  const fallbackFunctionBody =
    mainSource.slice(
      mainSource.indexOf("function openExternalAuthProviderBrowserFallback("),
      mainSource.indexOf("function handleAuthWindowNavigation("),
    ) || "";
  assert(
    fallbackFunctionBody.includes("authFlowAwaitingCompletion = true") &&
      fallbackFunctionBody.includes("authWindow.blur()") &&
      !fallbackFunctionBody.includes("authWindow.close()"),
    "#54 external-provider browser fallback should preserve the auth window instead of closing the transaction",
  );
  assert(
    mainSource.includes("searchKeys") &&
      mainSource.includes("safeUrl") &&
      mainSource.includes("navigation-completes-login"),
    "#54 auth flow should write privacy-safer debug events for future login-loop reports",
  );
  assert(
    mainSource.includes("function exportDebugLogsZipToDirectory(") &&
      mainSource.includes("writeZipArchive(zipPath, archiveFiles)") &&
      mainSource.includes("shell.showItemInFolder(exported.zipPath)") &&
      mainSource.includes("Debug logs zip exported successfully."),
    "#54 debug export should produce a zip and automatically reveal that zip for attachment",
  );
  assert(
    completionIndex >= 0 &&
      browserFallbackIndex >= 0 &&
      allowAuthIndex >= 0 &&
      completionIndex < allowAuthIndex,
    "#54 auth window should treat Messenger landing as completion before allowing checkpoint/auth routes to continue",
  );
  assert(
    completionIndex < browserFallbackIndex &&
      browserFallbackIndex < allowAuthIndex,
    "#54 auth window should hand external providers to the browser before allowing Facebook checkpoint routes to continue in-app",
  );

  const beta28LoopFixture = JSON.parse(
    fs.readFileSync(
      path.join(
        APP_ROOT,
        "scripts/fixtures/issue54-beta28-auth-loop-sequence.json",
      ),
      "utf8",
    ),
  );
  const loopEvents = beta28LoopFixture.events;
  assertEqual(
    loopEvents.filter(
      (event: string) =>
        event === "auth-flow-external-provider-browser-fallback-started",
    ).length,
    2,
    "#54 beta 28 fixture should capture repeated Google browser fallback attempts",
  );
  assertEqual(
    loopEvents.filter(
      (event: string) =>
        event === "auth-flow-external-provider-browser-resume-requested",
    ).length,
    2,
    "#54 beta 28 fixture should capture repeated app resume attempts",
  );
  assertEqual(
    loopEvents.includes("auth-flow-closed-before-completion"),
    true,
    "#54 beta 28 fixture should capture the auth transaction closing before Messenger completion",
  );
  assertEqual(
    beta28LoopFixture.expectedFixShape.resumeReusesPreservedAuthWindow,
    true,
    "#54 fixture should document that resume must reuse the preserved auth window",
  );
};

const runMediaOverlayPolicyTests = () => {
  assertEqual(
    evaluateMediaOverlayVisible({
      path: "/messages/media_viewer.123",
      modeFromPath: "media",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: false,
      downloadCount: 0,
      hasShareAction: false,
      shareCount: 0,
      hasNavigationAction: false,
      navigationCount: 0,
      hasLargeMedia: false,
    }),
    true,
    "#45 explicit media routes should always stay in media mode",
  );
  assertEqual(
    evaluateMediaOverlayVisible({
      path: "/messages/t/123",
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: true,
      downloadCount: 1,
      hasShareAction: true,
      shareCount: 1,
      hasNavigationAction: false,
      navigationCount: 0,
      hasLargeMedia: true,
    }),
    true,
    "#45 same-route viewer with download controls should still switch to media mode",
  );
  assertEqual(
    evaluateMediaOverlayVisible({
      path: "/messages/t/123",
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: false,
      downloadCount: 0,
      hasShareAction: true,
      shareCount: 1,
      hasNavigationAction: false,
      navigationCount: 0,
      hasLargeMedia: true,
    }),
    false,
    "#49 a chat thread with Back + Share + large preview should not be misclassified as a media viewer",
  );
  assertEqual(
    evaluateMediaOverlayVisible({
      path: "/messages/t/123",
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: false,
      downloadCount: 0,
      hasShareAction: false,
      shareCount: 0,
      hasNavigationAction: true,
      navigationCount: 2,
      hasLargeMedia: true,
    }),
    true,
    "#45 same-route viewers with navigation controls should still switch to media mode",
  );
  assertEqual(
    evaluateMediaOverlayVisible({
      path: "/messages/t/123",
      modeFromPath: "chat",
      threadSubtabRoute: false,
      hasDismissAction: true,
      dismissCount: 1,
      hasDownloadAction: false,
      downloadCount: 0,
      hasShareAction: false,
      shareCount: 0,
      hasNavigationAction: true,
      navigationCount: 1,
      hasLargeMedia: false,
    }),
    false,
    "#50/#52 message-request top bars without large media should not put chat routes into media mode",
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
    incomingCallHintPolicy.shouldTreatIncomingCallUiAsVisible({
      answerVisible: false,
      declineVisible: false,
      joinVisible: true,
      titleSignal: false,
      selectorSignal: false,
      textSignal: false,
    }),
    false,
    "#49 join-only Marketplace-like controls should not count as visible incoming-call UI",
  );
  assertEqual(
    incomingCallHintPolicy.shouldTreatIncomingCallUiAsVisible({
      answerVisible: true,
      declineVisible: false,
      joinVisible: true,
      titleSignal: false,
      selectorSignal: false,
      textSignal: false,
    }),
    false,
    "#49 accept-or-join without decline should not count as visible incoming-call UI",
  );
  assertEqual(
    incomingCallHintPolicy.shouldTreatIncomingCallUiAsVisible({
      answerVisible: false,
      declineVisible: true,
      joinVisible: true,
      titleSignal: false,
      selectorSignal: false,
      textSignal: false,
    }),
    true,
    "#49 join plus decline should still count as visible incoming-call UI",
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
  assert(
    typeof incomingCallIpcPolicy.decideIncomingCallFirstNotificationDelay ===
      "function",
    "incoming call IPC policy missing decideIncomingCallFirstNotificationDelay",
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

  const periodicScanWithoutControlsEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "periodic-scan",
        caller: "Account A",
        confidence: "medium",
        hasVisibleControls: false,
      }),
    });
  assertEqual(
    periodicScanWithoutControlsEscalation.shouldEscalate,
    false,
    "#50 periodic-scan call evidence without visible controls should not arm incoming-call reminder state",
  );
  assertEqual(
    periodicScanWithoutControlsEscalation.reason,
    "soft-evidence-requires-visible-controls",
    "#50 periodic-scan call evidence without visible controls should report the no-controls suppression reason",
  );

  const domSoftWithoutControlsEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "dom-soft",
        caller: "Account A",
        confidence: "medium",
        hasVisibleControls: false,
      }),
    });
  assertEqual(
    domSoftWithoutControlsEscalation.shouldEscalate,
    false,
    "#50 dom-soft call evidence without visible controls should stay diagnostic-only",
  );
  assertEqual(
    domSoftWithoutControlsEscalation.reason,
    "soft-evidence-requires-visible-controls",
    "#50 dom-soft call evidence without visible controls should report the no-controls suppression reason",
  );

  const syntheticWakeTopBarEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "dom-soft",
        caller:
          incomingCallEvidence.extractIncomingCallCallerName(
            "Incoming call Account A messaged you",
          ).caller ?? undefined,
        confidence: "medium",
        hasVisibleControls: false,
        matchedPattern: "incoming (video |audio )?call",
        recoveryActive: true,
      }),
      recoveryActive: true,
    });
  assertEqual(
    syntheticWakeTopBarEscalation.shouldEscalate,
    false,
    "#50 synthetic wake top-bar with call-ish text but no controls should not notify",
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

  const explicitControlsEscalation =
    incomingCallIpcPolicy.decideIncomingCallSignalEscalation({
      evidence: incomingCallEvidence.buildIncomingCallEvidence({
        source: "dom-explicit",
        caller: "Account A",
        confidence: "high",
        hasVisibleControls: true,
      }),
    });
  assertEqual(
    explicitControlsEscalation.shouldEscalate,
    true,
    "#50 explicit DOM call evidence with visible controls should still notify",
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

  const threadKeyFallback =
    incomingCallIpcPolicy.decideIncomingCallNativeNotification({
      payload: {
        evidence: incomingCallEvidence.buildIncomingCallEvidence({
          source: "dom-explicit",
          confidence: "high",
          threadKey: "thread-456",
        }),
      },
      now: baseNow + 500,
      notificationByKey: new Map<string, number>(),
      lastNoKeyIncomingCallNotificationAt: 0,
    });
  assertEqual(
    threadKeyFallback.callKey,
    "thread:thread-456",
    "#49 incoming-call IPC should fall back to thread identity when no call dedupe key is present",
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

  assertEqual(
    incomingCallEvidence.normalizeIncomingCallCaller("Profile Picture"),
    null,
    "#49 incoming-call caller normalisation should drop placeholder caller labels",
  );
  assertEqual(
    incomingCallEvidence.normalizeIncomingCallCaller("Person B Person B"),
    "Person B",
    "#49 incoming-call caller normalisation should collapse repeated caller names",
  );
  assertEqual(
    incomingCallEvidence.buildIncomingCallNotificationBody({
      caller: "Profile Picture",
      fallbackCaller: "Person B",
    }),
    "Person B is calling you on Messenger",
    "#49 incoming-call notification bodies should reuse the active session caller when a placeholder echo arrives",
  );
  assertEqual(
    incomingCallEvidence.normalizeIncomingCallCaller(
      "callProfile pictureIncoming",
    ),
    null,
    "#50 incoming-call caller normalisation should reject accessibility chrome junk",
  );
  assertEqual(
    incomingCallEvidence.normalizeIncomingCallCaller(
      "call Profile picture Incoming",
    ),
    null,
    "#50 incoming-call caller normalisation should reject mixed placeholder caller labels",
  );
  assertEqual(
    incomingCallEvidence.extractIncomingCallCallerName(
      "callProfile pictureIncoming",
    ).caller,
    null,
    "#50 incoming-call caller extraction should fail closed for placeholder junk",
  );
  assertEqual(
    incomingCallEvidence.normalizeIncomingCallCaller("Account A messaged you"),
    null,
    "#50 incoming-call caller normalisation should reject message-preview snippets",
  );
  assertEqual(
    incomingCallEvidence.extractIncomingCallCallerName(
      "Incoming call Account A messaged you",
    ).caller,
    null,
    "#50 incoming-call caller extraction should reject wake replay message-preview snippets",
  );
  assertEqual(
    incomingCallEvidence.buildIncomingCallNotificationBody({
      caller: "Account A messaged you",
      fallbackCaller: "Account B",
    }),
    "Account B is calling you on Messenger",
    "#50 incoming-call notification bodies should not upgrade from message-preview snippets",
  );
  assertEqual(
    incomingCallEvidence.extractIncomingCallCallerName(
      "Amanda Goodwin is calling you",
    ).caller,
    "Amanda Goodwin",
    "#50 incoming-call caller extraction should keep real caller names from active-ring text",
  );
  assertEqual(
    incomingCallEvidence.extractIncomingCallCallerName(
      "Incoming call from Amanda Goodwin",
    ).caller,
    "Amanda Goodwin",
    "#50 incoming-call caller extraction should keep real caller names from incoming-call titles",
  );
  assertEqual(
    incomingCallEvidence.buildIncomingCallNotificationBody({
      caller: "",
      body: "Unknown caller",
    }),
    "Someone is calling you on Messenger",
    "#49 incoming-call notification bodies should stay generic when no usable caller survives normalisation",
  );

  const placeholderEchoDecision =
    incomingCallIpcPolicy.decideIncomingCallSessionUpdate({
      sameActiveSession: true,
      normalizedCaller: null,
      notificationBody: "Someone is calling you on Messenger",
      activeNotificationBody: "Amanda Goodwin is calling you on Messenger",
      dedupeReason: "same-key",
    });
  assertEqual(
    placeholderEchoDecision.action,
    "ignore-placeholder-echo",
    "#50 incoming-call IPC should ignore same-session placeholder echoes once a better caller is active",
  );

  const improvedCallerDecision =
    incomingCallIpcPolicy.decideIncomingCallSessionUpdate({
      sameActiveSession: true,
      normalizedCaller: "Amanda Goodwin",
      notificationBody: "Amanda Goodwin is calling you on Messenger",
      activeNotificationBody: "Someone is calling you on Messenger",
      dedupeReason: "same-key",
    });
  assertEqual(
    improvedCallerDecision.action,
    "show-improved-notification",
    "#50 incoming-call IPC should immediately upgrade a generic active notification when a same-key caller name arrives",
  );

  const callerlessFirstToastDecision =
    incomingCallIpcPolicy.decideIncomingCallFirstNotificationDelay({
      shouldNotify: true,
      sameActiveSession: false,
      normalizedCaller: null,
    });
  assertEqual(
    callerlessFirstToastDecision.shouldDelay,
    true,
    "#50 incoming-call IPC should hold a callerless first toast briefly while waiting for better caller evidence",
  );

  const namedFirstToastDecision =
    incomingCallIpcPolicy.decideIncomingCallFirstNotificationDelay({
      shouldNotify: true,
      sameActiveSession: false,
      normalizedCaller: "User A",
    });
  assertEqual(
    namedFirstToastDecision.shouldDelay,
    false,
    "#50 incoming-call IPC should show a named first toast immediately",
  );

  const activeSessionFirstToastDecision =
    incomingCallIpcPolicy.decideIncomingCallFirstNotificationDelay({
      shouldNotify: true,
      sameActiveSession: true,
      normalizedCaller: null,
    });
  assertEqual(
    activeSessionFirstToastDecision.shouldDelay,
    false,
    "#50 incoming-call IPC should not delay active-session placeholder echoes",
  );

  const unchangedCallerDecision =
    incomingCallIpcPolicy.decideIncomingCallSessionUpdate({
      sameActiveSession: true,
      normalizedCaller: "Amanda Goodwin",
      notificationBody: "Amanda Goodwin is calling you on Messenger",
      activeNotificationBody: "Amanda Goodwin is calling you on Messenger",
      dedupeReason: "same-key",
    });
  assertEqual(
    unchangedCallerDecision.action,
    "refresh-active-session",
    "#50 incoming-call IPC should avoid re-showing notifications when the same-key caller body is unchanged",
  );
};

const runNotificationPolicyTests = () => {
  const notificationDecisionPolicy = loadNotificationDecisionPolicy();
  const notificationActivityPolicy = loadNotificationActivityPolicy();
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
    typeof notificationDecisionPolicy.classifyMutationMuteStateRecheckReason ===
      "function",
    "notification decision policy missing classifyMutationMuteStateRecheckReason",
  );
  assert(
    typeof notificationDecisionPolicy.shouldSuppressSelfAuthoredNotification ===
      "function",
    "notification decision policy missing shouldSuppressSelfAuthoredNotification",
  );
  assert(
    typeof notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity ===
      "function",
    "notification decision policy missing shouldSuppressBrowserNotificationActivity",
  );
  assert(
    typeof notificationDecisionPolicy.evaluateMessengerMessageProof ===
      "function",
    "notification decision policy missing evaluateMessengerMessageProof",
  );
  assert(
    typeof notificationActivityPolicy.isLikelyGlobalFacebookNotification ===
      "function",
    "notification activity policy missing isLikelyGlobalFacebookNotification",
  );

  const mutedIndividualMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Person A",
        body: "Can you review this?",
      },
      [
        {
          href: "/t/person-a",
          title: "Person A",
          body: "Can you review this?",
          muted: true,
          unread: true,
        },
        {
          href: "/t/group-project",
          title: "Project Squad",
          body: "Person A sent a message",
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
    "/t/person-a",
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
        body: "Person A sent a message",
      },
      [
        {
          href: "/t/person-a",
          title: "Person A",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Person A sent a message",
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
        title: "Person Alpha",
        body: "sent a message",
      },
      [
        {
          href: "/t/person-alpha",
          title: "Person Alpha",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Person A sent a message",
          searchText: "Project Squad Person Alpha sent a message",
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
        title: "Person Alpha",
        body: "sent a message",
      },
      [
        {
          href: "/t/person-alpha",
          title: "Person Alpha",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Person A sent a message",
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

  const photoMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Person A",
        body: "sent a photo.",
      },
      [
        {
          href: "/t/person-a",
          title: "Person A",
          body: "sent a photo.",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Person A sent a photo.",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    photoMutedConflict.reason,
    "muted-conflict",
    "#46 sender-title photo notifications should fail closed when a muted group overlaps",
  );

  const linkMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Person A",
        body: "shared a link.",
      },
      [
        {
          href: "/t/person-a",
          title: "Person A",
          body: "shared a link.",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Person A shared a link.",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    linkMutedConflict.reason,
    "muted-conflict",
    "#46 sender-title link notifications should fail closed when a muted group overlaps",
  );

  const aliasNonMutedAlternative =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Person Alpha",
        body: "sent a message",
      },
      [
        {
          href: "/t/person-alpha",
          title: "Person Alpha",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/project-squad",
          title: "Project Squad",
          body: "Person A sent a message",
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
    "/t/person-alpha",
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
          title: "Person A",
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
          title: "Person A",
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

  const previewTitlePlaceholderBodyMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title:
          "Account A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
        body: "New message",
      },
      [
        {
          href: "/t/account-a-direct",
          title: "Account A",
          body: "I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          muted: false,
          unread: true,
        },
        {
          href: "/t/group-muted-preview",
          title: "Group Thread",
          body: "Account A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          searchText:
            "Account B replied to Account C - Group Thread Account A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    previewTitlePlaceholderBodyMutedConflict.reason,
    "muted-conflict",
    "#49 sender-prefixed preview titles with a generic New message body should fail closed when a muted group row overlaps",
  );
  assertEqual(
    previewTitlePlaceholderBodyMutedConflict.matchedHref,
    undefined,
    "#49 sender-prefixed preview title muted conflicts should not resolve a target conversation",
  );

  const previewTitlePlaceholderBodyUnmutedAlternative =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title:
          "Account A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
        body: "New message",
      },
      [
        {
          href: "/t/account-a-direct",
          title: "Account A",
          body: "I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          muted: false,
          unread: true,
        },
        {
          href: "/t/group-unmuted-preview",
          title: "Group Thread",
          body: "Account A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          searchText:
            "Account B replied to Account C - Group Thread Account A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    previewTitlePlaceholderBodyUnmutedAlternative.reason,
    "matched",
    "#49 sender-prefixed preview titles with a generic New message body should still match when no muted overlap exists",
  );
  assertEqual(
    previewTitlePlaceholderBodyUnmutedAlternative.matchedHref,
    "/t/account-a-direct",
    "#49 sender-prefixed preview titles without muted overlap should still prefer the direct conversation match",
  );

  const facebookUserPreviewTitleBodyMutedConflict =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title:
          "Facebook User: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
        body: "New message",
      },
      [
        {
          href: "/t/user-a-direct",
          title: "Facebook User",
          body: "I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          muted: false,
          unread: true,
        },
        {
          href: "/t/group-muted-preview",
          title: "Group Thread",
          body: "Facebook User: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          searchText:
            "User B replied in Group Thread to User A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    facebookUserPreviewTitleBodyMutedConflict.reason,
    "muted-conflict",
    "#50 Facebook User sender-preview titles with a generic New message body should fail closed with muted overlap",
  );
  assertEqual(
    facebookUserPreviewTitleBodyMutedConflict.matchedHref,
    undefined,
    "#50 sender-preview + New message conflicts should not resolve to a concrete conversation",
  );

  const mutationPreviewRecheckFacebookUser =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title:
          "Facebook User: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
        body: "New message",
      },
      {
        title:
          "User A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
        body: "New message",
      },
    );
  assertEqual(
    mutationPreviewRecheckFacebookUser.shouldRecheck,
    true,
    "#50 mutation recheck helper should flag Facebook User sender-preview titles with New message",
  );
  assertEqual(
    mutationPreviewRecheckFacebookUser.reason,
    "sender-preview-placeholder",
    "#50 Facebook User sender-preview rechecks should use the sender-preview-placeholder reason",
  );

  const mutationPreviewRecheckNormalSender =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title:
          "User A: I passed by three scrub areas tonight but nothing appeared on my radar 😬",
        body: "New message",
      },
      {
        title: "User A",
        body: "New message",
      },
    );
  assertEqual(
    mutationPreviewRecheckNormalSender.shouldRecheck,
    true,
    "#50 mutation recheck helper should flag normal sender-preview + New message",
  );
  assertEqual(
    mutationPreviewRecheckNormalSender.reason,
    "sender-preview-placeholder",
    "#50 normal sender-preview rechecks should use sender-preview-placeholder",
  );

  const longSenderPreviewText =
    "This is a longer fallback preview captured while Messenger is still settling a muted group row. " +
    "It keeps appending enough message text that the title grows beyond the older short-preview limit, " +
    "but it is still shaped like a sender-prefixed message preview rather than a real group title.";
  const longSenderPreviewTitle = `User A: ${longSenderPreviewText}`;
  assert(
    longSenderPreviewTitle.length > 220,
    "#50 long sender-preview fixture should exercise the extended title length path",
  );

  const mutationPreviewRecheckLongSender =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: longSenderPreviewTitle,
        body: "New message",
      },
      {
        title: longSenderPreviewTitle,
        body: "New message",
      },
    );
  assertEqual(
    mutationPreviewRecheckLongSender.shouldRecheck,
    true,
    "#50 long sender-prefixed preview titles with New message should trigger mute-state recheck",
  );
  assertEqual(
    mutationPreviewRecheckLongSender.reason,
    "sender-preview-placeholder",
    "#50 long sender-prefixed preview titles should use sender-preview-placeholder",
  );

  const longPreviewSettledMuted =
    notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
      {
        title: "Project Group",
        body: `User A: ${longSenderPreviewText}`,
      },
      "/t/group-long-preview",
      [
        {
          href: "/t/group-long-preview",
          title: "Project Group",
          body: `User A: ${longSenderPreviewText}`,
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    longPreviewSettledMuted.shouldNotify,
    false,
    "#50 long sender-preview fallback should suppress when the same row settles muted",
  );
  assertEqual(
    longPreviewSettledMuted.muted,
    true,
    "#50 long sender-preview fallback should preserve muted settled-row state",
  );

  const longPreviewSettledUnmuted =
    notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
      {
        title: "Project Group",
        body: `User A: ${longSenderPreviewText}`,
      },
      "/t/group-long-preview-unmuted",
      [
        {
          href: "/t/group-long-preview-unmuted",
          title: "Project Group",
          body: `User A: ${longSenderPreviewText}`,
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    longPreviewSettledUnmuted.shouldNotify,
    true,
    "#50 ordinary unmuted group messages should remain deliverable after the recheck delay",
  );
  assertEqual(
    longPreviewSettledUnmuted.matchedHref,
    "/t/group-long-preview-unmuted",
    "#50 unmuted group recheck should still target the observed conversation",
  );

  const mutationPreviewRecheckLongRealBody =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: longSenderPreviewTitle,
        body: longSenderPreviewText,
      },
      {
        title: "User A",
        body: longSenderPreviewText,
      },
    );
  assertEqual(
    mutationPreviewRecheckLongRealBody.shouldRecheck,
    false,
    "#50 normal direct messages with real bodies should not be delayed even when the title is long",
  );
  assertEqual(
    mutationPreviewRecheckLongRealBody.reason,
    "none",
    "#50 long-title direct messages with real bodies should return none for mutation recheck",
  );

  const mutationPreviewRecheckMediaTitle =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: "User A sent a photo.",
        body: "New message",
      },
      {
        title: "User A sent a photo.",
        body: "New message",
      },
    );
  assertEqual(
    mutationPreviewRecheckMediaTitle.shouldRecheck,
    true,
    "#50 mutation recheck helper should keep media-title + New message as a recheck candidate",
  );
  assertEqual(
    mutationPreviewRecheckMediaTitle.reason,
    "sender-media-placeholder",
    "#50 media-title rechecks should use the sender-media-placeholder reason",
  );

  const mutationPreviewRecheckDirectMessage =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: "User A",
        body: "I passed by three scrub areas tonight but nothing appeared on my radar 😬",
      },
      {
        title: "User A",
        body: "I passed by three scrub areas tonight but nothing appeared on my radar 😬",
      },
    );
  assertEqual(
    mutationPreviewRecheckDirectMessage.shouldRecheck,
    false,
    "#50 mutation recheck helper should skip normal direct messages with real bodies",
  );
  assertEqual(
    mutationPreviewRecheckDirectMessage.reason,
    "none",
    "#50 normal direct messages should return none for mutation recheck",
  );

  const mutationRecheckGroupSenderBody =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: "Project Group",
        body: "User A: Can you review this when you get a minute?",
      },
      {
        title: "Project Group",
        body: "User A: Can you review this when you get a minute?",
      },
      {
        observedSearchText: "Group chat: Project Group",
        matchedSearchText: "Group chat: Project Group",
      },
    );
  assertEqual(
    mutationRecheckGroupSenderBody.shouldRecheck,
    true,
    "#50 group-title notifications with sender-prefixed bodies should trigger mute-state recheck",
  );
  assertEqual(
    mutationRecheckGroupSenderBody.reason,
    "group-sender-preview",
    "#50 group-title sender-body rechecks should use group-sender-preview",
  );

  const mutationRecheckCapturedGroupShape =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: "Group Thread",
        body: "User B: And how was the night?",
      },
      {
        title: "Group Thread",
        body: "User B: And how was the night?",
      },
      {
        observedSearchText: "Group chat: Group Thread",
        matchedSearchText: "Group chat: Group Thread",
      },
    );
  assertEqual(
    mutationRecheckCapturedGroupShape.shouldRecheck,
    true,
    "#50 captured group-title sender-body shape should trigger mute-state recheck",
  );
  assertEqual(
    mutationRecheckCapturedGroupShape.reason,
    "group-sender-preview",
    "#50 captured group-title sender-body shape should use group-sender-preview",
  );

  const groupSenderBodySettledMuted =
    notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
      {
        title: "Project Group",
        body: "User A: Can you review this when you get a minute?",
      },
      "/t/group-sender-body",
      [
        {
          href: "/t/group-sender-body",
          title: "Project Group",
          body: "User A: Can you review this when you get a minute?",
          muted: true,
          unread: true,
        },
      ],
    );
  assertEqual(
    groupSenderBodySettledMuted.shouldNotify,
    false,
    "#50 group-title sender-body recheck should suppress when the same row settles muted",
  );
  assertEqual(
    groupSenderBodySettledMuted.muted,
    true,
    "#50 group-title sender-body recheck should preserve muted settled-row state",
  );

  const groupSenderBodySettledUnmuted =
    notificationDecisionPolicy.resolveObservedSidebarNotificationTarget(
      {
        title: "Project Group",
        body: "User A: Can you review this when you get a minute?",
      },
      "/t/group-sender-body-unmuted",
      [
        {
          href: "/t/group-sender-body-unmuted",
          title: "Project Group",
          body: "User A: Can you review this when you get a minute?",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    groupSenderBodySettledUnmuted.shouldNotify,
    true,
    "#50 unmuted group-title sender-body messages should remain deliverable after recheck",
  );
  assertEqual(
    groupSenderBodySettledUnmuted.matchedHref,
    "/t/group-sender-body-unmuted",
    "#50 unmuted group-title sender-body recheck should still target the observed conversation",
  );

  const mutationRecheckDirectColonBody =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: "User A",
        body: "Plan: can you review this when you get a minute?",
      },
      {
        title: "User A",
        body: "Plan: can you review this when you get a minute?",
      },
    );
  assertEqual(
    mutationRecheckDirectColonBody.shouldRecheck,
    false,
    "#50 direct messages with colon-prefixed real bodies should not be delayed",
  );
  assertEqual(
    mutationRecheckDirectColonBody.reason,
    "none",
    "#50 direct messages with colon-prefixed real bodies should return none for mutation recheck",
  );

  const mutationPreviewRecheckGroupSenderBody =
    notificationDecisionPolicy.classifyMutationMuteStateRecheckReason(
      {
        title: "Group Thread",
        body: "User A: I passed by three scrub areas tonight",
      },
      {
        title: "User A",
        body: "User A: I passed by three scrub areas tonight",
      },
    );
  assertEqual(
    mutationPreviewRecheckGroupSenderBody.shouldRecheck,
    false,
    "#50 mutation recheck helper should skip group sender bodies when the matched row is a direct conversation",
  );
  assertEqual(
    mutationPreviewRecheckGroupSenderBody.reason,
    "none",
    "#50 mismatched group-title/direct sender-body payloads should return none",
  );

  const mutedGroupTitleMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Project Squad",
        body: "Person A: shipped the fix",
      },
      [
        {
          href: "/t/group-project",
          title: "Project Squad",
          body: "Person A: shipped the fix",
          muted: true,
          unread: true,
        },
        {
          href: "/t/person-a",
          title: "Person A",
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

  const personTitleSocialActivityMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Taylor",
        body: "commented on your post",
      },
      [
        {
          href: "/t/taylor",
          title: "Taylor",
          body: "Are you free tonight?",
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
    personTitleSocialActivityMatch.ambiguous,
    true,
    "#46 person-title Facebook activity should fail closed instead of matching a chat row",
  );
  assertEqual(
    personTitleSocialActivityMatch.reason,
    "low-confidence",
    "#46 person-title Facebook activity should remain low-confidence",
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
  assertEqual(
    observedDirectMatch.debug?.matchedHref,
    "/t/taylor",
    "#49 observed direct conversation debug should record the matched href",
  );
  assertEqual(
    observedDirectMatch.debug?.matchedObservedHref,
    true,
    "#49 observed direct conversation debug should record the observed-row match",
  );
  assert(
    Array.isArray(observedDirectMatch.debug?.topCandidates) &&
      observedDirectMatch.debug.topCandidates.length > 0,
    "#49 observed direct conversation debug should include scored candidate summaries",
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
  assertEqual(
    observedMutedConflict.debug?.finalReason,
    "muted-conflict",
    "#49 muted-conflict debug should preserve the final decision reason",
  );
  assert(
    Array.isArray(observedMutedConflict.debug?.topCandidates) &&
      observedMutedConflict.debug.topCandidates.some(
        (candidate: { muted?: boolean }) => candidate.muted === true,
      ),
    "#49 muted-conflict debug should include muted candidate summaries",
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
  assertEqual(
    observedRowMismatch.debug?.finalReason,
    "observed-row-mismatch",
    "#49 observed sidebar mismatch debug should preserve the mismatch reason",
  );
  assertEqual(
    observedRowMismatch.debug?.matchedObservedHref,
    false,
    "#49 observed sidebar mismatch debug should record that the changed row did not match",
  );

  const mainSource = fs.readFileSync(
    path.join(APP_ROOT, "src/main/main.ts"),
    "utf8",
  );
  assert(
    mainSource.includes("const MAX_NOTIFICATION_DEBUG_EVENTS = 12000;"),
    "#49 notification debug retention should keep 12000 in-memory events",
  );
  assert(
    mainSource.includes("const DEBUG_LOG_EXPORT_TAIL_LINES = 1500;") &&
      mainSource.includes("const DEBUG_LOG_SUMMARY_TAIL_LINES = 250;"),
    "#50 debug zip export should cap copied logs and summary tails",
  );
  assert(
    mainSource.includes("classifyGroupManagementNotification(payload)") &&
      mainSource.includes("main-process-group-management-activity"),
    "#50 main-process display boundary should keep suppressing shared group-management classifications",
  );
  assert(
    mainSource.includes("getNotificationIconPath") &&
      mainSource.includes("shouldUseNativeMacBundleIcon") &&
      mainSource.includes('return getIconAssetPath("icon-128.png");') &&
      mainSource.includes('getIconAssetPath("icon-128.png") ||') &&
      mainSource.includes('path.join(process.resourcesPath, "icon.icns")') &&
      mainSource.includes(
        'process.platform === "darwin" ? getNotificationIconPath : undefined',
      ),
    "#50 macOS notifications and update dialogs should resolve channel/theme-aware app icons instead of relying on renderer-provided or hard-coded icons",
  );

  const afterPackSource = fs.readFileSync(
    path.join(APP_ROOT, "scripts/after-pack.js"),
    "utf8",
  );
  assert(
    afterPackSource.includes("CFBundleIconFile") &&
      afterPackSource.includes("fs.copyFileSync(legacyAppIconPath") &&
      afterPackSource.includes("isBeta ? ['beta', 'icon.icns']") &&
      afterPackSource.includes("NotificationHelper.app"),
    "#50 macOS notification helper should package the app icon for notification-system surfaces",
  );

  const notificationHandlerSource = fs.readFileSync(
    path.join(APP_ROOT, "src/main/notification-handler.ts"),
    "utf8",
  );
  assert(
    notificationHandlerSource.includes("resolveDefaultIconPath") &&
      notificationHandlerSource.includes("const applyDefaultIcon") &&
      notificationHandlerSource.includes("const applyRendererIcon") &&
      notificationHandlerSource.includes(
        'normalizedData.sourceKind === "messenger-message"',
      ) &&
      notificationHandlerSource.includes("applyRendererIcon();") &&
      notificationHandlerSource.includes("applyDefaultIcon();"),
    "#55 notification handler should prefer contact avatars for Messenger messages while keeping app-icon fallback behavior",
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

  const participationRequestSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "New notification",
      body: "3 people requested to participate for the first time in Nova Scotia Aurora...",
    });
  assertEqual(
    participationRequestSuppressed,
    true,
    "#46 should suppress Facebook participation-request notifications",
  );

  const sharedParticipationRequestSuppressed =
    notificationActivityPolicy.isLikelyGlobalFacebookNotification({
      title: "Facebook User",
      body: "2 people requested membership in a group you're managing",
    });
  assertEqual(
    sharedParticipationRequestSuppressed,
    true,
    "#49 the shared notification activity classifier should suppress group-management membership requests at the final notification boundary",
  );

  const personTitleJoinRequestSuppressed =
    notificationActivityPolicy.isLikelyGlobalFacebookNotification({
      title: "Taylor",
      body: "Taylor requested to join this group you're managing",
    });
  assertEqual(
    personTitleJoinRequestSuppressed,
    true,
    "#49 the shared notification activity classifier should suppress person-titled group join requests",
  );

  const personTitleParticipationRequestSuppressed =
    notificationActivityPolicy.isLikelyGlobalFacebookNotification({
      title: "Person A",
      body: "3 people requested to participate for the first time in a group you're managing",
    });
  assertEqual(
    personTitleParticipationRequestSuppressed,
    true,
    "#49 the shared notification activity classifier should suppress participation-request activity even when the title looks like a person",
  );

  const firstTimePostAdminActivitySuppressed =
    notificationActivityPolicy.isLikelyGlobalFacebookNotification({
      title: "User A",
      body: "User A wants to post for the first time in Example Group. Review their post.",
    });
  assertEqual(
    firstTimePostAdminActivitySuppressed,
    true,
    "#50 the shared notification activity classifier should suppress first-time-post admin review notifications",
  );

  const adminMediaPlaceholderSuppressed =
    notificationActivityPolicy.isLikelyGlobalFacebookNotification({
      title: "User A (Admin) sent a photo.",
      body: "New message",
    });
  assertEqual(
    adminMediaPlaceholderSuppressed,
    true,
    "#50 the shared notification activity classifier should suppress admin media placeholders from group activity replays",
  );

  const moderatorMediaPlaceholderSuppressed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "User A (Moderator) sent a video.",
      body: "New message",
    });
  assertEqual(
    moderatorMediaPlaceholderSuppressed.suppress,
    true,
    "#50 browser-originated moderator media placeholders should be suppressed before display",
  );
  assertEqual(
    moderatorMediaPlaceholderSuppressed.reason,
    "group-management-activity",
    "#50 admin/moderator media placeholders should use the shared group-management classifier",
  );

  const adminMediaRealBodyAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "User A (Admin)",
      body: "Here's the photo from rehearsal",
    });
  assertEqual(
    adminMediaRealBodyAllowed.suppress,
    false,
    "#50 ordinary chats from an admin-titled sender with a real body should remain deliverable",
  );

  const firstTimePostAdminMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "User A",
        body: "User A wants to post for the first time in Example Group. Review their post.",
      },
      [
        {
          href: "/t/example-group-admin-queue",
          title: "Example Group",
          body: "User A wants to post for the first time in Example Group. Review their post.",
          searchText:
            "Group conversation Example Group User A wants to post for the first time in Example Group. Review their post.",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    firstTimePostAdminMatch.ambiguous,
    false,
    "#50 first-time-post admin review payload can still earn Messenger thread proof",
  );
  assertEqual(
    firstTimePostAdminMatch.matchedHref,
    "/t/example-group-admin-queue",
    "#50 first-time-post admin review payload should demonstrate the proven-thread leak path",
  );
  assert(
    firstTimePostAdminMatch.confidence > 0.55,
    "#50 first-time-post admin review payload should match the sidebar row strongly enough to require activity-policy suppression",
  );

  const firstTimePostAdminProof =
    notificationDecisionPolicy.evaluateMessengerMessageProof(
      {
        title: "User A",
        body: "User A wants to post for the first time in Example Group. Review their post.",
      },
      {
        href: "/t/example-group-admin-queue",
        title: "Example Group",
        body: "User A wants to post for the first time in Example Group. Review their post.",
        searchText:
          "Group conversation Example Group User A wants to post for the first time in Example Group. Review their post.",
        muted: false,
        unread: true,
      },
    );
  assertEqual(
    firstTimePostAdminProof.allow,
    false,
    "#50 group-thread proof should not promote admin review rows that lack chat-message structure",
  );
  assertEqual(
    firstTimePostAdminProof.reason,
    "group-row-non-message-shape",
    "#50 rejected group-thread proof should explain the non-message row shape",
  );

  const groupSenderBodyProof =
    notificationDecisionPolicy.evaluateMessengerMessageProof(
      {
        title: "Project Group",
        body: "User A: Can you review this when you get a minute?",
      },
      {
        href: "/t/group-sender-body",
        title: "Project Group",
        body: "User A: Can you review this when you get a minute?",
        searchText: "Group conversation Project Group",
        muted: false,
        unread: true,
      },
    );
  assertEqual(
    groupSenderBodyProof.allow,
    true,
    "#50 group-thread proof should still allow sender-prefixed chat bodies",
  );
  assertEqual(
    groupSenderBodyProof.reason,
    "group-sender-body",
    "#50 sender-prefixed group chat bodies should record structural proof",
  );

  const groupSenderActionProof =
    notificationDecisionPolicy.evaluateMessengerMessageProof(
      {
        title: "User A",
        body: "sent a message",
      },
      {
        href: "/t/group-sender-action",
        title: "Project Group",
        body: "User A sent a message",
        searchText: "Group conversation Project Group User A sent a message",
        muted: false,
        unread: true,
      },
    );
  assertEqual(
    groupSenderActionProof.allow,
    true,
    "#50 group-thread proof should still allow sender-action message previews",
  );
  assertEqual(
    groupSenderActionProof.reason,
    "group-sender-action",
    "#50 sender-action group previews should record structural proof",
  );

  const browserGroupAdminSuppression =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "New notification",
      body: "2 people requested membership in a group you're managing",
    });
  assertEqual(
    browserGroupAdminSuppression.suppress,
    true,
    "#50 browser-originated group/admin notifications should be suppressed before service-worker display",
  );
  assertEqual(
    browserGroupAdminSuppression.reason,
    "group-management-activity",
    "#50 browser-originated group/admin suppression should use the shared group-management classifier",
  );

  const browserFirstTimePostAdminSuppression =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "User A",
      body: "User A wants to post for the first time in Example Group. Review their post.",
    });
  assertEqual(
    browserFirstTimePostAdminSuppression.suppress,
    true,
    "#50 browser-originated first-time-post admin notifications should be suppressed before service-worker display",
  );
  assertEqual(
    browserFirstTimePostAdminSuppression.reason,
    "group-management-activity",
    "#50 first-time-post admin suppression should use the shared group-management classifier",
  );

  const browserCallHistorySuppression =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Messenger",
      body: "You called account A",
    });
  assertEqual(
    browserCallHistorySuppression.suppress,
    true,
    "#50 browser-originated post-call history notifications should stay suppressed",
  );
  assertEqual(
    browserCallHistorySuppression.reason,
    "call-history-activity",
    "#50 browser-originated post-call history suppression should use the shared call classifier",
  );

  const browserMessageAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Account A",
      body: "Can you review this?",
    });
  assertEqual(
    browserMessageAllowed.suppress,
    false,
    "#50 ordinary browser-originated message notifications should remain deliverable",
  );

  const ordinaryPostIntentChatAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Account A",
      body: "I want to post this later after you review it.",
    });
  assertEqual(
    ordinaryPostIntentChatAllowed.suppress,
    false,
    "#50 ordinary direct chat text about posting should remain deliverable without first-time admin review wording",
  );

  const socialAnswerActivitySuppressed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "New notification",
      body: "Someone liked your answer to their question",
    });
  assertEqual(
    socialAnswerActivitySuppressed.suppress,
    true,
    "#50 browser-originated answer-like social activity should be suppressed",
  );
  assertEqual(
    socialAnswerActivitySuppressed.reason,
    "global-facebook-activity",
    "#50 answer-like social activity suppression should be classified as global Facebook activity",
  );

  const nonShellSocialAnswerActivitySuppressed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Group activity",
      body: "Someone liked your answer to their question",
    });
  assertEqual(
    nonShellSocialAnswerActivitySuppressed.suppress,
    true,
    "#50 generic someone-liked answer activity should be suppressed even when Facebook uses a group-like title",
  );

  const ordinarySomeoneAnswerChatAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Account A",
      body: "Someone liked your answer to their question",
    });
  assertEqual(
    ordinarySomeoneAnswerChatAllowed.suppress,
    false,
    "#50 sender-titled ordinary chat text matching the answer-like social activity phrase should not be suppressed",
  );

  const ordinaryAnswerChatAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Account A",
      body: "I liked your answer to their question",
    });
  assertEqual(
    ordinaryAnswerChatAllowed.suppress,
    false,
    "#50 ordinary chat text that mentions liking an answer should not be suppressed",
  );

  const quotedAnswerChatAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Group chat",
      body: "Someone said: liked your answer to their question",
    });
  assertEqual(
    quotedAnswerChatAllowed.suppress,
    false,
    "#50 quoted group chat text resembling social activity should remain deliverable",
  );

  const browserGroupPostActivitySuppressed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Community Group",
      body: "User A posted in Community Group",
    });
  assertEqual(
    browserGroupPostActivitySuppressed.suppress,
    true,
    "#50 browser-originated group feed posts should be suppressed even when Facebook uses the group name as the title",
  );
  assertEqual(
    browserGroupPostActivitySuppressed.reason,
    "global-facebook-activity",
    "#50 browser-originated group feed post suppression should be classified as global Facebook activity",
  );

  const browserGroupCommentActivitySuppressed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Community Group",
      body: "User B commented on a post in Community Group",
    });
  assertEqual(
    browserGroupCommentActivitySuppressed.suppress,
    true,
    "#50 browser-originated group feed comments should be suppressed with group-name titles",
  );

  const ordinaryPostedInChatAllowed =
    notificationDecisionPolicy.shouldSuppressBrowserNotificationActivity({
      title: "Account A",
      body: "I posted in the group chat earlier",
    });
  assertEqual(
    ordinaryPostedInChatAllowed.suppress,
    false,
    "#50 first-person chat text mentioning posted in should remain deliverable",
  );

  const resumeBoundaryCapturesFreshUnread =
    typeof notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary ===
      "function" &&
    notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary("resume");
  assertEqual(
    resumeBoundaryCapturesFreshUnread,
    true,
    "#49 wake/resume boundaries should snapshot fresh unread rows so delayed stale replays cannot surface as new notifications",
  );

  const unlockBoundaryCapturesFreshUnread =
    typeof notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary ===
      "function" &&
    notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary(
      "unlock-screen",
    );
  assertEqual(
    unlockBoundaryCapturesFreshUnread,
    true,
    "#49 unlock boundaries should snapshot fresh unread rows so sleep/wake approval leaks fail closed",
  );

  const navigationBoundaryCapturesFreshUnread =
    typeof notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary ===
      "function" &&
    notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary(
      "navigation",
    );
  assertEqual(
    navigationBoundaryCapturesFreshUnread,
    false,
    "#49 ordinary navigation settling should not broaden into wake-style unread snapshotting",
  );

  const onlineRecoveryBoundaryCapturesFreshUnread =
    typeof notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary ===
      "function" &&
    notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary(
      "online-recovery",
    );
  assertEqual(
    onlineRecoveryBoundaryCapturesFreshUnread,
    true,
    "#49 online recovery should snapshot fresh unread rows so stale admin replays after reconnect fail closed like wake/resume",
  );

  const simulateNativeWakeBoundaryDecision = (input: {
    reason: string;
    existingUnreadRows: Array<{
      href: string;
      title: string;
      body: string;
      muted: boolean;
      unread: boolean;
      searchText?: string;
    }>;
    replayPayload: { title: string; body: string };
    replayRow: {
      href: string;
      title: string;
      body: string;
      muted: boolean;
      unread: boolean;
      searchText?: string;
    };
  }) => {
    const classifySuppressionClass = (payload: {
      title: string;
      body: string;
    }) => {
      const callClassification =
        notificationDecisionPolicy.classifyCallNotification(payload);
      if (callClassification.shouldSuppressNotification) {
        return "call-history";
      }
      if (
        notificationDecisionPolicy.isLikelyGlobalFacebookNotification(payload)
      ) {
        return "global-activity";
      }
      return "message";
    };
    const snapshotFresh =
      typeof notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary ===
        "function" &&
      notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary(
        input.reason,
      );
    const recordedState = new Map<
      string,
      {
        body: string;
        suppressionClass: "message" | "global-activity" | "call-history";
      }
    >();
    if (snapshotFresh) {
      for (const row of input.existingUnreadRows) {
        recordedState.set(row.href, {
          body: row.body,
          suppressionClass: classifySuppressionClass({
            title: row.title,
            body: row.body,
          }),
        });
      }
    }

    const match = notificationDecisionPolicy.resolveNativeNotificationTarget(
      input.replayPayload,
      [input.replayRow],
    );
    const replaySuppressionClass =
      classifySuppressionClass(input.replayPayload) === "message"
        ? classifySuppressionClass({
            title: input.replayRow.title,
            body: input.replayRow.body,
          })
        : classifySuppressionClass(input.replayPayload);
    const replayLooksGlobalActivity =
      notificationDecisionPolicy.isLikelyGlobalFacebookNotification(
        input.replayPayload,
      ) ||
      notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
        title: input.replayRow.title,
        body: input.replayRow.body,
      });
    const preExistingReplaySuppressed = Boolean(
      match.matchedHref &&
      (() => {
        const existing = recordedState.get(match.matchedHref!);
        return Boolean(
          existing &&
          (existing.body === input.replayRow.body ||
            (existing.suppressionClass !== "message" &&
              existing.suppressionClass === replaySuppressionClass)),
        );
      })(),
    );
    const shouldNotify =
      !match.ambiguous &&
      !match.muted &&
      Boolean(match.matchedHref) &&
      !replayLooksGlobalActivity &&
      !preExistingReplaySuppressed;

    return {
      match,
      snapshotFresh,
      replayLooksGlobalActivity,
      preExistingReplaySuppressed,
      shouldNotify,
    };
  };

  const wakeReplayFixture = loadFixtureJson<{
    cases: Array<{
      name: string;
      reason: string;
      existingUnreadRows: Array<{
        href: string;
        title: string;
        body: string;
        muted: boolean;
        unread: boolean;
        searchText?: string;
      }>;
      replayPayload: { title: string; body: string };
      replayRow: {
        href: string;
        title: string;
        body: string;
        muted: boolean;
        unread: boolean;
        searchText?: string;
      };
      expect: {
        snapshotFresh: boolean;
        replayLooksGlobalActivity: boolean;
        preExistingReplaySuppressed: boolean;
        shouldNotify: boolean;
      };
    }>;
  }>("fixtures/issue49/notification-wake-replay.json");
  const wakeReplayResults = wakeReplayFixture.cases.map((testCase) => ({
    name: testCase.name,
    actual: (() => {
      const result = simulateNativeWakeBoundaryDecision(testCase);
      return {
        snapshotFresh: result.snapshotFresh,
        replayLooksGlobalActivity: result.replayLooksGlobalActivity,
        preExistingReplaySuppressed: result.preExistingReplaySuppressed,
        shouldNotify: result.shouldNotify,
      };
    })(),
    expected: testCase.expect,
  }));
  assertEqual(
    JSON.stringify(wakeReplayResults.map((result) => result.actual)),
    JSON.stringify(wakeReplayResults.map((result) => result.expected)),
    "#49 the local wake/resume fixture replay should fail closed for stale approval/admin rows while still allowing real fresh direct messages",
  );

  const membershipRequestSuppressed =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: "Taylor",
      body: "Membership request pending in a group you're managing",
    });
  assertEqual(
    membershipRequestSuppressed,
    true,
    "#49 the preload notification policy should suppress membership-request activity with person-like titles",
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
      title: "Person B",
      body: "You: selfnotif test",
    });
  assertEqual(
    selfAuthoredTextMessage,
    true,
    "#41 should suppress self-authored text previews",
  );

  const selfAuthoredAttachmentMessage =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Person B",
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
      title: "Person B",
      body: "Can you review this?",
    });
  assertEqual(
    incomingMessagePreview,
    false,
    "#41 should not suppress incoming previews",
  );

  const selfAuthoredEditedMessage =
    notificationDecisionPolicy.isLikelySelfAuthoredMessagePreview({
      title: "Person B",
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
        title: "Person B",
        body: "You: selfnotif test",
      },
      {
        title: "Person B",
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
        title: "Person B",
        body: "Can you review this?",
      },
      {
        title: "Person B",
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
      body: "Person A is calling you",
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
      body: "Person A is calling you",
    });
  assertEqual(
    incomingCallNotSuppressed,
    false,
    "#46 should not globally suppress incoming call notifications",
  );

  const calledYouClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Amanda",
      body: "Amanda called you",
    });
  assertEqual(
    calledYouClassifier.shouldSuppressNotification,
    true,
    "#50 call classifier should suppress connected-call history rows such as X called you",
  );

  const youCalledClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Amanda",
      body: "You called Amanda",
    });
  assertEqual(
    youCalledClassifier.shouldSuppressNotification,
    true,
    "#50 call classifier should suppress self-authored connected-call history rows",
  );

  const ordinaryMessageClassifier =
    notificationDecisionPolicy.classifyCallNotification({
      title: "Amanda",
      body: "Can you call me later?",
    });
  assertEqual(
    ordinaryMessageClassifier.shouldSuppressNotification,
    false,
    "#50 call classifier should not suppress ordinary messages that mention calls",
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
  const notificationTextPolicy = loadNotificationTextPolicy();
  const { resolveNotificationDisplayBoundary, NotificationHandler } =
    loadNotificationHandler();
  assert(
    typeof notificationDisplayPolicy.formatNotificationDisplayTitle ===
      "function",
    "notification display policy missing formatNotificationDisplayTitle",
  );
  assert(
    typeof notificationTextPolicy.normalizeNotificationImageAltText ===
      "function",
    "notification text policy missing normalizeNotificationImageAltText",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Bub",
      alternateNames: ["Robert"],
    }),
    "Bub",
    "#50 notification titles should preserve Facebook's provided title without adding inferred names",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Weekend Plans",
      alternateNames: ["Person Alpha", "Taylor", "Casey"],
    }),
    "Weekend Plans",
    "#50 group notification titles should not append inferred participant names",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Person A",
      alternateNames: ["Facebook User", "Person A", "Person Alpha"],
    }),
    "Person A",
    "#50 notification title pass-through should ignore alternate-name metadata",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Person A",
      alternateNames: ["🤦🏻‍♀️"],
    }),
    "Person A",
    "#50 notification title pass-through should ignore emoji-only alternate names",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Person A",
      alternateNames: ["✨", "Taylor", "🤦🏻‍♀️"],
    }),
    "Person A",
    "#50 notification title pass-through should ignore decorative and valid alternate names alike",
  );

  assertEqual(
    notificationDisplayPolicy.formatNotificationDisplayTitle({
      title: "Person A",
      alternateNames: ["Profile picture", "Taylor"],
    }),
    "Person A",
    "#50 notification title pass-through should ignore avatar-derived alternate names",
  );

  assertEqual(
    notificationTextPolicy.normalizeNotificationImageAltText(
      "Icon for this message",
    ),
    "",
    "#50 notification bodies should drop generic Messenger message-icon alt text",
  );
  assertEqual(
    notificationTextPolicy.normalizeNotificationImageAltText(
      "(Icon for this message)",
    ),
    "",
    "#50 notification bodies should drop parenthesised generic message-icon alt text",
  );
  assertEqual(
    notificationTextPolicy.normalizeNotificationImageAltText("(Y)"),
    "👍",
    "#50 notification body alt cleanup should preserve Messenger thumbs-up emoji aliases",
  );
  assertEqual(
    notificationTextPolicy.normalizeNotificationImageAltText("😂"),
    "😂",
    "#50 notification body alt cleanup should preserve real emoji alt text",
  );

  const iconArtefactBoundary = resolveNotificationDisplayBoundary({
    title: "Bub",
    body: "Icon for this message",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    iconArtefactBoundary.normalizedData.body,
    "",
    "#50 display-boundary policy should drop generic Messenger message-icon body text",
  );

  const chatLikeSomeoneAnswerBoundary = resolveNotificationDisplayBoundary({
    title: "Account A",
    body: "Someone liked your answer to their question",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    chatLikeSomeoneAnswerBoundary.suppress,
    false,
    "#50 display boundary should not suppress sender-titled chat text matching answer-like social activity",
  );

  const chatLikeAnswerBoundary = resolveNotificationDisplayBoundary({
    title: "Account A",
    body: "I liked your answer to their question",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    chatLikeAnswerBoundary.suppress,
    false,
    "#50 display boundary should not suppress ordinary chat text resembling answer-like social activity",
  );

  const shellAnswerActivityBoundary = resolveNotificationDisplayBoundary({
    title: "New notification",
    body: "Someone liked your answer to their question",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    shellAnswerActivityBoundary.suppress,
    true,
    "#50 display boundary should suppress shell-titled answer-like Facebook activity",
  );

  const groupActivityCommentBoundary = resolveNotificationDisplayBoundary({
    title: "Group activity",
    body: "Someone liked your comment",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    groupActivityCommentBoundary.suppress,
    true,
    "#50 display boundary should suppress group activity comment-like notifications even with thread-shaped hrefs",
  );

  const facebookGroupFeedBoundary = resolveNotificationDisplayBoundary({
    title: "Facebook group activity",
    body: "Someone posted in a group",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    facebookGroupFeedBoundary.suppress,
    true,
    "#50 display boundary should suppress Facebook group feed activity after reconnect or wake replay",
  );

  const directChatCommentBoundary = resolveNotificationDisplayBoundary({
    title: "Account A",
    body: "Someone liked your comment",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    directChatCommentBoundary.suppress,
    false,
    "#50 display boundary should keep person-titled direct chats that mention comment-like text",
  );

  assertEqual(
    JSON.stringify(
      notificationDisplayPolicy.sanitizeNotificationNameCache(
        {
          threadA: {
            realNames: ["🤦🏻‍♀️", "Taylor", "✨", "Profile picture"],
            updatedAt: 123,
          },
          threadB: {
            realName: "🤦🏻‍♀️",
            updatedAt: 456,
          },
        },
        999,
      ),
    ),
    JSON.stringify({
      threadA: {
        realNames: ["Taylor"],
        updatedAt: 123,
      },
    }),
    "#49 notification name-cache cleanup should prune emoji-only, decorative, and placeholder avatar alternates from persisted entries while preserving valid names",
  );

  assertEqual(
    JSON.stringify(
      notificationDisplayPolicy.sanitizeNotificationNameCache(
        {
          threadA: {
            realName: "Robert",
          },
        },
        999,
      ),
    ),
    JSON.stringify({
      threadA: {
        realNames: ["Robert"],
        updatedAt: 999,
      },
    }),
    "#49 notification name-cache cleanup should migrate legacy single-name entries and supply fallback timestamps",
  );

  const fakeNotifications: any[] = [];
  class FakeNotification extends EventEmitter {
    options: Record<string, unknown>;
    closeCount = 0;
    showCount = 0;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      fakeNotifications.push(this);
    }
    show() {
      this.showCount += 1;
      this.emit("show");
    }
    close() {
      this.closeCount += 1;
      this.emit("close");
    }
  }
  const handler = new NotificationHandler(
    () => null,
    "Messenger",
    (options: Record<string, unknown>) => new FakeNotification(options) as any,
  );
  const firstFake = new FakeNotification({ title: "Account A" });
  const secondFake = new FakeNotification({ title: "Account B" });
  (handler as any).activeNotifications.set("first", {
    notification: firstFake,
    key: "first",
    title: "Account A",
    body: "First message",
    href: "/t/1",
    createdAt: Date.now() - 60_000,
    isIncomingCall: false,
  });
  const incomingFake = new FakeNotification({ title: "Messenger" });
  (handler as any).activeNotifications.set("second", {
    notification: secondFake,
    key: "second",
    title: "Account B",
    body: "Second message",
    href: "/t/2",
    createdAt: Date.now() - 500,
    isIncomingCall: false,
  });
  (handler as any).activeNotifications.set("incoming-call", {
    notification: incomingFake,
    key: "incoming-call",
    title: "Messenger",
    body: "Account C is calling you on Messenger",
    href: undefined,
    createdAt: Date.now() - 100,
    isIncomingCall: true,
  });
  const cleanupSummary = handler.closeActiveNotifications("test-wake", {
    minAgeMs: 30_000,
  });
  assertEqual(
    cleanupSummary.activeBefore,
    3,
    "#50 wake notification cleanup should report active notifications before closing",
  );
  assertEqual(
    cleanupSummary.closedCount,
    1,
    "#50 wake notification cleanup should close only stale app-created active notifications",
  );
  assertEqual(
    cleanupSummary.activeAfter,
    2,
    "#50 wake notification cleanup should preserve fresh and incoming-call notification records",
  );
  assertEqual(
    firstFake.closeCount === 1 &&
      secondFake.closeCount === 0 &&
      incomingFake.closeCount === 0,
    true,
    "#50 wake notification cleanup should close stale non-call notifications while preserving fresh messages and incoming calls",
  );

  const calledYouBoundary = resolveNotificationDisplayBoundary({
    title: "Amanda",
    body: "Amanda called you",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    calledYouBoundary.suppress,
    true,
    "#50 display-boundary policy should suppress connected-call history notifications",
  );

  const groupAdminBoundary = resolveNotificationDisplayBoundary({
    title: "New notification",
    body: "3 people requested to participate for the first time in a group you're managing",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    groupAdminBoundary.suppress,
    true,
    "#50 display-boundary policy should suppress group-admin participation request notifications",
  );

  const firstTimePostAdminBoundary = resolveNotificationDisplayBoundary({
    title: "User A",
    body: "User A wants to post for the first time in Example Group. Review their post.",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    firstTimePostAdminBoundary.suppress,
    true,
    "#50 display-boundary policy should suppress first-time-post admin review notifications even after Messenger thread proof",
  );

  const personTitledGroupAdminBoundary = resolveNotificationDisplayBoundary({
    title: "Taylor",
    body: "Taylor requested to join this group you're managing",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    personTitledGroupAdminBoundary.suppress,
    true,
    "#50 display-boundary policy should suppress person-titled group-admin request notifications",
  );

  const callEndedBoundary = resolveNotificationDisplayBoundary({
    title: "Messenger",
    body: "Call ended",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    callEndedBoundary.suppress,
    true,
    "#50 display-boundary policy should suppress call ended status notifications",
  );

  const incomingCallBoundary = resolveNotificationDisplayBoundary({
    title: "Incoming call",
    body: "Amanda Goodwin is calling you on Messenger",
    sourceKind: "incoming-call",
    sourceLabel: "test-incoming-call",
    provenanceReason: "test-call-proof",
  });
  assertEqual(
    incomingCallBoundary.suppress,
    false,
    "#50 display-boundary policy should keep genuine incoming-call notifications",
  );

  const untypedBoundary = resolveNotificationDisplayBoundary({
    title: "Account A",
    body: "New message",
    href: "/t/test",
  } as any);
  assertEqual(
    untypedBoundary.suppress,
    true,
    "provenance contract should suppress untyped notification display paths",
  );
  assertEqual(
    untypedBoundary.reason,
    "display-boundary-missing-source-kind",
    "provenance contract should report missing source kind",
  );

  const unprovenFacebookBoundary = resolveNotificationDisplayBoundary({
    title: "Account A",
    body: "New message",
    sourceKind: "facebook",
    sourceLabel: "test-unproven-facebook",
    provenanceReason: "raw-facebook-notification",
    href: "/t/test",
  });
  assertEqual(
    unprovenFacebookBoundary.suppress,
    true,
    "raw Facebook notification sources should fail closed without Messenger proof",
  );

  const appOwnedBoundary = resolveNotificationDisplayBoundary({
    title: "Download Complete",
    body: "Saved to Downloads: file.jpg",
    sourceKind: "app-owned",
    sourceLabel: "test-download-complete",
    provenanceReason: "test-app-owned",
    silent: true,
  });
  assertEqual(
    appOwnedBoundary.suppress,
    false,
    "app-owned notifications should bypass Facebook provenance suppression",
  );

  const messengerMessageBoundary = resolveNotificationDisplayBoundary({
    title: "Account A",
    body: "New message",
    sourceKind: "messenger-message",
    sourceLabel: "test-message",
    provenanceReason: "test-thread-proof",
    href: "/t/test",
  });
  assertEqual(
    messengerMessageBoundary.suppress,
    false,
    "proven Messenger message notifications should remain displayable",
  );

  const notificationInjectSource = fs.readFileSync(
    path.join(APP_ROOT, "src/preload/notifications-inject.ts"),
    "utf8",
  );
  assert(
    notificationInjectSource.includes(
      'sendNotification(\n          String(title),\n          String(body),\n          "NATIVE"',
    ),
    "#50 native Facebook notifications should pass title/body through without sidebar-derived title rewriting",
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
  runMessengerThreadSubviewPolicyTests();
  runWindowOpenRoutingTests();
  runDebugZipExportTests();
  runMediaOverlayPolicyTests();
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
