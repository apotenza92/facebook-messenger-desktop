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
  | "explicit-ordinary-chat"
  | "thread-destroyed";

export type MarketplaceVisualSessionTransition =
  | "strong-confirmed"
  | "weak-bootstrap-pending"
  | "weak-bootstrap-confirmed"
  | "ordinary-clear-pending"
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

export function resolveMarketplaceVisualSessionDecision(input: {
  currentRouteKey: string;
  nowMs: number;
  graceMs: number;
  previousSession?: MarketplaceVisualSessionState | null;
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

  const weakHeaderMatchesSessionHeaderBand = doesMarketplaceThreadHeaderBandMatch(
    {
      confirmedHeaderBand: previousSession?.headerBand,
      candidateHeaderBand: input.weakHeaderBand,
    },
  );
  const routeChangeWeakHeaderMatchesPriorSession =
    routeChanged &&
    doesMarketplaceThreadRouteChangeWeakHeaderMatch({
      confirmedHeaderBand: priorSession?.headerBand,
      candidateHeaderBand: input.weakHeaderBand,
    });
  const routeChangeRecentMarketplaceMatch =
    routeChanged &&
    priorSession &&
    Number.isFinite(priorSession.lastMatchedAt) &&
    input.nowMs - priorSession.lastMatchedAt <= input.graceMs;

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

  if (routeChanged) {
    if (routeChangeWeakHeaderMatchesPriorSession && routeChangeRecentMarketplaceMatch) {
      const nextSession: MarketplaceVisualSessionState = {
        routeKey: input.currentRouteKey,
        visualCropHeight: priorSession?.visualCropHeight ?? null,
        headerBand:
          normalizeMarketplaceThreadHeaderBand(input.weakHeaderBand) ??
          priorSession?.headerBand ??
          null,
        lastConfirmedAt: priorSession?.lastConfirmedAt ?? input.nowMs,
        lastStrongConfirmedAt: priorSession?.lastStrongConfirmedAt ?? null,
        lastMatchedAt: input.nowMs,
        confirmationKind: priorSession?.confirmationKind ?? "strong-header",
        signalSource: "weak-header",
        lifecycleReason: "route-changed",
        lastLifecycleAt: input.nowMs,
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

  const nextSession: MarketplaceVisualSessionState = {
    ...previousSession,
    lastMatchedAt: input.nowMs,
    signalSource: "bridge",
    lifecycleReason: "same-thread-rerender",
    lastLifecycleAt: input.nowMs,
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
