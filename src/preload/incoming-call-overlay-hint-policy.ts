export type IncomingCallUiVisibilitySignals = {
  answerVisible: boolean;
  declineVisible: boolean;
  joinVisible: boolean;
  titleSignal: boolean;
  selectorSignal: boolean;
  textSignal: boolean;
};

export function shouldTreatIncomingCallUiAsVisible(
  signals: IncomingCallUiVisibilitySignals,
): boolean {
  if (signals.answerVisible && signals.declineVisible) {
    return true;
  }

  if (signals.answerVisible && signals.joinVisible) {
    return true;
  }

  return (
    signals.titleSignal || signals.selectorSignal || signals.textSignal
  );
}

export function shouldKeepIncomingCallHintActive(params: {
  sinceStartMs: number;
  sinceVisibleMs: number;
  minHoldMs: number;
  missGraceMs: number;
}): boolean {
  const { sinceStartMs, sinceVisibleMs, minHoldMs, missGraceMs } = params;

  return sinceStartMs < minHoldMs || sinceVisibleMs < missGraceMs;
}

export function getIncomingCallHintClearReason(params: {
  activeForMs: number;
  missingForMs: number;
  detectedSinceHint: boolean;
  minStickyMs: number;
  missingClearMs: number;
  maxWithoutDetectionMs: number;
}): "incoming-call-controls-missing" | "incoming-call-hint-stale" | null {
  const {
    activeForMs,
    missingForMs,
    detectedSinceHint,
    minStickyMs,
    missingClearMs,
    maxWithoutDetectionMs,
  } = params;

  if (
    detectedSinceHint &&
    activeForMs >= minStickyMs &&
    missingForMs >= missingClearMs
  ) {
    return "incoming-call-controls-missing";
  }

  if (!detectedSinceHint && activeForMs >= maxWithoutDetectionMs) {
    return "incoming-call-hint-stale";
  }

  return null;
}
