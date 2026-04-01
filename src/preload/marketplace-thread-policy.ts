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

type MarketplaceThreadSignalInput = {
  rightPaneMarketplaceSignalDetected?: boolean;
  rightPaneItemLinkDetected?: boolean;
  headerMarketplaceDetected?: boolean;
  headerBackDetected?: boolean;
  headerBackMarketplaceDetected?: boolean;
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
