export type FacebookHeaderSuppressionMode =
  | "hide-banner"
  | "hide-facebook-nav-descendants"
  | "off";

export type FacebookHeaderSuppressionSignals = {
  isMessagesSurface: boolean;
  hasTopAnchoredBanner: boolean;
  hasFacebookNavSignal: boolean;
  hasPreservedMessengerControls: boolean;
};

export type EffectiveFacebookHeaderSuppressionInput = {
  requestedMode: FacebookHeaderSuppressionMode;
  incomingCallOverlayHintActive: boolean;
  hasFacebookNavSignal: boolean;
  previousMode?: FacebookHeaderSuppressionMode | null;
};

export type FacebookHeaderSuppressionRetentionInput = {
  previousActive: boolean;
  currentActive: boolean;
  missingForMs: number;
  graceMs: number;
};

export type MessagesShellTargetHeightInput = {
  viewportHeight: number;
  shellTop: number;
  collapseHeight: number;
};

function normalizeFiniteMeasurement(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
}

export function resolveFacebookHeaderSuppressionMode(
  input: FacebookHeaderSuppressionSignals,
): FacebookHeaderSuppressionMode {
  if (!input.isMessagesSurface || !input.hasTopAnchoredBanner) {
    return "off";
  }

  if (input.hasPreservedMessengerControls) {
    return input.hasFacebookNavSignal ? "hide-facebook-nav-descendants" : "off";
  }

  return "hide-banner";
}

export function resolveEffectiveFacebookHeaderSuppressionMode(
  input: EffectiveFacebookHeaderSuppressionInput,
): FacebookHeaderSuppressionMode {
  if (!input.incomingCallOverlayHintActive) {
    return input.requestedMode;
  }

  if (input.requestedMode !== "hide-banner") {
    return input.requestedMode;
  }

  if (input.previousMode === "hide-facebook-nav-descendants") {
    return "hide-facebook-nav-descendants";
  }

  return input.hasFacebookNavSignal ? "hide-facebook-nav-descendants" : "off";
}

export function shouldKeepFacebookHeaderSuppressionActive(
  input: FacebookHeaderSuppressionRetentionInput,
): boolean {
  if (!input.previousActive || input.currentActive) {
    return false;
  }

  return normalizeFiniteMeasurement(input.missingForMs) <=
    normalizeFiniteMeasurement(input.graceMs);
}

export function resolveMessagesShellTargetHeight(
  input: MessagesShellTargetHeightInput,
): number {
  const viewportHeight = normalizeFiniteMeasurement(input.viewportHeight);
  const shellTop = normalizeFiniteMeasurement(input.shellTop);
  const collapseHeight = normalizeFiniteMeasurement(input.collapseHeight);
  const effectiveTop = Math.max(0, shellTop - collapseHeight);

  return Math.max(0, viewportHeight - effectiveTop);
}
