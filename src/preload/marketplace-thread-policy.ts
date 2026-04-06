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

export type MarketplaceVisualSessionTransition =
  | "confirmed"
  | "bridging"
  | "cleared"
  | "rejected"
  | "inactive";

export type MarketplaceVisualSessionState = {
  routeKey: string;
  visualCropHeight: number | null;
  headerBand: MarketplaceThreadHeaderBand | null;
  lastConfirmedAt: number;
  lastMatchedAt: number;
  signalSource: MarketplaceSessionSignalSource;
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
  weakHeaderMatchesSessionHeaderBand: boolean;
  nextSession: MarketplaceVisualSessionState | null;
};

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

  return (
    verticalOverlap &&
    horizontalOverlap &&
    topDiff <= 28 &&
    bottomDiff <= 36 &&
    leftDiff <= 32 &&
    rightDiff <= 120
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
  strongVisualCropHeight?: number | null;
  strongHeaderBand?: MarketplaceThreadHeaderBand | null;
  weakHeaderBand?: MarketplaceThreadHeaderBand | null;
}): MarketplaceVisualSessionDecision {
  const hadPreviousSession = input.previousSession !== null && input.previousSession !== undefined;
  const previousSession =
    input.previousSession &&
    input.previousSession.routeKey === input.currentRouteKey
      ? input.previousSession
      : null;
  const weakHeaderMatchesSessionHeaderBand = doesMarketplaceThreadHeaderBandMatch(
    {
      confirmedHeaderBand: previousSession?.headerBand,
      candidateHeaderBand: input.weakHeaderBand,
    },
  );

  if (input.strongSignalSource) {
    const visualCropHeight = normalizeMarketplaceVisualCropHeight(
      input.strongVisualCropHeight ?? previousSession?.visualCropHeight,
    );
    const nextSession: MarketplaceVisualSessionState = {
      routeKey: input.currentRouteKey,
      visualCropHeight,
      headerBand:
        normalizeMarketplaceThreadHeaderBand(input.strongHeaderBand) ??
        previousSession?.headerBand ??
        null,
      lastConfirmedAt: input.nowMs,
      lastMatchedAt: input.nowMs,
      signalSource: input.strongSignalSource,
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: visualCropHeight !== null,
      visualCropHeight,
      transition: "confirmed",
      signalSource: input.strongSignalSource,
      weakHeaderMatchesSessionHeaderBand,
      nextSession,
    };
  }

  if (!previousSession) {
    return {
      sessionActive: false,
      shouldApplyReducedCrop: false,
      visualCropHeight: null,
      transition: hadPreviousSession ? "cleared" : input.weakHeaderBand ? "rejected" : "inactive",
      signalSource: null,
      weakHeaderMatchesSessionHeaderBand: false,
      nextSession: null,
    };
  }

  if (weakHeaderMatchesSessionHeaderBand) {
    const nextSession: MarketplaceVisualSessionState = {
      ...previousSession,
      lastMatchedAt: input.nowMs,
      signalSource: "weak-header",
    };

    return {
      sessionActive: true,
      shouldApplyReducedCrop: nextSession.visualCropHeight !== null,
      visualCropHeight: nextSession.visualCropHeight,
      transition: "bridging",
      signalSource: "weak-header",
      weakHeaderMatchesSessionHeaderBand: true,
      nextSession,
    };
  }

  const missingForMs = Math.max(0, input.nowMs - previousSession.lastMatchedAt);
  if (!input.weakHeaderBand && missingForMs <= input.graceMs) {
    return {
      sessionActive: true,
      shouldApplyReducedCrop: previousSession.visualCropHeight !== null,
      visualCropHeight: previousSession.visualCropHeight,
      transition: "bridging",
      signalSource: "bridge",
      weakHeaderMatchesSessionHeaderBand: false,
      nextSession: previousSession,
    };
  }

  return {
    sessionActive: false,
    shouldApplyReducedCrop: false,
    visualCropHeight: null,
    transition: input.weakHeaderBand ? "rejected" : "cleared",
    signalSource: null,
    weakHeaderMatchesSessionHeaderBand,
    nextSession: null,
  };
}
