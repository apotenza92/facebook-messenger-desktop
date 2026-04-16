export type MessengerReloadRequest = {
  debugExportUiActive?: boolean;
};

export type MessengerReloadDecision = {
  allowed: boolean;
  reason: "allowed" | "debug-export-ui-active";
};

export function decideMessengerReload(
  input: MessengerReloadRequest,
): MessengerReloadDecision {
  if (input.debugExportUiActive === true) {
    return {
      allowed: false,
      reason: "debug-export-ui-active",
    };
  }

  return {
    allowed: true,
    reason: "allowed",
  };
}
