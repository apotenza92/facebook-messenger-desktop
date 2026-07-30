export type MessengerReloadRequest = {
  debugExportUiActive?: boolean;
};

export type MessengerReloadDecision = {
  allowed: boolean;
  reason: "allowed" | "debug-export-ui-active";
};

export type MessengerTopLevelNavigationRequest = {
  currentUrl: string;
  nextUrl: string;
};

export type MessengerTopLevelNavigationDecision = {
  allowed: boolean;
  reason: "allowed" | "same-thread-e2ee-downgrade";
};

type MessengerThreadRoute = {
  encrypted: boolean;
  threadKey: string;
};

function parseMessengerThreadRoute(input: string): MessengerThreadRoute | null {
  try {
    const parsed = new URL(input);
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "facebook.com" &&
        !parsed.hostname.endsWith(".facebook.com"))
    ) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (
      segments.length >= 4 &&
      segments[0].toLowerCase() === "messages" &&
      segments[1].toLowerCase() === "e2ee" &&
      segments[2].toLowerCase() === "t"
    ) {
      return {
        encrypted: true,
        threadKey: segments[3],
      };
    }

    if (
      segments.length >= 3 &&
      segments[0].toLowerCase() === "messages" &&
      segments[1].toLowerCase() === "t"
    ) {
      return {
        encrypted: false,
        threadKey: segments[2],
      };
    }
  } catch {
    // Invalid or non-web URLs are outside this narrow navigation policy.
  }

  return null;
}

export function decideMessengerTopLevelNavigation(
  input: MessengerTopLevelNavigationRequest,
): MessengerTopLevelNavigationDecision {
  const current = parseMessengerThreadRoute(input.currentUrl);
  const next = parseMessengerThreadRoute(input.nextUrl);

  if (
    current?.encrypted === true &&
    next?.encrypted === false &&
    current.threadKey === next.threadKey
  ) {
    return {
      allowed: false,
      reason: "same-thread-e2ee-downgrade",
    };
  }

  return {
    allowed: true,
    reason: "allowed",
  };
}

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
