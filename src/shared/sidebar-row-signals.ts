// Locale-free reading of Messenger chat-list rows, shared by the sidebar
// notification engine (injected page script) and the unread badge counter
// (preload). Every decision here uses DOM structure, computed style or icon
// geometry; never interface or message text, which changes with the user's
// language (#104) and collides with ordinary messages (#105).
//
// Evidence (Oct 2026 diagnostics on macOS and Windows, ~3,000 row states):
// unread rows render their title and preview [dir=auto] texts at weight 600,
// read rows at 500/400, with no exceptions. Facebook's thread-list source
// (MWThreadAddOnSecondary) renders a bell-with-slash icon for muted threads
// and a blue badge for unread ones, independently of each other.

export type SidebarRowSnapshot = {
  threadKey: string;
  title: string;
  preview: string;
  unread: boolean;
  muted: boolean;
  timeLabel: string | null;
  stale: boolean;
};

const UNREAD_FONT_WEIGHT = 600;
const MAX_TIME_LABEL_LENGTH = 24;

const ROW_LINK_SELECTOR = 'a[href*="/t/"], a[href*="/e2ee/t/"]';
const ROW_TEXT_SELECTOR = '[dir="auto"]';

// Bell-with-slash geometries Facebook has shipped for muted conversations.
// The 16px Nucleus variant was confirmed in Facebook's static sources in
// October 2026; the others are earlier Messenger variants.
const MUTED_ICON_PATH_PREFIXES = [
  "M9.244 24.99",
  "M29.676 7.746",
  "M2.5 6c0-.322",
];
const MUTED_ICON_PATH_FRAGMENTS = [
  "L26.867 7.366",
  "L6.293 28.29",
  "8.296 8.296A3.001 3.001 0 0 1 5 12.5",
];
// Sprite identifiers, not user-visible text.
const MUTED_ICON_SPRITE_IDS = [
  "bell_cross",
  "bell-cross",
  "bellcross",
  "notifications_off",
  "notification_off",
];

const normalizeSpace = (value: string | null | undefined): string =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

export function normalizeSidebarThreadKey(raw: string): string | null {
  try {
    const url = new URL(raw, "https://www.facebook.com");
    const match = url.pathname.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return match ? `/t/${match[1]}` : null;
  } catch {
    return null;
  }
}

export function findSidebarRowLink(row: Element): HTMLAnchorElement | null {
  return row.querySelector<HTMLAnchorElement>(ROW_LINK_SELECTOR);
}

const readFontWeight = (element: Element): number => {
  try {
    const weight = Number.parseInt(getComputedStyle(element).fontWeight, 10);
    return Number.isFinite(weight) ? weight : 0;
  } catch {
    return 0;
  }
};

const rowTextElements = (row: Element): Element[] =>
  Array.from(row.querySelectorAll(ROW_TEXT_SELECTOR)).filter(
    (element) =>
      normalizeSpace(element.textContent).length > 0 &&
      // Nested [dir=auto] nodes belong to their outer text.
      !element.parentElement?.closest(ROW_TEXT_SELECTOR),
  );

// Image and emoji glyphs are <img alt> nodes inside the preview.
const readTextWithImages = (element: Element): string => {
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
      return;
    }
    if (node instanceof HTMLImageElement) {
      text += node.alt || "";
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(element);
  return normalizeSpace(text);
};

export function isSidebarRowUnread(row: Element): boolean {
  const [title, preview] = rowTextElements(row);
  return [title, preview].some(
    (element) => element && readFontWeight(element) >= UNREAD_FONT_WEIGHT,
  );
}

export function isSidebarRowMuted(row: Element): boolean {
  for (const path of Array.from(row.querySelectorAll("svg path"))) {
    const d = path.getAttribute("d") || "";
    if (
      MUTED_ICON_PATH_PREFIXES.some((prefix) => d.startsWith(prefix)) ||
      MUTED_ICON_PATH_FRAGMENTS.some((fragment) => d.includes(fragment))
    ) {
      return true;
    }
  }
  for (const use of Array.from(row.querySelectorAll("svg use"))) {
    const href = (
      use.getAttribute("href") ||
      use.getAttribute("xlink:href") ||
      ""
    ).toLowerCase();
    if (MUTED_ICON_SPRITE_IDS.some((id) => href.includes(id))) return true;
  }
  return false;
}

// The relative time is the first short text after the preview, wherever
// the layout puts it: its own [dir=auto] node or an inline span after a
// separator. Pure punctuation (the separator itself) is skipped.
const readTimeLabel = (
  row: Element,
  preview: Element | undefined,
): string | null => {
  if (!preview) return null;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let passedPreview = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (preview.contains(node)) {
      passedPreview = true;
      continue;
    }
    if (!passedPreview) continue;
    const text = normalizeSpace(node.textContent);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    return text.length <= MAX_TIME_LABEL_LENGTH ? text : null;
  }
  return null;
};

// Zero code points of common decimal digit blocks (ASCII, Arabic-Indic,
// Extended Arabic-Indic, Devanagari, Bengali, Thai, fullwidth).
const DIGIT_ZEROES = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10];

// Decimal digits from any script, as Messenger localises numerals.
const parseFirstNumber = (label: string): number | null => {
  const match = label.match(/\p{Nd}+/u);
  if (!match) return null;
  let value = 0;
  for (const char of match[0]) {
    const code = char.codePointAt(0) || 0;
    let digit = -1;
    for (const zero of DIGIT_ZEROES) {
      if (code >= zero && code <= zero + 9) {
        digit = code - zero;
        break;
      }
    }
    if (digit < 0) return null;
    value = value * 10 + digit;
  }
  return value;
};

// A message is fresh while Messenger shows no relative time, a word such as
// "now", or a count of one ("1m"). Any larger count means the message is at
// least two units old, which only happens when old messages sync late.
export function isSidebarTimeLabelStale(label: string | null): boolean {
  if (!label) return false;
  const value = parseFirstNumber(label);
  return value !== null && value >= 2;
}

export function readSidebarRow(row: Element): SidebarRowSnapshot | null {
  const link = findSidebarRowLink(row);
  const threadKey = link
    ? normalizeSidebarThreadKey(link.getAttribute("href") || "")
    : null;
  if (!threadKey) return null;

  const [titleElement, previewElement] = rowTextElements(row);
  if (!titleElement) return null;

  const timeLabel = readTimeLabel(row, previewElement);
  return {
    threadKey,
    title: readTextWithImages(titleElement),
    preview: previewElement ? readTextWithImages(previewElement) : "",
    unread: isSidebarRowUnread(row),
    muted: isSidebarRowMuted(row),
    timeLabel,
    stale: isSidebarTimeLabelStale(timeLabel),
  };
}

const sidebarRowSignalsApi = {
  normalizeSidebarThreadKey,
  findSidebarRowLink,
  isSidebarRowUnread,
  isSidebarRowMuted,
  isSidebarTimeLabelStale,
  readSidebarRow,
};

export type SidebarRowSignalsApi = typeof sidebarRowSignalsApi;

(globalThis as typeof globalThis & {
  __mdSidebarRowSignals?: SidebarRowSignalsApi;
}).__mdSidebarRowSignals = sidebarRowSignalsApi;
