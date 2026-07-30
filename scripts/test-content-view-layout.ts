import {
  getContentViewBounds,
  reconcileContentViewBounds,
  type ContentViewBounds,
} from "../src/main/content-view-layout";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

function run(): void {
  assertEqual(
    getContentViewBounds({ width: 900, height: 600 }, 56),
    { x: 0, y: -56, width: 900, height: 656 },
    "Messenger header cropping should extend the view without shortening its visible content",
  );

  let viewBounds: ContentViewBounds = {
    x: 0,
    y: -56,
    width: 900,
    height: 656,
  };
  let setBoundsCalls = 0;
  const target = {
    getBounds: () => viewBounds,
    setBounds: (bounds: ContentViewBounds) => {
      setBoundsCalls += 1;
      viewBounds = bounds;
    },
  };

  assertEqual(
    reconcileContentViewBounds(target, { width: 900, height: 625 }, 56),
    true,
    "A menu hide that grows the client area without a window resize event should reconcile the view",
  );
  assertEqual(
    viewBounds,
    { x: 0, y: -56, width: 900, height: 681 },
    "The Messenger view should fill the client area after the menu bar is hidden",
  );
  assertEqual(
    reconcileContentViewBounds(target, { width: 900, height: 625 }, 56),
    false,
    "An already-correct view should not be resized again",
  );
  assertEqual(
    setBoundsCalls,
    1,
    "Layout monitoring should remain idempotent while the client area is unchanged",
  );

  console.log("PASS content view layout tests");
}

run();
