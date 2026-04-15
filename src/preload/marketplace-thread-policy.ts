const MARKETPLACE_THREAD_ACTION_HINT_PATTERN =
  /\b(view similar items|view listing|mark as pending|mark as sold|mark as available|no longer available|send a quick response)\b/i;
const MARKETPLACE_THREAD_HEADER_HINT_PATTERN = /\bmarketplace\b/i;
const MARKETPLACE_THREAD_BACK_HINT_PATTERN =
  /\b(back|go back|back to previous page)\b/i;
const MARKETPLACE_ITEM_URL_HINT_PATTERN =
  /https?:\/\/[^/\s]+\/marketplace\/item\//i;

export type MarketplaceThreadHintSignal =
  | "action"
  | "item-link"
  | "header"
  | "back";

export type MarketplaceThreadHeaderBand = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type MarketplaceSessionSignalSource =
  | "strong-header"
  | "right-pane-action"
  | "item-link"
  | "weak-header"
  | "bridge";

export type MarketplaceSessionConfirmationKind =
  | "strong-header"
  | "weak-bootstrap";

export type MarketplaceSessionLifecycleReason =
  | "confirmed-marketplace-thread"
  | "weak-bootstrap-confirmed"
  | "same-thread-rerender"
  | "ordinary-clear-pending"
  | "route-changed"
  | "route-change-rescue-pending"
  | "explicit-ordinary-chat"
  | "thread-destroyed";

export type MarketplaceVisualSessionTransition =
  | "strong-confirmed"
  | "weak-bootstrap-pending"
  | "weak-bootstrap-confirmed"
  | "ordinary-clear-pending"
  | "route-change-rescue-pending"
  | "bridged"
  | "cleared"
  | "rejected"
  | "inactive";

export type MarketplaceVisualSessionRejectionReason =
  | "weak-bootstrap-startup-settling"
  | "weak-bootstrap-ordinary-chat"
  | "weak-bootstrap-signal-changed"
  | "weak-bootstrap-route-changed";

export type MarketplaceOrdinaryClearBlockedReason =
  | "recent-confirmation"
  | "back-anchor-match"
  | "insufficient-passes"
  | "marketplace-returned";

export type MarketplaceCurrentEvidenceClass =
  | "strong"
  | "weak"
  | "ordinary-only"
  | "none";

export type MarketplaceVisualSessionState = {
  routeKey: string;
  visualCropHeight: number | null;
  headerBand: MarketplaceThreadHeaderBand | null;
  lastConfirmedAt: number;
  lastStrongConfirmedAt: number | null;
  lastMatchedAt: number;
  confirmationKind: MarketplaceSessionConfirmationKind;
  signalSource: MarketplaceSessionSignalSource;
  lifecycleReason: MarketplaceSessionLifecycleReason;
  lastLifecycleAt: number;
  routeChangeRescueStartedAt: number | null;
  routeChangeRescuePendingUntil: number | null;
};

type MarketplaceThreadSignalInput = {
  rightPaneMarketplaceSignalDetected?: boolean;
  rightPaneItemLinkDetected?: boolean;
  headerMarketplaceDetected?: boolean;
  headerBackDetected?: boolean;
  headerBackMarketplaceDetected?: boolean;
};

export type MarketplaceVisualSessionDecision = {
  sessionActive: boolean;
  shouldApplyReducedCrop: boolean;
  visualCropHeight: number | null;
  transition: MarketplaceVisualSessionTransition;
  signalSource: MarketplaceSessionSignalSource | null;
  lifecycleReason: MarketplaceSessionLifecycleReason | null;
  rejectionReason: MarketplaceVisualSessionRejectionReason | null;
  weakHeaderMatchesSessionHeaderBand: boolean;
  nextSession: MarketplaceVisualSessionState | null;
};

export type MarketplaceWeakBootstrapState = {
  routeKey: string;
  signalSource: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  >;
  stablePasses: number;
  firstSeenAt: number;
  lastSeenAt: number;
  visualCropHeight: number | null;
};

export type MarketplaceWeakBootstrapDecision = {
  nextState: MarketplaceWeakBootstrapState | null;
  pendingBootstrapSignalSource: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  pendingBootstrapAllowed: boolean;
  pendingBootstrapRejectedReason: MarketplaceVisualSessionRejectionReason | null;
  confirmedSignalSource: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  stablePasses: number;
  firstSeenAgeMs: number | null;
  confirmationEligible: boolean;
  transition:
    | "inactive"
    | "reset"
    | "rejected"
    | "pending"
    | "confirmed";
};

export type MarketplaceRouteChangePendingBridgeReason =
  | "allowed-right-pane-action-back-detected"
  | "no-pending-bootstrap-signal"
  | "pending-bootstrap-not-allowed"
  | "missing-back-control"
  | "unsupported-signal-source";

export type MarketplaceWeakBootstrapRouteChangeBridgeReason =
  | "allowed-recent-weak-bootstrap-right-pane-action"
  | "not-weak-bootstrap-session"
  | "no-pending-bootstrap-signal"
  | "pending-bootstrap-not-allowed"
  | "unsupported-signal-source";

export function shouldConfirmWeakMarketplaceBootstrap(input: {
  stablePasses: number;
  firstSeenAgeMs: number;
  requiredPasses: number;
  minConfirmAgeMs: number;
}): boolean {
  return (
    Number.isFinite(input.stablePasses) &&
    Number.isFinite(input.firstSeenAgeMs) &&
    input.stablePasses >= input.requiredPasses &&
    input.firstSeenAgeMs >= input.minConfirmAgeMs
  );
}

export function resolveWeakMarketplaceBootstrapDecision(input: {
  routeKey: string;
  nowMs: number;
  weakSignalSource?: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  weakBootstrapSettled: boolean;
  headerOrdinaryChatDetected?: boolean;
  headerBackMarketplaceDetected?: boolean;
  currentMarketplaceSessionActive?: boolean;
  previousState?: MarketplaceWeakBootstrapState | null;
  requiredPasses: number;
  minConfirmAgeMs: number;
  visualCropHeight: number | null;
}): MarketplaceWeakBootstrapDecision {
  if (input.headerBackMarketplaceDetected || input.currentMarketplaceSessionActive) {
    return {
      nextState: null,
      pendingBootstrapSignalSource: null,
      pendingBootstrapAllowed: false,
      pendingBootstrapRejectedReason: null,
      confirmedSignalSource: null,
      stablePasses: 0,
      firstSeenAgeMs: null,
      confirmationEligible: false,
      transition: "reset",
    };
  }

  if (!input.weakSignalSource) {
    return {
      nextState: null,
      pendingBootstrapSignalSource: null,
      pendingBootstrapAllowed: false,
      pendingBootstrapRejectedReason: null,
      confirmedSignalSource: null,
      stablePasses: 0,
      firstSeenAgeMs: null,
      confirmationEligible: false,
      transition: input.previousState ? "reset" : "inactive",
    };
  }

  if (!input.weakBootstrapSettled) {
    return {
      nextState: null,
      pendingBootstrapSignalSource: input.weakSignalSource,
      pendingBootstrapAllowed: false,
      pendingBootstrapRejectedReason: "weak-bootstrap-startup-settling",
      confirmedSignalSource: null,
      stablePasses: 0,
      firstSeenAgeMs: null,
      confirmationEligible: false,
      transition: "rejected",
    };
  }

  if (input.headerOrdinaryChatDetected) {
    return {
      nextState: null,
      pendingBootstrapSignalSource: input.weakSignalSource,
      pendingBootstrapAllowed: false,
      pendingBootstrapRejectedReason: "weak-bootstrap-ordinary-chat",
      confirmedSignalSource: null,
      stablePasses: 0,
      firstSeenAgeMs: null,
      confirmationEligible: false,
      transition: "rejected",
    };
  }

  const firstSeenAt =
    input.previousState &&
    input.previousState.routeKey === input.routeKey &&
    input.previousState.signalSource === input.weakSignalSource
      ? input.previousState.firstSeenAt
      : input.nowMs;
  const stablePasses =
    input.previousState &&
    input.previousState.routeKey === input.routeKey &&
    input.previousState.signalSource === input.weakSignalSource
      ? input.previousState.stablePasses + 1
      : 1;
  const firstSeenAgeMs = Math.max(0, input.nowMs - firstSeenAt);
  const confirmationEligible = shouldConfirmWeakMarketplaceBootstrap({
    stablePasses,
    firstSeenAgeMs,
    requiredPasses: input.requiredPasses,
    minConfirmAgeMs: input.minConfirmAgeMs,
  });

  if (confirmationEligible) {
    return {
      nextState: null,
      pendingBootstrapSignalSource: null,
      pendingBootstrapAllowed: false,
      pendingBootstrapRejectedReason: null,
      confirmedSignalSource: input.weakSignalSource,
      stablePasses,
      firstSeenAgeMs,
      confirmationEligible: true,
      transition: "confirmed",
    };
  }

  return {
    nextState: {
      routeKey: input.routeKey,
      signalSource: input.weakSignalSource,
      stablePasses,
      firstSeenAt,
      lastSeenAt: input.nowMs,
      visualCropHeight: input.visualCropHeight,
    },
    pendingBootstrapSignalSource: input.weakSignalSource,
    pendingBootstrapAllowed: true,
    pendingBootstrapRejectedReason: null,
    confirmedSignalSource: null,
    stablePasses,
    firstSeenAgeMs,
    confirmationEligible: false,
    transition: "pending",
  };
}

export function resolveMarketplaceOrdinaryClearBlockedReason(input: {
  previousSession?: MarketplaceVisualSessionState | null;
  nowMs: number;
  postConfirmGraceMs: number;
  sameRouteMarketplaceBackAnchorDetected?: boolean;
  headerOrdinaryChatDetected?: boolean;
  headerBackMarketplaceDetected?: boolean;
  weakHeaderMatchesSessionHeaderBand?: boolean;
  weakSignalDetected?: boolean;
}): MarketplaceOrdinaryClearBlockedReason | null {
  const previousSession =
    input.previousSession !== null && input.previousSession !== undefined
      ? input.previousSession
      : null;
  if (!previousSession || !input.headerOrdinaryChatDetected) {
    return null;
  }

  if (
    input.headerBackMarketplaceDetected ||
    input.weakHeaderMatchesSessionHeaderBand ||
    input.weakSignalDetected
  ) {
    return null;
  }

  if (input.sameRouteMarketplaceBackAnchorDetected) {
    return "back-anchor-match";
  }

  if (
    previousSession.confirmationKind === "strong-header" &&
    previousSession.lastStrongConfirmedAt !== null &&
    input.nowMs - previousSession.lastStrongConfirmedAt <=
      input.postConfirmGraceMs
  ) {
    return "recent-confirmation";
  }

  return null;
}

export function resolveMarketplaceCurrentEvidenceClass(input: {
  headerBackMarketplaceDetected?: boolean;
  strongSignalSource?:
    | Extract<
        MarketplaceSessionSignalSource,
        "strong-header" | "right-pane-action" | "item-link"
      >
    | null;
  weakHeaderBand?: MarketplaceThreadHeaderBand | null;
  weakSignalDetected?: boolean;
  sameRouteMarketplaceBackAnchorDetected?: boolean;
  headerOrdinaryChatDetected?: boolean;
}): MarketplaceCurrentEvidenceClass {
  if (
    input.headerBackMarketplaceDetected ||
    input.strongSignalSource === "strong-header"
  ) {
    return "strong";
  }

  if (
    input.weakSignalDetected ||
    input.weakHeaderBand ||
    input.sameRouteMarketplaceBackAnchorDetected
  ) {
    return "weak";
  }

  if (input.headerOrdinaryChatDetected) {
    return "ordinary-only";
  }

  return "none";
}

function normalizeHint(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function collectMarketplaceThreadHintSignals(
  value: string | null | undefined,
): MarketplaceThreadHintSignal[] {
  const hint = normalizeHint(value);
  if (!hint) {
    return [];
  }

  const signals: MarketplaceThreadHintSignal[] = [];
  if (MARKETPLACE_THREAD_ACTION_HINT_PATTERN.test(hint)) {
    signals.push("action");
  }
  if (MARKETPLACE_ITEM_URL_HINT_PATTERN.test(hint)) {
    signals.push("item-link");
  }
  if (MARKETPLACE_THREAD_HEADER_HINT_PATTERN.test(hint)) {
    signals.push("header");
  }
  if (MARKETPLACE_THREAD_BACK_HINT_PATTERN.test(hint)) {
    signals.push("back");
  }

  return signals;
}

export function isMarketplaceThreadActionHint(
  value: string | null | undefined,
): boolean {
  return collectMarketplaceThreadHintSignals(value).some(
    (signal) => signal === "action" || signal === "item-link",
  );
}

export function isMarketplaceThreadBackHint(
  value: string | null | undefined,
): boolean {
  return collectMarketplaceThreadHintSignals(value).includes("back");
}

export function isMarketplaceThreadHeaderHint(
  value: string | null | undefined,
): boolean {
  return collectMarketplaceThreadHintSignals(value).includes("header");
}

export function hasMarketplaceThreadHeaderSignal(
  hints: Iterable<string | null | undefined>,
): boolean {
  let hasBack = false;
  let hasMarketplace = false;

  for (const hint of hints) {
    const normalized = normalizeHint(hint);
    if (!normalized) {
      continue;
    }

    if (isMarketplaceThreadBackHint(normalized)) {
      hasBack = true;
    }
    if (isMarketplaceThreadHeaderHint(normalized)) {
      hasMarketplace = true;
    }

    if (hasBack && hasMarketplace) {
      return true;
    }
  }

  return false;
}

export function isMarketplaceThreadUiActive(input: {
  rightPaneMarketplaceSignalDetected?: boolean;
  rightPaneItemLinkDetected?: boolean;
  headerMarketplaceDetected?: boolean;
  headerBackMarketplaceDetected?: boolean;
}): boolean {
  return shouldRetainMarketplaceVisualCrop(input);
}

export function shouldRetainMarketplaceVisualCrop(
  input: MarketplaceThreadSignalInput,
): boolean {
  return (
    input.rightPaneMarketplaceSignalDetected === true ||
    input.rightPaneItemLinkDetected === true ||
    input.headerBackMarketplaceDetected === true
  );
}

function normalizeMarketplaceVisualCropHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

function normalizeMarketplaceThreadHeaderBand(
  band: MarketplaceThreadHeaderBand | null | undefined,
): MarketplaceThreadHeaderBand | null {
  if (!band) {
    return null;
  }

  const top = Math.round(Number(band.top));
  const bottom = Math.round(Number(band.bottom));
  const left = Math.round(Number(band.left));
  const right = Math.round(Number(band.right));
  if (
    !Number.isFinite(top) ||
    !Number.isFinite(bottom) ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    return null;
  }

  if (bottom < top || right < left) {
    return null;
  }

  return {
    top,
    bottom,
    left,
    right,
  };
}

export function doesMarketplaceThreadHeaderBandMatch(input: {
  confirmedHeaderBand?: MarketplaceThreadHeaderBand | null;
  candidateHeaderBand?: MarketplaceThreadHeaderBand | null;
}): boolean {
  const confirmedHeaderBand = normalizeMarketplaceThreadHeaderBand(
    input.confirmedHeaderBand,
  );
  const candidateHeaderBand = normalizeMarketplaceThreadHeaderBand(
    input.candidateHeaderBand,
  );
  if (!confirmedHeaderBand || !candidateHeaderBand) {
    return false;
  }

  const topDiff = Math.abs(candidateHeaderBand.top - confirmedHeaderBand.top);
  const bottomDiff = Math.abs(
    candidateHeaderBand.bottom - confirmedHeaderBand.bottom,
  );
  const leftDiff = Math.abs(candidateHeaderBand.left - confirmedHeaderBand.left);
  const rightDiff = Math.abs(
    candidateHeaderBand.right - confirmedHeaderBand.right,
  );
  const verticalOverlap =
    candidateHeaderBand.bottom >= confirmedHeaderBand.top - 20 &&
    candidateHeaderBand.top <= confirmedHeaderBand.bottom + 20;
  const horizontalOverlap =
    candidateHeaderBand.right >= confirmedHeaderBand.left - 24 &&
    candidateHeaderBand.left <= confirmedHeaderBand.right + 96;
  const relaxedContainedShift =
    verticalOverlap &&
    candidateHeaderBand.left >= confirmedHeaderBand.left &&
    candidateHeaderBand.right <= confirmedHeaderBand.right + 40 &&
    topDiff <= 36 &&
    bottomDiff <= 48 &&
    leftDiff <= 140 &&
    rightDiff <= 180;

  return (
    relaxedContainedShift ||
    (verticalOverlap &&
      horizontalOverlap &&
      topDiff <= 28 &&
      bottomDiff <= 36 &&
      leftDiff <= 32 &&
      rightDiff <= 120)
  );
}

export function doesMarketplaceThreadBackAnchorMatch(input: {
  confirmedHeaderBand?: MarketplaceThreadHeaderBand | null;
  candidateBackBand?: MarketplaceThreadHeaderBand | null;
}): boolean {
  const confirmedHeaderBand = normalizeMarketplaceThreadHeaderBand(
    input.confirmedHeaderBand,
  );
  const candidateBackBand = normalizeMarketplaceThreadHeaderBand(
    input.candidateBackBand,
  );
  if (!confirmedHeaderBand || !candidateBackBand) {
    return false;
  }

  const verticalOverlap =
    candidateBackBand.bottom >= confirmedHeaderBand.top - 20 &&
    candidateBackBand.top <= confirmedHeaderBand.bottom + 20;
  const anchoredNearLeft =
    candidateBackBand.left <= confirmedHeaderBand.left + 140 &&
    candidateBackBand.right >= confirmedHeaderBand.left - 24 &&
    candidateBackBand.right <= confirmedHeaderBand.left + 220;

  return verticalOverlap && anchoredNearLeft;
}

export function doesMarketplaceThreadFreshHeaderPairMatch(input: {
  candidateHeaderBand?: MarketplaceThreadHeaderBand | null;
  candidateBackBand?: MarketplaceThreadHeaderBand | null;
}): boolean {
  const candidateHeaderBand = normalizeMarketplaceThreadHeaderBand(
    input.candidateHeaderBand,
  );
  const candidateBackBand = normalizeMarketplaceThreadHeaderBand(
    input.candidateBackBand,
  );
  if (!candidateHeaderBand || !candidateBackBand) {
    return false;
  }

  const verticalOverlap =
    candidateBackBand.bottom >= candidateHeaderBand.top - 20 &&
    candidateBackBand.top <= candidateHeaderBand.bottom + 20;
  const anchoredNearHeaderLeft =
    candidateBackBand.left <= candidateHeaderBand.left + 24 &&
    candidateBackBand.right >= candidateHeaderBand.left - 48 &&
    candidateBackBand.right <= candidateHeaderBand.left + 120;
  const headerInTopLeftBand =
    candidateHeaderBand.top <= 180 && candidateHeaderBand.left <= 220;

  return verticalOverlap && anchoredNearHeaderLeft && headerInTopLeftBand;
}

export function doesMarketplaceThreadRouteChangeWeakHeaderMatch(input: {
  confirmedHeaderBand?: MarketplaceThreadHeaderBand | null;
  candidateHeaderBand?: MarketplaceThreadHeaderBand | null;
}): boolean {
  const confirmedHeaderBand = normalizeMarketplaceThreadHeaderBand(
    input.confirmedHeaderBand,
  );
  const candidateHeaderBand = normalizeMarketplaceThreadHeaderBand(
    input.candidateHeaderBand,
  );
  if (!confirmedHeaderBand || !candidateHeaderBand) {
    return false;
  }

  const topDiff = Math.abs(candidateHeaderBand.top - confirmedHeaderBand.top);
  const bottomDiff = Math.abs(
    candidateHeaderBand.bottom - confirmedHeaderBand.bottom,
  );
  const verticalOverlap =
    candidateHeaderBand.bottom >= confirmedHeaderBand.top - 20 &&
    candidateHeaderBand.top <= confirmedHeaderBand.bottom + 20;
  const anchoredWithinPreviousHeaderBand =
    candidateHeaderBand.left <= confirmedHeaderBand.left + 96 &&
    candidateHeaderBand.right >= confirmedHeaderBand.left + 40 &&
    candidateHeaderBand.right <= confirmedHeaderBand.right + 48;
  const candidateWidth = candidateHeaderBand.right - candidateHeaderBand.left;
  const headerInTopLeftBand =
    candidateHeaderBand.top <= 180 && candidateHeaderBand.left <= 220;

  return (
    verticalOverlap &&
    anchoredWithinPreviousHeaderBand &&
    candidateWidth >= 100 &&
    topDiff <= 36 &&
    bottomDiff <= 48 &&
    headerInTopLeftBand
  );
}

export function resolvePendingBootstrapRouteChangeBridgeReason(input: {
  pendingBootstrapSignalSource?: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  pendingBootstrapAllowed?: boolean;
  headerBackDetected?: boolean;
}): MarketplaceRouteChangePendingBridgeReason {
  if (!input.pendingBootstrapSignalSource) {
    return "no-pending-bootstrap-signal";
  }
  if (input.pendingBootstrapAllowed !== true) {
    return "pending-bootstrap-not-allowed";
  }
  if (input.headerBackDetected !== true) {
    return "missing-back-control";
  }
  if (input.pendingBootstrapSignalSource !== "right-pane-action") {
    return "unsupported-signal-source";
  }
  return "allowed-right-pane-action-back-detected";
}

function shouldBridgePendingBootstrapOnRouteChange(input: {
  pendingBootstrapSignalSource?: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  pendingBootstrapAllowed?: boolean;
  headerBackDetected?: boolean;
}): boolean {
  return (
    resolvePendingBootstrapRouteChangeBridgeReason(input) ===
    "allowed-right-pane-action-back-detected"
  );
}

export function resolveWeakBootstrapRouteChangeBridgeReason(input: {
  previousSession?: MarketplaceVisualSessionState | null;
  pendingBootstrapSignalSource?: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  pendingBootstrapAllowed?: boolean;
}): MarketplaceWeakBootstrapRouteChangeBridgeReason {
  if (input.previousSession?.confirmationKind !== "weak-bootstrap") {
    return "not-weak-bootstrap-session";
  }
  if (!input.pendingBootstrapSignalSource) {
    return "no-pending-bootstrap-signal";
  }
  if (input.pendingBootstrapAllowed !== true) {
    return "pending-bootstrap-not-allowed";
  }
  if (input.pendingBootstrapSignalSource !== "right-pane-action") {
    return "unsupported-signal-source";
  }
  return "allowed-recent-weak-bootstrap-right-pane-action";
}

function shouldBridgeWeakBootstrapOnRouteChange(input: {
  previousSession?: MarketplaceVisualSessionState | null;
  pendingBootstrapSignalSource?: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  pendingBootstrapAllowed?: boolean;
}): boolean {
  return (
    resolveWeakBootstrapRouteChangeBridgeReason(input) ===
    "allowed-recent-weak-bootstrap-right-pane-action"
  );
}

export function resolveMarketplaceVisualSessionDecision(input: {
  currentRouteKey: string;
  nowMs: number;
  graceMs: number;
  routeChangeRescueMs?: number;
  previousSession?: MarketplaceVisualSessionState | null;
  recentSession?: MarketplaceVisualSessionState | null;
  recentContinuityGraceMs?: number;
  strongSignalSource?:
    | Extract<
        MarketplaceSessionSignalSource,
        "strong-header" | "right-pane-action" | "item-link"
      >
    | null;
  isWeakBootstrapConfirmation?: boolean;
  pendingBootstrapSignalSource?: Extract<
    MarketplaceSessionSignalSource,
    "right-pane-action" | "item-link"
  > | null;
  pendingBootstrapAllowed?: boolean;
  pendingBootstrapRejectedReason?: MarketplaceVisualSessionRejectionReason | null;
  strongVisualCropHeight?: number | null;
  strongHeaderBand?: MarketplaceThreadHeaderBand | null;
  weakHeaderBand?: MarketplaceThreadHeaderBand | null;
  headerBackDetected?: boolean;
  sameRouteMarketplaceBackAnchorDetected?: boolean;
  headerBackMatchesSessionHeaderBand?: boolean;
  explicitOrdinaryChatDetected?: boolean;
  ordinaryClearPending?: boolean;
}): MarketplaceVisualSessionDecision {
  const hadPreviousSession =
    input.previousSession !== null && input.previousSession !== undefined;
  const priorSession = input.previousSession ?? null;
  const routeChanged =
    hadPreviousSession && priorSession?.routeKey !== input.currentRouteKey;
  const previousSession =
    priorSession && priorSession.routeKey === input.currentRouteKey
      ? priorSession
      : null;
  const recentSession =
    !hadPreviousSession &&
    input.recentSession !== null &&
    input.recentSession !== undefined &&
    input.recentSession.routeKey !== input.currentRouteKey
      ? input.recentSession
      : null;
  const routeBridgeSession = routeChanged ? priorSession : recentSession;
  const routeBridgeGraceMs = recentSession
    ? Math.max(
        0,
        Number.isFinite(input.recentContinuityGraceMs)
          ? Math.round(input.recentContinuityGraceMs ?? 0)
          : input.graceMs,
      )
    : input.graceMs;

  const weakHeaderMatchesSessionHeaderBand = doesMarketplaceThreadHeaderBandMatch(
    {
      confirmedHeaderBand: previousSession?.headerBand,
      candidateHeaderBand: input.weakHeaderBand,
    },
  );
  const routeChangeWeakHeaderMatchesPriorSession =
    routeBridgeSession !== null &&
    doesMarketplaceThreadRouteChangeWeakHeaderMatch({
      confirmedHeaderBand: routeBridgeSession.headerBand,
      candidateHeaderBand: input.weakHeaderBand,
    });
  const routeChangeRecentMarketplaceMatch =
    routeBridgeSession !== null &&
    Number.isFinite(routeBridgeSession.lastMatchedAt) &&
    input.nowMs - routeBridgeSession.lastMatchedAt <= routeBridgeGraceMs;
  const recentPendingBootstrapBridgeAllowed =
    recentSession !== null &&
    routeChangeRecentMarketplaceMatch &&
    input.pendingBootstrapAllowed === true &&
    input.pendingBootstrapSignalSource === "right-pane-action";

  if (input.strongSignalSource) {
    const visualCropHeight = normalizeMarketplaceVisualCropHeight(
      input.strongVisualCropHeight ??
        previousSession?.visualCropHeight ??
        priorSession?.visualCropHeight,
    );
    const nextSession: MarketplaceVisualSessionState = {
      routeKey: input.currentRouteKey,
      visualCropHeight,
      headerBand:
        normalizeMarketplaceThreadHeaderBand(input.strongHeaderBand) ??
        previousSession?.headerBand ??
        priorSession?.headerBand ??
        null,
      lastConfirmedAt: input.nowMs,
      lastStrongConfirmedAt: input.isWeakBootstrapConfirmation
        ? previousSession?.lastStrongConfirmedAt ??
          priorSession?.lastStrongConfirmedAt ??
          null
        : input.nowMs,
      lastMatchedAt: input.nowMs,
      confirmationKind: input.isWeakBootstrapConfirmation
        ? "weak-bootstrap"
        : "strong-header",
      signalSource: input.strongSignalSource,
      lifecycleReason: input.isWeakBootstrapConfirmation
        ? "weak-bootstrap-confirmed"
        : "confirmed-marketplace-thread",
      lastLifecycleAt: input.nowMs,
      routeChangeRescueStartedAt: null,
      routeChangeRescuePendingUntil: null,
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: visualCropHeight !== null,
      visualCropHeight,
      transition: input.isWeakBootstrapConfirmation
        ? "weak-bootstrap-confirmed"
        : "strong-confirmed",
      signalSource: input.strongSignalSource,
      lifecycleReason: input.isWeakBootstrapConfirmation
        ? "weak-bootstrap-confirmed"
        : "confirmed-marketplace-thread",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand,
      nextSession,
    };
  }

  if (routeChanged || recentSession) {
    if (routeChangeWeakHeaderMatchesPriorSession && routeChangeRecentMarketplaceMatch) {
      const nextSession: MarketplaceVisualSessionState = {
        routeKey: input.currentRouteKey,
        visualCropHeight: routeBridgeSession?.visualCropHeight ?? null,
        headerBand:
          normalizeMarketplaceThreadHeaderBand(input.weakHeaderBand) ??
          routeBridgeSession?.headerBand ??
          null,
        lastConfirmedAt: routeBridgeSession?.lastConfirmedAt ?? input.nowMs,
        lastStrongConfirmedAt: routeBridgeSession?.lastStrongConfirmedAt ?? null,
        lastMatchedAt: input.nowMs,
        confirmationKind: routeBridgeSession?.confirmationKind ?? "strong-header",
        signalSource: "weak-header",
        lifecycleReason: "route-changed",
        lastLifecycleAt: input.nowMs,
        routeChangeRescueStartedAt: null,
        routeChangeRescuePendingUntil: null,
      };

      return {
        sessionActive: true,
        shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
        visualCropHeight: nextSession.visualCropHeight,
        transition: "bridged",
        signalSource: "weak-header",
        lifecycleReason: "route-changed",
        rejectionReason: null,
        weakHeaderMatchesSessionHeaderBand: routeChangeWeakHeaderMatchesPriorSession,
        nextSession,
      };
    }

    if (
      routeChangeRecentMarketplaceMatch &&
      (
        shouldBridgePendingBootstrapOnRouteChange({
          pendingBootstrapSignalSource: input.pendingBootstrapSignalSource,
          pendingBootstrapAllowed: input.pendingBootstrapAllowed,
          headerBackDetected: input.headerBackDetected,
        }) || recentPendingBootstrapBridgeAllowed
      )
    ) {
      const routeChangePendingBootstrapSignalSource =
        input.pendingBootstrapSignalSource!;
      const nextSession: MarketplaceVisualSessionState = {
        routeKey: input.currentRouteKey,
        visualCropHeight: routeBridgeSession?.visualCropHeight ?? null,
        headerBand: routeBridgeSession?.headerBand ?? null,
        lastConfirmedAt: routeBridgeSession?.lastConfirmedAt ?? input.nowMs,
        lastStrongConfirmedAt: routeBridgeSession?.lastStrongConfirmedAt ?? null,
        lastMatchedAt: input.nowMs,
        confirmationKind: routeBridgeSession?.confirmationKind ?? "strong-header",
        signalSource: routeChangePendingBootstrapSignalSource,
        lifecycleReason: "route-changed",
        lastLifecycleAt: input.nowMs,
        routeChangeRescueStartedAt: null,
        routeChangeRescuePendingUntil: null,
      };

      return {
        sessionActive: true,
        shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
        visualCropHeight: nextSession.visualCropHeight,
        transition: "bridged",
        signalSource: routeChangePendingBootstrapSignalSource,
        lifecycleReason: "route-changed",
        rejectionReason: null,
        weakHeaderMatchesSessionHeaderBand: false,
        nextSession,
      };
    }

    if (
      routeChangeRecentMarketplaceMatch &&
      shouldBridgeWeakBootstrapOnRouteChange({
        previousSession: routeBridgeSession,
        pendingBootstrapSignalSource: input.pendingBootstrapSignalSource,
        pendingBootstrapAllowed: input.pendingBootstrapAllowed,
      })
    ) {
      const weakBootstrapRouteChangeSignalSource =
        input.pendingBootstrapSignalSource!;
      const nextSession: MarketplaceVisualSessionState = {
        routeKey: input.currentRouteKey,
        visualCropHeight: routeBridgeSession?.visualCropHeight ?? null,
        headerBand: routeBridgeSession?.headerBand ?? null,
        lastConfirmedAt: routeBridgeSession?.lastConfirmedAt ?? input.nowMs,
        lastStrongConfirmedAt: routeBridgeSession?.lastStrongConfirmedAt ?? null,
        lastMatchedAt: input.nowMs,
        confirmationKind: routeBridgeSession?.confirmationKind ?? "weak-bootstrap",
        signalSource: weakBootstrapRouteChangeSignalSource,
        lifecycleReason: "route-changed",
        lastLifecycleAt: input.nowMs,
        routeChangeRescueStartedAt: null,
        routeChangeRescuePendingUntil: null,
      };

      return {
        sessionActive: true,
        shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
        visualCropHeight: nextSession.visualCropHeight,
        transition: "bridged",
        signalSource: weakBootstrapRouteChangeSignalSource,
        lifecycleReason: "route-changed",
        rejectionReason: null,
        weakHeaderMatchesSessionHeaderBand: false,
        nextSession,
      };
    }

    const routeChangeRescueMs = Math.max(
      0,
      Math.min(
        input.graceMs,
        Number.isFinite(input.routeChangeRescueMs)
          ? Math.round(input.routeChangeRescueMs ?? 0)
          : input.graceMs,
      ),
    );
    if (
      routeChangeRecentMarketplaceMatch &&
      routeChangeRescueMs > 0 &&
      priorSession &&
      priorSession.headerBand &&
      priorSession.confirmationKind === "strong-header" &&
      input.pendingBootstrapSignalSource == null
    ) {
      const nextSession: MarketplaceVisualSessionState = {
        routeKey: input.currentRouteKey,
        visualCropHeight: priorSession.visualCropHeight ?? null,
        headerBand: priorSession.headerBand,
        lastConfirmedAt: priorSession.lastConfirmedAt,
        lastStrongConfirmedAt: priorSession.lastStrongConfirmedAt,
        lastMatchedAt: priorSession.lastMatchedAt,
        confirmationKind: priorSession.confirmationKind,
        signalSource: "bridge",
        lifecycleReason: "route-change-rescue-pending",
        lastLifecycleAt: input.nowMs,
        routeChangeRescueStartedAt: input.nowMs,
        routeChangeRescuePendingUntil: input.nowMs + routeChangeRescueMs,
      };

      return {
        sessionActive: true,
        shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
        visualCropHeight: nextSession.visualCropHeight,
        transition: "route-change-rescue-pending",
        signalSource: "bridge",
        lifecycleReason: "route-change-rescue-pending",
        rejectionReason: null,
        weakHeaderMatchesSessionHeaderBand: false,
        nextSession,
      };
    }

    return {
      sessionActive: false,
      shouldApplyReducedCrop: false,
      visualCropHeight: null,
      transition: "cleared",
      signalSource: null,
      lifecycleReason: "route-changed",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand: false,
      nextSession: null,
    };
  }

  if (!previousSession) {
    if (input.pendingBootstrapSignalSource) {
      return {
        sessionActive: false,
        shouldApplyReducedCrop: false,
        visualCropHeight: null,
        transition: input.pendingBootstrapAllowed
          ? "weak-bootstrap-pending"
          : "rejected",
        signalSource: input.pendingBootstrapSignalSource,
        lifecycleReason: null,
        rejectionReason: input.pendingBootstrapAllowed
          ? null
          : input.pendingBootstrapRejectedReason ?? null,
        weakHeaderMatchesSessionHeaderBand: false,
        nextSession: null,
      };
    }

    return {
      sessionActive: false,
      shouldApplyReducedCrop: false,
      visualCropHeight: null,
      transition: hadPreviousSession
        ? "cleared"
        : input.weakHeaderBand
          ? "rejected"
          : "inactive",
      signalSource: null,
      lifecycleReason: null,
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand: false,
      nextSession: null,
    };
  }

  if (input.explicitOrdinaryChatDetected) {
    return {
      sessionActive: false,
      shouldApplyReducedCrop: false,
      visualCropHeight: null,
      transition: "cleared",
      signalSource: null,
      lifecycleReason: "explicit-ordinary-chat",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand,
      nextSession: null,
    };
  }

  if (input.sameRouteMarketplaceBackAnchorDetected) {
    const nextSession: MarketplaceVisualSessionState = {
      ...previousSession,
      lastMatchedAt: input.nowMs,
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      lastLifecycleAt: input.nowMs,
      routeChangeRescueStartedAt: null,
      routeChangeRescuePendingUntil: null,
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
      visualCropHeight: nextSession.visualCropHeight,
      transition: "bridged",
      signalSource: "bridge",
      lifecycleReason: "same-thread-rerender",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand,
      nextSession,
    };
  }

  if (input.ordinaryClearPending) {
    const nextSession: MarketplaceVisualSessionState = {
      ...previousSession,
      signalSource: "bridge",
      lifecycleReason: "ordinary-clear-pending",
      lastLifecycleAt: input.nowMs,
      routeChangeRescueStartedAt: null,
      routeChangeRescuePendingUntil: null,
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
      visualCropHeight: nextSession.visualCropHeight,
      transition: "ordinary-clear-pending",
      signalSource: "bridge",
      lifecycleReason: "ordinary-clear-pending",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand,
      nextSession,
    };
  }

  if (weakHeaderMatchesSessionHeaderBand) {
    const nextSession: MarketplaceVisualSessionState = {
      ...previousSession,
      lastMatchedAt: input.nowMs,
      signalSource: "weak-header",
      lifecycleReason: "same-thread-rerender",
      lastLifecycleAt: input.nowMs,
      routeChangeRescueStartedAt: null,
      routeChangeRescuePendingUntil: null,
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
      visualCropHeight: nextSession.visualCropHeight,
      transition: "bridged",
      signalSource: "weak-header",
      lifecycleReason: "same-thread-rerender",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand: true,
      nextSession,
    };
  }

  const routeChangeRescuePendingUntil =
    previousSession.routeChangeRescuePendingUntil;
  const routeChangeRescueActive =
    routeChangeRescuePendingUntil !== null &&
    input.nowMs <= routeChangeRescuePendingUntil;
  if (routeChangeRescueActive) {
    const nextSession: MarketplaceVisualSessionState = {
      ...previousSession,
      signalSource: "bridge",
      lifecycleReason: "route-change-rescue-pending",
      lastLifecycleAt: input.nowMs,
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
      visualCropHeight: nextSession.visualCropHeight,
      transition: "route-change-rescue-pending",
      signalSource: "bridge",
      lifecycleReason: "route-change-rescue-pending",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand,
      nextSession,
    };
  }

  if (routeChangeRescuePendingUntil !== null) {
    return {
      sessionActive: false,
      shouldApplyReducedCrop: false,
      visualCropHeight: null,
      transition: "cleared",
      signalSource: null,
      lifecycleReason: "route-changed",
      rejectionReason: null,
      weakHeaderMatchesSessionHeaderBand,
      nextSession: null,
    };
  }

  const nextSession: MarketplaceVisualSessionState = {
    ...previousSession,
    lastMatchedAt: input.nowMs,
    signalSource: "bridge",
    lifecycleReason: "same-thread-rerender",
    lastLifecycleAt: input.nowMs,
    routeChangeRescueStartedAt: null,
    routeChangeRescuePendingUntil: null,
  };

  return {
    sessionActive: true,
    shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
    visualCropHeight: nextSession.visualCropHeight,
    transition: "bridged",
    signalSource: "bridge",
    lifecycleReason: "same-thread-rerender",
    rejectionReason: null,
    weakHeaderMatchesSessionHeaderBand,
    nextSession,
  };
}
