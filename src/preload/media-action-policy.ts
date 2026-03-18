type AriaSelectorMatcher =
  | { type: "exact"; value: string }
  | { type: "contains"; value: string };

const buildActionSelectors = (matchers: AriaSelectorMatcher[]): string[] => {
  const selectors = new Set<string>();
  const targets = ['[role="button"]', "button", "a[href]"];

  for (const matcher of matchers) {
    const attribute =
      matcher.type === "exact"
        ? `[aria-label="${matcher.value}" i]`
        : `[aria-label*="${matcher.value}" i]`;

    selectors.add(attribute);
    for (const target of targets) {
      selectors.add(`${target}${attribute}`);
    }
  }

  return Array.from(selectors);
};

export const dismissActionSelectors = buildActionSelectors([
  { type: "exact", value: "Close" },
  { type: "exact", value: "Back" },
  { type: "contains", value: "Go back" },
  { type: "exact", value: "Back to Previous Page" },
]);

export const mediaDownloadSelectors = buildActionSelectors([
  { type: "contains", value: "Download" },
  { type: "contains", value: "Save" },
]);

export const mediaShareSelectors = buildActionSelectors([
  { type: "contains", value: "Share" },
  { type: "contains", value: "Forward" },
]);

export const mediaNavigationSelectors = buildActionSelectors([
  { type: "contains", value: "Next" },
  { type: "contains", value: "Previous" },
  { type: "contains", value: "Prev" },
]);

export function getDismissActionPriority(label: string): number {
  const normalized = String(label || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized === "close") return 0;
  if (normalized.startsWith("close ")) return 1;
  if (normalized === "back") return 2;
  if (normalized.includes("go back")) return 3;
  if (normalized === "back to previous page") return 4;
  return 5;
}
