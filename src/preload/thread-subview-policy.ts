const MESSENGER_THREAD_SUBVIEW_BACK_HINT_PATTERN =
  /\b(back|go back|back to previous page)\b/i;
const MESSENGER_LIST_SUBVIEW_HEADER_PATTERNS = [
  {
    kind: "archived-chats",
    pattern: /\barchived chats?\b/i,
  },
  {
    kind: "message-requests",
    pattern: /\b(message requests?|requests?)\b/i,
  },
  {
    kind: "restricted-accounts",
    pattern: /\brestricted accounts?\b/i,
  },
] as const;
const ORDINARY_THREAD_CONTROL_PATTERN =
  /\b(search in conversation|audio call|video call|start (?:an? )?(?:audio |video )?call|open conversation information|conversation information|chat info|details|info)\b/i;

export type MessengerThreadSubviewKind =
  | "archived-chats"
  | "message-requests"
  | "restricted-accounts";

export type MessengerThreadSubviewHintSignal =
  | "back"
  | "list-subview-header"
  | "ordinary-thread-control";

export type MessengerThreadSubviewHeaderBand = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

function normalizeHint(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBand(
  band: MessengerThreadSubviewHeaderBand | null | undefined,
): MessengerThreadSubviewHeaderBand | null {
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

  return { top, bottom, left, right };
}

export function collectMessengerThreadSubviewHintSignals(
  value: string | null | undefined,
): MessengerThreadSubviewHintSignal[] {
  const hint = normalizeHint(value);
  if (!hint) {
    return [];
  }

  const signals: MessengerThreadSubviewHintSignal[] = [];
  if (MESSENGER_THREAD_SUBVIEW_BACK_HINT_PATTERN.test(hint)) {
    signals.push("back");
  }
  if (resolveMessengerThreadSubviewHeaderKind(hint)) {
    signals.push("list-subview-header");
  }
  if (ORDINARY_THREAD_CONTROL_PATTERN.test(hint)) {
    signals.push("ordinary-thread-control");
  }

  return signals;
}

export function isMessengerThreadSubviewBackHint(
  value: string | null | undefined,
): boolean {
  return collectMessengerThreadSubviewHintSignals(value).includes("back");
}

export function resolveMessengerThreadSubviewHeaderKind(
  value: string | null | undefined,
): MessengerThreadSubviewKind | null {
  const hint = normalizeHint(value);
  if (!hint) {
    return null;
  }

  for (const entry of MESSENGER_LIST_SUBVIEW_HEADER_PATTERNS) {
    if (entry.pattern.test(hint)) {
      return entry.kind;
    }
  }

  return null;
}

export function isMessengerThreadSubviewHeaderHint(
  value: string | null | undefined,
): boolean {
  return resolveMessengerThreadSubviewHeaderKind(value) !== null;
}

export function isOrdinaryThreadControlHint(
  value: string | null | undefined,
): boolean {
  return collectMessengerThreadSubviewHintSignals(value).includes(
    "ordinary-thread-control",
  );
}

export function hasMessengerThreadSubviewHeaderSignal(
  hints: Iterable<string | null | undefined>,
): boolean {
  let hasBack = false;
  let hasSubviewHeader = false;

  for (const hint of hints) {
    const normalized = normalizeHint(hint);
    if (!normalized) {
      continue;
    }

    if (isMessengerThreadSubviewBackHint(normalized)) {
      hasBack = true;
    }
    if (isMessengerThreadSubviewHeaderHint(normalized)) {
      hasSubviewHeader = true;
    }

    if (hasBack && hasSubviewHeader) {
      return true;
    }
  }

  return false;
}

export function doesMessengerThreadSubviewFreshHeaderPairMatch(input: {
  candidateHeaderBand?: MessengerThreadSubviewHeaderBand | null;
  candidateBackBand?: MessengerThreadSubviewHeaderBand | null;
}): boolean {
  const candidateHeaderBand = normalizeBand(input.candidateHeaderBand);
  const candidateBackBand = normalizeBand(input.candidateBackBand);
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
    candidateHeaderBand.top <= 180 && candidateHeaderBand.left <= 260;

  return verticalOverlap && anchoredNearHeaderLeft && headerInTopLeftBand;
}

export function shouldCarryMessengerThreadSubviewSession(input: {
  kind?: MessengerThreadSubviewKind | null;
  previousRouteKey?: string | null;
  currentRouteKey?: string | null;
  lastMatchedAgeMs?: number | null;
  candidateBackBand?: MessengerThreadSubviewHeaderBand | null;
}): boolean {
  if (input.kind !== "archived-chats") {
    return false;
  }

  const previousRouteKey = normalizeHint(input.previousRouteKey);
  const currentRouteKey = normalizeHint(input.currentRouteKey);
  if (!previousRouteKey || !currentRouteKey || previousRouteKey === currentRouteKey) {
    return false;
  }

  const lastMatchedAgeMs = Number(input.lastMatchedAgeMs);
  if (!Number.isFinite(lastMatchedAgeMs) || lastMatchedAgeMs > 8_000) {
    return false;
  }

  const candidateBackBand = normalizeBand(input.candidateBackBand);
  if (!candidateBackBand) {
    return false;
  }

  return (
    candidateBackBand.top <= 180 &&
    candidateBackBand.left <= 140 &&
    candidateBackBand.right <= 220 &&
    candidateBackBand.bottom <= 240
  );
}

export function shouldContinueMessengerThreadSubviewSession(input: {
  kind?: MessengerThreadSubviewKind | null;
  headerKind?: MessengerThreadSubviewKind | null;
  previousRouteKey?: string | null;
  currentRouteKey?: string | null;
  lastMatchedAgeMs?: number | null;
  candidateBackBand?: MessengerThreadSubviewHeaderBand | null;
  ordinaryThreadControlDetected?: boolean | null;
}): boolean {
  if (input.kind !== "archived-chats" || input.headerKind !== "archived-chats") {
    return false;
  }

  const previousRouteKey = normalizeHint(input.previousRouteKey);
  const currentRouteKey = normalizeHint(input.currentRouteKey);
  if (!previousRouteKey || !currentRouteKey) {
    return false;
  }

  const lastMatchedAgeMs = Number(input.lastMatchedAgeMs);
  if (!Number.isFinite(lastMatchedAgeMs) || lastMatchedAgeMs > 10_000) {
    return false;
  }

  const candidateBackBand = normalizeBand(input.candidateBackBand);
  if (!candidateBackBand) {
    return false;
  }

  return (
    candidateBackBand.top <= 180 &&
    candidateBackBand.left <= 140 &&
    candidateBackBand.right <= 220 &&
    candidateBackBand.bottom <= 240
  );
}

export function resolveMessengerThreadSubviewKind(input: {
  headerBackDetected?: boolean;
  headerKind?: MessengerThreadSubviewKind | null;
  ordinaryThreadControlDetected?: boolean;
}): MessengerThreadSubviewKind | null {
  if (input.headerBackDetected === true && input.headerKind) {
    return input.headerKind;
  }

  return null;
}
