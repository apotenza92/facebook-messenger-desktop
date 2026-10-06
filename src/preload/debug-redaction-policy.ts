export type DescribableElement = {
  tagName: string;
  id?: string;
  className?: unknown;
  isContentEditable?: boolean;
  getAttribute: (name: string) => string | null;
  href?: unknown;
};

const EDITABLE_TAGS = new Set(["input", "textarea", "select"]);

const isEditable = (element: DescribableElement): boolean => {
  const tag = element.tagName.toLowerCase();
  if (EDITABLE_TAGS.has(tag)) return true;
  if (element.isContentEditable === true) return true;
  const editable = element.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
};

// Describe an interaction target for diagnostics without its content.
// Text content is never recorded (it can be a draft message or a
// conversation preview), and editable fields also drop their labels.
export const describeInteractionTarget = (
  element: DescribableElement | null,
): Record<string, unknown> | null => {
  if (!element) return null;
  const editable = isEditable(element);
  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className:
      typeof element.className === "string"
        ? element.className.slice(0, 160)
        : undefined,
    role: element.getAttribute("role") || undefined,
    editable: editable || undefined,
    ariaLabel: editable
      ? undefined
      : element.getAttribute("aria-label") || undefined,
    title: editable ? undefined : element.getAttribute("title") || undefined,
    href: typeof element.href === "string" ? element.href : undefined,
  };
};
