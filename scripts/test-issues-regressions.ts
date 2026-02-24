type ViewportMode = "chat" | "media" | "other";

const {
  resolveViewportMode,
  shouldApplyMessagesCrop,
} = require("../src/preload/messages-viewport-policy");
const notificationDecisionPolicy = require("../src/preload/notification-decision-policy.ts");

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`,
    );
  }
};

const runViewportPolicyTests = () => {
  const expectMode = (
    path: string,
    mediaOverlayVisible: boolean,
    expectedMode: ViewportMode,
    expectedCrop: boolean,
  ) => {
    const mode = resolveViewportMode({ urlPath: path, mediaOverlayVisible });
    const crop = shouldApplyMessagesCrop({ urlPath: path, mediaOverlayVisible });
    assertEqual(
      mode,
      expectedMode,
      `#45 viewport mode mismatch for ${path} (visible=${mediaOverlayVisible})`,
    );
    assertEqual(
      crop,
      expectedCrop,
      `#45 crop mismatch for ${path} (visible=${mediaOverlayVisible})`,
    );
  };

  // Core #45 deterministic checks
  expectMode("/messages/t/123", false, "chat", true);
  expectMode("/messages/t/123", true, "media", false);
  expectMode("/messages/media_viewer.123", false, "media", false);
  expectMode("/photo/123", false, "media", false);
  expectMode("/settings", false, "other", false);

  // Transition sequence reproducing "first chat works, subsequent chats break"
  const sequence: Array<{
    path: string;
    visible: boolean;
    mode: ViewportMode;
    crop: boolean;
  }> = [
    { path: "/messages/t/first", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/first", visible: true, mode: "media", crop: false },
    { path: "/messages/t/first", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/second", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/second", visible: true, mode: "media", crop: false },
    { path: "/messages/t/second", visible: false, mode: "chat", crop: true },
    { path: "/messages/t/first", visible: true, mode: "media", crop: false },
    { path: "/messages/t/first", visible: false, mode: "chat", crop: true },
  ];

  sequence.forEach((step, index) => {
    expectMode(step.path, step.visible, step.mode, step.crop);
    assertEqual(
      step.mode === "chat",
      step.crop,
      `#45 sequence stale crop state at step ${index + 1}`,
    );
  });
};

const runNotificationPolicyTests = () => {
  assert(
    typeof notificationDecisionPolicy.resolveNativeNotificationTarget === "function",
    "notification decision policy missing resolveNativeNotificationTarget",
  );
  assert(
    typeof notificationDecisionPolicy.createNotificationDeduper === "function",
    "notification decision policy missing createNotificationDeduper",
  );

  const mutedMatch = notificationDecisionPolicy.resolveNativeNotificationTarget(
    {
      title: "Project Squad",
      body: "Alex: shipped the fix",
    },
    [
      {
        href: "/t/group-project",
        title: "Project Squad",
        body: "Alex: shipped the fix",
        muted: true,
        unread: true,
      },
      {
        href: "/t/alex",
        title: "Alex",
        body: "shipped the fix",
        muted: false,
        unread: true,
      },
    ],
  );
  assertEqual(
    mutedMatch.ambiguous,
    false,
    "#46 muted-group case should resolve to a single candidate",
  );
  assertEqual(
    mutedMatch.matchedHref,
    "/t/group-project",
    "#46 muted-group case matched wrong conversation",
  );
  assertEqual(
    mutedMatch.muted,
    true,
    "#46 muted-group case should mark result as muted",
  );

  const ambiguousMatch =
    notificationDecisionPolicy.resolveNativeNotificationTarget(
      {
        title: "Alex",
        body: "Alex sent a message in Project Squad",
      },
      [
        {
          href: "/t/alex",
          title: "Alex",
          body: "sent a message",
          muted: false,
          unread: true,
        },
        {
          href: "/t/group-project",
          title: "Project Squad",
          body: "Alex sent a message",
          muted: false,
          unread: true,
        },
      ],
    );
  assertEqual(
    ambiguousMatch.ambiguous,
    true,
    "#46 sender/group overlap should be treated as ambiguous",
  );
  assertEqual(
    typeof ambiguousMatch.matchedHref,
    "undefined",
    "#46 ambiguous resolution should fail closed with no matchedHref",
  );

  const directMatch = notificationDecisionPolicy.resolveNativeNotificationTarget(
    {
      title: "Taylor",
      body: "Are you free?",
    },
    [
      {
        href: "/t/taylor",
        title: "Taylor",
        body: "Are you free?",
        muted: false,
        unread: true,
      },
      {
        href: "/t/random-group",
        title: "Weekend Plans",
        body: "Dinner on Friday",
        muted: false,
        unread: true,
      },
    ],
  );
  assertEqual(
    directMatch.ambiguous,
    false,
    "#46 direct conversation should resolve confidently",
  );
  assertEqual(
    directMatch.matchedHref,
    "/t/taylor",
    "#46 direct conversation matched wrong conversation",
  );
  assertEqual(
    directMatch.muted,
    false,
    "#46 direct conversation should not be muted",
  );

  const deduper = notificationDecisionPolicy.createNotificationDeduper(5000);
  assertEqual(
    deduper.shouldSuppress("/t/group-project", 1000),
    false,
    "#46 deduper should allow first delivery",
  );
  assertEqual(
    deduper.shouldSuppress("/t/group-project", 2500),
    true,
    "#46 deduper should suppress rapid sender/group duplicates",
  );
  assertEqual(
    deduper.shouldSuppress("/t/group-project", 9000),
    false,
    "#46 deduper should allow after TTL expires",
  );
};

const run = () => {
  runViewportPolicyTests();
  runNotificationPolicyTests();
  console.log("PASS #45/#46 deterministic regression tests");
};

try {
  run();
} catch (error) {
  console.error("FAIL #45/#46 regression tests failed:", error);
  process.exit(1);
}
