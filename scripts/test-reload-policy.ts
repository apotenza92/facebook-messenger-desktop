const {
  decideMessengerReload,
  decideMessengerTopLevelNavigation,
} = require("../src/main/reload-policy.ts");

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

function run() {
  assertEqual(
    decideMessengerReload({ debugExportUiActive: false }),
    { allowed: true, reason: "allowed" },
    "Reload should stay allowed when the debug export UI is inactive",
  );

  assertEqual(
    decideMessengerReload({ debugExportUiActive: true }),
    { allowed: false, reason: "debug-export-ui-active" },
    "Reload should be suppressed while the debug export UI is active",
  );

  assertEqual(
    decideMessengerTopLevelNavigation({
      currentUrl:
        "https://www.facebook.com/messages/e2ee/t/issue-79-thread",
      nextUrl: "https://www.facebook.com/messages/t/issue-79-thread",
    }),
    { allowed: false, reason: "same-thread-e2ee-downgrade" },
    "Same-thread E2EE-to-legacy navigation should be suppressed",
  );

  assertEqual(
    decideMessengerTopLevelNavigation({
      currentUrl:
        "https://www.facebook.com/messages/e2ee/t/current-thread",
      nextUrl: "https://www.facebook.com/messages/t/different-thread",
    }),
    { allowed: true, reason: "allowed" },
    "Changing to a different thread should remain allowed",
  );

  assertEqual(
    decideMessengerTopLevelNavigation({
      currentUrl: "https://www.facebook.com/messages/t/issue-79-thread",
      nextUrl:
        "https://www.facebook.com/messages/e2ee/t/issue-79-thread",
    }),
    { allowed: true, reason: "allowed" },
    "Upgrading the same thread to its E2EE route should remain allowed",
  );

  assertEqual(
    decideMessengerTopLevelNavigation({
      currentUrl:
        "https://www.facebook.com/messages/e2ee/t/issue-79-thread",
      nextUrl:
        "https://www.facebook.com/messages/e2ee/t/issue-79-thread",
    }),
    { allowed: true, reason: "allowed" },
    "Explicit reloads of the active E2EE route should remain allowed",
  );

  assertEqual(
    decideMessengerTopLevelNavigation({
      currentUrl:
        "https://www.facebook.com/messages/e2ee/t/issue-79-thread",
      nextUrl: "https://example.com/messages/t/issue-79-thread",
    }),
    { allowed: true, reason: "allowed" },
    "External navigation remains governed by the existing URL policy",
  );

  console.log("PASS reload policy tests");
}

run();
