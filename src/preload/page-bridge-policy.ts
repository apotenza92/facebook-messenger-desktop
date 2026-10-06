import { isFacebookOrMessengerUrl } from "./url-policy";

export type PageBridgeMessageEvent = {
  source: unknown;
  origin: string;
};

// The app's injected page scripts post bridge messages on the top-level
// window itself. Messages from any other frame (iframes, popups) or from a
// non-Facebook origin must never reach IPC, because they can raise
// notifications, focus the window for a "call", or change the badge.
export const isTrustedPageBridgeMessage = (
  event: PageBridgeMessageEvent,
  ownWindow: unknown,
): boolean => {
  if (!event || event.source !== ownWindow) return false;
  if (typeof event.origin !== "string") return false;
  if (!event.origin.startsWith("https://")) return false;
  return isFacebookOrMessengerUrl(event.origin);
};
