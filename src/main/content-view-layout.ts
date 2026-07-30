export type ContentViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ContentViewLayoutTarget = {
  getBounds: () => ContentViewBounds;
  setBounds: (bounds: ContentViewBounds) => void;
};

export function getContentViewBounds(
  contentBounds: Pick<ContentViewBounds, "width" | "height">,
  cropHeight: number,
): ContentViewBounds {
  const crop = Math.max(0, Math.round(cropHeight));

  return {
    x: 0,
    y: -crop,
    width: contentBounds.width,
    height: contentBounds.height + crop,
  };
}

export function reconcileContentViewBounds(
  target: ContentViewLayoutTarget,
  contentBounds: Pick<ContentViewBounds, "width" | "height">,
  cropHeight: number,
): boolean {
  const nextBounds = getContentViewBounds(contentBounds, cropHeight);
  const currentBounds = target.getBounds();
  const changed =
    currentBounds.x !== nextBounds.x ||
    currentBounds.y !== nextBounds.y ||
    currentBounds.width !== nextBounds.width ||
    currentBounds.height !== nextBounds.height;

  if (changed) {
    target.setBounds(nextBounds);
  }

  return changed;
}
