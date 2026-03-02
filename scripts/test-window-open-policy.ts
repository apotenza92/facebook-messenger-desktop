import {
  decideWindowOpenAction,
  type WindowOpenAction,
} from "../src/main/url-policy";
import {
  ABOUT_BLANK_CHILD_BOOTSTRAP_MAX_NAVIGATIONS,
  ABOUT_BLANK_CHILD_BOOTSTRAP_WINDOW_MS,
  shouldAllowAboutBlankChildBootstrapNavigation,
} from "../src/main/about-blank-bootstrap-policy";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`,
    );
  }
}

function expectAction(url: string, expected: WindowOpenAction): void {
  const actual = decideWindowOpenAction(url);
  assertEqual(actual, expected, `Window-open action mismatch for ${url}`);
}

function run(): void {
  // Should stay as child windows (call-like flows)
  expectAction("about:blank", "allow-child-window");
  expectAction(
    "https://www.facebook.com/videochat/",
    "allow-child-window",
  );
  expectAction(
    "https://www.messenger.com/call/start/?thread_id=123",
    "allow-child-window",
  );

  // Should be rerouted into the main view (media viewer overlays)
  expectAction(
    "https://www.facebook.com/messages/media_viewer/?thread_id=123",
    "reroute-main-view",
  );
  expectAction(
    "https://www.facebook.com/photo/?fbid=12345",
    "reroute-main-view",
  );

  // Should trigger native download handling
  expectAction(
    "https://scontent-syd2-1.xx.fbcdn.net/v/t39.30808-6/example.jpg",
    "download-media",
  );

  // Message thread links should stay in-app
  expectAction("https://www.facebook.com/messages/t/123", "reroute-main-view");

  // Non-messages links should open externally in system browser
  expectAction("https://www.messenger.com/t/123", "open-external-browser");
  expectAction("https://www.facebook.com/groups/some-group", "open-external-browser");
  expectAction("https://example.com/call", "open-external-browser");

  const bootstrapStartedAt = Date.now() - 250;
  const trustedIntermediateBootstrap =
    shouldAllowAboutBlankChildBootstrapNavigation(
      "https://www.facebook.com/ajax/call_bootstrap_bridge/",
      "open-external-browser",
      bootstrapStartedAt,
      0,
      false,
    );
  assertEqual(
    trustedIntermediateBootstrap.allowed,
    true,
    "Trusted about:blank bootstrap intermediate should be allowed",
  );
  assertEqual(
    trustedIntermediateBootstrap.allowedBy,
    "trusted-intermediate",
    "Trusted about:blank bootstrap intermediate should report trusted-intermediate",
  );

  const callSafeBootstrap = shouldAllowAboutBlankChildBootstrapNavigation(
    "https://www.facebook.com/videochat/",
    "allow-child-window",
    bootstrapStartedAt,
    0,
    false,
  );
  assertEqual(
    callSafeBootstrap.allowed,
    true,
    "Call-safe about:blank bootstrap hop should be allowed",
  );

  const postCallThreadBootstrap =
    shouldAllowAboutBlankChildBootstrapNavigation(
      "https://www.facebook.com/messages/t/123",
      "reroute-main-view",
      bootstrapStartedAt,
      1,
      true,
    );
  assertEqual(
    postCallThreadBootstrap.allowed,
    true,
    "Thread hop after a call-safe bootstrap hop should be allowed",
  );
  assertEqual(
    postCallThreadBootstrap.allowedBy,
    "post-call-thread-hop",
    "Thread hop after call-safe bootstrap should report post-call-thread-hop",
  );

  const messengerPostCallThreadBootstrap =
    shouldAllowAboutBlankChildBootstrapNavigation(
      "https://www.messenger.com/t/123",
      "open-external-browser",
      bootstrapStartedAt,
      2,
      true,
    );
  assertEqual(
    messengerPostCallThreadBootstrap.allowed,
    true,
    "Messenger thread hop after call-safe bootstrap should be allowed",
  );

  const trustedIntermediateAfterCallSafe =
    shouldAllowAboutBlankChildBootstrapNavigation(
      "https://www.facebook.com/ajax/call_bootstrap_bridge/",
      "open-external-browser",
      bootstrapStartedAt,
      1,
      true,
    );
  assertEqual(
    trustedIntermediateAfterCallSafe.allowed,
    true,
    "Trusted intermediate hop should remain allowed after a call-safe bootstrap hop",
  );

  const trustedThenThreadBootstrap =
    shouldAllowAboutBlankChildBootstrapNavigation(
      "https://www.facebook.com/messages/t/123",
      "reroute-main-view",
      bootstrapStartedAt,
      2,
      true,
    );
  assertEqual(
    trustedThenThreadBootstrap.allowed,
    true,
    "Thread hop after trusted intermediate + prior call-safe bootstrap should be allowed",
  );

  const threadBootstrap = shouldAllowAboutBlankChildBootstrapNavigation(
    "https://www.facebook.com/messages/t/123",
    "reroute-main-view",
    bootstrapStartedAt,
    0,
    false,
  );
  const threadWithDownloadAction = shouldAllowAboutBlankChildBootstrapNavigation(
    "https://www.facebook.com/messages/t/123",
    "download-media",
    bootstrapStartedAt,
    3,
    true,
  );
  assertEqual(
    threadWithDownloadAction.allowed,
    false,
    "Thread hop should not be allowed for download-media actions",
  );
  assertEqual(
    threadBootstrap.allowed,
    false,
    "About:blank bootstrap should not allow thread reroute hops without prior call-safe hop",
  );

  const expiredBootstrapWindow = shouldAllowAboutBlankChildBootstrapNavigation(
    "https://www.facebook.com/videochat/",
    "allow-child-window",
    Date.now() - ABOUT_BLANK_CHILD_BOOTSTRAP_WINDOW_MS - 1_000,
    0,
    true,
  );
  assertEqual(
    expiredBootstrapWindow.allowed,
    false,
    "About:blank bootstrap should deny hops after bootstrap window expiry",
  );

  const exhaustedBootstrapBudget = shouldAllowAboutBlankChildBootstrapNavigation(
    "https://www.facebook.com/videochat/",
    "allow-child-window",
    bootstrapStartedAt,
    ABOUT_BLANK_CHILD_BOOTSTRAP_MAX_NAVIGATIONS,
    true,
  );
  assertEqual(
    exhaustedBootstrapBudget.allowed,
    false,
    "About:blank bootstrap should stop allowing hops after navigation budget is exhausted",
  );

  console.log("PASS window-open policy regression tests");
}

try {
  run();
} catch (error) {
  console.error("FAIL window-open policy regression tests failed:", error);
  process.exit(1);
}
