const path = require("path");
const { chromium } = require("playwright");

const APP_ROOT = process.env.MESSENGER_APP_ROOT
  ? path.resolve(process.env.MESSENGER_APP_ROOT)
  : path.resolve(__dirname, "..");

const {
  resolveMarketplaceVisualSessionDecision,
} = require(path.join(APP_ROOT, "src/preload/marketplace-thread-policy.ts"));
const notificationDecisionPolicy = require(path.join(
  APP_ROOT,
  "src/preload/notification-decision-policy.ts",
));

const assertEqual = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
};

const MARKETPLACE_SESSION_DOM_GRACE_MS = 2500;
const MARKETPLACE_ROUTE_CHANGE_RESCUE_MS = 1800;
const MARKETPLACE_RECENT_CONTINUITY_GRACE_MS = 10000;

const viewportStyle = `
  html, body {
    margin: 0;
    padding: 0;
    width: 800px;
    height: 600px;
    overflow: hidden;
    position: relative;
    font-family: Arial, sans-serif;
  }
  #app {
    position: relative;
    width: 800px;
    height: 600px;
  }
  .box {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid transparent;
  }
  .label {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    white-space: nowrap;
  }
`;

const marketplaceHtml = (variant: string) => {
  if (variant === "confirmed") {
    return `<!doctype html><html><head><style>${viewportStyle}</style></head><body><div id="app">
      <div class="box header-container" style="left:12px; top:62px; width:187px; height:44px;">
        <button class="box back" aria-label="Back" title="Back" style="left:0; top:4px; width:40px; height:32px;"><span class="label">Back</span></button>
        <div class="box marketplace-label" aria-label="Marketplace" title="Marketplace" style="left:40px; top:8px; width:147px; height:29px;"><span class="label">Marketplace</span></div>
      </div>
      <button class="box ordinary" aria-label="Conversation information" title="Conversation information" style="left:620px; top:80px; width:120px; height:30px;"><span class="label">Conversation information</span></button>
    </div></body></html>`;
  }

  if (variant === "ordinary-route") {
    return `<!doctype html><html><head><style>${viewportStyle}</style></head><body><div id="app">
      <button class="box ordinary" aria-label="Conversation information" title="Conversation information" style="left:620px; top:80px; width:120px; height:30px;"><span class="label">Conversation information</span></button>
    </div></body></html>`;
  }

  if (variant === "late-weak-candidate") {
    return `<!doctype html><html><head><style>${viewportStyle}</style></head><body><div id="app">
      <div class="box weak-container" style="left:168px; top:70px; width:147px; height:29px;">
        <div class="box marketplace-label" aria-label="Marketplace" title="Marketplace" style="left:0; top:0; width:147px; height:29px;"><span class="label">Marketplace</span></div>
      </div>
      <button class="box ordinary" aria-label="Conversation information" title="Conversation information" style="left:620px; top:80px; width:120px; height:30px;"><span class="label">Conversation information</span></button>
    </div></body></html>`;
  }

  if (variant === "late-weak-rescue") {
    return `<!doctype html><html><head><style>${viewportStyle}</style></head><body><div id="app">
      <div class="box weak-container" style="left:83px; top:70px; width:147px; height:29px;">
        <div class="box marketplace-label" aria-label="Marketplace" title="Marketplace" style="left:0; top:0; width:147px; height:29px;"><span class="label">Marketplace</span></div>
      </div>
      <button class="box ordinary" aria-label="Conversation information" title="Conversation information" style="left:620px; top:80px; width:120px; height:30px;"><span class="label">Conversation information</span></button>
    </div></body></html>`;
  }

  throw new Error(`Unknown marketplace fixture: ${variant}`);
};

const notificationHtml = (rows: Array<{
  href: string;
  title: string;
  body: string;
  unread: boolean;
}>) => `<!doctype html><html><body>
  <div role="navigation">
    <div role="grid" aria-label="Chats">
      ${rows
        .map(
          (row) => `
        <div role="row" aria-label="${row.unread ? "Unread message: " : ""}${row.title}">
          <a href="${row.href}" role="link">Open</a>
          <div dir="auto">${row.title}</div>
          <div dir="auto">${row.body}</div>
          ${row.unread ? '<button aria-label="Mark as read">Read</button>' : ""}
        </div>`,
        )
        .join("\n")}
    </div>
  </div>
</body></html>`;

const extractMarketplaceSignals = async (page: any) =>
  page.evaluate(() => {
    const toBand = (rect: DOMRect | null) => {
      if (!rect) return null;
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      };
    };

    const back = document.querySelector(".back") as HTMLElement | null;
    const strongContainer = document.querySelector(
      ".header-container",
    ) as HTMLElement | null;
    const weakContainer = document.querySelector(
      ".weak-container, .header-container .marketplace-label",
    ) as HTMLElement | null;
    const ordinary = Array.from(document.querySelectorAll("button, [aria-label], [title]")).some(
      (node) => {
        const text = [
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          (node.textContent || "").trim(),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return /conversation information|chat info|details|info/.test(text);
      },
    );

    return {
      headerBackDetected: Boolean(back),
      headerBackMarketplaceDetected: Boolean(back && strongContainer),
      headerOrdinaryChatDetected: ordinary,
      strongHeaderBand: strongContainer ? toBand(strongContainer.getBoundingClientRect()) : null,
      weakHeaderBand: weakContainer ? toBand(weakContainer.getBoundingClientRect()) : null,
    };
  });

const extractNotificationRows = async (page: any) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    return rows.map((row) => {
      const link = row.querySelector('a[href]');
      const texts = Array.from(row.querySelectorAll('[dir="auto"]')).map((el) =>
        (el.textContent || "").trim(),
      );
      return {
        href: link?.getAttribute("href") || "",
        title: texts[0] || "",
        body: texts[1] || "",
        muted: false,
        unread: Boolean(row.querySelector('[aria-label*="Mark as read" i]')),
      };
    });
  });

const simulateWakeDecision = (input: {
  reason: string;
  existingUnreadRows: Array<{
    href: string;
    title: string;
    body: string;
    muted: boolean;
    unread: boolean;
  }>;
  replayPayload: { title: string; body: string };
  replayRow: {
    href: string;
    title: string;
    body: string;
    muted: boolean;
    unread: boolean;
  };
}) => {
  const snapshotFresh =
    typeof notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary ===
      "function" &&
    notificationDecisionPolicy.shouldSnapshotFreshUnreadOnBoundary(input.reason);
  const recordedBodies = new Map<string, string>();
  if (snapshotFresh) {
    for (const row of input.existingUnreadRows) {
      recordedBodies.set(row.href, row.body);
    }
  }

  const match = notificationDecisionPolicy.resolveNativeNotificationTarget(
    input.replayPayload,
    [input.replayRow],
  );
  const replayLooksGlobalActivity =
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification(input.replayPayload) ||
    notificationDecisionPolicy.isLikelyGlobalFacebookNotification({
      title: input.replayRow.title,
      body: input.replayRow.body,
    });
  const preExistingReplaySuppressed = Boolean(
    match.matchedHref && recordedBodies.get(match.matchedHref) === input.replayRow.body,
  );

  return {
    snapshotFresh,
    replayLooksGlobalActivity,
    preExistingReplaySuppressed,
    shouldNotify:
      !match.ambiguous &&
      !match.muted &&
      Boolean(match.matchedHref) &&
      !replayLooksGlobalActivity &&
      !preExistingReplaySuppressed,
  };
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  let previousSession = null;

  await page.setContent(marketplaceHtml("confirmed"));
  const confirmedSignals = await extractMarketplaceSignals(page);
  const confirmed = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/e2ee/t/marketplace-thread-A",
    nowMs: 10000,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    strongSignalSource: confirmedSignals.headerBackMarketplaceDetected
      ? "strong-header"
      : null,
    strongVisualCropHeight: 56,
    strongHeaderBand: confirmedSignals.strongHeaderBand,
    weakHeaderBand: confirmedSignals.weakHeaderBand,
    headerBackDetected: confirmedSignals.headerBackDetected,
    explicitOrdinaryChatDetected: false,
  });
  previousSession = confirmed.nextSession;
  assertEqual(
    {
      sessionActive: confirmed.sessionActive,
      transition: confirmed.transition,
      signalSource: confirmed.signalSource,
      lifecycleReason: confirmed.lifecycleReason,
      visualCropHeight: confirmed.visualCropHeight,
    },
    {
      sessionActive: true,
      transition: "strong-confirmed",
      signalSource: "strong-header",
      lifecycleReason: "confirmed-marketplace-thread",
      visualCropHeight: 56,
    },
    "offline marketplace harness failed at strong confirmation",
  );

  await page.setContent(marketplaceHtml("ordinary-route"));
  const ordinarySignals = await extractMarketplaceSignals(page);
  const rescuePending = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/ordinary-chat-B",
    nowMs: 10960,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    previousSession,
    weakHeaderBand: ordinarySignals.weakHeaderBand,
    headerBackDetected: ordinarySignals.headerBackDetected,
    explicitOrdinaryChatDetected: false,
  });
  previousSession = rescuePending.nextSession;
  assertEqual(
    {
      sessionActive: rescuePending.sessionActive,
      transition: rescuePending.transition,
      lifecycleReason: rescuePending.lifecycleReason,
      rescuePending:
        rescuePending.nextSession?.routeChangeRescuePendingUntil !== null,
    },
    {
      sessionActive: true,
      transition: "route-change-rescue-pending",
      lifecycleReason: "route-change-rescue-pending",
      rescuePending: true,
    },
    "offline marketplace harness failed to hold the route-change rescue state",
  );

  await page.setContent(marketplaceHtml("late-weak-candidate"));
  const weakCandidateSignals = await extractMarketplaceSignals(page);
  const stillPending = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/ordinary-chat-B",
    nowMs: 12422,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    previousSession,
    weakHeaderBand: weakCandidateSignals.weakHeaderBand,
    headerBackDetected: weakCandidateSignals.headerBackDetected,
    explicitOrdinaryChatDetected: false,
  });
  previousSession = stillPending.nextSession;
  assertEqual(
    {
      sessionActive: stillPending.sessionActive,
      transition: stillPending.transition,
      signalSource: stillPending.signalSource,
      rescuePending:
        stillPending.nextSession?.routeChangeRescuePendingUntil !== null,
    },
    {
      sessionActive: true,
      transition: "route-change-rescue-pending",
      signalSource: "bridge",
      rescuePending: true,
    },
    "offline marketplace harness failed to keep the first weak candidate pending",
  );

  await page.setContent(marketplaceHtml("late-weak-rescue"));
  const weakRescueSignals = await extractMarketplaceSignals(page);
  const rescued = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/ordinary-chat-B",
    nowMs: 12454,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    previousSession,
    weakHeaderBand: weakRescueSignals.weakHeaderBand,
    headerBackDetected: weakRescueSignals.headerBackDetected,
    explicitOrdinaryChatDetected: false,
  });
  assertEqual(
    {
      sessionActive: rescued.sessionActive,
      transition: rescued.transition,
      signalSource: rescued.signalSource,
      lifecycleReason: rescued.lifecycleReason,
      rescuePending: rescued.nextSession?.routeChangeRescuePendingUntil !== null,
    },
    {
      sessionActive: true,
      transition: "bridged",
      signalSource: "weak-header",
      lifecycleReason: "same-thread-rerender",
      rescuePending: false,
    },
    "offline marketplace harness failed to rescue on the later weak Marketplace header",
  );

  const weakBootstrapConfirmed = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-weak-thread-A",
    nowMs: 13000,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    strongSignalSource: "right-pane-action",
    strongVisualCropHeight: 36,
    isWeakBootstrapConfirmation: true,
  });
  const weakBootstrapRouteBridge = resolveMarketplaceVisualSessionDecision({
    currentRouteKey: "/messages/t/marketplace-weak-thread-B",
    nowMs: 13320,
    graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
    routeChangeRescueMs: MARKETPLACE_ROUTE_CHANGE_RESCUE_MS,
    previousSession: weakBootstrapConfirmed.nextSession,
    pendingBootstrapSignalSource: "right-pane-action",
    pendingBootstrapAllowed: true,
    headerBackDetected: false,
  });
  assertEqual(
    {
      sessionActive: weakBootstrapRouteBridge.sessionActive,
      transition: weakBootstrapRouteBridge.transition,
      signalSource: weakBootstrapRouteBridge.signalSource,
      lifecycleReason: weakBootstrapRouteBridge.lifecycleReason,
      confirmationKind:
        weakBootstrapRouteBridge.nextSession?.confirmationKind ?? null,
      visualCropHeight: weakBootstrapRouteBridge.visualCropHeight,
    },
    {
      sessionActive: true,
      transition: "bridged",
      signalSource: "right-pane-action",
      lifecycleReason: "route-changed",
      confirmationKind: "weak-bootstrap",
      visualCropHeight: 36,
    },
    "offline marketplace harness failed to bridge recent weak-bootstrap continuity across a route change",
  );

  const detachedRecentContinuityBridge =
    resolveMarketplaceVisualSessionDecision({
      currentRouteKey: "/messages/t/marketplace-detoured-thread-E",
      nowMs: 17000,
      graceMs: MARKETPLACE_SESSION_DOM_GRACE_MS,
      recentContinuityGraceMs: MARKETPLACE_RECENT_CONTINUITY_GRACE_MS,
      previousSession: null,
      recentSession: {
        ...confirmed.nextSession,
        routeKey: "/messages/t/marketplace-detoured-thread-B",
        lastMatchedAt: 10150,
      },
      pendingBootstrapSignalSource: "right-pane-action",
      pendingBootstrapAllowed: true,
      headerBackDetected: false,
    });
  assertEqual(
    {
      sessionActive: detachedRecentContinuityBridge.sessionActive,
      transition: detachedRecentContinuityBridge.transition,
      signalSource: detachedRecentContinuityBridge.signalSource,
      lifecycleReason: detachedRecentContinuityBridge.lifecycleReason,
      visualCropHeight: detachedRecentContinuityBridge.visualCropHeight,
    },
    {
      sessionActive: true,
      transition: "bridged",
      signalSource: "right-pane-action",
      lifecycleReason: "route-changed",
      visualCropHeight: 56,
    },
    "offline marketplace harness failed to bridge a detoured Marketplace re-entry from recent continuity",
  );

  await page.setContent(
    notificationHtml([
      {
        href: "/t/group-admin-queue",
        title: "Account A",
        body: "Membership request pending in a group you're managing",
        unread: true,
      },
    ]),
  );
  const existingUnreadRows = await extractNotificationRows(page);
  const wakeReplaySuppressed = simulateWakeDecision({
    reason: "resume",
    existingUnreadRows,
    replayPayload: {
      title: "Account A",
      body: "Membership request pending in a group you're managing",
    },
    replayRow: existingUnreadRows[0],
  });
  assertEqual(
    wakeReplaySuppressed,
    {
      snapshotFresh: true,
      replayLooksGlobalActivity: true,
      preExistingReplaySuppressed: true,
      shouldNotify: false,
    },
    "offline notification harness failed to suppress a stale wake-time approval replay",
  );

  const onlineRecoveryReplaySuppressed = simulateWakeDecision({
    reason: "online-recovery",
    existingUnreadRows,
    replayPayload: {
      title: "Account A",
      body: "Membership request pending in a group you're managing",
    },
    replayRow: existingUnreadRows[0],
  });
  assertEqual(
    onlineRecoveryReplaySuppressed,
    {
      snapshotFresh: true,
      replayLooksGlobalActivity: true,
      preExistingReplaySuppressed: true,
      shouldNotify: false,
    },
    "offline notification harness failed to suppress a stale admin replay after online recovery",
  );

  await page.setContent(
    notificationHtml([
      {
        href: "/t/direct-thread-B",
        title: "Account B",
        body: "Are you free tonight?",
        unread: true,
      },
    ]),
  );
  const directRows = await extractNotificationRows(page);
  const freshDirectAllowed = simulateWakeDecision({
    reason: "resume",
    existingUnreadRows: [],
    replayPayload: {
      title: "Account B",
      body: "Are you free tonight?",
    },
    replayRow: directRows[0],
  });
  assertEqual(
    freshDirectAllowed,
    {
      snapshotFresh: true,
      replayLooksGlobalActivity: false,
      preExistingReplaySuppressed: false,
      shouldNotify: true,
    },
    "offline notification harness failed to allow a real fresh direct message after wake",
  );

  await browser.close();
  console.log("PASS offline issue #49 DOM harness");
})().catch((error: Error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
